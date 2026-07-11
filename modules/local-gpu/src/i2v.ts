// Pure mapping for the local-gpu i2v module: build the local backend's i2v_clip request body, read
// its output, and encode/decode the async poll token. No I/O here, so it unit-tests without the
// runtime or any GPU. The job-input contract is IDENTICAL to vivijure-backend's i2v_clip action
// (studio #81 / backend #87) -- that sameness IS the swappability: the same wire body drives the Wan
// datacenter engine OR the LTX consumer engine; only the box behind the endpoint differs.

import type { DurationGridDecl, MotionBackendInput, MotionBackendOutput } from "./contract";

/** Pure (#707): validate a backend-declared duration grid (from the door's /health) into the shape
 *  the manifest relays. STRICT: anything malformed -- non-positive fps, no usable tiers -- returns
 *  null and the manifest omits the field. The module relays only what the backend honestly declared;
 *  it never repairs or fabricates a grid. */
export function readDurationGrid(raw: unknown): DurationGridDecl | null {
  const g = raw as { fps?: unknown; tiers?: unknown } | null | undefined;
  if (!g || typeof g.fps !== "number" || !(g.fps > 0) || !g.tiers || typeof g.tiers !== "object") return null;
  const tiers: Record<string, { max_frames: number }> = {};
  for (const [tier, v] of Object.entries(g.tiers as Record<string, { max_frames?: unknown } | null>)) {
    if (v && typeof v.max_frames === "number" && v.max_frames > 0) tiers[tier] = { max_frames: v.max_frames };
  }
  return Object.keys(tiers).length > 0 ? { fps: g.fps, tiers } : null;
}

// i2v default cadence. The backend snaps the final frame count to its model's temporal stride, so we
// send a count derived from the shot length and let the backend do the snap (LTX wants 8k+1; Wan 4k+1).
export const DEFAULT_FPS = 24;

export function framesFor(seconds: number, fps: number): number {
  const n = Math.round((Number(seconds) || 5) * fps);
  return Math.max(fps, n); // at least ~1s of frames; the backend snaps to its stride
}

/** The local backend /run body for the i2v_clip action, mapped from the hook input + module config.
 *  project comes from the invoke context, the rest from the per-shot input + clamped knobs.
 *  keyframe_key is sent ONLY when the caller gave an explicit one; otherwise it is omitted so the
 *  backend applies its own key convention (the single source of truth for where the keyframe landed --
 *  duplicating the slug rule here would risk drift against the keyframe stage). */
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

/** Map the backend's i2v_clip output into the hook's MotionBackendOutput. Returns null if the backend
 *  reported no clip_key (treated as a job failure by the caller). */
export function readOutput(shotId: string, output: unknown): MotionBackendOutput | null {
  const out = (output ?? {}) as BackendI2vOutput;
  if (!out.clip_key) return null;
  const mapped: MotionBackendOutput = {
    shot_id: out.shot_id || shotId,
    clip_key: out.clip_key,
    fps: typeof out.fps === "number" ? out.fps : DEFAULT_FPS,
    frames: typeof out.num_frames === "number" ? out.num_frames : 0,
  };
  if (typeof out.distilled === "boolean") mapped.distilled = out.distilled;
  return mapped;
}

// --- async poll token --------------------------------------------------------------------------

// Everything /poll and /cancel need: the backend job id + which shot it is. The backend already knows
// where the clip belongs (it wrote it), so unlike a cloud module we carry no R2 destination.
// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a backend
// "job not found" as a real terminal loss vs a momentary post-submit propagation race (the #141 root
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
        jobId: o.jobId,
        project: o.project,
        shotId: o.shotId,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// How long after submit a backend "job not found" is treated as a propagation race (keep polling)
// rather than a real terminal loss. A local always-on server keeps its job registry in memory, so a
// 404 normally means the box RESTARTED mid-job (the work is genuinely lost) -- but a fresh submit can
// race the registry write, so mirror the control plane's grace (150s, same as own-gpu/#141) before
// failing the shot. Past the window a 404 is a real loss: fail honestly rather than poll a dead job.
export const JOB_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did the backend report this job as gone? A restarted / unknown job returns HTTP 404 with a
 *  body like {"status":404,"title":"Not Found","detail":"job not found"} -- where `status` is the
 *  NUMBER 404, not a run state. Detect that shape (numeric/absent status + a not-found marker) so the
 *  caller can stop polling forever. A real run state (IN_QUEUE/IN_PROGRESS/COMPLETED/FAILED) -> false. */
export function jobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false; // a real run state
  if (typeof st === "number") return st === 404; // numeric status echoed from an error envelope
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: classify one /poll tick when the backend reports the job gone. `submittedAt` is the token's
 *  stamp (undefined on a legacy token). Returns "gone-failed" past the grace window (or for a legacy
 *  token, where a 404 now is necessarily a real loss not a fresh race) so the caller fails the shot
 *  instead of polling a dead job forever (#141); "gone-grace" while still inside the window. */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = JOB_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed"; // legacy token: a 404 now is a real loss
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}
