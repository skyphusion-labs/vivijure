// Film orchestrator: the keyframe -> clip handoff. The connective tissue that turns a storyboard
// into moving clips by sequencing two async stages ACROSS REQUESTS, on the same R2-job-doc +
// caller-poll pattern the clip orchestrator uses (a Durable Object is the later upgrade for both):
//   phase "keyframe": run the keyframe module (project preview) -> keyframe keys (out-of-request).
//   phase "clips":    presign each keyframe key -> keyframe_url, feed {shot_id, keyframe_url, prompt,
//                     seconds} into the clip orchestrator (motion.backend, out-of-request).
// POST /api/render/film starts it; GET /api/render/film/:id advances it; the caller polls to `done`.
// No Worker ever holds a multi-minute GPU/cloud render.

import type { Env } from "./env";
import { discoverModules, invokeModule, pollModule, cancelModule, servingForHook, validateConfig, dispatchChain } from "./modules/registry";
import { loadInstallConfig } from "./operator-config";
import type { KeyframeInput, KeyframeOutput, FinishInput, FinishOutput, ConfigSchema, NotifyInput, NotifyOutput, DialogueLine, DialogueInput, DialogueOutput, SpeechInput, SpeechOutput, MasterInput, MasterOutput, FilmFinishInput, FilmFinishOutput } from "./modules/types";
import {
  startClipJob, advanceClipJob, summarizeJob, clipFileMatchesShot, finishedClipFileMatchesShot, listClipsByShotId, reclaimClipsFromR2,
  type ClipShotInput, type ClipJob, type JobSummary,
} from "./render-orchestrator";
import { presignR2Get, presignR2Put } from "./r2-presign";
import { readShotDurationsFromBundle } from "./bundle-assembler";
import { buildCaptionCues } from "./captions";
import { resolveStagedAudioKey } from "./audio-stage";
import { coerceShotId } from "./storyboard-validate";
import { getCastById, markLoraReady } from "./cast-db";
import { withD1Retry } from "./d1-retry";
import { deriveLoraDestKey } from "./lora-bundle";

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
  // Transient-retry counter for the CURRENT chain step (reset when the step advances). A transient
  // invocation blip (the module worker momentarily unreachable / 5xx -- the musetalk cold-start race
  // that silenced shot_02) re-dispatches the step up to FINISH_STEP_MAX_ATTEMPTS instead of going
  // failed; a deterministic reject or the cap exhausted fails loud. Mirrors scatter assemble_attempts.
  attempts?: number;
}

/** One shot's dialogue audio moving through the `speech` chain (post-dialogue, pre-finish). `chain` is
 *  the speech module bindings in ui.order; `idx` walks them, each consuming the previous module's
 *  enhanced audio. `configs` is the validated config per step (parallel to `chain`). Mirrors FinishShot,
 *  but threads AUDIO (audio_key) instead of the video clip. A speech step is a POLISH step: a hard
 *  failure DEGRADES the shot (keeps its current audio) rather than failing the render. */
export interface SpeechShot {
  shot_id: string;
  audio_key: string;   // current dialogue-audio key (updated as each speech module completes)
  chain: string[];     // speech module env-binding names, in ui.order
  configs?: Record<string, unknown>[];
  idx: number;
  status: "pending" | "done" | "failed";
  poll?: string;
  applied: string[];
  degraded?: string;   // last soft-degrade reason on this shot (honest, never a fake applied tag)
  error?: string;
  attempts?: number;   // transient-retry counter for the current step (reset on advance)
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
  speech_config?: Record<string, Record<string, unknown>>; // per speech module (keyed by module name), validated at enterSpeechOrFinish
  film_finish_config?: Record<string, Record<string, unknown>>; // per film.finish module (by name), validated in applyFilmFinish
  master_config?: Record<string, Record<string, unknown>>; // per master module (by name), validated at enterMasterOrMux
  keyframe_binding: string | null;
  phase: "keyframe" | "clips" | "dialogue" | "speech" | "finish" | "assemble" | "master" | "mux" | "done" | "failed";
  keyframe_poll?: string;
  // The keyframe module's backend RunPod job id (#318), surfaced on its async-accept envelope. Lets
  // the poll handler read that job's progress snapshot (counts.keyframe_done) for keyframe sub-progress.
  keyframe_job_id?: string;
  clip_job_id?: string;
  finish_shots?: FinishShot[];
  speech_shots?: SpeechShot[]; // per-shot speech (dialogue-audio enhance) chain, run between dialogue and finish
  // Talking characters: per-shot dialogue lines (resolved at submission: authored text + cast voice),
  // synthesized to per-shot audio by the `dialogue` module in a phase between clips and finish. The
  // resulting audio_key per shot is injected into that shot's FinishInput for lip-sync. Absent/empty
  // => a silent film (no dialogue phase). dialogue_poll holds the in-flight batch job's poll token.
  dialogue_lines?: DialogueLine[];
  dialogue_poll?: string;
  dialogue_audio?: Record<string, string>; // shot_id -> dialogue audio R2 key
  // slot -> cast_member id (from the render's castLoras). At keyframe completion the orchestrator
  // banks any freshly-trained adapter back onto the cast member (markLoraReady) so a character's LoRA
  // is trained ONCE and reused across every project -- instead of retrained every render. (#xxx)
  cast_loras?: Record<string, number>;
  film_key?: string; // R2 key of the assembled film (mp4), set when phase reaches "done"
  silent_film_key?: string; // silent concat output before optional audio mux
  audio_key?: string; // staged R2_RENDERS audio bed to mux after assemble (the `master` chain polishes
                      // THIS key in place: each master step rewrites it to the mastered bed before mux)
  // Film-level audio mastering (the `master` chain): polish the assembled film's audio BED -- music
  // upscale (soxr) + LUFS loudness -- AFTER the mix is built (assemble) and BEFORE the final mux. Set
  // only when there IS an audio_key AND a master module is installed; absent => the bed is muxed as-is.
  // FAIL-SAFE, like film.finish: a step that fails / degrades passes the CURRENT bed through (records a
  // reason in `degraded`), never failing the render -- a polish miss must never drop a fully-rendered
  // film (the #249 / #77 discipline). `chain` is the master module bindings in ui.order; `idx` walks
  // them; `poll` holds the in-flight step's token; `attempts` is its bounded transient-retry counter.
  master?: {
    chain: string[];     // master module env-binding names, in ui.order
    idx: number;         // current chain step
    poll?: string;       // in-flight step poll token
    attempts?: number;   // transient-retry counter for the CURRENT step (reset when the step advances)
    applied: string[];   // accumulated applied tags across the chain (e.g. ["music-upscale:soxr48k"])
    degraded: string[];  // per-step soft-degrade reasons ("<binding>: <reason>"); a passthrough is never silent
    configs?: Record<string, unknown>[]; // per-step clamped planner config, aligned to `chain` order (enterMasterOrMux)
  };
  // Opening title + end-credit text for the film.finish chain (title / credit cards). Absent -> no
  // cards; the film.finish module passes the film through unchanged. (#190)
  film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  // Observable outcome of the film.finish chain (title / credit cards). The chain is FAIL-SAFE -- the
  // assembled film always survives -- so a degraded run (e.g. the video-finish container unreachable)
  // still reaches phase="done", just WITHOUT cards. Recording the outcome makes that observable instead
  // of a silent green: which modules ran, any chain errors, the per-step detail, and a `degraded` reason
  // set when cards were requested but could not be applied. (#207 follow-up)
  film_finish?: {
    applied: string[];   // module names whose invoke returned ok (ChainResult.applied)
    errors: string[];    // chain-level errors: a skipped (unbound) or failed (ok:false) module
    steps?: string[];    // last output detail: ["film-titles"] applied, or ["passthrough:..."]/["noop:no-cards"] degraded
    degraded?: string;   // set when the film was passed through UNCARDED; the reason (cards NOT applied)
  };
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
  // Wall-clock of the last REAL per-shot progress (#136): re-stamped by advanceFilmJob when the
  // current phase's done-count advances (a clip/finish/speech shot completed) OR on a phase
  // transition. The UI stall signal measures against THIS, not phase_started_at, so a healthy
  // multi-shot clips/finish phase (10 i2v shots at ~3min each = 30+min in ONE phase) no longer
  // false-trips "stalled". The driver's recovery still measures from phase_started_at (unchanged).
  last_progress_at?: number;
  // The progress fingerprint last seen ("<phase>:<doneCount>"); any change is genuine forward progress.
  progress_marker?: string;
  error?: string;
  created_at: number;
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
    // Finish WAS set up for this job: the assembled clips are the FINISHED ones only. Never substitute
    // a raw i2v clip for a finish shot that did not reach "done" -- that silent-degrade (#245/#246)
    // shipped unfinished clips marked done with applied=[] (wan: RIFE crashed at idx 0 -> the shot
    // "failed" -> the job fell through to the raw _wan clip). A failed finish fails the render in
    // advanceFinishPhase; this is the defense-in-depth so assemble can never ship a raw clip.
    for (const fs of job.finish_shots) {
      if (fs.status === "done" && fs.clip_key) out.set(fs.shot_id, fs.clip_key);
    }
    return out;
  }
  // No finish modules installed (finish_shots empty) -> assemble the raw i2v clips (the clips_only path).
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
  // Outcome of the film.finish chain (title / credit cards). Surfaced so the API/frontend can show
  // honest degrade state -- a film that reached "done" but shipped WITHOUT cards (e.g. the video-finish
  // container was unreachable) has film_finish.degraded set. Absent until film.finish runs. (#211 follow-up)
  film_finish?: FilmJob["film_finish"];
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
    film_finish: job.film_finish,
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

