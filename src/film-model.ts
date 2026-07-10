// Film model: the PURE half of the film orchestrator (S6 god-file split). Everything here is
// data shapes + synchronous logic with NO Env and NO I/O -- the doc-key builders, phase/summary
// projections, finish-step retry/adoption/convention logic, assemble transport classification,
// master-chain state helpers, and the stall math. The orchestrator (film-orchestrator.ts) owns
// every await; it re-exports this module, so importers and tests keep their one entry point.

import type { ConfigSchema, DialogueLine, FinishOutput, MasterOutput, RegisteredModule, SpeechOutput } from "./modules/types";
import { validateConfig } from "./modules/registry";
import { summarizeJob, type ClipJob, type JobSummary } from "./render-orchestrator";
import { coerceShotId } from "./storyboard-validate";

export interface FilmScene { shot_id: string; prompt: string; seconds: number; }

/** One clip moving through the `finish` chain (post-clips). `chain` is the finish module bindings in
 *  ui.order; `idx` walks through them, each consuming the previous module's output clip. `configs` is
 *  the validated config for each chain step (parallel to `chain`), so each module gets its
 *  config_schema defaults -- without it a module receives `{}` and no-ops (see issue #75). */
/** #662: one finish CHAIN STEP's honest outcome, recorded as the step resolves. `binding` is the chain
 *  ref (chain[idx]); `tags` is what the step contributed to the output clip (the module's applied markers
 *  on a run, the reconstructed marker on a reuse); `reused` is true when the step was adopted from an R2
 *  artifact (#583) rather than run this pass. The ordered list of these reconciles 1:1 to the shot chain. */
export interface FinishStepRecord { binding: string; tags: string[]; reused: boolean; }

