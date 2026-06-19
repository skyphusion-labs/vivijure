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
import type { KeyframeInput, KeyframeOutput, FinishInput, FinishOutput, ConfigSchema, NotifyInput, NotifyOutput } from "./modules/types";
import {
  startClipJob, advanceClipJob, summarizeJob, clipFileMatchesShot, listClipsByShotId,
  type ClipShotInput, type ClipJob, type JobSummary,
} from "./render-orchestrator";
import { presignR2Get, presignR2Put } from "./r2-presign";
import { resolveStagedAudioKey } from "./audio-stage";
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

export interface FilmKeyframeRef {
  shot_id: string;
  keyframe_key: string;
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
  phase: "keyframe" | "clips" | "finish" | "assemble" | "mux" | "done" | "failed";
  keyframe_poll?: string;
  clip_job_id?: string;
  finish_shots?: FinishShot[];
  film_key?: string; // R2 key of the assembled film (mp4), set when phase reaches "done"
  silent_film_key?: string; // silent concat output before optional audio mux
  audio_key?: string; // staged R2_RENDERS audio bed to mux after assemble
  mux_output_key?: string; // deterministic mux destination for idempotent retries
  mux_attempts?: number;
  // keyframes-only preview: stop after the keyframe module, no i2v / assemble.
  keyframes_only?: boolean;
  /** Scatter shard: stop after finish (per-shot clips in R2), skip assemble. */
  clips_only?: boolean;
  keyframes?: FilmKeyframeRef[];
  cancelled?: boolean;
  /** Child animation from a keyframes-only preview (finalize / cloud / hybrid). */
  derive_mode?: "finalized" | "cloud-finalized";
  parent_render_id?: number;
  // Bounded counter for transient assemble retries (issue #82). A cold or slow video-finish concat can
  // 504 (or be briefly unreachable) on the last CPU-only step; rather than failing a fully-rendered
  // film, enterAssemblePhase keeps phase="assemble" so the next poll re-attempts (the re-PUT to the same
  // film key is idempotent), capped by MAX_ASSEMBLE_ATTEMPTS. Absent on pre-#82 jobs (reads as 0).
  assemble_attempts?: number;
  // Wall-clock the job entered its CURRENT phase (issue #129). advanceFilmJob stamps this on every
  // phase transition; the stall recovery measures how long a pollable phase has been stuck against it.
  // Absent on pre-#129 jobs -> recovery falls back to created_at (still bounded, just more generous).
  phase_started_at?: number;
  // Set once the keyframe stall recovery has adopted orphaned keyframes from R2, so the (idempotent)
  // adoption is never retried in a loop -- after one adoption the job has moved to clips anyway.
  keyframe_recovered?: boolean;
  // Set once the clips stall recovery has adopted orphaned clips from R2 (issue #139). Same idea as
  // keyframe_recovered: the motion.backend (own-gpu) poll can return pending forever on a GC'd RunPod
  // job while the finished clip already sits in R2; recovery collects them by shot name and advances.
  clips_recovered?: boolean;
  error?: string;
  created_at: number;
  user_email?: string; // film owner; passed to the `notify` hook on done (e.g. for an email notifier)
}

interface FetcherLike { fetch(input: Request | string, init?: RequestInit): Promise<Response>; }
const asFetcher = (v: unknown): FetcherLike | null =>
  v && typeof (v as { fetch?: unknown }).fetch === "function" ? (v as FetcherLike) : null;

const filmKey = (id: string) => `renders/${id}/film-job.json`;
const clipDocKey = (clipJobId: string) => `renders/${clipJobId}/clips-job.json`; // matches render-orchestrator

export { filmKey as filmJobDocKey, clipDocKey as clipJobDocKey };

/** Cheap existence check for an R2 object (HEAD, no body). Used to derive assemble
 *  completion from R2 presence so a stalled-after-PUT concat self-heals (issue #122). */
async function r2ObjectExists(env: Env, key: string): Promise<boolean> {
  try {
    return (await env.R2_RENDERS.head(key)) !== null;
  } catch {
    return false;
  }
}

/** Collect finished clip keys from a terminal clips_only (or full) film job doc. */
export async function clipKeysFromFilmJob(
  env: Env,
  job: FilmJob,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (job.finish_shots?.length) {
    for (const fs of job.finish_shots) {
      if (fs.status === "done" && fs.clip_key) out.set(fs.shot_id, fs.clip_key);
    }
    if (out.size) return out;
  }
  if (!job.clip_job_id) return out;
  const cjObj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
  if (!cjObj) return out;
  const clipJob = JSON.parse(await cjObj.text()) as ClipJob;
  for (const sh of clipJob.shots) {
    if (sh.status === "done" && sh.clip_key) out.set(sh.shot_id, sh.clip_key);
  }
  return out;
}

