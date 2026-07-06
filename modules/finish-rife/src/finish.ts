// Pure finish-rife logic: build the RunPod request body, parse the result, encode/decode the
// async poll token. No I/O here -- unit-tests without runtime or spend.

import type { FinishInput, FinishOutput } from "./contract";

/** Build the passthrough FinishOutput that records WHY the clip went through unchanged, so a real
 *  failure (misconfig / backend down) is never indistinguishable from the legitimate "nothing
 *  enabled" no-op -- the silent-degrade bug of #77. A genuine degrade tags `applied` with
 *  `passthrough:<reason>` and sets the `degraded` field; the intentional no-op tags
 *  `noop:<reason>` and leaves `degraded` unset. `detail` enriches the degraded note (and the
 *  caller's warn line) without bloating the short `applied` tag. Pure: no I/O, no logging -- the
 *  index worker does the console.warn, this just shapes the data. */
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

export interface FinishConfig {
  interpolate: boolean;
  interpolation_factor: number;
  face_restore: string;   // "none" | "gfpgan" | "codeformer"
  face_fidelity: number;
  only_faces: boolean;
}

export function defaultConfig(): FinishConfig {
  return { interpolate: true, interpolation_factor: 2, face_restore: "none", face_fidelity: 0.7, only_faces: true };
}

export function coerceConfig(cfg: Record<string, unknown>): FinishConfig {
  const base = defaultConfig();
  const factor = Number(cfg.interpolation_factor ?? base.interpolation_factor);
  // floor to the largest power-of-two <= factor (matches the backend int() truncation)
  const snapped = [8, 4, 2, 1].find(v => v <= factor) ?? 1;
  return {
    interpolate: typeof cfg.interpolate === "boolean" ? cfg.interpolate : base.interpolate,
    interpolation_factor: snapped,
    face_restore: ["none", "gfpgan", "codeformer"].includes(String(cfg.face_restore)) ? String(cfg.face_restore) : base.face_restore,
    face_fidelity: Math.min(1, Math.max(0, Number(cfg.face_fidelity ?? base.face_fidelity))),
    only_faces: typeof cfg.only_faces === "boolean" ? cfg.only_faces : base.only_faces,
  };
}

/** The RunPod /run body for vivijure-backend action="finish_clip". */
export function buildRunPodBody(input: FinishInput, cfg: FinishConfig, project: string): { input: Record<string, unknown> } {
  return {
    input: {
      action: "finish_clip",
      project,
      shot_id: input.shot_id,
      clip_key: input.clip_key,
      config: {
        interpolate: cfg.interpolate,
        interpolation_factor: cfg.interpolation_factor,
        face_restore: cfg.face_restore === "none" ? false : cfg.face_restore,
        face_fidelity: cfg.face_fidelity,
        only_faces: cfg.only_faces,
      },
      ...(input.output_hash ? { output_hash: input.output_hash } : {}), // #583: forward verbatim for the sidecar stamp
    },
  };
}

// --- poll token -------------------------------------------------------------------------------

// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141). Optional for
// back-compat with tokens issued before the field.
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

// How long after submit a RunPod "job not found" is treated as a propagation race vs a real GC. Mirrors
// the control plane's PHANTOM_GRACE_SECONDS (150s) so a momentary post-submit 404 never false-fails.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did RunPod report this job as gone? A GC'd job returns HTTP 404 with a body like
 *  {"status":404,"title":"Not Found",...} where `status` is the NUMBER 404, not a run state. (#141) */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: classify a gone job -- "gone-failed" past the grace window (or for a legacy token, where a 404
 *  is a real GC not a fresh race); "gone-grace" while still inside the window. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

/** What the vivijure-backend finish_clip action returns on completion. */
export interface BackendOutput {
  shot_id?: string;
  clip_key?: string;
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