/** Bank any freshly-trained cast LoRA so a character is trained ONCE and reused across every project,
 *  instead of retrained on every render. THE long-standing bug: inline-trained adapters were saved to
 *  R2 but never written back to cast_members, so resolveCastLoras never saw them `ready` and the
 *  backend retrained the same LoRA every render (a silent ~20-min tax). For each slot the keyframe
 *  module reports under trained_loras, map slot -> cast id via job.cast_loras, copy the render-scoped
 *  adapter to a character-stable key (survives project deletion), and mark the cast member ready.
 *  Reused slots (backend reports the already-banked key) and unmapped slots are no-ops; a versioned
 *  stable key keyed on job.created_at makes a retry idempotent. Best-effort but LOUD on failure
 *  (unlike the silent state-tar restore it replaces). Keyed on cast id (PK) only. */
async function recordTrainedLorasToCast(env: Env, job: FilmJob, kfOut: KeyframeOutput): Promise<void> {
  const trained = kfOut.trained_loras;
  const castIds = job.cast_loras;
  if (!trained || !castIds) return;
  for (const [slot, srcKey] of Object.entries(trained)) {
    const castId = castIds[slot];
    if (!Number.isInteger(castId) || castId <= 0 || typeof srcKey !== "string" || !srcKey) continue;
    const stableKey = deriveLoraDestKey(castId, job.created_at);
    try {
      // Advance hot path: a transient D1 blip here would needlessly skip banking a freshly-trained
      // adapter (-> a wasteful retrain next render), so retry the cast read + readiness write.
      const cast = await withD1Retry(() => getCastById(env, castId));
      if (!cast) continue;
      // Reused this render (srcKey == current key) or already banked this render (retry): no-op.
      if (cast.lora_status === "ready" && (cast.lora_key === srcKey || cast.lora_key === stableKey)) continue;
      const obj = await env.R2_RENDERS.get(srcKey);
      if (!obj) { console.warn(`recordTrainedLoras: adapter missing in R2 (${srcKey}); cast ${castId} not banked`); continue; }
      await env.R2_RENDERS.put(stableKey, obj.body);
      await withD1Retry(() => markLoraReady(env, castId, stableKey));
      console.log(`recordTrainedLoras: cast ${castId} slot ${slot} banked ${srcKey} -> ${stableKey} (cross-project reuse)`);
    } catch (e) {
      console.warn(`recordTrainedLoras: cast ${castId} slot ${slot} failed: ${(e as Error).message}`);
    }
  }
}

/** Internal: after keyframes, either stop (preview) or hand off to the clip orchestrator. */
async function afterKeyframeOutput(env: Env, job: FilmJob, kfOut: KeyframeOutput): Promise<void> {
  // Bank trained adapters before anything else, so a character LoRA is recorded even for a
  // keyframes-only preview / regen (which is exactly where the perpetual retrain hurt most).
  await recordTrainedLorasToCast(env, job, kfOut);
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
  fs.attempts = 0; // a step succeeded -> the next step gets a fresh transient-retry budget
  if (fs.idx >= fs.chain.length) fs.status = "done"; // else stays pending; next advance submits chain[idx]
}

/** Pure: fold one speech module's output into the shot. On a REAL enhancement (no `degraded`), thread the
 *  new audio_key forward so the next step (and finish) sees the cleaned audio; on an honest soft-degrade,
 *  LEAVE audio_key UNCHANGED (the original audio survives) and record the reason -- no fake applied tag,
 *  the chain never fails on a polish miss. Advance idx; done when the chain is exhausted. */
export function applySpeechOutput(ss: SpeechShot, out: SpeechOutput): void {
  if (!out.degraded) ss.audio_key = out.audio_key; // real enhance threads forward; a degrade keeps the original
  ss.applied.push(...(out.applied || []));
  if (out.degraded) ss.degraded = out.degraded;
  ss.idx += 1;
  ss.poll = undefined;
  ss.attempts = 0;
  if (ss.idx >= ss.chain.length) ss.status = "done";
}

// Bounded transient-retry for a finish-step invocation/poll failure. shot_02 shipped silent because
// its lip-sync invocation hit a transient blip (the module worker momentarily unreachable / 5xx --
// a musetalk cold-start race) and went straight to `failed`, where the mid-chain intermediate was
// then adopted. Now a TRANSIENT failure re-dispatches the step (status stays `pending`) up to the
// cap; a DETERMINISTIC reject (a 4xx, a real module error, "job failed", "no clip_key") or the cap
// exhausted goes `failed` -- loud, no spin. Same classify-then-retry discipline as the D1 / assemble
// transport retries.
export const FINISH_STEP_MAX_ATTEMPTS = 3;

/** Classify an invokeModule / pollModule failure string. Transport shapes are transient:
 *  "module /invoke -> 503", "module /poll -> 504", "module unreachable: <timeout/network>". A module-
 *  logic ok:false (input reject, "job failed", "no clip_key") or a 4xx is deterministic -> fail. */
export function classifyFinishFailure(error: string | undefined): "transient" | "deterministic" {
  const e = error ?? "";
  const m = e.match(/->\s*(\d{3})\b/); // the "module /invoke -> NNN" / "/poll -> NNN" transport status
  if (m) {
    const s = Number(m[1]);
    return s === 408 || s === 429 || (s >= 500 && s <= 599) ? "transient" : "deterministic";
  }
  if (/unreachable|timed? ?out|timeout|network|econnreset|connection (reset|lost)|fetch failed/i.test(e)) {
    return "transient";
  }
  return "deterministic"; // a module-logic ok:false -> a real reject, fail loud
}

/** Decide whether to re-dispatch a failed finish step or fail it. Pure so the retry contract is
 *  unit-testable without a module fetcher. */
