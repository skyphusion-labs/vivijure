// Render-execution orchestrator: drive the motion.backend module per shot, ASYNC (invoke -> poll)
// and ACROSS REQUESTS, so a Worker never holds a multi-minute generation. POST starts the job
// (resolves the chosen motion.backend module, submits each shot, persists the poll tokens to an R2
// job doc). GET advances it (polls the shots still pending; the module's /poll finalizes a clip to
// R2 on completion). The caller polls GET until `complete`. Keyframes arrive as URLs -- the GPU
// keyframe stage feeds them later; for now the clip stage stands alone.
//
// State is an R2 json per job. GET only polls shots still pending (done ones are not re-polled, so
// no re-download). For concurrency-safe progress a Durable Object is the upgrade; this MVP assumes
// the caller polls sequentially.

import type { Env } from "./env";
import { discoverModules, invokeModule, pollModule, servingForHook, validateConfig } from "./modules/registry";
import type { MotionBackendInput, MotionBackendOutput, PollResponse } from "./modules/types";

export interface ClipShotInput {
  shot_id: string;
  keyframe_url: string;
  keyframe_key?: string; // the underlying R2 key; an own-GPU backend that shares the bucket reads it
  prompt: string;
  seconds: number;
  motion_backend?: string; // per-shot module name; falls back to the job default
}
export interface ClipShot extends ClipShotInput {
  status: "pending" | "done" | "failed";
  poll?: string;
  clip_key?: string;
  error?: string;
  binding?: string | null; // resolved env binding for this shot's motion module
}
export interface ClipJob {
  job_id: string;
  project: string;
  motion_backend: string | null;
  binding: string | null;
  module_configs?: Record<string, Record<string, unknown>>;
  shots: ClipShot[];
  created_at: number;
}

interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
const asFetcher = (v: unknown): FetcherLike | null =>
  v && typeof (v as { fetch?: unknown }).fetch === "function" ? (v as FetcherLike) : null;

const jobKey = (jobId: string) => `renders/${jobId}/clips-job.json`;

export interface JobSummary {
  total: number;
  done: number;
  failed: number;
  pending: number;
  complete: boolean;
}
export function summarizeJob(job: ClipJob): JobSummary {
  const total = job.shots.length;
  const done = job.shots.filter((s) => s.status === "done").length;
  const failed = job.shots.filter((s) => s.status === "failed").length;
  return { total, done, failed, pending: total - done - failed, complete: done + failed === total };
}

/** Apply a /poll outcome to a shot (pure): failure -> failed; still pending -> unchanged; output ->
 *  done with the clip key. */
export function applyPoll(shot: ClipShot, r: PollResponse<MotionBackendOutput>): void {
  if (!r.ok) {
    shot.status = "failed";
    shot.error = r.error;
    return;
  }
  if ((r as { pending?: boolean }).pending) return; // still running
  shot.status = "done";
  shot.clip_key = (r as { output: MotionBackendOutput }).output.clip_key;
}

/** Pure: does an R2 clips-object filename belong to this shot? The backend writes a finished motion clip
 *  per shot under `renders/<project>/clips/`, named with the shot id followed by a NON-digit separator
 *  (e.g. `shot_09_i2v.mp4`, `shot_09_seedance.mp4`). Match the shot id only at a digit boundary so
 *  `shot_1` never swallows `shot_10`; exclude `_finished*` (finish-chain outputs, not motion clips);
 *  require a video extension. Matches by shot-id boundary, NOT the backend's exact slug, so it stays
 *  independent of the backend naming convention (the core never hardcodes where the backend wrote). */
export function clipFileMatchesShot(file: string, shotId: string): boolean {
  if (!file.startsWith(shotId)) return false;
  const rest = file.slice(shotId.length);
  if (rest.length === 0) return false; // need a separator + extension
  if (/^\d/.test(rest)) return false; // digit boundary: shot_1 must not match shot_10...
  if (/(^|[._-])finished([._-]|$)/i.test(rest)) return false; // finish-chain output, not a motion clip
  return /\.(mp4|mov|webm|mkv)$/i.test(file); // a video file
}

/** Pure: does an R2 clips-object filename belong to this shot's FINISH-chain output? The finish modules
 *  write `renders/<project>/clips/<shot_id>_finished.mp4`. Same shot-id digit boundary as the motion-clip
 *  matcher, but here the `_finished` marker is REQUIRED (it is the finish output, not the raw motion clip)
 *  and a video extension is required. Matches by boundary + the `finished` marker, not a hardcoded full
 *  slug, so it stays independent of the backend convention. */
export function finishedClipFileMatchesShot(file: string, shotId: string): boolean {
  if (!file.startsWith(shotId)) return false;
  const rest = file.slice(shotId.length);
  if (/^\d/.test(rest)) return false; // digit boundary: shot_1 must not match shot_10...
  if (!/(^|[._-])finished([._-]|$)/i.test(rest)) return false; // MUST be a finish-chain output
  return /\.(mp4|mov|webm|mkv)$/i.test(file);
}

/** Map shot_id -> R2 key for the objects under `renders/<project>/clips/` that match `matches` (by shot-id
 *  boundary). Makes R2 PRESENCE the authority on completion: an artifact in R2 beats a module's poll
 *  verdict (the backend wrote it even if its RunPod job was later GC'd and the module fast-failed the
 *  poll; issue #141). `matches` selects the raw motion clip (default) or the finish output. Only the
 *  requested shot ids are returned. */