/** Map a film job phase to a shard status string for scatter gather decisions. */
export function filmPhaseToShardStatus(job: FilmJob): string {
  if (job.cancelled) return "CANCELLED";
  if (job.phase === "done") return "COMPLETED";
  if (job.phase === "failed") return "FAILED";
  return "IN_PROGRESS";
}

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

/** Internal: keyframes-only path -- record keys and mark done (no i2v / assemble). */
function completeKeyframesOnly(job: FilmJob, kfOut: KeyframeOutput): void {
  const kfs = kfOut.keyframes || [];
  if (!kfs.length) {
    job.phase = "failed";
    job.error = "keyframe stage produced no keyframes";
    return;
  }
  job.keyframes = kfs.map((k) => ({ shot_id: k.shot_id, keyframe_key: k.keyframe_key }));
  job.phase = "done";
}

/** Internal: after keyframes, either stop (preview) or hand off to the clip orchestrator. */
async function afterKeyframeOutput(env: Env, job: FilmJob, kfOut: KeyframeOutput): Promise<void> {
  if (job.keyframes_only) {
    completeKeyframesOnly(job, kfOut);
    return;
  }
  await advanceToClips(env, job, kfOut);
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
  if (!chain.length) {
    job.phase = job.clips_only ? "done" : "assemble";
    return;
  }
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
  if ((job.finish_shots || []).every((fs) => fs.status !== "pending")) {
    job.phase = job.clips_only ? "done" : "assemble";
  }
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

/** Call the video-finish container's POST /finish, retrying on a transient gateway status -- 503 (a
 *  cold container can 503 while its port is still binding -- same shape as callImagePrep in
 *  bundle-assembler) or 504 (a cold-boot + ffmpeg concat that exceeds the request window; issue #82).
 *  backoffMs is injectable so tests do not actually wait. Returns the Response or null on a network
 *  error. The orchestrator (enterAssemblePhase) adds an outer, across-polls auto-recover on top of
 *  this in-request retry, since a single request window may not outlast a fully-cold container. */
export async function callVideoFinish(
  env: Env,
  payload: {
    clips: { url: string }[];
    outputUrl: string;
    outputKey: string;
    width?: number;
    height?: number;
    fps?: number;
    audioUrl?: string;
    remuxAudioOnly?: boolean;
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
    if (resp && resp.status !== 503 && resp.status !== 504) return resp;
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, backoffMs)); // container still binding / warming
  }
  return resp;
}

const filmOutKey = (filmId: string) => `renders/${filmId}/film.mp4`;

// Cap on across-polls assemble re-attempts before a transient failure goes terminal (issue #82).
const MAX_ASSEMBLE_ATTEMPTS = 6;

/** Pure: classify a video-finish assemble attempt and advance the bounded retry counter (issue #82).
 *  `status` is the HTTP status, or null when the container was unreachable (network error). The counter
 *  tracks CONSECUTIVE transient failures, so the returned `attempts` is always the value to store:
 *    - transient gateway outcome (unreachable, or 502/503/504 from a cold or slow ffmpeg concat
 *      exceeding the request window) -> prior + 1; the film stays in "assemble" and the next poll
 *      re-attempts (re-PUTting the same film key is idempotent), bounded by maxAttempts.
 *    - any definitive answer from the container ("ok": a real success, OR the container's own terminal
 *      error like a 500 ffmpeg body) -> 0, because the transient streak is broken. Resetting here is
 *      what keeps a slow-but-successful finish from carrying stale attempts toward the cap, and gives a
 *      later manual phase-reset a full retry budget. The caller then distinguishes success from the
 *      container's terminal error (which must NOT loop).
 *  A fully-rendered film therefore self-heals from a cold-container 504 instead of failing on the last
 *  CPU-only step and needing a human phase-reset. */
export type AssembleTransport =
  | { state: "ok"; attempts: number } // definitive answer; streak reset to 0, caller reads the response
  | { state: "retry"; attempts: number; error: string } // stay in "assemble", re-attempt next poll
  | { state: "exhausted"; attempts: number; error: string }; // cap hit -> terminal failed