export function classifyFinishRetry(
  error: string | undefined,
  priorAttempts: number,
  maxAttempts: number = FINISH_STEP_MAX_ATTEMPTS,
): { action: "retry"; attempts: number } | { action: "fail" } {
  if (classifyFinishFailure(error) !== "transient") return { action: "fail" };
  const attempts = (priorAttempts ?? 0) + 1;
  return attempts < maxAttempts ? { action: "retry", attempts } : { action: "fail" };
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

/** Pure: is this finish shot eligible to be adopted from its R2 artifact? R2 PRESENCE IS AUTHORITATIVE
 *  -- if <shot>_finished.mp4 is in R2 the work is done regardless of what the RunPod job envelope says.
 *  Two cases are adoptable:
 *    - `failed`: a module fast-failed a shot whose finished clip is actually in R2 (the GC'd-job path, #141).
 *    - `pending` on its LAST chain module with a submitted poll token: a finish job whose RunPod envelope
 *      froze at IN_PROGRESS (worker recycled, /status never flips to COMPLETED) so the poll reports
 *      pending forever -- but the finish output already landed in R2. Without this the shot pends to the
 *      90min hard-deadline and FALSE-FAILS a complete render (surfaced by RUN #29; sibling of #141/#142).
 *  A `pending` shot mid-chain (idx < last) is NOT adopted: its R2 key would be an intermediate module's
 *  output, not the chain's final artifact, so the remaining modules must still run. */
export function finishShotAdoptableFromR2(fs: FinishShot): boolean {
  // Adopt an R2 clip ONLY when it is the chain's FINAL artifact (idx === last). A mid-chain shot's
  // R2 key is an INTERMEDIATE module's output, so adopting it skips the remaining finish modules
  // (e.g. lip-sync) and ships a half-finished, silent clip. This guard protected the `pending` branch
  // but the `failed` branch lacked it, so a mid-chain module failure adopted the intermediate as
  // "done" -- the silent showcase render (lip-sync failed at idx 1 of 4 -> the RIFE intermediate was
  // adopted). The failed branch is the #141 GC'd-job path: a fast-failed shot whose FINAL clip is in R2.
  if (fs.idx !== fs.chain.length - 1) return false;
  if (fs.status === "failed") return true;
  return fs.status === "pending" && !!fs.poll;
}

/** Pure: adopt every adoptable finish shot whose finished clip is present in R2 (the artifact overrides
 *  the module's verdict / a stuck envelope). Mutates `finishShots`, returns the number adopted. Mirrors
 *  reclaimClipsFromR2 on the clips leg so the two phases recover symmetrically. */
export function reclaimFinishShotsFromR2(finishShots: FinishShot[], present: Map<string, string>): number {
  let adopted = 0;
  for (const fs of finishShots) {
    if (finishShotAdoptableFromR2(fs) && present.has(fs.shot_id)) {
      fs.clip_key = present.get(fs.shot_id) as string;
      fs.status = "done";
      fs.poll = undefined;
      fs.error = undefined; // the finished artifact in R2 is the source of truth
      adopted += 1;
    }
  }
  return adopted;
}

/** Pure: the R2 key the CURRENT finish step (fs.chain[fs.idx]) is expected to write, given its input
 *  clip (fs.clip_key). Mirrors each finish module's OWN output-key convention so the orchestrator can
 *  check R2 PRESENCE for a step whose RunPod job was GC'd / froze MID-chain (the #141/#166 R2-authoritative
 *  pattern, extended from the final step to any step). The modules: finish-rife writes
 *  `<project>/clips/<shot>_finished.mp4` (named off the shot id by its container); the append-convention
 *  modules derive `<input-base>_<suffix>.<ext>` from the input clip key (musetalk lip-sync -> `_ls`,
 *  upscale -> `_up`; see vivijure-musetalk / vivijure-upscale handler.py). Returns null for a module whose
 *  convention we do not model (e.g. text-overlay), so an unmodeled step gets NO R2 shortcut and can never
 *  be advanced off a sibling step's artifact -- the mid-chain phantom-adopt the silent-render bug warned of. */
export function finishStepOutputKey(project: string, fs: FinishShot): string | null {
  const binding = fs.chain[fs.idx] ?? "";
  if (/RIFE/i.test(binding)) return `renders/${project}/clips/${fs.shot_id}_finished.mp4`;
  const suffix = /LIPSYNC|MUSETALK/i.test(binding) ? "_ls" : /UPSCALE/i.test(binding) ? "_up" : null;
  if (!suffix) return null;
  const key = fs.clip_key;
  const slash = key.lastIndexOf("/");
  const dotInBase = key.slice(slash + 1).lastIndexOf(".");
  if (dotInBase < 0) return `${key}${suffix}`;
  const at = slash + 1 + dotInBase;
  return `${key.slice(0, at)}${suffix}${key.slice(at)}`; // insert the suffix before the extension
}

/** Pure: the `applied` tag the CURRENT finish step would report, reconstructed from its validated config
 *  so an R2-adopted step (whose job is gone, so its real response is lost) still carries the marker the
 *  verifier and UI read (e.g. `lipsync:v15`, `upscale:2x`, `interpolate:2x`). Mirrors each module's own
 *  `applied` string. Unmodeled modules get a `<binding>:r2-adopted` marker so the adoption is never silent. */
export function finishStepAppliedTag(fs: FinishShot): string {
  const binding = fs.chain[fs.idx] ?? "";
  const cfg = (fs.configs?.[fs.idx] ?? {}) as Record<string, unknown>;
  if (/LIPSYNC|MUSETALK/i.test(binding)) return `lipsync:${String(cfg.version ?? "v15")}`;
  if (/UPSCALE/i.test(binding)) return `upscale:${Number(cfg.scale ?? 2)}x`;
  if (/RIFE/i.test(binding)) return cfg.interpolate === false ? "noop:interpolate-off" : `interpolate:${Number(cfg.interpolation_factor ?? 2)}x`;
  return `${binding}:r2-adopted`;
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
  // finish_shots are built; interpose the dialogue phase (synthesize per-shot speech) before finish so
  // a lip-sync finish module has the audio to drive the mouth. No dialogue -> straight to finish.
  await enterDialogueOrFinish(env, job);
}

/** Fold a dialogue module's batch result into the per-shot audio map the finish stage reads. */
function applyDialogueOutput(job: FilmJob, out: DialogueOutput): void {
  const map: Record<string, string> = {};
  for (const a of out?.audio || []) {
    if (a && typeof a.shot_id === "string" && typeof a.audio_key === "string") map[a.shot_id] = a.audio_key;
  }
  job.dialogue_audio = map;
}

/** After finish_shots are built: if the film has dialogue lines AND a `dialogue` module is installed,
 *  submit the per-shot speech batch and enter the dialogue phase; otherwise go straight to finish. A
 *  submit failure (or no module) soft-degrades to a SILENT finish -- a dialogue glitch must never fail
 *  a fully-rendered film (lip-sync no-ops without an audio_key). */
async function enterDialogueOrFinish(env: Env, job: FilmJob): Promise<void> {
  const lines = job.dialogue_lines;
  if (!lines || !lines.length) { await enterSpeechOrFinish(env, job); return; }
  const envRec = env as unknown as Record<string, unknown>;
  const dialogueModule = servingForHook(await discoverModules(envRec), "dialogue")[0];
  const fetcher = dialogueModule ? asFetcher(envRec[dialogueModule.binding]) : null;
  if (!fetcher) { await enterSpeechOrFinish(env, job); return; }  // no dialogue module bound: silent film
  const req = {
    hook: "dialogue" as const,
    input: { project: job.project, lines } as DialogueInput,
    config: {},
    context: { project: job.project, job_id: job.film_id },
  };
  const r = await invokeModule<DialogueInput, DialogueOutput>(fetcher, req);
  if (!r.ok) { console.warn(`film ${job.film_id}: dialogue submit failed (${r.error}); silent finish`); await enterSpeechOrFinish(env, job); return; }
  if ((r as { pending?: boolean }).pending) { job.dialogue_poll = (r as { poll: string }).poll; job.phase = "dialogue"; return; }
  if ("output" in r) { applyDialogueOutput(job, r.output as DialogueOutput); }
  await enterSpeechOrFinish(env, job);
}

/** Poll the in-flight dialogue batch. On done, record the per-shot audio map and advance to finish; a
 *  failure soft-degrades to a silent finish (the rendered clips are fine, just unvoiced). */
async function advanceDialoguePhase(env: Env, job: FilmJob): Promise<void> {
  if (!job.dialogue_poll) { await enterSpeechOrFinish(env, job); return; }
  const envRec = env as unknown as Record<string, unknown>;
  const dialogueModule = servingForHook(await discoverModules(envRec), "dialogue")[0];
  const fetcher = dialogueModule ? asFetcher(envRec[dialogueModule.binding]) : null;
  if (!fetcher) { job.dialogue_poll = undefined; await enterSpeechOrFinish(env, job); return; }
  const p = await pollModule<DialogueOutput>(fetcher, { poll: job.dialogue_poll });
  if (!p.ok) { console.warn(`film ${job.film_id}: dialogue failed (${p.error}); silent finish`); job.dialogue_poll = undefined; await enterSpeechOrFinish(env, job); return; }
  if ((p as { pending?: boolean }).pending) return;  // still synthesizing
  applyDialogueOutput(job, (p as { output: DialogueOutput }).output);
  job.dialogue_poll = undefined;
  await enterSpeechOrFinish(env, job);
}

/** After dialogue is resolved: if any `speech` module is installed AND there is dialogue audio to clean,
 *  build the per-shot speech chain and enter the speech phase; otherwise go straight to finish. No speech
 *  module, or no shot with dialogue audio -> straight to finish (an unvoiced film needs no speech pass). */
async function enterSpeechOrFinish(env: Env, job: FilmJob): Promise<void> {
  const audio = job.dialogue_audio ?? {};
  const shotIds = Object.keys(audio);
  if (!shotIds.length) { job.phase = "finish"; return; }  // unvoiced film: nothing to enhance
  const serving = servingForHook(await discoverModules(env as unknown as Record<string, unknown>), "speech"); // ui.order
  const chain = serving.map((m) => m.binding);
  if (!chain.length) { job.phase = "finish"; return; }  // no speech modules installed: passthrough to finish
  const configs = resolveFinishConfigs(serving, job.speech_config ?? {});
  job.speech_shots = shotIds.map((shot_id) => ({
    shot_id, audio_key: audio[shot_id], chain, configs, idx: 0, status: "pending" as const, applied: [],
  }));
  job.phase = "speech";
}

/** Advance the speech chain: per shot, submit its current speech module or poll the in-flight one,
 *  chaining the enhanced audio forward on completion. A transient invocation/poll blip re-dispatches the
 *  step up to the cap (classifyFinishRetry, shared with finish); a DETERMINISTIC failure does NOT fail the
 *  render -- speech is a POLISH step, so a hard step failure DEGRADES the shot (keep its current audio,
 *  record the reason, mark the chain done) rather than failing a fully-rendered film (#249/#77). When
 *  every shot is terminal, fold the cleaned (or, on a degrade, original) audio back into job.dialogue_audio
 *  -- so a lip-sync finish module drives the mouth from it -- and advance to finish. */
async function advanceSpeechPhase(env: Env, job: FilmJob): Promise<void> {
  const envRec = env as unknown as Record<string, unknown>;
  const degrade = (ss: SpeechShot, reason: string): void => {
    // A hard failure on a POLISH step: keep the current audio (original survives), record the reason
    // honestly (no fake applied tag), advance idx so the chain completes. The render never fails here.
    ss.degraded = reason;
    ss.idx += 1; ss.poll = undefined; ss.attempts = 0;
    if (ss.idx >= ss.chain.length) ss.status = "done";
  };
  const blipOrDegrade = (ss: SpeechShot, error: string | undefined, keepPoll: boolean): void => {
    const d = classifyFinishRetry(error, ss.attempts ?? 0); // reuse the shared transient classifier
    if (d.action === "retry") {
      ss.attempts = d.attempts;
      ss.error = `speech ${ss.chain[ss.idx]} transient (attempt ${d.attempts}/${FINISH_STEP_MAX_ATTEMPTS}), retrying: ${error ?? ""}`;
      if (!keepPoll) ss.poll = undefined;
    } else {
      degrade(ss, `${ss.chain[ss.idx]}: ${error ?? "speech step failed"}`);
    }
  };
  for (const ss of job.speech_shots || []) {
    if (ss.status !== "pending") continue;
    const fetcher = asFetcher(envRec[ss.chain[ss.idx]]);
    if (!fetcher) { degrade(ss, `speech module ${ss.chain[ss.idx]} not bound`); continue; }
    const req = {
      hook: "speech" as const,
      input: { shot_id: ss.shot_id, audio_key: ss.audio_key } as SpeechInput,
      config: ss.configs?.[ss.idx] ?? {},
      context: { project: job.project, job_id: job.film_id },
    };
    if (!ss.poll) {
      const r = await invokeModule<SpeechInput, SpeechOutput>(fetcher, req);
      if (!r.ok) { blipOrDegrade(ss, r.error, false); }
      else if ((r as { pending?: boolean }).pending) { ss.poll = (r as { poll: string }).poll; }
      else if ("output" in r) { applySpeechOutput(ss, r.output as SpeechOutput); }
      else { degrade(ss, "speech module returned neither output nor a poll token"); }
    } else {
      const p = await pollModule<SpeechOutput>(fetcher, { poll: ss.poll });
      if (p.ok && !(p as { pending?: boolean }).pending) {
        applySpeechOutput(ss, (p as { output: SpeechOutput }).output);
      } else if (!p.ok && classifyFinishFailure(p.error) === "transient") {
        blipOrDegrade(ss, p.error, true);
      } else if (!p.ok) {
        blipOrDegrade(ss, p.error, false);
      }
      // else: still pending -> leave it for the next tick
    }
  }
  const speechShots = job.speech_shots || [];
  if (speechShots.every((ss) => ss.status !== "pending")) {
    // Fold the cleaned (or, on a degrade, original) audio back into dialogue_audio so a lip-sync finish
    // module drives the mouth from it. This is the single point folding speech results into film state.
    for (const ss of speechShots) (job.dialogue_audio ??= {})[ss.shot_id] = ss.audio_key;
    job.phase = "finish";
  }
}

/** R2-authoritative recovery for a finish step whose RunPod job is GONE (poll 404s, GC'd-after-complete)
 *  or FROZEN (envelope stuck IN_PROGRESS so /poll pends forever, #166) MID-chain: if THIS step's expected
 *  output (finishStepOutputKey) is already in R2, fold it in and advance idx so the next module dispatches
 *  -- instead of pending to the hard-deadline. Distinct from finishShotAdoptableFromR2, which adopts only
 *  the chain's FINAL artifact: this advances ONE step on its OWN predicted output, so the remaining modules
 *  still run and it can never ship a half-finished clip (the mid-chain phantom-adopt the silent-render bug
 *  warned against). Returns true iff it advanced the step. */
async function adoptFinishStepFromR2(env: Env, job: FilmJob, fs: FinishShot): Promise<boolean> {
  const expected = finishStepOutputKey(job.project, fs);
  if (!expected) return false;
  if ((await env.R2_RENDERS.head(expected)) === null) return false;
  applyFinishOutput(fs, { shot_id: fs.shot_id, clip_key: expected, out_fps: 0, frames: 0, applied: [finishStepAppliedTag(fs)] });
  return true;
}

/** Advance the finish chain: per shot, submit its current finish module or poll the in-flight one,
 *  chaining to the next module on completion. Phase -> assemble when every shot is terminal. */
async function advanceFinishPhase(env: Env, job: FilmJob): Promise<void> {
  const envRec = env as unknown as Record<string, unknown>;
  // A transient invocation/poll blip re-dispatches the step (status stays `pending`) up to the cap
  // instead of failing it; a deterministic reject or the cap exhausted fails loud. `keepPoll` keeps a
  // poll token to re-poll (a lost poll) vs clearing it to re-submit (a failed invoke).
  const failOrRetry = (fs: FinishShot, error: string | undefined, keepPoll: boolean): void => {
    const d = classifyFinishRetry(error, fs.attempts ?? 0);
    if (d.action === "retry") {
      fs.attempts = d.attempts;
      fs.error = `finish ${fs.chain[fs.idx]} transient (attempt ${d.attempts}/${FINISH_STEP_MAX_ATTEMPTS}), retrying: ${error ?? ""}`;
      if (!keepPoll) fs.poll = undefined; // re-submit next tick; status stays "pending"
    } else {
      fs.status = "failed";
      fs.error = error;
    }
  };
  for (const fs of job.finish_shots || []) {
    if (fs.status !== "pending") continue;
    const fetcher = asFetcher(envRec[fs.chain[fs.idx]]);
    if (!fetcher) { fs.status = "failed"; fs.error = `finish module ${fs.chain[fs.idx]} not bound`; continue; }
    const req = {
      hook: "finish" as const,
      input: { shot_id: fs.shot_id, clip_key: fs.clip_key, audio_key: job.dialogue_audio?.[fs.shot_id] } as FinishInput,
      config: fs.configs?.[fs.idx] ?? {}, // validated per-module config (issue #75); {} only for legacy jobs
      context: { project: job.project, job_id: job.film_id },
    };
    if (!fs.poll) {
      const r = await invokeModule<FinishInput, FinishOutput>(fetcher, req);
      if (!r.ok) { failOrRetry(fs, r.error, false); }
      else if ((r as { pending?: boolean }).pending) { fs.poll = (r as { poll: string }).poll; }
      else if ("output" in r) { applyFinishOutput(fs, r.output as FinishOutput); }
      else { fs.status = "failed"; fs.error = "finish module returned neither output nor a poll token"; }
    } else {
      const p = await pollModule<FinishOutput>(fetcher, { poll: fs.poll });
      if (p.ok && !(p as { pending?: boolean }).pending) {
        applyFinishOutput(fs, (p as { output: FinishOutput }).output);
      } else if (!p.ok && classifyFinishFailure(p.error) === "transient") {
        failOrRetry(fs, p.error, true); // a transport blip: re-poll the same job under the cap
      } else if (!(await adoptFinishStepFromR2(env, job, fs))) {
        // The step's RunPod job is GONE (a deterministic poll failure -- 404 job-not-found, the
        // GC'd-after-complete path) or FROZEN (envelope stuck IN_PROGRESS so /poll pends forever, #166),
        // and this step's output is NOT in R2. A deterministic failure with no artifact fails loud; a
        // still-pending poll with no artifact stays pending (the job may yet finish, or its output land).
        // The whole point: a mid-chain finish step can no longer pend forever when its output is in R2 --
        // the wedge that stalled the showcase (RIFE done, idx never advanced, lip-sync never dispatched).
        if (!p.ok) failOrRetry(fs, p.error, true);
      }
      // else: adoptFinishStepFromR2 folded this step's R2 output in and advanced idx (R2 authoritative).
    }
  }
  // R2 PRESENCE IS AUTHORITATIVE (issue #141), symmetric to the clips reclaim: the finish output may
  // already be in R2 at renders/<project>/clips/<shot>_finished.mp4 even though the module verdict says
  // otherwise -- a shot it fast-failed on a GC'd job (#141), OR a last-chain shot stuck `pending` because
  // the RunPod envelope froze at IN_PROGRESS and the poll never sees COMPLETED (RUN #29). Reclaim any
  // adoptable shot whose finished clip is present BEFORE the every-terminal judgment, so the finish phase
  // never advances dropping a shot -- and never false-fails at the hard-deadline -- with the clip in R2.
  // Only one R2 list, only when there is an adoptable shot to reclaim (the all-done happy path pays nothing).
  const finishShots = job.finish_shots || [];
  if (finishShots.some(finishShotAdoptableFromR2)) {
    const present = await listClipsByShotId(env, job.project, finishShots.map((fs) => fs.shot_id), finishedClipFileMatchesShot);
    reclaimFinishShotsFromR2(finishShots, present);
  }
  if (finishShots.every((fs) => fs.status !== "pending")) {
    // Fail LOUD on a genuinely-failed finish step. After the bounded transient-retry (failOrRetry)
    // and the R2 reclaim above, a shot still "failed" has no path left and no finished artifact -- so
    // the render must NOT advance to done/assemble shipping the raw i2v clip with applied=[]. That
    // silent-degrade (#245/#246) shipped green-but-unfinished films (wan: RIFE crashed at idx 0, the
    // shot "failed", the job went done with the raw clip, error:None). Surface the real error instead.
    const failed = finishShots.filter((fs) => fs.status === "failed");
    if (failed.length) {
      job.phase = "failed";
      job.error = `finish failed for ${failed.length} shot(s): ` +
        failed.map((fs) => `${fs.shot_id} at ${fs.chain[fs.idx] ?? "?"} (${fs.error ?? "no error"})`).join("; ");
      return;
    }
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
    keepClipAudio?: boolean;
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
      download_url,
    };
    const context = { project: job.project, job_id: job.film_id };
    for (const m of notifiers) {
      const fetcher = asFetcher(envRec[m.binding]);
      if (!fetcher) continue;
      try {
        // Inject the operator-set install-config (e.g. notify-email's notify_email recipient) as the
        // user config, then clamp through the contract; render-scope fields stay at their defaults.
        const installConfig = await loadInstallConfig(env, m.name, m.config_schema);
        await invokeModule<NotifyInput, NotifyOutput>(fetcher, {
          hook: "notify", input, config: validateConfig(m.config_schema ?? {}, installConfig), context,
        });
      } catch { /* best-effort per notifier -- a delivery failure never fails the render */ }
    }
  } catch (e) {
    console.warn(`notify chain failed for ${job.film_id}: ${(e as Error).message}`);
  }
}

