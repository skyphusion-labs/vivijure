// Pure Seedance mapping/parsing: build the RunPod request body, parse the result video URL, and
// encode/decode the async poll token. No I/O here, so it unit-tests without the runtime or spend.

import type { MotionBackendInput } from "./contract";

// Seedance v1.5 Pro accepts a CONTINUOUS duration of 4-12 seconds: the endpoint 400s on 3 or below
// ("Invalid duration ... Must be between 4 and 12 seconds", #279). Clamp the per-shot seconds into
// [4, 12]; a below-range value snaps UP to MIN_DURATION and is RECORDED at the call site, never a
// silent change to the user's timing.
export const MIN_DURATION = 4;
export const MAX_DURATION = 12;

// The resolutions the Seedance V1.5 Pro endpoint ACCEPTS. The manifest's config_schema enum is
// built from this list so schema and provider cannot drift apart again: advertising 1080p while the
// provider 400s it ("Invalid resolution: '1080p'. Must be '480p' or '720p'") failed every shot of a
// film AFTER its keyframe spend (#577, film-c9c44dcc).
export const RESOLUTIONS = ["480p", "720p"];
export const DEFAULT_RESOLUTION = "720p";
export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, n));
}

/** The RunPod /run body for Seedance, mapped from the hook input + the clamped module config. */
export function buildSeedanceBody(input: MotionBackendInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  return {
    input: {
      prompt: input.prompt,
      image: input.keyframe_url,
      duration: clampDuration(input.seconds),
      aspect_ratio: String(cfg.aspect_ratio ?? "16:9"),
      resolution: String(cfg.resolution ?? DEFAULT_RESOLUTION),
      camera_fixed: !!cfg.camera_fixed,
      generate_audio: !!cfg.generate_audio,
      seed: typeof cfg.seed === "number" ? cfg.seed : -1,
    },
  };
}

/** RunPod video workers vary in output shape; find the first plausible video URL (prefers an .mp4). */
export function extractVideoUrl(output: unknown): string | null {
  let firstHttp: string | null = null;
  const visit = (v: unknown): string | null => {
    if (typeof v === "string") {
      if (/^https?:\/\/\S+\.mp4(\?|$)/i.test(v)) return v;
      if (firstHttp === null && /^https?:\/\//i.test(v)) firstHttp = v;
      return null;
    }
    if (Array.isArray(v)) {
      for (const x of v) { const hit = visit(x); if (hit) return hit; }
      return null;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["video_url", "videoUrl", "url", "video", "output", "result", "assets"]) {
        if (k in o) { const hit = visit(o[k]); if (hit) return hit; }
      }
      for (const x of Object.values(o)) { const hit = visit(x); if (hit) return hit; }
    }
    return null;
  };
  return visit(output) ?? firstHttp;
}

/** The R2 key the rendered clip is stored under, per shot. */
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_seedance.mp4`;
}

// --- async poll token --------------------------------------------------------------------------

// Everything /poll needs to finalize a job: the RunPod job id + where the clip belongs + its length.
// The token is opaque (base64 JSON) so the caller just round-trips it from /invoke to /poll.
// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141). Optional for
// back-compat with tokens issued before the field.
export interface PollState {
  jobId: string;
  project: string;
  shotId: string;
  seconds: number;
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
        jobId: o.jobId, project: o.project, shotId: o.shotId, seconds: Number(o.seconds) || 5,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// How long after submit a RunPod "job not found" is treated as a propagation race vs a real GC. Mirrors
// the control plane's PHANTOM_GRACE_SECONDS (150s) so a momentary post-submit 404 never false-fails.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did RunPod report this job as gone? A GC'd job returns HTTP 404 with a body like
 *  {"status":404,"title":"Not Found",...} where `status` is the NUMBER 404, not a run state. (#141)
 *  seedance/kling DOWNLOAD the provider video then write R2 themselves only on COMPLETED, so a never-
 *  completed job has no recoverable artifact -- the only correct behavior past grace is to FAIL. */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: "gone-failed" past the grace window (or a legacy token); "gone-grace" inside it. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
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
