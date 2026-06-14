// Film orchestrator: the keyframe -> clip handoff. The connective tissue that turns a storyboard
// into moving clips by sequencing two async stages ACROSS REQUESTS, on the same R2-job-doc +
// caller-poll pattern the clip orchestrator uses (a Durable Object is the later upgrade for both):
//   phase "keyframe": run the keyframe module (project preview) -> keyframe keys (out-of-request).
//   phase "clips":    presign each keyframe key -> keyframe_url, feed {shot_id, keyframe_url, prompt,
//                     seconds} into the clip orchestrator (motion.backend, out-of-request).
// POST /api/render/film starts it; GET /api/render/film/:id advances it; the caller polls to `done`.
// No Worker ever holds a multi-minute GPU/cloud render.

import type { Env } from "./env";
import { discoverModules, invokeModule, pollModule, servingForHook, validateConfig } from "./modules/registry";
import type { KeyframeInput, KeyframeOutput, FinishInput, FinishOutput } from "./modules/types";
import {
  startClipJob, advanceClipJob, summarizeJob,
  type ClipShotInput, type ClipJob, type JobSummary,
} from "./render-orchestrator";
import { presignR2Get } from "./r2-presign";

export interface FilmScene { shot_id: string; prompt: string; seconds: number; }

/** One clip moving through the `finish` chain (post-clips). `chain` is the finish module bindings in
 *  ui.order; `idx` walks through them, each consuming the previous module's output clip. */
export interface FinishShot {
  shot_id: string;
  clip_key: string;   // current clip key (updated as each finish module completes)
  chain: string[];    // finish module env-binding names, in ui.order
  idx: number;
  status: "pending" | "done" | "failed";
  poll?: string;
  applied: string[];
  error?: string;
}

export interface FilmJob {
  film_id: string;
  project: string;
  bundle_key: string;
  scenes: FilmScene[];
  motion_backend: string | null;
  motion_config: Record<string, unknown>;
  keyframe_binding: string | null;
  phase: "keyframe" | "clips" | "finish" | "done" | "failed";
  keyframe_poll?: string;
  clip_job_id?: string;
  finish_shots?: FinishShot[];
  error?: string;
  created_at: number;
}

interface FetcherLike { fetch(input: Request | string, init?: RequestInit): Promise<Response>; }
const asFetcher = (v: unknown): FetcherLike | null =>
  v && typeof (v as { fetch?: unknown }).fetch === "function" ? (v as FetcherLike) : null;

const filmKey = (id: string) => `renders/${id}/film-job.json`;
const clipDocKey = (clipJobId: string) => `renders/${clipJobId}/clips-job.json`; // matches render-orchestrator

/** Pure: join keyframe outputs to scenes by shot_id. A scene with no matching keyframe is dropped
 *  and reported in `missing` (so the caller knows which shots the keyframe stage did not produce). */
export function joinKeyframesToScenes(
  scenes: FilmScene[],
  keyframes: { shot_id: string; keyframe_key: string }[],
): { matched: { shot_id: string; keyframe_key: string; prompt: string; seconds: number }[]; missing: string[] } {
  const byShot = new Map(keyframes.map((k) => [k.shot_id, k.keyframe_key]));
  const matched: { shot_id: string; keyframe_key: string; prompt: string; seconds: number }[] = [];
  const missing: string[] = [];
  for (const sc of scenes) {
    const key = byShot.get(sc.shot_id);
    if (key) matched.push({ shot_id: sc.shot_id, keyframe_key: key, prompt: sc.prompt, seconds: sc.seconds });
    else missing.push(sc.shot_id);
  }
  return { matched, missing };
}

export interface FinishSummary { total: number; done: number; failed: number; pending: number; }
export interface FilmSummary {
  film_id: string;
  phase: FilmJob["phase"];
  error?: string;
  clips?: JobSummary;
  finish?: FinishSummary;
}
export function summarizeFinish(shots: FinishShot[]): FinishSummary {
  return {
    total: shots.length,
    done: shots.filter((s) => s.status === "done").length,
    failed: shots.filter((s) => s.status === "failed").length,
    pending: shots.filter((s) => s.status === "pending").length,
  };
}
export function summarizeFilm(job: FilmJob, clipJob: ClipJob | null): FilmSummary {
  return {
    film_id: job.film_id, phase: job.phase, error: job.error,
    clips: clipJob ? summarizeJob(clipJob) : undefined,
    finish: job.finish_shots ? summarizeFinish(job.finish_shots) : undefined,
  };
}