/** Final transition: run the film.finish chain (title / credit cards) on the assembled+muxed film,
 *  then mark done + notify. FAIL-SAFE: no film.finish module, no title/credits, or ANY error -> the
 *  film keeps its original key. A film.finish step must never drop a fully-rendered film. (#190) */
async function transitionToDone(env: Env, job: FilmJob): Promise<void> {
  try {
    await applyFilmFinish(env, job);
  } catch (e) {
    // A swallowed throw must not ship as a silent green: record it on the job so the degraded outcome is
    // observable. The film keeps its original (uncarded) key -- a finish step never drops the film. (#190)
    const msg = (e as Error).message;
    job.film_finish = {
      applied: job.film_finish?.applied ?? [],
      errors: [...(job.film_finish?.errors ?? []), `film.finish threw: ${msg}`],
      steps: job.film_finish?.steps,
      degraded: job.film_finish?.degraded ?? `threw: ${msg}`,
    };
    console.warn(`film.finish failed for ${job.film_id}: ${msg}; keeping the original film`);
  }
  job.phase = "done";
  await fireNotify(env, job);
}

// The film.finish hook I/O is the named FilmFinishInput / FilmFinishOutput pair in ./modules/types
// (every hook has one). The core reads FilmFinishOutput back: the (maybe new) film key, the per-step
// detail (`applied`: the module name on success, or a "passthrough:..."/"noop:..." reason on a
// soft-degrade), and `degraded` -- set when the film was passed through UNCARDED (e.g. the video-finish
// container was unreachable). The chain is fail-safe, so `degraded` is the only signal that requested
// cards were not applied; applyFilmFinish records it on the job rather than dropping it.

