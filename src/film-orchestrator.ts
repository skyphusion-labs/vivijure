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
import type { KeyframeInput, KeyframeOutput, FinishInput, FinishOutput, ConfigSchema } from "./modules/types";
import {
  startClipJob, advanceClipJob, summarizeJob,
  type ClipShotInput, type ClipJob, type JobSummary,
} from "./render-orchestrator";
import { presignR2Get, presignR2Put } from "./r2-presign";
import { coerceShotId } from "./storyboard-validate";

export interface FilmScene { shot_id: string; prompt: string; seconds: number; }

/** One clip moving through the `finish` chain (post-clips). `chain` is the finish module bindings in
 *  ui.order; `idx` walks through them, each consuming the previous module's output clip. `configs` is
 *  the validated config for each chain step (parallel to `chain`), so each module gets its
 *  config_schema defaults -- without it a module receives `{}` and no-ops (see issue #75). */
export interface FinishShot {
  shot_id: string;
  clip_key: string;   // current clip key (updated as each finish module completes)
  chain: string[];    // finish module env-binding names, in ui.order
  configs?: Record<string, unknown>[]; // validated config per chain step, parallel to `chain`
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
  finish_config: Record<string, Record<string, unknown>>; // per finish module (keyed by module name), validated at enterFinishPhase
  keyframe_binding: string | null;
  phase: "keyframe" | "clips" | "finish" | "assemble" | "done" | "failed";
  keyframe_poll?: string;
  clip_job_id?: string;
  finish_shots?: FinishShot[];
  film_key?: string; // R2 key of the assembled film (mp4), set when phase reaches "done"
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
  film_key?: string; // present once the film is assembled (phase "done")
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
    film_key: job.film_key,
  };
}

/** Pure: order a set of finished clips by the storyboard's scene order, keeping only shots that
 *  produced a clip. The film must play in scene order regardless of which order the clip/finish
 *  stages happened to complete in. A shot with no clip is dropped (it never rendered). */
