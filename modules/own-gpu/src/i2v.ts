// Pure mapping for the own-gpu i2v module: build the vivijure-backend i2v_clip request body, read
// its output, and encode/decode the async poll token. No I/O here, so it unit-tests without the
// runtime or GPU spend. The contract is vivijure-backend's i2v_clip action (studio #81 / backend #87).

import type { MotionBackendInput, MotionBackendOutput } from "./contract";

// Wan2.2-I2V default cadence (I2VParams). The backend snaps the final frame count to 4k+1, so we
// send a count derived from the shot length and let the backend do the snap.
export const DEFAULT_FPS = 16;

export function framesFor(seconds: number, fps: number): number {
  const n = Math.round((Number(seconds) || 5) * fps);
  return Math.max(fps, n); // at least ~1s of frames; the backend snaps to 4k+1
}

/** The RunPod /run body for our backend's i2v_clip action, mapped from the hook input + module
 *  config. project comes from the invoke context, the rest from the per-shot input + clamped knobs.
 *  keyframe_key is sent ONLY when the caller gave an explicit one; otherwise it is omitted so the
 *  backend applies its own `keys.keyframe_key` convention (a single source of truth for the key --
 *  duplicating the slug rule here would risk drift against where the keyframe stage actually wrote). */
export function buildI2vBody(
  input: MotionBackendInput,
  cfg: Record<string, unknown>,
  project: string,
): { input: Record<string, unknown> } {
  const fps = typeof cfg.fps === "number" ? cfg.fps : DEFAULT_FPS;
  const config: Record<string, unknown> = {
    quality: String(cfg.quality ?? "standard"),
    num_frames: framesFor(input.seconds, fps),
    fps,
  };
  if (typeof cfg.seed === "number" && cfg.seed >= 0) config.seed = cfg.seed;
  if (typeof cfg.flow_shift === "number") config.flow_shift = cfg.flow_shift;
  if (typeof cfg.negative_prompt === "string" && cfg.negative_prompt) config.negative_prompt = cfg.negative_prompt;
  const job: Record<string, unknown> = {
    action: "i2v_clip",
    project,
    shot_id: input.shot_id,
    prompt: input.prompt,
    config,
  };
  if (input.keyframe_key) job.keyframe_key = input.keyframe_key;
  return { input: job };
}

// The backend's i2v_clip output (handler return). It writes the clip to R2 itself and reports the
// key, so this module never downloads or re-uploads -- it just surfaces what the backend wrote.
export interface BackendI2vOutput {
  clip_key?: string;
  shot_id?: string;
  fps?: number;
  num_frames?: number;
  seconds?: number;
  distilled?: boolean;
}

/** Map the backend's i2v_clip output into the hook's MotionBackendOutput. Returns null if the
 *  backend reported no clip_key (treated as a job failure by the caller). */
export function readOutput(shotId: string, output: unknown): MotionBackendOutput | null {
  const out = (output ?? {}) as BackendI2vOutput;
  if (!out.clip_key) return null;
  return {
    shot_id: out.shot_id || shotId,
    clip_key: out.clip_key,
    fps: typeof out.fps === "number" ? out.fps : DEFAULT_FPS,
    frames: typeof out.num_frames === "number" ? out.num_frames : 0,
  };
}

// --- async poll token --------------------------------------------------------------------------

// Everything /poll needs to finalize: the RunPod job id + which shot it is. The backend already
// knows where the clip belongs (it wrote it), so unlike a cloud module we carry no R2 destination.
// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a momentary post-submit propagation race (issue #141 root
// cause). Optional for back-compat: tokens issued before this field read it as undefined.
export interface PollState {
  jobId: string;
  project: string;
  shotId: string;
  submittedAt?: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.project === "string" && typeof o.shotId === "string") {
      return {
        jobId: o.jobId, project: o.project, shotId: o.shotId,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// How long after submit a RunPod "job not found" is treated as a propagation race (keep polling)
// rather than a real terminal GC. RunPod's /run can return an id before /status can see it; mirror the
// control plane's PHANTOM_GRACE_SECONDS (150s) so a momentary 404 never false-fails a live job.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did RunPod report this job as gone? A GC'd / unknown job returns HTTP 404 with a body like
 *  {"status":404,"title":"Not Found","detail":"job not found"} -- where `status` is the NUMBER 404, not
 *  a RunPod run state. Detect that shape (numeric/absent status + a not-found marker) so the caller can
 *  stop polling it forever. A real run state ("IN_QUEUE"/"IN_PROGRESS"/"COMPLETED"/"FAILED") -> false. */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false; // a real run state
  if (typeof st === "number") return st === 404; // numeric status echoed from an error envelope
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: classify one /poll tick when RunPod reports the job gone. `submittedAt` is the token's stamp
 *  (undefined on a legacy token). Returns "gone-failed" past the grace window (or for a legacy token,
 *  where a 404 is necessarily a real GC not a fresh race) so the caller fails the shot instead of
 *  polling a dead job forever (#141); "gone-grace" while still inside the window (post-submit race). */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed"; // legacy token: a 404 now is a real GC, not a race
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}