export function classifyAssembleTransport(
  status: number | null,
  priorAttempts: number,
  maxAttempts: number,
): AssembleTransport {
  const transient = status === null || status === 502 || status === 503 || status === 504;
  if (!transient) return { state: "ok", attempts: 0 };
  const attempts = priorAttempts + 1;
  const reason = status === null ? "container unreachable" : `gateway ${status}`;
  if (attempts < maxAttempts) {
    return {
      state: "retry",
      attempts,
      error: `assemble retry ${attempts}/${maxAttempts} (${reason}); clips intact, re-attempting next poll`,
    };
  }
  return {
    state: "exhausted",
    attempts,
    error: `video-finish ${reason} after ${attempts} assemble attempts; clips intact in R2 (reset phase to "assemble" to retry)`,
  };
}

/** Internal: the assemble leg. Gather the final clips (in scene order), presign each as a fetchable
 *  GET + presign the film output as a PUT, and hand them to the video-finish container, which ffmpeg-
 *  concats them into one mp4 and PUTs it. This is a CPU-only job (never GPU). The container call is
 *  synchronous; for a long film it can run a while, so if the request times out the phase stays
 *  "assemble" and the next advance re-attempts (re-PUTting the same key is idempotent). */
/** Best-effort: on the done-transition, fire the `notify` hook chain -- every installed notify module
 *  (email, webhook, ...) delivers independently. Presigns the film's download link + hands over the
 *  completion context. A notifier failure (or none installed) NEVER fails the already-assembled render;
 *  the film is in R2 by the time this runs. */
async function fireNotify(env: Env, job: FilmJob): Promise<void> {
  if (!job.film_key) return;
  try {
    const envRec = env as unknown as Record<string, unknown>;
    const notifiers = servingForHook(await discoverModules(envRec), "notify");
    if (!notifiers.length) return;
    const download_url = await presignR2Get(env, job.film_key, 86400); // 24h link, matches the poll summary
    const input: NotifyInput = {
      event: "render.complete", film_id: job.film_id, project: job.project,
      download_url, user_email: job.user_email,
    };
    const context = { project: job.project, job_id: job.film_id, user_email: job.user_email };
    for (const m of notifiers) {
      const fetcher = asFetcher(envRec[m.binding]);
      if (!fetcher) continue;
      try {
        await invokeModule<NotifyInput, NotifyOutput>(fetcher, {
          hook: "notify", input, config: validateConfig(m.config_schema ?? {}, {}), context,
        });
      } catch { /* best-effort per notifier -- a delivery failure never fails the render */ }
    }
  } catch (e) {
    console.warn(`notify chain failed for ${job.film_id}: ${(e as Error).message}`);
  }
}

async function enterMuxPhase(env: Env, job: FilmJob): Promise<void> {
  const silentKey = job.silent_film_key;
  const audioKey = job.audio_key;
  if (!silentKey || !audioKey) {
    job.film_key = silentKey;
    job.phase = "done";
    await fireNotify(env, job);
    return;
  }
  if (!env.VIDEO_FINISH_VPC) {
    job.phase = "failed";
    job.error = "video-finish VPC binding not configured";
    return;
  }

  const outKey = job.mux_output_key
    ?? silentKey.replace(/\.mp4$/i, "") + "-audio-" + crypto.randomUUID().slice(0, 8) + ".mp4";
  job.mux_output_key = outKey;

  const [videoUrl, audioUrl, outputUrl] = await Promise.all([
    presignR2Get(env, silentKey, 1800),
    presignR2Get(env, audioKey, 1800),
    presignR2Put(env, outKey, 1800),
  ]);

  const resp = await callVideoFinish(env, {
    clips: [{ url: videoUrl }],
    outputUrl,
    outputKey: outKey,
    audioUrl,
    remuxAudioOnly: true,
  });

  const transport = classifyAssembleTransport(resp ? resp.status : null, job.mux_attempts ?? 0, MAX_ASSEMBLE_ATTEMPTS);
  job.mux_attempts = transport.attempts;
  if (transport.state === "retry") {
    job.phase = "mux";
    job.error = transport.error;
    return;
  }
  if (transport.state === "exhausted") {
    job.phase = "failed";
    job.error = transport.error;
    return;
  }
  if (!resp) {
    job.phase = "failed";
    job.error = "video-finish container unreachable";
    return;
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.text()).slice(0, 400); } catch { /* body unreadable */ }
    job.phase = "failed";
    job.error = `video-finish mux returned ${resp.status}${detail ? `: ${detail}` : ""}`;
    return;
  }
  let body: FinishContainerResult;
  try {
    body = (await resp.json()) as FinishContainerResult;
  } catch {
    job.phase = "failed";
    job.error = "video-finish returned a non-JSON response";
    return;
  }
  if (!body.ok) {
    job.phase = "failed";
    job.error = `video-finish mux failed: ${body.error || "unknown error"}`;
    return;
  }
  job.film_key = outKey;
  job.phase = "done";
  await fireNotify(env, job);
}