export interface FinishShot {
  shot_id: string;
  clip_key: string;   // current clip key (updated as each finish module completes)
  chain: string[];    // finish module transport refs (MODULE_* service or dispatch:<script>), in ui.order
  configs?: Record<string, unknown>[]; // validated config per chain step, parallel to `chain`
  idx: number;
  status: "pending" | "done" | "failed";
  poll?: string;
  applied: string[];
  // #583 honesty: the step markers this shot REUSED from R2 this pass (adopted, NOT run this pass).
  // Parallel to `applied` (steps actually RUN this pass); the union is the transforms present in the
  // output clip. An adopted step never fabricates an `applied`-run tag -- the reuse is disclosed here.
  adopted?: string[];
  // #662 honesty reconciliation: ONE record per chain step as it resolves (run OR reused-from-R2), in
  // chain order. For a `done` shot ledger.length === chain.length and ledger[i].binding === chain[i], so
  // the per-shot ledger reconciles 1:1 to the chain. A reused step is PRESENT here (reused:true), never
  // dropped -- so reading the ledger never looks like a missing step the way `applied` alone can (a reused
  // step's tag lives in `adopted`, not `applied`). Optional: pre-#662 job docs predate it.
  ledger?: FinishStepRecord[];
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
  chain: string[];     // speech module transport refs (MODULE_* service or dispatch:<script>), in ui.order
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
    chain: string[];     // master module transport refs (MODULE_* service or dispatch:<script>), in ui.order
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
    // #600: film.finish steps write DETERMINISTIC per-step keys (renders/<film>-ff<n>.mp4), so a step
    // that completed inside a request that then timed out is ADOPTED from R2 on the next tick instead of
    // re-encoded. Before this the keys were random per attempt, so a big film re-burned ~8 min of
    // media-stack CPU every cron tick and never finished. R2 presence IS the persisted progress
    // (#122/#141); the existing idempotent assemble re-entry drives the per-tick resume.
    adopted?: string[];  // steps folded from a pre-existing R2 artifact (reuse, never a fake applied run, #583)
    // #663: R2 key of the FINAL .srt subtitle sidecar (re-timed for any title-card prepend, named next to
    // the final film). Surfaced on FilmSummary so the sidecar is discoverable via the API, not only by key
    // convention. Absent when no sidecar was written (burn-only, or a silent / dialogue-free film).
    sidecar_key?: string;
  };
  // #600 in-flight guard: deterministic film.finish step key -> the ts it was dispatched (persisted
  // BEFORE the dispatch, crash-safe). A step still inside the in-flight window (key not yet in R2) is
  // NOT re-dispatched, so a killed leaseholder + the 300s advance-lease TTL (shorter than an ~8-min
  // encode) + the fail-open advance path cannot fire a DUPLICATE encode of the same step each tick.
  film_finish_dispatched?: Record<string, number>;
  // #602 async job+poll: a film.finish module can return { pending, poll } when its work outlasts a
  // request budget (a long subtitle burn / card concat). The core drives submit+poll ACROSS TICKS with
  // the persisted token, so no single request holds the encode open. film_finish_polls maps the step`s
  // deterministic output key -> that step`s in-flight module poll token; film_finish_attempts counts a
  // step`s TERMINAL poll/submit failures, bounding re-dispatch before the step soft-degrades (ships the
  // film UNCARDED, #190 fail-safe -- a card miss never fails a fully-rendered film). R2 presence at the
  // step key stays authoritative on completion (adopt), exactly as the #600 synchronous path.
  film_finish_polls?: Record<string, string>;
  film_finish_attempts?: Record<string, number>;
  // #663: deterministic film.finish step key -> seconds a title card prepended at that step. Persisted so
  // the post-chain .srt sidecar re-time recovers the offset even when the prepending step is adopted (not
  // re-folded) on a later poll tick.
  film_finish_prepend?: Record<string, number>;
  // Loud, structured degrade when the video-finish tier (VIDEO_FINISH_VPC) is UNAVAILABLE at
  // assemble/mux -- the binding is unbound, or the container/tunnel was unreachable after the bounded
  // retry. The film COMPLETES (never hard-fails after the GPU spend, #519) delivering what was rendered:
  // the per-shot clips (assemble degrade, no single concatenated film) or the SILENT assembled film (mux
  // degrade, the audio bed could not be muxed). This is the UNAVAILABILITY path ONLY; a genuine per-shot
  // finish / container ERROR (the container ran and reported a real failure) still fails the render loud
  // (#245/#249). Surfaced on FilmSummary + a `film.finish_unavailable` structured event so the UI and
  // smoke tests can assert on it, never a silent green.
  finish_unavailable?: {
    at: "assemble" | "mux";      // which delegated step could not run
    reason: string;              // the honest cause (unbound binding, or unreachable-after-retry)
    delivered: "clips" | "silent_film"; // what shipped instead of the finished film
    clips?: { shot_id: string; clip_key: string }[]; // per-shot clips (assemble degrade), the deliverable
  };
  // Loud, structured degrade when the keyframe stall recovery hit the phase ceiling with only a
  // PARTIAL keyframe set in R2 (#619): keyframes upload progressively, so a stall mid-batch leaves
  // some scenes unrendered. Below the ceiling the recovery HOLDS for the rest; at the ceiling it
  // advances delivering the scenes that DID render, but records the drop here so the film NEVER
  // reports a clean complete over the rebased (smaller) shot total. Surfaced on FilmSummary + the
  // poll view + a `film.keyframes_incomplete` structured event (#245/#249). Absent on a normal render
  // (a full set, or a below-ceiling partial that simply waits for the rest).
  keyframes_incomplete?: {
    adopted: number;    // scenes whose keyframe landed in R2 and were carried forward
    expected: number;   // scenes the storyboard asked for
    dropped: string[];  // shot_ids with no keyframe at the ceiling (never rendered)
  };
  mux_output_key?: string; // deterministic mux destination for idempotent retries
  mix_audio_key?: string; // #231: multi-track mixed audio (dialogue + ducked music + loudnorm) destination
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


const filmKey = (id: string) => `renders/${id}/film-job.json`;
const clipDocKey = (clipJobId: string) => `renders/${clipJobId}/clips-job.json`; // matches render-orchestrator

export { filmKey as filmJobDocKey, clipDocKey as clipJobDocKey };

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