/** Inputs for runFilmFinish -- job-shape-agnostic so BOTH the single-film path (advanceFilmJob) and the
 *  scatter gather can run the film.finish chain on an assembled+muxed film (#284/#285). */
export interface RunFilmFinishInput {
  film_key: string;
  scenes: FilmScene[];
  dialogue_lines?: DialogueLine[];
  film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  film_finish_config?: Record<string, Record<string, unknown>>;
  bundle_key: string;
  project: string;
  job_id: string;
}
export interface RunFilmFinishResult {
  ran: boolean;      // false when no film.finish module is installed (caller leaves its state untouched)
  film_key: string;  // carded film key, or the input key on no-op / passthrough
  applied: string[];
  errors: string[];
  steps?: string[];
  degraded?: string;
}

/** Run the film.finish chain (subtitle / title / credit cards) on an assembled+muxed film. Reused by the
 *  single-film path AND the scatter gather. Captions are FILM-LEVEL (buildCaptionCues computes each
 *  line's start from the cumulative duration of preceding shots), so the caller passes the FULL scenes +
 *  dialogue_lines in assembled (shot) order. FAIL-SAFE: a module soft-degrade / failure passes the film
 *  through (recorded in degraded), never drops it. */
export async function runFilmFinish(env: Env, input: RunFilmFinishInput): Promise<RunFilmFinishResult> {
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  if (servingForHook(modules, "film.finish").length === 0) {
    return { ran: false, film_key: input.film_key, applied: [], errors: [] }; // nothing installed -> no-op
  }
  const outKey = input.film_key.replace(/\.mp4$/i, "") + "-titled-" + crypto.randomUUID().slice(0, 8) + ".mp4";
  // A soft .srt sidecar for the subtitle module's sidecar / both modes (its own presigned PUT). Cheap
  // to presign whether or not a subtitle module is installed; ignored by film-titles.
  const sidecarKey = outKey.replace(/\.mp4$/i, "") + ".srt";
  const [videoUrl, outputUrl, sidecarUrl] = await Promise.all([
    presignR2Get(env, input.film_key, 1800),
    presignR2Put(env, outKey, 1800),
    presignR2Put(env, sidecarKey, 1800),
  ]);
  // Time-synced dialogue captions for the subtitle film.finish module: the cumulative per-shot
  // windows (real beat-trimmed durations from the bundle, authored seconds as fallback) carrying each
  // speaking shot's line. Empty when the film has no dialogue -> the subtitle module no-ops. Narration
  // is NOT captioned (a single film-level track with no per-line timing); see src/captions.ts.
  const durations = await readShotDurationsFromBundle(env, input.bundle_key);
  const captions = buildCaptionCues(input.scenes, input.dialogue_lines ?? [], durations);
  const seed: FilmFinishInput = {
    film_key: input.film_key,
    video_url: videoUrl,
    output_url: outputUrl,
    output_key: outKey,
    title: input.film_titles?.title,
    credits: input.film_titles?.credits,
    captions,
    sidecar_url: sidecarUrl,
    sidecar_key: sidecarKey,
  };
  // Multiple film.finish modules chain (e.g. subtitle ui.order=5 then film-titles ui.order=10), each
  // consuming the PRIOR step's output. The seed presigns the FIRST step (read original film, write
  // outKey); every subsequent step must read what the previous step WROTE, not the original, or it
  // overwrites the prior step's work (#14: titles re-read the original and dropped the captions). So
  // nextInput presigns a FRESH GET (of the prior step's film_key) + PUT (to a new key) per step.
  const result = await dispatchChain<FilmFinishInput, FilmFinishOutput>(
    envRec,
    modules,
    "film.finish",
    seed,
    { project: input.project, job_id: input.job_id },
    {
      nextInput: async (prev) => {
        const prevKey = prev?.film_key ?? input.film_key;
        const stepOutKey = input.film_key.replace(/\.mp4$/i, "") + "-ff-" + crypto.randomUUID().slice(0, 8) + ".mp4";
        const stepSidecarKey = stepOutKey.replace(/\.mp4$/i, "") + ".srt";
        const [stepVideoUrl, stepOutputUrl, stepSidecarUrl] = await Promise.all([
          presignR2Get(env, prevKey, 1800),
          presignR2Put(env, stepOutKey, 1800),
          presignR2Put(env, stepSidecarKey, 1800),
        ]);
        return {
          ...seed,
          film_key: prevKey,
          video_url: stepVideoUrl,
          output_url: stepOutputUrl,
          output_key: stepOutKey,
          sidecar_url: stepSidecarUrl,
          sidecar_key: stepSidecarKey,
        };
      },
      // Per-module planner config (subtitle styling/mode/enabled, film-titles font/color/bg), clamped
      // by dispatchChain against each module's schema. Without this the film.finish chain dispatched with
      // {} and every styling/toggle knob was dead from the planner (the dead-config pattern, now closed).
      configFor: (name) => input.film_finish_config?.[name],
    },
  );
  // Record the chain outcome so a degraded or failed film.finish is observable state, not a silent green.
  // The module soft-degrades (passthrough) on a container failure and still returns ok:true, so the only
  // signal that cards were NOT applied is `output.degraded`; surface it (and any chain errors) here. (#207)
  const out = result.output;
  const degraded = result.degraded.length > 0 ? result.degraded.join("; ") : undefined;
  const finalKey = typeof out?.film_key === "string" && out.film_key.length > 0 ? out.film_key : input.film_key;
  return { ran: true, film_key: finalKey, applied: result.applied, errors: result.errors, steps: out?.applied, degraded };
}