async function finishAssembledFilm(env: Env, job: FilmJob, silentKey: string): Promise<void> {
  job.silent_film_key = silentKey;
  if (job.audio_key) {
    job.phase = "mux";
    await enterMuxPhase(env, job);
  } else {
    job.film_key = silentKey;
    job.phase = "done";
    await fireNotify(env, job);
  }
}

async function enterAssemblePhase(
  env: Env,
  job: FilmJob,
  finalClips: { shot_id: string; clip_key: string }[],
): Promise<void> {
  if (!finalClips.length) { job.phase = "failed"; job.error = "no clips to assemble"; return; }

  // Derive completion from R2 presence: if the concat output is already in R2, a prior
  // attempt's ffmpeg PUT succeeded even though its response was lost (the container 504'd
  // after writing, or the poll window closed mid-PUT and the job was re-driven). Re-running
  // the concat would be wasted CPU, so finalize straight from the existing object. This is
  // what lets a stalled-after-PUT assemble self-heal on the next poll / sweep tick instead of
  // looping. (issue #122)
  const outputKey = filmOutKey(job.film_id);
  if (await r2ObjectExists(env, outputKey)) {
    job.assemble_attempts = 0;
    await finishAssembledFilm(env, job, outputKey);
    return;
  }

  if (!env.VIDEO_FINISH_VPC) { job.phase = "failed"; job.error = "video-finish VPC binding not configured"; return; }

  const clips: { url: string }[] = [];
  for (const c of finalClips) {
    clips.push({ url: await presignR2Get(env, c.clip_key, 1800) }); // 30min: covers a multi-clip concat
  }
  const outputUrl = await presignR2Put(env, outputKey, 1800);

  // Resolution/fps are left to the container default (it normalizes the clips); the motion output
  // does not carry width/height, so matching the source resolution is a later polish, not a gate.
  const resp = await callVideoFinish(env, { clips, outputUrl, outputKey });
  // A transient gateway outcome (unreachable / 502 / 503 / 504) auto-recovers across polls instead of
  // going terminal: the clips are intact in R2 and re-PUTting the same film key is idempotent, so keep
  // phase="assemble" and let the next poll re-attempt against a (by then) warmer container -- bounded so
  // a genuinely stuck assemble still fails loudly (issue #82).
  const transport = classifyAssembleTransport(resp ? resp.status : null, job.assemble_attempts ?? 0, MAX_ASSEMBLE_ATTEMPTS);
  // One assignment for every outcome: the helper returns the next counter value (prior+1 on a transient
  // failure, 0 once the container gives a definitive answer -- so a slow-but-successful finish never
  // carries stale attempts toward the cap, and a manual phase-reset starts from a full budget).
  job.assemble_attempts = transport.attempts;
  if (transport.state === "retry") {
    job.phase = "assemble"; // unchanged; next advanceFilmJob poll re-enters this leg
    job.error = transport.error;
    return;
  }
  if (transport.state === "exhausted") {
    job.phase = "failed";
    job.error = transport.error;
    return;
  }
  // state === "ok": a transient status is never null, so resp is non-null here. The guard keeps the
  // compiler happy and is a defensive backstop.
  if (!resp) { job.phase = "failed"; job.error = "video-finish container unreachable"; return; }
  if (!resp.ok) {
    // A non-transient error status: the container's own failure (e.g. a 500 with an ffmpeg/assemble
    // error body). Surface the body -- an opaque "returned 500" is undiagnosable -- and go terminal;
    // retrying a real assemble error would only loop.
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
  await finishAssembledFilm(env, job, outputKey);
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

/** Start a film at the clips phase using existing keyframe keys (finalize / cloud / hybrid). */
export async function startFilmFromKeyframes(
  env: Env,
  args: {
    project: string;
    bundle_key: string;
    scenes: FilmScene[];
    keyframes: FilmKeyframeRef[];
    motion_backend?: string;
    per_shot_motion?: Record<string, string>;
    motion_config?: Record<string, unknown>;
    motion_configs?: Record<string, Record<string, unknown>>;
    finish_config?: Record<string, Record<string, unknown>>;
    derive_mode: "finalized" | "cloud-finalized";
    parent_render_id?: number;
    audio_key?: string;
    user_email?: string;
  },
): Promise<FilmJob> {
  const scenes = coerceSceneIds(args.scenes ?? []);
  const stagedAudio = await resolveStagedAudioKey(env, args.audio_key);
  const { matched, missing } = joinKeyframesToScenes(scenes, args.keyframes || []);
  const job: FilmJob = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project,
    bundle_key: args.bundle_key,
    scenes,
    motion_backend: args.motion_backend ?? null,
    motion_config: args.motion_config ?? {},
    finish_config: args.finish_config ?? {},
    keyframe_binding: null,
    phase: "failed",
    created_at: Date.now(),
    phase_started_at: Date.now(),
    derive_mode: args.derive_mode,
    parent_render_id: args.parent_render_id,
    audio_key: stagedAudio,
    user_email: args.user_email,
  };
  if (!matched.length) {
    job.error = `no keyframes matched requested shots (missing: ${missing.join(", ")})`;
    await putFilm(env, job);
    return job;
  }
  const shots: ClipShotInput[] = [];
  for (const m of matched) {
    const keyframe_url = await presignR2Get(env, m.keyframe_key, 1800);
    shots.push({
      shot_id: m.shot_id,
      keyframe_url,
      keyframe_key: m.keyframe_key,
      prompt: m.prompt,
      seconds: m.seconds,
      motion_backend: args.per_shot_motion?.[m.shot_id],
    });
  }
  const clip = await startClipJob(env, {
    project: args.project,
    shots,
    motion_backend: args.motion_backend,
    config: args.motion_config,
    module_configs: args.motion_configs,
  });
  job.clip_job_id = clip.job_id;
  job.phase = summarizeJob(clip).failed === clip.shots.length ? "failed" : "clips";
  if (job.phase === "failed") job.error = "every clip submission failed";
  await putFilm(env, job);
  return job;
}

/** Start a film job: resolve the keyframe module, submit the project preview, persist the poll token. */
export async function startFilmJob(
  env: Env,
  args: {
    project: string; bundle_key: string; scenes: FilmScene[];
    motion_backend?: string; keyframe_config?: Record<string, unknown>; motion_config?: Record<string, unknown>;
    finish_config?: Record<string, Record<string, unknown>>;
    keyframes_only?: boolean;
    clips_only?: boolean;
    pretrained_loras?: Record<string, string>;
    audio_key?: string;
    user_email?: string;
  },
): Promise<FilmJob> {
  const scenes = coerceSceneIds(args.scenes ?? []);
  const stagedAudio = args.clips_only ? undefined : await resolveStagedAudioKey(env, args.audio_key);
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const kf = servingForHook(modules, "keyframe")[0] ?? null;
  const job: FilmJob = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project, bundle_key: args.bundle_key, scenes,
    motion_backend: args.motion_backend ?? null, motion_config: args.motion_config ?? {},
    finish_config: args.finish_config ?? {},
    keyframes_only: !!args.keyframes_only,
    clips_only: !!args.clips_only,
    audio_key: stagedAudio,
    keyframe_binding: kf ? kf.binding : null, phase: "keyframe", created_at: Date.now(),
    phase_started_at: Date.now(),
    user_email: args.user_email,
  };
  const fetcher = kf ? asFetcher(envRec[kf.binding]) : null;
  if (!kf || !fetcher) {
    job.phase = "failed";
    job.error = kf ? `keyframe module ${kf.name} (${kf.binding}) is not bound` : "no keyframe module installed";
  } else {
    const config = validateConfig(kf.config_schema, args.keyframe_config);
    const keyframeInput: KeyframeInput = {
      project: args.project,
      bundle_key: args.bundle_key,
      shot_ids: scenes.map((s) => s.shot_id),
    };
    if (args.pretrained_loras && Object.keys(args.pretrained_loras).length) {
      keyframeInput.pretrained_loras = { ...args.pretrained_loras };
    }
    const r = await invokeModule<KeyframeInput, KeyframeOutput>(fetcher, {
      hook: "keyframe",
      input: keyframeInput,
      config,
      context: { project: args.project, job_id: job.film_id },
    });
    if (!r.ok) { job.phase = "failed"; job.error = r.error; }
    else if ((r as { pending?: boolean }).pending) { job.keyframe_poll = (r as { poll: string }).poll; }
    else if ("output" in r) { await afterKeyframeOutput(env, job, r.output as KeyframeOutput); }
    else { job.phase = "failed"; job.error = "keyframe module returned neither output nor a poll token"; }
  }
  await putFilm(env, job);
  return job;
}