export interface FinishSummary { total: number; done: number; failed: number; pending: number; adopted: number; }
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
  // Loud degrade status when the video-finish tier was UNAVAILABLE (unbound / unreachable-after-retry):
  // the film COMPLETED delivering per-shot clips (assemble) or the silent film (mux) instead of the
  // finished film. Absent on a normal render. Lets the API/UI show "clips only, finish unavailable" (#519).
  finish_unavailable?: FilmJob["finish_unavailable"];
  // #619: keyframe recovery hit the ceiling with a partial set; the film delivered only the scenes
  // that rendered. Absent on a normal render. Lets the API/UI show "N of M scenes, dropped [...]".
  keyframes_incomplete?: FilmJob["keyframes_incomplete"];
}
export function summarizeFinish(shots: FinishShot[]): FinishSummary {
  return {
    total: shots.length,
    done: shots.filter((s) => s.status === "done").length,
    failed: shots.filter((s) => s.status === "failed").length,
    pending: shots.filter((s) => s.status === "pending").length,
    adopted: shots.filter((s) => (s.adopted?.length ?? 0) > 0).length, // #583: shots with >=1 finish step reused from R2
  };
}
export function summarizeFilm(job: FilmJob, clipJob: ClipJob | null): FilmSummary {
  return {
    film_id: job.film_id, phase: job.phase, error: job.error,
    clips: clipJob ? summarizeJob(clipJob) : undefined,
    finish: job.finish_shots ? summarizeFinish(job.finish_shots) : undefined,
    film_key: job.film_key,
    film_finish: job.film_finish,
    finish_unavailable: job.finish_unavailable,
    keyframes_incomplete: job.keyframes_incomplete,
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

/** Pure: fold one finish module's output into the shot -- chain its output clip into the next module,
 *  record what it applied, advance the chain index; status -> done when the chain is exhausted. */
export function applyFinishOutput(fs: FinishShot, out: FinishOutput): void {
  fs.clip_key = out.clip_key;
  const tags = out.applied || [];
  fs.applied.push(...tags);
  // #662: account THIS run step in the per-step ledger (chain order), so a done shot's ledger covers the
  // whole chain 1:1. `tags` may be empty (a step that ran but reported no marker); the record still
  // accounts the step -- coverage is per-record, not per-tag.
  (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [...tags], reused: false });
  fs.idx += 1;
  fs.poll = undefined;
  fs.attempts = 0; // a step succeeded -> the next step gets a fresh transient-retry budget
  if (fs.idx >= fs.chain.length) fs.status = "done"; // else stays pending; next advance submits chain[idx]
}

/** Pure: fold an ADOPTED (reused-from-R2, NOT run this pass) finish-step artifact into the shot. Same
 *  chain advance as applyFinishOutput, but the step marker lands in `adopted` (the honest reuse channel)
 *  and is NEVER pushed into `applied` -- the record must not claim a run that did not happen (#583).
 *  `clip_key` is the adopted artifact key; `tag` is the reconstructed step marker (finishStepAppliedTag). */
export function adoptFinishStepOutput(fs: FinishShot, clip_key: string, tag: string): void {
  fs.clip_key = clip_key;
  (fs.adopted ??= []).push(tag);
  // #662: account THIS reused step in the per-step ledger (reused:true), so it is PRESENT in the ledger
  // even though its tag lives in `adopted`, not `applied` -- the fix for the "applied drops one tag" report.
  (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [tag], reused: true });
  fs.idx += 1;
  fs.poll = undefined;
  fs.attempts = 0; // a step advanced -> the next step gets a fresh transient-retry budget
  if (fs.idx >= fs.chain.length) fs.status = "done";
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
export function reclaimFinishShotsFromR2(finishShots: FinishShot[], present: Map<string, string>, modules?: RegisteredModule[]): number {
  let adopted = 0;
  for (const fs of finishShots) {
    if (finishShotAdoptableFromR2(fs) && present.has(fs.shot_id)) {
      fs.clip_key = present.get(fs.shot_id) as string;
      fs.status = "done";
      fs.poll = undefined;
      fs.error = undefined; // the finished artifact in R2 is the source of truth
      // #583 honesty: this shot's FINAL step was REUSED from R2, not run this pass -- disclose it in
      // `adopted` (never a fake `applied`-run tag). finishShotAdoptableFromR2 guarantees idx === last,
      // so the reused marker is the last chain step's tag.
      const tag = finishStepAppliedTag(fs, modules);
      (fs.adopted ??= []).push(tag);
      // #662: account the reused FINAL step (idx === last) in the per-step ledger, completing it to
      // chain.length so the adopted shot's ledger reconciles 1:1 to its chain.
      (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [tag], reused: true });
      adopted += 1;
    }
  }
  return adopted;
}