export async function listClipsByShotId(
  env: Env,
  project: string,
  shotIds: string[],
  matches: (file: string, shotId: string) => boolean = clipFileMatchesShot,
): Promise<Map<string, string>> {
  const prefix = `renders/${project}/clips/`;
  const found = new Map<string, string>(); // shot_id -> key (first match wins)
  let cursor: string | undefined;
  do {
    const listed = await env.R2_RENDERS.list({ prefix, cursor, limit: 1000 });
    for (const o of listed.objects) {
      const file = o.key.slice(prefix.length);
      for (const shotId of shotIds) {
        if (!found.has(shotId) && matches(file, shotId)) found.set(shotId, o.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return found;
}

/** Start a clip job: resolve the motion.backend module per shot, submit, persist poll tokens. */
export async function startClipJob(
  env: Env,
  args: {
    project: string;
    shots: ClipShotInput[];
    motion_backend?: string;
    config?: Record<string, unknown>;
    module_configs?: Record<string, Record<string, unknown>>;
  },
): Promise<ClipJob> {
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const serving = servingForHook(modules, "motion.backend");
  const defaultMb = args.motion_backend
    ? serving.find((m) => m.name === args.motion_backend) ?? null
    : serving[0] ?? null;
  const moduleConfigs = args.module_configs ?? {};
  const defaultConfig = defaultMb
    ? validateConfig(defaultMb.config_schema, args.config ?? moduleConfigs[defaultMb.name])
    : {};

  const job_id = "clips-" + crypto.randomUUID();
  const shots: ClipShot[] = [];
  for (const sh of args.shots) {
    const shot: ClipShot = { ...sh, status: "pending" };
    const mbName = sh.motion_backend ?? args.motion_backend ?? defaultMb?.name;
    const mb = mbName ? serving.find((m) => m.name === mbName) ?? null : defaultMb;
    const binding = mb ? mb.binding : null;
    shot.binding = binding;
    shot.motion_backend = mb?.name ?? undefined;
    const fetcher = binding ? asFetcher(envRec[binding]) : null;
    const config = mb
      ? validateConfig(mb.config_schema, moduleConfigs[mb.name] ?? (mb.name === defaultMb?.name ? args.config : undefined) ?? args.config)
      : defaultConfig;
    if (!mb || !fetcher) {
      shot.status = "failed";
      shot.error = mb ? `module ${mb.name} (${binding}) is not bound` : "no motion.backend module installed";
      shots.push(shot);
      continue;
    }
    const r = await invokeModule<MotionBackendInput, MotionBackendOutput>(fetcher, {
      hook: "motion.backend",
      input: { shot_id: sh.shot_id, keyframe_url: sh.keyframe_url, keyframe_key: sh.keyframe_key, prompt: sh.prompt, seconds: sh.seconds },
      config,
      context: { project: args.project, job_id },
    });
    if (!r.ok) {
      shot.status = "failed";
      shot.error = r.error;
    } else if ((r as { pending?: boolean }).pending) {
      shot.poll = (r as { poll: string }).poll;
    } else if ("output" in r) {
      shot.status = "done";
      shot.clip_key = (r.output as MotionBackendOutput).clip_key;
    } else {
      shot.status = "failed";
      shot.error = "module returned neither output nor a poll token";
    }
    shots.push(shot);
  }

  const job: ClipJob = {
    job_id,
    project: args.project,
    motion_backend: defaultMb ? defaultMb.name : null,
    binding: defaultMb ? defaultMb.binding : null,
    module_configs: Object.keys(moduleConfigs).length ? moduleConfigs : undefined,
    shots,
    created_at: Date.now(),
  };
  await env.R2_RENDERS.put(jobKey(job_id), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  return job;
}

/** Advance a clip job: poll the shots still pending; the module finalizes a clip to R2 on done. */
export async function advanceClipJob(env: Env, jobId: string): Promise<ClipJob | null> {
  const obj = await env.R2_RENDERS.get(jobKey(jobId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as ClipJob;
  const envRec = env as unknown as Record<string, unknown>;
  let anyFailed = false;
  for (const shot of job.shots) {
    if (shot.status !== "pending" || !shot.poll) continue;
    const binding = shot.binding ?? job.binding;
    const fetcher = binding ? asFetcher(envRec[binding]) : null;
    if (!fetcher) {
      shot.status = "failed";
      shot.error = "module binding no longer bound";
      anyFailed = true;
      continue;
    }
    const p = await pollModule<MotionBackendOutput>(fetcher, { poll: shot.poll });
    applyPoll(shot, p);
    if (!p.ok) anyFailed = true; // applyPoll set status=failed; a clip may still be in R2 (reclaim below)
  }
  // R2 PRESENCE IS AUTHORITATIVE (issue #141/#143): a module can fast-fail a shot whose RunPod job was
  // GC'd, but the backend may have written the clip to R2 before the job aged out. Reclaim any just-failed
  // shot whose clip is present in R2 -- BEFORE the caller's summarizeJob() complete/advance judgment, so a
  // film never advances/assembles with a clip dropped that is actually sitting in R2. Only one R2 LIST,
  // and only when a shot failed this pass (the happy path pays nothing). A shot with no R2 clip stays
  // failed (a genuine non-render).
  if (anyFailed) {
    const present = await listClipsByShotId(env, job.project, job.shots.map((s) => s.shot_id));
    for (const shot of job.shots) {
      if (shot.status === "failed" && present.has(shot.shot_id)) {
        shot.status = "done";
        shot.clip_key = present.get(shot.shot_id);
        shot.poll = undefined;
        shot.error = undefined; // clear the premature failure; the artifact is the source of truth
      }
    }
  }
  await env.R2_RENDERS.put(jobKey(jobId), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  return job;
}
