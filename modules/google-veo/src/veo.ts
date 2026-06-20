// Pure Google Veo 3.1 Fast mapping/parsing: build the RunPod request body, parse the result
// video URL, and encode/decode the async poll token. No I/O here, so it unit-tests without the
// runtime or spend. The video-URL parse, poll token, and RunPod-GC helpers are shared, vendored
// per-module so the module stays independent (matches the seedance/hailuo reference).
//
// Phase 1 (#172): video-only. generate_audio defaults false; the core's score/mux chain owns audio,
// exactly like the seedance/hailuo reference. Expose generate_audio as an opt-in config bool so
// native Veo audio is a one-line enable later.

import type { MotionBackendInput } from "./contract";

// Veo 3.1 Fast only accepts the discrete values [4, 6, 8]. Snap to nearest; ties go to the lower
// allowed value. Default 6 when the input is zero/NaN (matches the #172 spec).
export function clampDuration(seconds: number): number {
  const n = Math.max(4, Math.min(8, Math.round(Number(seconds) || 6)));
  if (n <= 5) return 4;
  if (n <= 7) return 6;
  return 8;
}

/** The RunPod /run body for Veo 3.1 Fast, mapped from the hook input + the clamped module config. */
export function buildVeoBody(input: MotionBackendInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  return {
    input: {
      prompt: input.prompt,
      image: input.keyframe_url,
      aspect_ratio: "16:9",
      duration: clampDuration(input.seconds),
      resolution: "720p",
      generate_audio: cfg.generate_audio === true,
      seed: 0,
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
  return `renders/${safe(project)}/clips/${safe(shotId)}_veo.mp4`;
}

// --- async poll token --------------------------------------------------------------------------

// Everything /poll needs to finalize a job: the RunPod job id + where the clip belongs + its length.
// The token is opaque (base64 JSON) so the caller just round-trips it from /invoke to /poll.
// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141).
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
        jobId: o.jobId, project: o.project, shotId: o.shotId, seconds: Number(o.seconds) || 6,
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
 *  This module DOWNLOADS the provider video then writes R2 itself only on COMPLETED, so a never-
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
