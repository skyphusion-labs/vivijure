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
import type { KeyframeInput, KeyframeOutput } from "./modules/types";
import {
  startClipJob, advanceClipJob, summarizeJob,
  type ClipShotInput, type ClipJob, type JobSummary,
} from "./render-orchestrator";
import { presignR2Get } from "./r2-presign";

export interface FilmScene { shot_id: string; prompt: string; seconds: number; }
export interface FilmJob {
  film_id: string;
  project: string;
  bundle_key: string;
  scenes: FilmScene[];
  motion_backend: string | null;
  motion_config: Record<string, unknown>;
  keyframe_binding: string | null;
  phase: "keyframe" | "clips" | "done" | "failed";
  keyframe_poll?: string;
  clip_job_id?: string;
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

export interface FilmSummary {
  film_id: string;
  phase: FilmJob["phase"];
  error?: string;
  clips?: JobSummary;
}
export function summarizeFilm(job: FilmJob, clipJob: ClipJob | null): FilmSummary {
  return { film_id: job.film_id, phase: job.phase, error: job.error, clips: clipJob ? summarizeJob(clipJob) : undefined };
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

  // Phase 2: drive the clip orchestrator; mark done when every shot is terminal.
  let clipJob: ClipJob | null = null;
  if (job.phase === "clips" && job.clip_job_id) {
    clipJob = await advanceClipJob(env, job.clip_job_id);
    if (clipJob && summarizeJob(clipJob).complete) { job.phase = "done"; }
    await putFilm(env, job);
  } else if (job.clip_job_id) {
    const cj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id)); // done/failed: load for the summary
    if (cj) clipJob = JSON.parse(await cj.text()) as ClipJob;
  }

  return { job, clipJob };
}