/** Mark an in-flight film job cancelled. Terminal jobs are returned unchanged. */
export async function cancelFilmJob(env: Env, filmId: string): Promise<FilmJob | null> {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as FilmJob;
  if (job.phase === "done" || job.phase === "failed") return job;
  job.cancelled = true;
  job.phase = "failed";
  job.error = "cancelled";
  await putFilm(env, job);
  return job;
}

// --------------------------------------------------------------------------- stall recovery (#129)

// How long a phase may sit without progress before the driver tries to recover it, and the absolute
// ceiling past which a still-pollable phase is failed loudly rather than left to hang forever. The
// background sweep (crons */1) calls advanceFilmJob every minute, so a wedged job is rescued or failed
// within KEYFRAME_STALL_SECONDS of the GPU finishing -- never the silent forever-IN_PROGRESS of #129.
//   Cause: the keyframe / finish module poll() returns pending for any non-COMPLETED RunPod /status,
//   so once RunPod garbage-collects a finished job the poll is pending with no deadline while the GPU
//   output already sits in R2. The keyframe stage writes deterministic keys
//   (renders/<project>/keyframes/<shot>.png), so the core CAN adopt those orphans without re-running
//   the GPU; clips/finish keys are GPU-assigned (not guessable), so those phases get the loud-fail
//   ceiling only (a stuck clips/finish poll is rarer and re-submitting is the human's call).
export const KEYFRAME_STALL_SECONDS = 20 * 60; // 20min: a project-wide SDXL keyframe pass is well done by now
export const PHASE_HARD_DEADLINE_SECONDS = 90 * 60; // 90min: absolute ceiling for any one pollable phase

