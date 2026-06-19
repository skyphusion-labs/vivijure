// Pure Kling mapping/parsing: build the RunPod request body, parse the result video URL, and
// encode/decode the async poll token. No I/O here, so it unit-tests without the runtime or spend.

import type { MotionBackendInput } from "./contract";

// Kling v2.1 Pro accepts a bounded shot length; clamp the storyboard's per-shot seconds in.
export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return Math.max(3, Math.min(10, n));
}

/** The RunPod /run body for Kling, mapped from the hook input + the clamped module config. */
export function buildKlingBody(input: MotionBackendInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  return {
    input: {
      prompt: input.prompt,
      image: input.keyframe_url,
      negative_prompt: String(cfg.negative_prompt ?? ""),
      guidance_scale: typeof cfg.guidance_scale === "number" ? cfg.guidance_scale : 0.5,
      duration: clampDuration(input.seconds),
      enable_safety_checker: cfg.enable_safety_checker !== false,
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
  return `renders/${safe(project)}/clips/${safe(shotId)}_kling.mp4`;
}

// --- async poll token --------------------------------------------------------------------------

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
 *  kling DOWNLOADS the provider video then writes R2 itself only on COMPLETED, so a never-completed job
 *  has no recoverable artifact -- the only correct behavior past grace is to FAIL. */
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