export function orderFinalClips(
  scenes: FilmScene[],
  shots: { shot_id: string; clip_key: string }[],
): { shot_id: string; clip_key: string }[] {
  const byShot = new Map(shots.map((s) => [s.shot_id, s.clip_key]));
  const out: { shot_id: string; clip_key: string }[] = [];
  for (const sc of scenes) {
    const clip_key = byShot.get(sc.shot_id);
    if (clip_key) out.push({ shot_id: sc.shot_id, clip_key });
  }
  return out;
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

/** Pure: resolve the validated config for each finish module, in chain order. Each module gets its
 *  config_schema defaults (the contract promises config is "already validated against the module's
 *  config_schema"); user overrides are keyed by module NAME (what /api/modules exposes), one hop,
 *  same words down. Without this a module receives `{}` and falls back to its do-nothing path, so
 *  finish-rife no-op'd in the first e2e (issue #75). */
export function resolveFinishConfigs(
  serving: { name: string; config_schema?: ConfigSchema }[],
  finishConfig: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown>[] {
  return serving.map((m) => validateConfig(m.config_schema, finishConfig?.[m.name]));
}

/** Internal: clips done -> set up the finish chain (one FinishShot per done clip). No finish modules
 *  installed -> skip straight to assemble (the raw clips). No clips rendered at all -> fail (nothing
 *  to assemble). */
async function enterFinishPhase(env: Env, job: FilmJob, clipJob: ClipJob): Promise<void> {
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const serving = servingForHook(modules, "finish"); // ui.order; the full finish chain
  const chain = serving.map((m) => m.binding);
  const configs = resolveFinishConfigs(serving, job.finish_config);
  const doneClips = clipJob.shots.filter((s) => s.status === "done" && s.clip_key);
  if (!doneClips.length) { job.phase = "failed"; job.error = "no clips rendered to assemble"; return; }
  if (!chain.length) { job.phase = "assemble"; return; } // no finish modules -> assemble raw clips
  job.finish_shots = doneClips.map((s) => ({
    shot_id: s.shot_id, clip_key: s.clip_key as string, chain, configs, idx: 0, status: "pending" as const, applied: [],
  }));
  job.phase = "finish";
}

/** Advance the finish chain: per shot, submit its current finish module or poll the in-flight one,
 *  chaining to the next module on completion. Phase -> assemble when every shot is terminal. */
async function advanceFinishPhase(env: Env, job: FilmJob): Promise<void> {
  const envRec = env as unknown as Record<string, unknown>;
  for (const fs of job.finish_shots || []) {
    if (fs.status !== "pending") continue;
    const fetcher = asFetcher(envRec[fs.chain[fs.idx]]);
    if (!fetcher) { fs.status = "failed"; fs.error = `finish module ${fs.chain[fs.idx]} not bound`; continue; }
    const req = {
      hook: "finish" as const,
      input: { shot_id: fs.shot_id, clip_key: fs.clip_key } as FinishInput,
      config: fs.configs?.[fs.idx] ?? {}, // validated per-module config (issue #75); {} only for legacy jobs
      context: { project: job.project, job_id: job.film_id },
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
  if ((job.finish_shots || []).every((fs) => fs.status !== "pending")) job.phase = "assemble";
}

// --------------------------------------------------------------------------- assemble (phase 4)

/** The video-finish container's POST /finish response (containers/video-finish/app.py). */
interface FinishContainerResult {
  ok: boolean;
  key?: string;
  bytes?: number;
  durationSeconds?: number;
  shots?: number;
  error?: string;
}

/** Call the video-finish container's POST /finish: warm the singleton, then post with a retry on a
 *  503 (a fully-cold container can 503 while its port is still binding -- same shape as callImagePrep
 *  in bundle-assembler). backoffMs is injectable so tests do not actually wait. Returns the Response
 *  or null on a network error. */
export async function callVideoFinish(
  env: Env,
  payload: {
    clips: { url: string }[];
    outputUrl: string;
    outputKey: string;
    width?: number;
    height?: number;
    fps?: number;
  },
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<Response | null> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  // video-finish runs always-on on the fleet, reached over a Workers VPC binding (private, no cold
  // start) -- so the old Container-DO singleton + warm-/health dance is gone (issue #83).
  let resp: Response | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await env.VIDEO_FINISH_VPC.fetch("http://video-finish/finish", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503) return resp;
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, backoffMs)); // container still binding
  }
  return resp;
}

const filmOutKey = (filmId: string) => `renders/${filmId}/film.mp4`;

/** Internal: the assemble leg. Gather the final clips (in scene order), presign each as a fetchable
 *  GET + presign the film output as a PUT, and hand them to the video-finish container, which ffmpeg-
 *  concats them into one mp4 and PUTs it. This is a CPU-only job (never GPU). The container call is
 *  synchronous; for a long film it can run a while, so if the request times out the phase stays
 *  "assemble" and the next advance re-attempts (re-PUTting the same key is idempotent). */
async function enterAssemblePhase(
  env: Env,
  job: FilmJob,
  finalClips: { shot_id: string; clip_key: string }[],
): Promise<void> {
  if (!finalClips.length) { job.phase = "failed"; job.error = "no clips to assemble"; return; }
  if (!env.VIDEO_FINISH) { job.phase = "failed"; job.error = "video-finish container not bound"; return; }

  const clips: { url: string }[] = [];
  for (const c of finalClips) {
    clips.push({ url: await presignR2Get(env, c.clip_key, 1800) }); // 30min: covers a multi-clip concat
  }
  const outputKey = filmOutKey(job.film_id);
  const outputUrl = await presignR2Put(env, outputKey, 1800);

  // Resolution/fps are left to the container default (it normalizes the clips); the motion output
  // does not carry width/height, so matching the source resolution is a later polish, not a gate.
  const resp = await callVideoFinish(env, { clips, outputUrl, outputKey });
  if (!resp) { job.phase = "failed"; job.error = "video-finish container unreachable"; return; }
  if (!resp.ok) {
    // Surface the container's own error body (it returns {ok:false,error}); an opaque "returned 500"
    // is undiagnosable. The container's ffmpeg/assemble failures are the most useful signal here.
    let detail = "";
    try { detail = (await resp.text()).slice(0, 400); } catch { /* body unreadable */ }
    job.phase = "failed";
    job.error = `video-finish container returned ${resp.status}${detail ? `: ${detail}` : ""}`;
    return;
  }
  let body: FinishContainerResult;
  try {
    body = (await resp.json()) as FinishContainerResult;
  } catch {
    job.phase = "failed"; job.error = "video-finish returned a non-JSON response"; return;
  }
  if (!body.ok) { job.phase = "failed"; job.error = `video-finish failed: ${body.error || "unknown error"}`; return; }
  job.film_key = outputKey;
  job.phase = "done";
}

/** Pure: normalize caller scene ids to the canonical `shot_NN` the bundle uses. /api/storyboard/bundle
 *  runs validateStoryboard, which coerces every scene id to `shot_<index+1>` in declaration order --
 *  so a caller that supplies its own ids (e.g. the Slate bot's `s1`/`s2`) gets a bundle storyboard
 *  whose ids do NOT match the film's shot_ids, and the keyframe stage rejects them
 *  (`process_shot_ids not in storyboard`). Coerce here with the SAME function so they line up by
 *  position (a valid `shot_NN` survives; anything else is renumbered). */
export function coerceSceneIds(scenes: FilmScene[]): FilmScene[] {
  return (scenes || []).map((s, i) => ({ ...s, shot_id: coerceShotId(s.shot_id, i) }));
}

/** Start a film job: resolve the keyframe module, submit the project preview, persist the poll token. */
export async function startFilmJob(
  env: Env,
  args: {
    project: string; bundle_key: string; scenes: FilmScene[];
    motion_backend?: string; keyframe_config?: Record<string, unknown>; motion_config?: Record<string, unknown>;
    finish_config?: Record<string, Record<string, unknown>>;
  },
): Promise<FilmJob> {
  const scenes = coerceSceneIds(args.scenes ?? []);
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const kf = servingForHook(modules, "keyframe")[0] ?? null;
  const job: FilmJob = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project, bundle_key: args.bundle_key, scenes,
    motion_backend: args.motion_backend ?? null, motion_config: args.motion_config ?? {},
    finish_config: args.finish_config ?? {},
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
      input: { project: args.project, bundle_key: args.bundle_key, shot_ids: scenes.map((s) => s.shot_id) },
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

  // Phase 3: drive the finish chain per clip (async, across requests), then -> assemble.
  if (job.phase === "finish" && job.finish_shots) {
    await advanceFinishPhase(env, job);
    await putFilm(env, job);
  }

  // Phase 4: assemble the final clips into one film (CPU-only ffmpeg concat in the video-finish
  // container), then -> done. The final clips are the finish-chain outputs if finish ran, else the
  // raw rendered clips; either way ordered by the storyboard. Reached inline once finish/clips
  // complete (the intermediate "assemble" was persisted above, so a timed-out concat just retries).
  if (job.phase === "assemble") {
    const source = job.finish_shots
      ? job.finish_shots
          .filter((fs) => fs.status === "done")
          .map((fs) => ({ shot_id: fs.shot_id, clip_key: fs.clip_key }))
      : (clipJob?.shots || [])
          .filter((s) => s.status === "done" && s.clip_key)
          .map((s) => ({ shot_id: s.shot_id, clip_key: s.clip_key as string }));
    await enterAssemblePhase(env, job, orderFinalClips(job.scenes, source));
    await putFilm(env, job);
  }

  return { job, clipJob };
}