const POLLABLE_PHASES: ReadonlySet<FilmJob["phase"]> = new Set(["keyframe", "clips", "finish"]);

/** Seconds the job has sat in its current phase. Falls back to created_at on pre-#129 jobs (no
 *  phase_started_at stamp); `now` is injectable so tests do not depend on the wall clock. */
export function phaseAgeSeconds(job: FilmJob, now: number = Date.now()): number {
  const since = job.phase_started_at ?? job.created_at;
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** List the keyframe PNGs the GPU wrote for a project and join them to the job's scenes. The keyframe
 *  stage writes `renders/<project>/keyframes/<shot_id>.png` itself (its own R2 creds; see the keyframe
 *  module), so the core can recover an orphaned keyframe phase straight from R2 presence -- no GPU re-
 *  run. Returns only keyframes whose shot_id is in the storyboard, so a stale PNG from an older render
 *  of the same project can never inject a shot the film did not ask for. */
export async function listProjectKeyframes(env: Env, project: string, scenes: FilmScene[]): Promise<FilmKeyframeRef[]> {
  const prefix = `renders/${project}/keyframes/`;
  const wanted = new Set(scenes.map((s) => s.shot_id));
  const out: FilmKeyframeRef[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.R2_RENDERS.list({ prefix, cursor, limit: 1000 });
    for (const o of listed.objects) {
      const file = o.key.slice(prefix.length);
      const shot_id = file.replace(/\.[^.]+$/, ""); // drop the extension (.png)
      if (shot_id && wanted.has(shot_id)) out.push({ shot_id, keyframe_key: o.key });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  // De-dupe (a project could in principle hold .png + another ext for a shot); keep the first seen.
  const seen = new Set<string>();
  return out.filter((k) => (seen.has(k.shot_id) ? false : (seen.add(k.shot_id), true)));
}

/** Recover a keyframe phase whose module poll has gone stale (RunPod GC'd the finished job) by adopting
 *  the keyframes already in R2 and advancing exactly as a fresh keyframe completion would (afterKeyframe
 *  Output -> clips, or done for a keyframes-only preview). Idempotent: marks keyframe_recovered so it
 *  runs once, and a fresh-completion advance on a later poll is unaffected (the phase has moved on).
 *  Returns true iff it adopted keyframes and moved the phase. */
async function recoverStalledKeyframePhase(env: Env, job: FilmJob): Promise<boolean> {
  const adopted = await listProjectKeyframes(env, job.project, job.scenes);
  if (!adopted.length) return false; // nothing in R2 to adopt -- not actually complete; let the ceiling handle it
  console.warn(`film ${job.film_id}: keyframe poll stale, adopting ${adopted.length} orphaned keyframes from R2 (#129)`);
  job.keyframe_recovered = true;
  job.keyframe_poll = undefined; // the phantom RunPod job is done with
  await afterKeyframeOutput(env, job, { project: job.project, keyframes: adopted });
  return true;
}

// clipFileMatchesShot + the shot-id->clip-key R2 listing live in render-orchestrator (the layer that owns
// the clip job + advanceClipJob), so the fail-time reclaim and the stall-recovery share ONE matcher (no
// drift). listProjectClips here is the scenes-shaped wrapper the film recovery uses.
export { clipFileMatchesShot };

/** List the motion clips the GPU wrote for a project, joined to the job's scenes by shot id (scene-shaped
 *  wrapper over render-orchestrator's listClipsByShotId). When a motion.backend poll never resolves (GC'd
 *  RunPod job), the clip is still in R2; matching by shot-id boundary recovers a stalled clips phase from
 *  R2 presence, no GPU re-run. Only shots in the storyboard are returned. */
export async function listProjectClips(env: Env, project: string, scenes: FilmScene[]): Promise<{ shot_id: string; clip_key: string }[]> {
  const wanted = scenes.map((s) => s.shot_id);
  const found = await listClipsByShotId(env, project, wanted);
  return wanted.filter((s) => found.has(s)).map((s) => ({ shot_id: s, clip_key: found.get(s) as string }));
}

/** Recover a clips phase whose motion.backend poll has gone stale by adopting the clips already in R2.
 *  Loads the clip job doc, marks any not-yet-done shot whose clip IS in R2 done with that key (pending OR
 *  a shot the module prematurely failed -- artifact present in R2 is the source of truth and overrides a
 *  module's failure verdict; #141), re-PUTs the clip doc, and -- only once every shot is terminal --
 *  advances to the finish chain exactly as a normal clips completion would.
 *
 *  RE-FIRES across sweeps (issue #143): the 10 clips finish + go stale at DIFFERENT times, so one pass may
 *  adopt only the shots whose clips have landed so far while others are still rendering. This must run
 *  every stalled sweep until the job is complete -- so it does NOT set a one-shot `clips_recovered` gate on
 *  a partial pass (unlike the keyframe batch, which completes all at once). `clips_recovered` is set ONLY
 *  when the job is complete and we advance to finish -- a record that adoption closed the job, not a guard
 *  that would block the next partial pass. Returns true iff it advanced the film phase out of "clips".
 *  A partial pass returns false (phase stays "clips"; the next stalled sweep re-attempts the rest); a pass
 *  that adopts nothing AND finds nothing already terminal also returns false (the hard ceiling decides). */
async function recoverStalledClipsPhase(env: Env, job: FilmJob): Promise<boolean> {
  if (!job.clip_job_id) return false;
  const cjObj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
  if (!cjObj) return false;
  const clipJob = JSON.parse(await cjObj.text()) as ClipJob;
  const inR2 = new Map((await listProjectClips(env, job.project, job.scenes)).map((c) => [c.shot_id, c.clip_key]));
  let adopted = 0;
  for (const shot of clipJob.shots) {
    // Adopt any NOT-done shot whose clip is in R2 -- pending OR failed. The module fix (#141) now FAILS a
    // shot whose RunPod job was GC'd, but the GPU may have written the clip before the job aged out;
    // "artifact present in R2" wins over a premature module failure. A shot with no R2 clip is untouched
    // (still rendering, or a genuine non-render) and will be retried on the next stalled sweep.
    if (shot.status !== "done" && inR2.has(shot.shot_id)) {
      shot.status = "done";
      shot.clip_key = inR2.get(shot.shot_id);
      shot.poll = undefined; // the phantom RunPod job is done with
      shot.error = undefined; // clear a premature module failure now that the artifact is adopted
      adopted += 1;
    }
  }
  // Persist any partial progress so a later sweep starts from it (the re-PUT is idempotent). Skip the PUT
  // only when nothing changed this pass, to avoid a needless write while we wait for more clips to land.
  if (adopted) {
    await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
    console.warn(`film ${job.film_id}: clips poll stale, adopted ${adopted} orphaned clips from R2 this pass (#143)`);
  }
  // Only advance once the WHOLE job is terminal -- otherwise stay in "clips" and let the next stalled sweep
  // pick up the shots that have since landed. Do NOT set a one-shot gate on a partial pass.
  if (!summarizeJob(clipJob).complete) return false;
  job.clips_recovered = true;
  await enterFinishPhase(env, job, clipJob);
  return true;
}

/** The stall-recovery pass, run after the normal phase advance. For a pollable phase that has not
 *  progressed within its deadline: try a same-phase recovery (keyframe adoption from R2), else, once
 *  past the absolute ceiling, fail loudly so a wedged render surfaces instead of hanging forever (#129).
 *  Returns true iff it changed the phase (so the caller re-stamps phase_started_at + persists). */
async function recoverStalledPhase(env: Env, job: FilmJob, now: number = Date.now()): Promise<boolean> {
  if (!POLLABLE_PHASES.has(job.phase)) return false;
  const age = phaseAgeSeconds(job, now);

  // Same-phase recovery: a keyframe poll that never resolved, but the keyframes are in R2.
  if (job.phase === "keyframe" && !job.keyframe_recovered && age >= KEYFRAME_STALL_SECONDS) {
    if (await recoverStalledKeyframePhase(env, job)) return true;
  }

  // Same-phase recovery: a clips (motion.backend) poll that never resolved, but the clips are in R2
  // (issue #139). Symmetric to keyframe adoption -- collect the orphaned clips by shot name and advance
  // to finish, so an own-gpu render whose GPU work completed does not loud-fail with its clips intact.
  // NO !clips_recovered guard (issue #143): clips finish + go stale at DIFFERENT times, so this must
  // RE-FIRE every stalled sweep to pick up shots whose clips land after an earlier partial pass;
  // recoverStalledClipsPhase only advances (and sets clips_recovered) once the whole job is complete.
  if (job.phase === "clips" && age >= KEYFRAME_STALL_SECONDS) {
    if (await recoverStalledClipsPhase(env, job)) return true;
  }

  // Absolute ceiling: a still-pollable phase this old is genuinely wedged with nothing in R2 to adopt
  // (keyframe/clips adoption above already rescued any phase whose artifacts landed; a finish phase has
  // no adoption yet; or the GPU truly produced nothing). Fail loudly rather than hang.
  if (age >= PHASE_HARD_DEADLINE_SECONDS) {
    const stuckPhase = job.phase;
    job.phase = "failed";
    job.error = `render stalled in phase "${stuckPhase}" for ${Math.floor(age / 60)}min with no progress; failing so it does not hang (resubmit to retry) (#129)`;
    return true;
  }
  return false;
}

/** Advance a film job across its two phases. Returns the job + the underlying clip job (for the
 *  summary), or null if no such film job exists. */
export async function advanceFilmJob(env: Env, filmId: string): Promise<{ job: FilmJob; clipJob: ClipJob | null } | null> {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as FilmJob;
  if (job.cancelled) return { job, clipJob: null };
  const envRec = env as unknown as Record<string, unknown>;
  const entryPhase = job.phase;

  // Stall recovery (#129): a pollable phase whose module poll never resolves (RunPod GC'd the finished
  // job) would otherwise hang IN_PROGRESS forever. Run BEFORE the phase legs so an adopted keyframe
  // phase advances to clips and the clips leg below drives it in the same tick. A persist happens at the
  // end via the phase-transition stamp; the helper only mutates the in-memory job.
  await recoverStalledPhase(env, job);

  // Phase 1: poll the keyframe job; on completion, presign + hand off to the clip orchestrator.
  if (job.phase === "keyframe" && job.keyframe_poll) {
    const fetcher = job.keyframe_binding ? asFetcher(envRec[job.keyframe_binding]) : null;
    if (!fetcher) { job.phase = "failed"; job.error = "keyframe module no longer bound"; }
    else {
      const p = await pollModule<KeyframeOutput>(fetcher, { poll: job.keyframe_poll });
      if (!p.ok) { job.phase = "failed"; job.error = p.error; }
      else if (!(p as { pending?: boolean }).pending) {
        await afterKeyframeOutput(env, job, (p as { output: KeyframeOutput }).output);
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

  // Phase 5: mux the audio bed onto the silent film via video-finish (VPC remuxAudioOnly).
  if (job.phase === "mux") {
    await enterMuxPhase(env, job);
    await putFilm(env, job);
  }

  // On any phase transition this tick, stamp when the new phase began (the stall recovery measures
  // against it) and persist. The phase legs above already persisted on the paths they took; this also
  // covers a recovery that failed the job at the ceiling (no leg ran after it), so that verdict lands
  // in R2. putFilm is an idempotent re-PUT, so the belt-and-suspenders double write is harmless.
  if (job.phase !== entryPhase) {
    job.phase_started_at = Date.now();
    await putFilm(env, job);
  }

  return { job, clipJob };
}
