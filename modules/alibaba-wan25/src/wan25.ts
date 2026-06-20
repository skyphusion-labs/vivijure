// Pure Alibaba Wan 2.5 mapping/parsing: build the RunPod request body, parse the result video URL,
// and encode/decode the async poll token. No I/O here, so it unit-tests without the runtime or
// spend. The video-URL parse, poll token, and RunPod-GC helpers are shared, vendored per-module
// so the module stays independent (matches the seedance/hailuo reference).
//
// Phase 1 (#187): video-only. Wan 2.5 has no audio output param; the core's score/mux chain owns
// audio, exactly like the Wan 2.6 (alibaba-wan) reference. Same input schema as Wan 2.6 -- only
// the RunPod endpoint slug differs (wan-2-5 vs wan-2-6-i2v).

import type { MotionBackendInput } from "./contract";

// Wan 2.5 accepts approximately 3-10 seconds per shot; clamp the storyboard's per-shot value in.
// Default 5 when the input is zero/NaN (matches Wan 2.6 default).
export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return Math.max(3, Math.min(10, n));
}

/** The RunPod /run body for Wan 2.5, mapped from the hook input + clamped module config.
 *  Same schema as Wan 2.6; enable_prompt_expansion defaults false, enable_safety_checker always on. */
export function buildWan25Body(input: MotionBackendInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  return {
    input: {
      prompt: input.prompt,
      image: input.keyframe_url,
      negative_prompt: "",
      size: "720p",
      duration: clampDuration(input.seconds),
      shot_type: "single",
      seed: -1,
      enable_prompt_expansion: cfg.enable_prompt_expansion === true,
      enable_safety_checker: true,
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
  return `renders/${safe(project)}/clips/${safe(shotId)}_wan25.mp4`;
}

// --- async poll token --------------------------------------------------------------------------

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

export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}