/** Internal: presign each matched keyframe -> start the clip job, advancing the film to phase=clips. */
async function advanceToClips(env: Env, job: FilmJob, kfOut: KeyframeOutput): Promise<void> {
  const { matched, missing } = joinKeyframesToScenes(job.scenes, kfOut.keyframes || []);
  if (!matched.length) {
    job.phase = "failed";
    job.error = `keyframe stage produced none of the requested shots (missing: ${missing.join(", ")})`;
    return;
  }
  const shots: ClipShotInput[] = [];
  for (const m of matched) {
    const keyframe_url = await presignR2Get(env, m.keyframe_key, 1800); // 30min: covers a long cloud i2v job
    shots.push({ shot_id: m.shot_id, keyframe_url, prompt: m.prompt, seconds: m.seconds });
  }
  const clip = await startClipJob(env, {
    project: job.project, shots,
    motion_backend: job.motion_backend ?? undefined,
    config: job.motion_config,
  });
  job.clip_job_id = clip.job_id;
  job.phase = "clips";
}

const putFilm = (env: Env, job: FilmJob) =>
  env.R2_RENDERS.put(filmKey(job.film_id), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });

/** Pure: fold one finish module's output into the shot -- chain its output clip into the next module,
 *  record what it applied, advance the chain index; status -> done when the chain is exhausted. */
export function applyFinishOutput(fs: FinishShot, out: FinishOutput): void {
  fs.clip_key = out.clip_key;
  fs.applied.push(...(out.applied || []));
  fs.idx += 1;
  fs.poll = undefined;
  if (fs.idx >= fs.chain.length) fs.status = "done"; // else stays pending; next advance submits chain[idx]
}

/** Internal: clips done -> set up the finish chain (one FinishShot per done clip). No finish modules
 *  installed, or no clips to finish -> straight to done. */
async function enterFinishPhase(env: Env, job: FilmJob, clipJob: ClipJob): Promise<void> {
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const chain = servingForHook(modules, "finish").map((m) => m.binding); // ui.order; the full finish chain
  const doneClips = clipJob.shots.filter((s) => s.status === "done" && s.clip_key);
  if (!chain.length || !doneClips.length) { job.phase = "done"; return; }
  job.finish_shots = doneClips.map((s) => ({
    shot_id: s.shot_id, clip_key: s.clip_key as string, chain, idx: 0, status: "pending" as const, applied: [],
  }));
  job.phase = "finish";
}

/** Advance the finish chain: per shot, submit its current finish module or poll the in-flight one,
 *  chaining to the next module on completion. Phase -> done when every shot is terminal. */
async function advanceFinishPhase(env: Env, job: FilmJob): Promise<void> {
  const envRec = env as unknown as Record<string, unknown>;
  for (const fs of job.finish_shots || []) {
    if (fs.status !== "pending") continue;
    const fetcher = asFetcher(envRec[fs.chain[fs.idx]]);
    if (!fetcher) { fs.status = "failed"; fs.error = `finish module ${fs.chain[fs.idx]} not bound`; continue; }
    const req = {
      hook: "finish" as const,
      input: { shot_id: fs.shot_id, clip_key: fs.clip_key } as FinishInput,
      config: {}, context: { project: job.project, job_id: job.film_id },
    };
    if (!fs.poll) {
      const r = await invokeModule<FinishInput, FinishOutput>(fetcher, req);
      if (!r.ok) { fs.status = "failed"; fs.error = r.error; }
      else if ((r as { pending?: boolean }).pending) { fs.poll = (r as { poll: string }).poll; }
      else if ("output" in r) { applyFinishOutput(fs, r.output as FinishOutput); }
      else { fs.status = "failed"; fs.error = "finish module returned neither output nor a poll token"; }
    } else {
      const p = await pollModule<FinishOutput>(fetcher, { poll: fs.poll });
      if (!p.ok) { fs.status = "failed"; fs.error = p.error; }
      else if (!(p as { pending?: boolean }).pending) { applyFinishOutput(fs, (p as { output: FinishOutput }).output); }
    }
  }
  if ((job.finish_shots || []).every((fs) => fs.status !== "pending")) job.phase = "done";
}

