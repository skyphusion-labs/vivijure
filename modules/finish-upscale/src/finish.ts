// Pure finish-upscale logic: build the RunPod request body, derive the output key, parse the result,
// encode/decode the async poll token. No I/O here -- unit-tests without runtime or spend.

import type { FinishInput, FinishOutput } from "./contract";

/** Passthrough FinishOutput that records WHY the clip went through unchanged, so a real failure
 *  (misconfig / backend down) is never indistinguishable from the legitimate no-op -- the silent-
 *  degrade bug of #77. A genuine degrade tags `applied` with `passthrough:<reason>` and sets
 *  `degraded`; the intentional no-op tags `noop:<reason>` and leaves `degraded` unset. Pure: no I/O. */
export function passthroughOutput(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): FinishOutput {
  const degraded = opts.degraded ?? true;
  const out: FinishOutput = {
    shot_id: input.shot_id,
    clip_key: input.clip_key,
    out_fps: input.src_fps ?? 24,
    frames: input.frames ?? 0,
    applied: [`${degraded ? "passthrough" : "noop"}:${reason}`],
  };
  if (degraded) out.degraded = opts.detail ? `${reason}: ${opts.detail}` : reason;
  return out;
}

export interface UpscaleConfig {
  scale: number;   // final factor: 2 | 4
  model: string;   // RealESRGAN_x4plus (photoreal/general) | realesr-animevideov3 (anime/fast)
}

const MODELS = ["realesr-animevideov3", "RealESRGAN_x4plus"] as const;

// Default REVERTED to animevideov3: the #585 flip to RealESRGAN_x4plus CUDA-OOM'd every real
// finish job ("tried to allocate 45.7 GiB" -- the natively-4x RRDB model on a 48fps rife'd 720p
// clip; film-01bfda9c, all 5 shots). x4plus stays an explicit opt-in until the vivijure-upscale
// handler gains tiled inference for it (upscale v0.2.9 work); re-flip only after that proves out
// on a real render. The photoreal-texture rationale of #585 still stands -- the default follows
// the handler's proven memory envelope, not the wish.
export function defaultConfig(): UpscaleConfig {
  return { scale: 2, model: "realesr-animevideov3" };
}

export function coerceConfig(cfg: Record<string, unknown>): UpscaleConfig {
  const base = defaultConfig();
  const scale = Number(cfg.scale ?? base.scale);
  return {
    scale: scale >= 4 ? 4 : 2,   // integer factors; the handler clamps to 2/4 as well
    model: (MODELS as readonly string[]).includes(String(cfg.model)) ? String(cfg.model) : base.model,
  };
}

/** The upscaled clip lands beside the source with a `_up` suffix, so the original survives and the
 *  chain passes the new key downstream. `renders/p/clips/shot.mp4` -> `renders/p/clips/shot_up.mp4`. */
export function upscaledKey(clipKey: string): string {
  const dot = clipKey.lastIndexOf(".");
  return dot > clipKey.lastIndexOf("/") ? `${clipKey.slice(0, dot)}_up${clipKey.slice(dot)}` : `${clipKey}_up`;
}

/** The RunPod /run body for the dedicated vivijure-upscale endpoint (R2 mode: it reads `clip_key`
 *  and writes `output_key` in the shared bucket itself, exactly as vivijure-backend does for finish). */
export function buildRunPodBody(input: FinishInput, cfg: UpscaleConfig): { input: Record<string, unknown> } {
  return {
    input: {
      clip_key: input.clip_key,
      output_key: upscaledKey(input.clip_key),
      scale: cfg.scale,
      model: cfg.model,
      ...(input.output_hash ? { output_hash: input.output_hash } : {}), // #583: forward verbatim for the sidecar stamp
    },
  };
}

// --- poll token (same shape as the other finish modules) --------------------------------------

// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141).
export interface PollState {
  jobId: string;
  shotId: string;
  srcFps: number;
  frames: number;
  submittedAt?: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.shotId === "string") {
      return {
        jobId: o.jobId, shotId: o.shotId, srcFps: Number(o.srcFps) || 16, frames: Number(o.frames) || 0,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch { /* fall through */ }
  return null;
}

// How long after submit a RunPod "job not found" is treated as a propagation race vs a real GC.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did RunPod report this job as gone? A GC'd job returns HTTP 404 with a body like
 *  {"status":404,...} where `status` is the NUMBER 404, not a run state. (#141) */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: classify a gone job -- "gone-failed" past the grace window (or for a legacy token without
 *  submittedAt, where a 404 is a real GC not a fresh race); "gone-grace" while still inside it. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

/** What the vivijure-upscale endpoint returns on completion (R2 mode). */
export interface BackendOutput {
  shot_id?: string;
  clip_key?: string;   // the upscaled key (the handler echoes output_key here)
  out_fps?: number;
  frames?: number;
  applied?: string[];
}

export function parseBackendOutput(output: unknown): BackendOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  return {
    shot_id: typeof o.shot_id === "string" ? o.shot_id : undefined,
    clip_key: typeof o.clip_key === "string" ? o.clip_key : undefined,
    out_fps: typeof o.out_fps === "number" ? o.out_fps : undefined,
    frames: typeof o.frames === "number" ? o.frames : undefined,
    applied: Array.isArray(o.applied) ? (o.applied as string[]) : [],
  };
}

// Cold-start cap: on a VIRGIN host the image pull (10-20GB) can outlive the normal #141 grace window
// while /status 404s, so the first-ever job on a fresh endpoint false-failed ("GC'd or never ran")
// and only the warm retry succeeded. When the endpoint's /health shows no worker has EVER come up,
// the 404 means "still initializing", not "dropped" -- keep polling up to this cap instead.
export const RUNPOD_COLD_GRACE_MS = 900_000; // 15 min; the film pipeline's 90-min deadline still bounds it

/** Pure: has NO worker ever come up on this endpoint (ready/idle/running all 0) while one is still
 *  coming (initializing/throttled > 0)? That is the virgin-host image pull. A dead endpoint (nothing
 *  up, nothing coming) returns false so a gone job still fails instead of pending forever. */
export function workersStillCold(health: unknown): boolean {
  if (!health || typeof health !== "object") return false;
  const w = (health as Record<string, unknown>).workers;
  if (!w || typeof w !== "object") return false;
  const n = (k: string): number => {
    const v = (w as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const up = n("ready") + n("idle") + n("running");
  const coming = n("initializing") + n("throttled");
  return up === 0 && coming > 0;
}

/** Pure: did the backend report a TERMINAL error inside `output` while the RunPod envelope status
 *  never advanced? (F17: a handler error path that returns instead of raising leaves the job
 *  IN_PROGRESS forever -- billing the worker -- while output already carries
 *  {status:"error", error:{stage, message}}.) Returns the human error string, or null when the
 *  output is a normal progress snapshot. */
export function terminalErrorInOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" && e.message.length > 0
      ? e.message
      : JSON.stringify(e).slice(0, 200);
    const stage = typeof e.stage === "string" && e.stage.length > 0 ? " (stage: " + e.stage + ")" : "";
    return msg + stage;
  }
  if (typeof err === "string" && err.length > 0) return err;
  if (o.status === "error") return "backend reported status=error with no error detail";
  return null;
}