/** #662 honesty invariant: does this finish shot's per-step ledger reconcile 1:1 to its chain? True unless
 *  a DONE shot has a ledger that fails to cover every chain step in order. Absent ledger (a pre-#662 job
 *  doc) or a non-done shot (still advancing, or failed mid-chain with a partial ledger) is NOT asserted.
 *  The invariant a DONE shot must hold: every chain step is accounted for exactly once (run or reused), so
 *  an adopted shot's ledger never looks like it dropped a step (the #245/#249 honesty-ledger discipline). */
export function finishShotLedgerReconciles(fs: FinishShot): boolean {
  if (fs.status !== "done" || !fs.ledger) return true;
  return fs.ledger.length === fs.chain.length && fs.ledger.every((r, i) => r.binding === fs.chain[i]);
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
export function finishStepOutputKey(project: string, fs: FinishShot, modules?: RegisteredModule[]): string | null {
  const binding = fs.chain[fs.idx] ?? "";
  // Contract-carried convention first (finish_artifacts, S6): the module DECLARES how it names its
  // output, so the core stops reverse-engineering module internals from the binding name.
  const decl = moduleByBinding(modules, binding)?.finish_artifacts;
  if (decl) {
    if (decl.output_key.kind === "shot_named") return `renders/${project}/clips/${fs.shot_id}${decl.output_key.filename}`;
    return insertKeySuffix(fs.clip_key, decl.output_key.suffix);
  }
  // Legacy fallback for module deploys predating finish_artifacts: the shipped modules' conventions,
  // derived from the binding name. Returns null for a module whose convention we do not model, so an
  // unmodeled step gets NO R2 shortcut and can never adopt a sibling step's artifact.
  if (/RIFE/i.test(binding)) return `renders/${project}/clips/${fs.shot_id}_finished.mp4`;
  const suffix = /LIPSYNC|MUSETALK/i.test(binding) ? "_ls" : /UPSCALE/i.test(binding) ? "_up" : null;
  if (!suffix) return null;
  return insertKeySuffix(fs.clip_key, suffix);
}

/** Insert an artifact suffix into an R2 key before its extension (`a/b.mp4` + `_ls` -> `a/b_ls.mp4`). */
function insertKeySuffix(key: string, suffix: string): string {
  const slash = key.lastIndexOf("/");
  const dotInBase = key.slice(slash + 1).lastIndexOf(".");
  if (dotInBase < 0) return `${key}${suffix}`;
  const at = slash + 1 + dotInBase;
  return `${key.slice(0, at)}${suffix}${key.slice(at)}`;
}

/** The finish module (if any) whose transport-encoded binding ref serves this chain step. */
function moduleByBinding(modules: RegisteredModule[] | undefined, binding: string): RegisteredModule | undefined {
  return modules?.find((m) => m.binding === binding);
}

/** Resolve a `{knob}` / `{knob|default}` applied-tag template against the step's validated config. */
function resolveAppliedTemplate(tag: string, cfg: Record<string, unknown>): string {
  return tag.replace(/\{([A-Za-z0-9_]+)(?:\|([^}]*))?\}/g, (_all, knob: string, dflt: string | undefined) => {
    const v = cfg[knob];
    return v === undefined ? (dflt ?? "") : String(v);
  });
}