/** Start a film job: resolve the keyframe module, submit the project preview, persist the poll token. */
export async function startFilmJob(
  env: Env,
  args: {
    project: string; bundle_key: string; scenes: FilmScene[];
    motion_backend?: string; keyframe_config?: Record<string, unknown>; motion_config?: Record<string, unknown>;
  },
): Promise<FilmJob> {
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const kf = servingForHook(modules, "keyframe")[0] ?? null;
  const job: FilmJob = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project, bundle_key: args.bundle_key, scenes: args.scenes,
    motion_backend: args.motion_backend ?? null, motion_config: args.motion_config ?? {},
    keyframe_binding: kf ? kf.binding : null, phase: "keyframe", created_at: Date.now(),
  };
  const fetcher = kf ? asFetcher(envRec[kf.binding]) : null;
  if (!kf || !fetcher) {
    job.phase = "failed";
    job.error = kf ? `keyframe module ${kf.name} (${kf.binding}) is not bound` : "no keyframe module installed";
  } else {
    const config = validateConfig(kf.config_schema, args.keyframe_config);
    const r = await invokeModule<KeyframeInput, KeyframeOutput>(fetcher, {
      hook: "keyframe",
      input: { project: args.project, bundle_key: args.bundle_key, shot_ids: args.scenes.map((s) => s.shot_id) },
      config,
      context: { project: args.project, job_id: job.film_id },
    });
    if (!r.ok) { job.phase = "failed"; job.error = r.error; }
    else if ((r as { pending?: boolean }).pending) { job.keyframe_poll = (r as { poll: string }).poll; }
    else if ("output" in r) { await advanceToClips(env, job, r.output as KeyframeOutput); } // sync (reuse) path
    else { job.phase = "failed"; job.error = "keyframe module returned neither output nor a poll token"; }
  }
  await putFilm(env, job);
  return job;
}

/** Advance a film job across its two phases. Returns the job + the underlying clip job (for the
 *  summary), or null if no such film job exists. */
export async function advanceFilmJob(env: Env, filmId: string): Promise<{ job: FilmJob; clipJob: ClipJob | null } | null> {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as FilmJob;
  const envRec = env as unknown as Record<string, unknown>;

  // Phase 1: poll the keyframe job; on completion, presign + hand off to the clip orchestrator.
  if (job.phase === "keyframe" && job.keyframe_poll) {
    const fetcher = job.keyframe_binding ? asFetcher(envRec[job.keyframe_binding]) : null;
    if (!fetcher) { job.phase = "failed"; job.error = "keyframe module no longer bound"; }
    else {
      const p = await pollModule<KeyframeOutput>(fetcher, { poll: job.keyframe_poll });
      if (!p.ok) { job.phase = "failed"; job.error = p.error; }
      else if (!(p as { pending?: boolean }).pending) {
        await advanceToClips(env, job, (p as { output: KeyframeOutput }).output);
      }
    }
    await putFilm(env, job);
  }

  // Phase 2: drive the clip orchestrator; when every shot is terminal, hand off to the finish chain.
  let clipJob: ClipJob | null = null;
  if (job.phase === "clips" && job.clip_job_id) {
    clipJob = await advanceClipJob(env, job.clip_job_id);
    if (clipJob && summarizeJob(clipJob).complete) { await enterFinishPhase(env, job, clipJob); }
    await putFilm(env, job);
  } else if (job.clip_job_id) {
    const cj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id)); // load for the summary
    if (cj) clipJob = JSON.parse(await cj.text()) as ClipJob;
  }

  // Phase 3: drive the finish chain per clip (async, across requests), then -> done.
  if (job.phase === "finish" && job.finish_shots) {
    await advanceFinishPhase(env, job);
    await putFilm(env, job);
  }

  return { job, clipJob };
}