/** Single-film film.finish: thin wrapper over runFilmFinish that folds the outcome back onto the job
 *  (behavior-identical to the pre-refactor inline version -- no-op leaves the job untouched). */
async function applyFilmFinish(env: Env, job: FilmJob): Promise<void> {
  if (!job.film_key) return;
  const r = await runFilmFinish(env, {
    film_key: job.film_key,
    scenes: job.scenes,
    dialogue_lines: job.dialogue_lines,
    film_titles: job.film_titles,
    film_finish_config: job.film_finish_config,
    bundle_key: job.bundle_key,
    project: job.project,
    job_id: job.film_id,
  });
  if (!r.ran) return; // no film.finish module installed -> leave job untouched (identical to pre-refactor)
  if (r.errors.length > 0) {
    console.warn(`film.finish errors for ${job.film_id}: ${r.errors.join("; ")}`);
  }
  if (r.degraded) {
    console.warn(`film.finish degraded for ${job.film_id}: ${r.degraded} -- film shipped WITHOUT cards`);
  }
  job.film_finish = { applied: r.applied, errors: r.errors, steps: r.steps, degraded: r.degraded };
  job.film_key = r.film_key;
}

async function enterMuxPhase(env: Env, job: FilmJob): Promise<void> {
  const silentKey = job.silent_film_key;
  const audioKey = job.audio_key;
  if (!silentKey || !audioKey) {
    job.film_key = silentKey;
    await transitionToDone(env, job);
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
  await transitionToDone(env, job);
}

// --------------------------------------------------------------------------- master (pre-mux audio)

/** The film-level `master` chain state carried on a FilmJob (the master module bindings in ui.order, the
 *  step cursor, the in-flight poll token, and the accumulated applied / degraded record). */
export type MasterState = NonNullable<FilmJob["master"]>;

// Bounded transient-retry for a master step, the same discipline as a finish step: a transport blip (the
// module worker momentarily unreachable / a 5xx) re-dispatches the step under the cap. On EXHAUSTION the
// step soft-degrades (passthrough) -- it does NOT fail the render, because master is a polish step (#249/#77).
export const MASTER_STEP_MAX_ATTEMPTS = 3;

// How long the master phase may sit before a frozen step (a RunPod envelope stuck IN_PROGRESS so /poll
// pends forever) is soft-degraded to a passthrough and the chain advances. Generous: a CPU master of a
// few-minute bed is well done by now. NOT a hard FAIL (unlike PHASE_HARD_DEADLINE_SECONDS) -- a stuck
// polish must degrade to the un-mastered bed and still ship the film, never drop it.
export const MASTER_STALL_SECONDS = 15 * 60;

/** Pure: total film length (seconds) from the scenes -- the optional `seconds` hint a master module gets
 *  (it probes the bed if absent). Returns undefined for a job with no scene durations. */
export function filmSeconds(job: Pick<FilmJob, "scenes">): number | undefined {
  const total = (job.scenes || []).reduce((a, s) => a + (Number(s.seconds) || 0), 0);
  return total > 0 ? total : undefined;
}

/** Pure: the mastered bed's R2 key -- beside the source with a `_mastered` suffix, so the original
 *  survives and each chain step writes a fresh, deterministic key (`renders/p/audio/bed.wav` ->
 *  `renders/p/audio/bed_mastered.wav`). The core presigns a PUT for this key and passes it to the master
 *  module; the extension is `.wav`, the master config default (the master phase does not thread per-user
 *  the planner's master config (so a user-selected mp3 lands on a `.mp3` key the container PUT matches).
 *  A deterministic key makes a transient-retry re-PUT idempotent (it overwrites, never orphans). */
export function masteredBedKey(audioKey: string, format: "wav" | "mp3" = "wav"): string {
  const slash = audioKey.lastIndexOf("/");
  const dot = audioKey.lastIndexOf(".");
  const base = dot > slash ? audioKey.slice(0, dot) : audioKey;
  return `${base}_mastered.${format}`;
}

/** Pure: fold one master step's SUCCESS output into the chain state, returning the bed key to carry to
 *  the next step (and the mux). Advances idx, resets the step's poll + attempts. `applied` tags
 *  accumulate; a module soft-degrade (ok:true + output.degraded -- it passed the bed through because it
 *  could not do the work) is recorded against the step binding, so a passthrough is never silent (#77).
 *  Returns the input bed unchanged when the module returned no usable audio_key. */
export function applyMasterOutput(m: MasterState, prevKey: string, out: MasterOutput): string {
  const binding = m.chain[m.idx] ?? "";
  const carried = typeof out.audio_key === "string" && out.audio_key.length > 0 ? out.audio_key : prevKey;
  for (const a of out.applied || []) m.applied.push(a);
  if (typeof out.degraded === "string" && out.degraded.length > 0) m.degraded.push(`${binding}: ${out.degraded}`);
  m.idx += 1;
  m.poll = undefined;
  m.attempts = 0;
  return carried;
}

/** Pure: record a step that could NOT run at all (unbound module, a terminal failure, or a stall) as a
 *  soft-degrade and advance the cursor. The bed carries through unchanged -- the render never fails on a
 *  master miss (#249 / #77). */
export function degradeMasterStep(m: MasterState, reason: string): void {
  const binding = m.chain[m.idx] ?? "";
  m.degraded.push(`${binding}: ${reason}`);
  m.idx += 1;
  m.poll = undefined;
  m.attempts = 0;
}

/** Pure: true once every master step has run (or degraded). */
export function masterChainDone(m: MasterState): boolean {
  return m.idx >= m.chain.length;
}

/** After the silent film is assembled and an audio bed exists: set up the `master` chain (if any master
 *  module is installed) to polish the bed before mux. No master module -> straight to mux with the bed
 *  as-is. Mirrors enterDialogueOrFinish -- it kicks the phase and lets advanceMasterPhase drive it. */
async function enterMasterOrMux(env: Env, job: FilmJob): Promise<void> {
  const envRec = env as unknown as Record<string, unknown>;
  const serving = servingForHook(await discoverModules(envRec), "master"); // ui.order; the full master chain
  const chain = serving.map((mod) => mod.binding);
  if (!chain.length) { job.phase = "mux"; await enterMuxPhase(env, job); return; } // no master installed: mux as-is
  // Per-step planner config, clamped against each module's schema (by name), aligned to chain order --
  // mirrors enterSpeechOrFinish / the finish chain so the audio-master knobs (target_lufs/upscale/format)
  // actually reach the module instead of dispatching with {}.
  const configs = resolveFinishConfigs(serving, job.master_config ?? {});
  job.master = { chain, idx: 0, applied: [], degraded: [], configs };
  job.phase = "master";
  await advanceMasterPhase(env, job);
}

/** Drive the master chain over the film's audio bed: submit the current step or poll the in-flight one,
 *  folding each mastered bed back into job.audio_key. FAIL-SAFE -- an unbound / failed / stalled step
 *  soft-degrades (passes the CURRENT bed through, records the reason) and the chain advances; the render
 *  NEVER fails on a master miss (#249 / #77). When the chain is exhausted, record the outcome and mux.
 *  One network round-trip (submit OR poll) per step per tick: a synchronous step folds and continues in
 *  the same tick; an async step parks on its poll token and returns (the next advanceFilmJob re-enters). */
async function advanceMasterPhase(env: Env, job: FilmJob): Promise<void> {
  const m = job.master;
  if (!m || !job.audio_key) { job.phase = "mux"; await enterMuxPhase(env, job); return; } // defensive: nothing to master
  const envRec = env as unknown as Record<string, unknown>;
  const seconds = filmSeconds(job);

  // A step in flight can freeze (a RunPod envelope stuck IN_PROGRESS pends forever). If the phase has sat
  // past the stall ceiling with a step still pending, soft-degrade THIS step (passthrough) and move on --
  // a stuck polish ships the un-mastered bed, it never hangs the render or drops the film.
  if (m.poll && phaseAgeSeconds(job) >= MASTER_STALL_SECONDS) {
    console.warn(`film ${job.film_id}: master step ${m.chain[m.idx]} stalled; passing the bed through`);
    degradeMasterStep(m, "stalled");
  }

  while (!masterChainDone(m)) {
    const fetcher = asFetcher(envRec[m.chain[m.idx]]);
    if (!fetcher) { degradeMasterStep(m, "module not bound"); continue; }
    if (!m.poll) {
      // CREDENTIALLESS module: the core owns the R2 S3 creds and presigns the bed GET + the mastered PUT
      // (the module/container hold no R2 creds), exactly as the film.finish chain does. Each step masters
      // the PRIOR step's output (job.audio_key carries forward), so presign per step from the current bed.
      const audioKey = job.audio_key;
      // The step's clamped planner config (target_lufs / upscale / format). The output key extension must
      // match the format the module/container will write, so derive it from the same config.
      const cfg = m.configs?.[m.idx] ?? {};
      const format = cfg.format === "mp3" ? "mp3" : "wav";
      const outputKey = masteredBedKey(audioKey, format);
      const [audioUrl, outputUrl] = await Promise.all([
        presignR2Get(env, audioKey, 1800), // 30min: covers a multi-minute CPU master
        presignR2Put(env, outputKey, 1800),
      ]);
      const req = {
        hook: "master" as const,
        input: {
          film_id: job.film_id, audio_key: audioKey,
          audio_url: audioUrl, output_url: outputUrl, output_key: outputKey, seconds,
        } as MasterInput,
        config: cfg,
        context: { project: job.project, job_id: job.film_id },
      };
      const r = await invokeModule<MasterInput, MasterOutput>(fetcher, req);
      if (!r.ok) {
        const d = classifyFinishRetry(r.error, m.attempts ?? 0, MASTER_STEP_MAX_ATTEMPTS);
        if (d.action === "retry") { m.attempts = d.attempts; return; } // transient: re-submit next tick
        degradeMasterStep(m, `invoke failed: ${r.error}`); continue;     // terminal: passthrough + advance
      }
      if ((r as { pending?: boolean }).pending) { m.poll = (r as { poll: string }).poll; m.attempts = 0; return; }
      if ("output" in r) { job.audio_key = applyMasterOutput(m, job.audio_key, r.output as MasterOutput); continue; }
      degradeMasterStep(m, "module returned neither output nor a poll token"); continue;
    }
    const p = await pollModule<MasterOutput>(fetcher, { poll: m.poll });
    if (p.ok && !(p as { pending?: boolean }).pending) {
      job.audio_key = applyMasterOutput(m, job.audio_key, (p as { output: MasterOutput }).output); continue;
    }
    if (p.ok) return; // still mastering -- poll again next tick
    const d = classifyFinishRetry(p.error, m.attempts ?? 0, MASTER_STEP_MAX_ATTEMPTS);
    if (d.action === "retry") { m.attempts = d.attempts; return; } // transient poll blip: re-poll next tick
    degradeMasterStep(m, `poll failed: ${p.error}`); // terminal: passthrough + advance
  }

  // Chain exhausted: the (maybe mastered) bed is in job.audio_key. A degrade is observable, not a silent green.
  if (m.degraded.length) console.warn(`film ${job.film_id}: master degraded -- ${m.degraded.join("; ")}`);
  job.phase = "mux";
  await enterMuxPhase(env, job);
}

async function finishAssembledFilm(env: Env, job: FilmJob, silentKey: string): Promise<void> {
  job.silent_film_key = silentKey;
  if (!job.audio_key) {
    job.film_key = silentKey;
    await transitionToDone(env, job);
    return;
  }
  // There IS an audio bed: master it (music upscale + loudness) if a master module is installed, then mux.
  // enterMasterOrMux soft-degrades to a straight mux when no master module is present (or the polish fails).
  await enterMasterOrMux(env, job);
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

  // Talking film: when shots carry per-shot dialogue, the lip-sync module baked that audio into each
  // clip. Tell the container to preserve per-clip audio through the concat (keepClipAudio) instead of
  // stripping it (-an) -- otherwise the assembled film comes out silent despite the spoken clips.
  const keepClipAudio = !!job.dialogue_audio && Object.keys(job.dialogue_audio).length > 0;

  // Resolution/fps are left to the container default (it normalizes the clips); the motion output
  // does not carry width/height, so matching the source resolution is a later polish, not a gate.
  const resp = await callVideoFinish(env, { clips, outputUrl, outputKey, keepClipAudio });
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
    speech_config?: Record<string, Record<string, unknown>>;
    film_finish_config?: Record<string, Record<string, unknown>>;
    master_config?: Record<string, Record<string, unknown>>;
    derive_mode: "finalized" | "cloud-finalized";
    parent_render_id?: number;
    audio_key?: string;
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
    speech_config: args.speech_config ?? {},
    film_finish_config: args.film_finish_config ?? {},
    master_config: args.master_config ?? {},
    keyframe_binding: null,
    phase: "failed",
    created_at: Date.now(),
    phase_started_at: Date.now(),
    derive_mode: args.derive_mode,
    parent_render_id: args.parent_render_id,
    audio_key: stagedAudio,
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
    motion_backend?: string; keyframe_backend?: string; keyframe_config?: Record<string, unknown>; motion_config?: Record<string, unknown>;
    finish_config?: Record<string, Record<string, unknown>>;
    speech_config?: Record<string, Record<string, unknown>>;
    film_finish_config?: Record<string, Record<string, unknown>>;
    master_config?: Record<string, Record<string, unknown>>;
    keyframes_only?: boolean;
    clips_only?: boolean;
    pretrained_loras?: Record<string, string>;
    audio_key?: string;
    dialogue_lines?: DialogueLine[];
    cast_loras?: Record<string, number>;
    film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  },
): Promise<FilmJob> {
  const scenes = coerceSceneIds(args.scenes ?? []);
  const stagedAudio = args.clips_only ? undefined : await resolveStagedAudioKey(env, args.audio_key);
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  // Honor the planner's keyframe backend pick (e.g. cloud-keyframe) over the ui.order default, mirroring
  // motion.backend selection. An explicit-but-unknown choice resolves to null -> the render fails loud
  // with a clear "keyframe module <choice> not installed" rather than silently swapping backends.
  const kfServing = servingForHook(modules, "keyframe");
  const kf = (args.keyframe_backend ? kfServing.find((m) => m.name === args.keyframe_backend) : kfServing[0]) ?? null;
  const job: FilmJob = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project, bundle_key: args.bundle_key, scenes,
    motion_backend: args.motion_backend ?? null, motion_config: args.motion_config ?? {},
    finish_config: args.finish_config ?? {},
    speech_config: args.speech_config ?? {},
    film_finish_config: args.film_finish_config ?? {},
    master_config: args.master_config ?? {},
    keyframes_only: !!args.keyframes_only,
    clips_only: !!args.clips_only,
    audio_key: stagedAudio,
    film_titles: args.film_titles,
    keyframe_binding: kf ? kf.binding : null, phase: "keyframe", created_at: Date.now(),
    phase_started_at: Date.now(),
    dialogue_lines: args.dialogue_lines && args.dialogue_lines.length ? args.dialogue_lines : undefined,
    cast_loras: args.cast_loras && Object.keys(args.cast_loras).length ? args.cast_loras : undefined,
  };
  const fetcher = kf ? asFetcher(envRec[kf.binding]) : null;
  if (!kf || !fetcher) {
    job.phase = "failed";
    job.error = kf
      ? `keyframe module ${kf.name} (${kf.binding}) is not bound`
      : (args.keyframe_backend ? `keyframe module ${args.keyframe_backend} not installed` : "no keyframe module installed");
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
    else if ((r as { pending?: boolean }).pending) { job.keyframe_poll = (r as { poll: string }).poll; job.keyframe_job_id = (r as { jobId?: string }).jobId; }
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

const POLLABLE_PHASES: ReadonlySet<FilmJob["phase"]> = new Set(["keyframe", "clips", "speech", "finish"]);

/** Seconds the job has sat in its current phase. Falls back to created_at on pre-#129 jobs (no
 *  phase_started_at stamp); `now` is injectable so tests do not depend on the wall clock. */
export function phaseAgeSeconds(job: FilmJob, now: number = Date.now()): number {
  const since = job.phase_started_at ?? job.created_at;
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** Progress fingerprint for the stall signal (#136): the current phase plus how many of its per-shot
 *  units are done. Monotonic within a phase (shots only go pending->done) and it changes on every phase
 *  transition, so ANY change is genuine forward progress -- which is what re-stamps last_progress_at.
 *  Phases with no per-shot fan-out (keyframe/dialogue/assemble/master/mux) report :0, so their stall
 *  window runs from when the phase began, exactly as before. */
export function filmProgressMarker(job: FilmJob, clipJob: ClipJob | null): string {
  let done = 0;
  if (job.phase === "clips") done = (clipJob?.shots || []).filter((s) => s.status === "done").length;
  else if (job.phase === "finish") done = (job.finish_shots || []).filter((fs) => fs.status === "done").length;
  else if (job.phase === "speech") done = (job.speech_shots || []).filter((ss) => ss.status === "done").length;
  return `${job.phase}:${done}`;
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

/** True iff EVERY scene's keyframe is already in R2 (the full set, one per shot). Gate for adopting on a
 *  pending poll (#129 envelope-freeze): a partial set means generation is still in flight, so we must NOT
 *  advance early -- only adopt once the set is complete. (The 20min stall backstop is intentionally
 *  lenient on partials, treating absent shots as genuine non-renders at the ceiling.) */
export async function keyframeSetCompleteInR2(env: Env, job: FilmJob): Promise<boolean> {
  if (!job.scenes.length) return false;
  const present = await listProjectKeyframes(env, job.project, job.scenes);
  const have = new Set(present.map((k) => k.shot_id));
  return job.scenes.every((s) => have.has(s.shot_id));
}

/** Cancel the film's in-flight keyframe RunPod job THROUGH its module, honestly. No-op when no keyframe
 *  job is in flight (wrong phase, no poll token, or no bound backend). When the bound module is missing
 *  or not `cancelable`, or the cancel call fails, we LOG the orphan rather than swallow it: an orphaned
 *  GPU job is a money leak that betrays scale-to-zero (#327 / #328), so it stays visible even when we
 *  cannot stop it. Read keyframe_poll BEFORE the caller clears it. Exported for the orchestrator
 *  unit test (it asserts the adopt + DELETE-cancel paths actually issue a cancel). */
export async function cancelInFlightKeyframe(env: Env, job: FilmJob): Promise<void> {
  if (job.phase !== "keyframe" || !job.keyframe_poll || !job.keyframe_binding) return;
  const poll = job.keyframe_poll;
  // NAME the backend job in every orphan log so a left-running job is actionable (an operator can
  // cancel it by hand -- exactly how this bug was caught). keyframe_job_id comes from the module's
  // #318 jobId on the pending invoke; "(job id unknown)" only if a module omitted that optional field.
  const jobId = job.keyframe_job_id ?? "(job id unknown)";
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const kf = modules.find((m) => m.binding === job.keyframe_binding) ?? null;
  const fetcher = kf ? asFetcher(envRec[kf.binding]) : null;
  if (!kf || !fetcher) {
    console.warn(`film ${job.film_id}: cannot cancel in-flight keyframe job -- module ${job.keyframe_binding} not bound; RunPod job ${jobId} left running (ORPHAN) (#327)`);
    return;
  }
  if (!kf.cancelable) {
    console.warn(`film ${job.film_id}: keyframe module ${kf.name} has no cancel primitive (cancelable=false) -- RunPod job ${jobId} left running (ORPHAN) (#327)`);
    return;
  }
  const r = await cancelModule(fetcher, { poll });
  if (r.ok) {
    console.warn(`film ${job.film_id}: cancelled in-flight keyframe RunPod job ${jobId} via ${kf.name} (#327)`);
  } else {
    console.warn(`film ${job.film_id}: keyframe cancel FAILED (${r.error}) -- RunPod job ${jobId} left running (ORPHAN) (#327)`);
  }
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
  // #327: STOP the still-running RunPod job BEFORE discarding its poll token. Adopting the cached
  // keyframes satisfies the work, but the GPU job keeps training/rendering unless we cancel it; clearing
  // keyframe_poll without cancelling is exactly what orphaned it. Best-effort, honest-degrade-logged.
  await cancelInFlightKeyframe(env, job);
  job.keyframe_recovered = true;
  job.keyframe_poll = undefined; // the RunPod job is cancelled (or logged as an orphan) above
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
  // Same R2-presence reclaim the clip leg uses (adopt any not-done shot whose clip is in R2 -- pending OR
  // a module fast-fail; the artifact wins). Shared helper = one matcher, no drift. Persist partial progress
  // so a later sweep starts from it (idempotent re-PUT); a shot with no R2 clip is left for the next sweep.
  const adopted = await reclaimClipsFromR2(env, clipJob);
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
      } else if (await keyframeSetCompleteInR2(env, job)) {
        // R2 PRESENCE IS AUTHORITATIVE, even on a *pending* poll (#129 sibling, mirrors #154 for finish):
        // the keyframe job's RunPod envelope can freeze at IN_PROGRESS after the GPU already wrote every
        // renders/<project>/keyframes/shot_NN.png to R2, so the poll reads pending forever. Don't wait for
        // KEYFRAME_STALL_SECONDS (20min) to adopt -- once the FULL set is in R2, advance now. The
        // completeness guard is essential: adopting a PARTIAL set (mid-generation) would advance to clips
        // with keyframes missing. (recoverStalledKeyframePhase stays as the >20min backstop, which is
        // lenient on partial = genuine non-renders.)
        await recoverStalledKeyframePhase(env, job);
      }
    }
    await putFilm(env, job);
  }

  // Phase 2: drive the clip orchestrator; when every shot is terminal, hand off to the finish chain.
  let clipJob: ClipJob | null = null;
  if (job.phase === "clips" && job.clip_job_id) {
    clipJob = await advanceClipJob(env, job.clip_job_id);
    // R2 PRESENCE IS AUTHORITATIVE, BEFORE the complete-judgment (issue #141): a module fast-fail (#142)
    // makes summarizeJob read complete (done+failed===total) at ~150s; without this, enterFinishPhase
    // builds from done clips only and DROPS the failed shots -- even though their clips are in R2. Reclaim
    // any not-done shot whose clip is in R2 (only lists when failed>0; idempotent with advanceClipJob's own
    // reclaim) so the film never advances/assembles with a clip dropped that actually landed.
    if (clipJob && summarizeJob(clipJob).failed > 0) {
      const adopted = await reclaimClipsFromR2(env, clipJob);
      if (adopted > 0) await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
    }
    if (clipJob && summarizeJob(clipJob).complete) { await enterFinishPhase(env, job, clipJob); }
    await putFilm(env, job);
  } else if (job.clip_job_id) {
    const cj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id)); // load for the summary
    if (cj) clipJob = JSON.parse(await cj.text()) as ClipJob;
  }

  // Phase 2.5: synthesize per-shot dialogue audio (one batch via the dialogue module), then -> finish.
  // Soft-degrades to a silent finish on any failure (see advanceDialoguePhase).
  if (job.phase === "dialogue") {
    await advanceDialoguePhase(env, job);
    await putFilm(env, job);
  }

  // Phase 2.6: enhance per-shot dialogue audio (the speech chain, async across requests), then -> finish.
  // A POLISH phase: a hard step failure degrades the shot (keeps the original audio) and the render
  // proceeds to finish -- a speech glitch must never fail a fully-rendered film (see advanceSpeechPhase).
  if (job.phase === "speech") {
    await advanceSpeechPhase(env, job);
    await putFilm(env, job);
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

  // Phase 4.5: master the assembled film's audio bed (music upscale + loudness) before mux. Pollable
  // like dialogue; FAIL-SAFE -- a master miss passes the bed through and proceeds to mux (#249 / #77).
  if (job.phase === "master") {
    await advanceMasterPhase(env, job);
    await putFilm(env, job);
  }

  // Phase 5: mux the (mastered) audio bed onto the silent film via video-finish (VPC remuxAudioOnly).
  if (job.phase === "mux") {
    await enterMuxPhase(env, job);
    await putFilm(env, job);
  }

  // Re-stamp the stall clock on REAL progress (#136). The clips/finish/speech phases advance per shot
  // over many minutes inside ONE phase, so a UI stall signal measured from phase_started_at alone cries
  // wolf on a healthy long phase. filmProgressMarker changes on any finished shot (or a phase
  // transition), so a change is genuine progress -> refresh last_progress_at. The DRIVER's recovery
  // (phaseAgeSeconds + the 90min ceiling) deliberately still measures from phase_started_at; this only
  // fixes the in-flight UI signal, never the recovery semantics.
  const marker = filmProgressMarker(job, clipJob);
  const progressed = marker !== job.progress_marker;
  if (progressed) {
    job.progress_marker = marker;
    job.last_progress_at = Date.now();
  }
  // On any phase transition this tick, stamp when the new phase began (the stall recovery measures
  // against it) and persist. The phase legs above already persisted on the paths they took; this also
  // covers a recovery that failed the job at the ceiling (no leg ran after it), so that verdict lands
  // in R2. putFilm is an idempotent re-PUT, so the belt-and-suspenders double write is harmless.
  if (job.phase !== entryPhase) {
    job.phase_started_at = Date.now();
    await putFilm(env, job);
  } else if (progressed) {
    await putFilm(env, job);
  }

  return { job, clipJob };
}