/** Pure: the `applied` tag the CURRENT finish step would report, reconstructed from its validated config
 *  so an R2-adopted step (whose job is gone, so its real response is lost) still carries the marker the
 *  verifier and UI read (e.g. `lipsync:v15`, `upscale:2x`, `interpolate:2x`). Mirrors each module's own
 *  `applied` string. Unmodeled modules get a `<binding>:r2-adopted` marker so the adoption is never silent. */
export function finishStepAppliedTag(fs: FinishShot, modules?: RegisteredModule[]): string {
  const binding = fs.chain[fs.idx] ?? "";
  const cfg = (fs.configs?.[fs.idx] ?? {}) as Record<string, unknown>;
  // Contract-carried rules first (finish_artifacts.applied, S6): first matching rule wins; a rule
  // with `when` applies only when the named knob equals its literal.
  const rules = moduleByBinding(modules, binding)?.finish_artifacts?.applied;
  if (rules) {
    for (const rule of rules) {
      if (rule.when && cfg[rule.when.knob] !== rule.when.equals) continue;
      return resolveAppliedTemplate(rule.tag, cfg);
    }
    return `${binding}:r2-adopted`; // declared rules, none matched: never silent
  }
  // Legacy fallback (module deploys predating finish_artifacts), binding-name derived.
  if (/LIPSYNC|MUSETALK/i.test(binding)) return `lipsync:${String(cfg.version ?? "v15")}`;
  if (/UPSCALE/i.test(binding)) return `upscale:${Number(cfg.scale ?? 2)}x`;
  if (/RIFE/i.test(binding)) return cfg.interpolate === false ? "noop:interpolate-off" : `interpolate:${Number(cfg.interpolation_factor ?? 2)}x`;
  return `${binding}:r2-adopted`;
}

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

/** Pure: normalize caller scene ids to the canonical `shot_NN` the bundle uses. /api/storyboard/bundle
 *  runs validateStoryboard, which coerces every scene id to `shot_<index+1>` in declaration order --
 *  so a caller that supplies its own ids (e.g. the Slate bot's `s1`/`s2`) gets a bundle storyboard
 *  whose ids do NOT match the film's shot_ids, and the keyframe stage rejects them
 *  (`process_shot_ids not in storyboard`). Coerce here with the SAME function so they line up by
 *  position (a valid `shot_NN` survives; anything else is renumbered). */
export function coerceSceneIds(scenes: FilmScene[]): FilmScene[] {
  return (scenes || []).map((s, i) => ({ ...s, shot_id: coerceShotId(s.shot_id, i) }));
}

/** Pure: remap dialogue-line shot ids through the SAME positional coercion coerceSceneIds applies to
 *  the scenes, keyed off the ORIGINAL (pre-coercion) scene ids. Without this a caller that supplies
 *  its own scene ids (`s1`/`s2`) plus dialogue_lines gets a film whose dialogue map is keyed `s1`
 *  while every consumer joins on the coerced `shot_01`: the lip-sync finish step reads no audio_key
 *  (noop:no-dialogue), buildCaptionCues yields zero cues, and the film ships silent + uncaptioned
 *  even though the TTS ran. A line whose id matches no scene is passed through unchanged (same
 *  fail-soft posture as the dialogue stage). Canonical `shot_NN` ids survive coerceShotId, so this
 *  is a no-op for the planner UI / scatter paths. */
export function coerceDialogueLineIds(originalScenes: FilmScene[], lines: DialogueLine[] | undefined): DialogueLine[] | undefined {
  if (!lines || !lines.length) return lines;
  const map = new Map<string, string>();
  (originalScenes || []).forEach((s, i) => {
    if (s && typeof s.shot_id === "string" && s.shot_id.trim()) map.set(s.shot_id.trim(), coerceShotId(s.shot_id, i));
  });
  return lines.map((l) => {
    const mapped = l && typeof l.shot_id === "string" ? map.get(l.shot_id.trim()) : undefined;
    return mapped && mapped !== l.shot_id ? { ...l, shot_id: mapped } : l;
  });
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

export const POLLABLE_PHASES: ReadonlySet<FilmJob["phase"]> = new Set(["keyframe", "clips", "speech", "finish"]);

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
