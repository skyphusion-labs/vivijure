// Pure Seedance mapping/parsing: build the RunPod request body from a MotionBackendInput + the
// module config, and pull the result video URL out of a RunPod /status output. No I/O here, so it
// unit-tests without the runtime or any spend.

import type { MotionBackendInput } from "./contract";

// Seedance v1.5 Pro accepts a bounded shot length; clamp the storyboard's per-shot seconds in.
export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return Math.max(3, Math.min(12, n));
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
      resolution: String(cfg.resolution ?? "720p"),
      camera_fixed: !!cfg.camera_fixed,
      generate_audio: !!cfg.generate_audio,
      seed: typeof cfg.seed === "number" ? cfg.seed : -1,
    },
  };
}

/** RunPod video workers vary in output shape; find the first plausible video URL in the payload
 *  (prefers an .mp4). Walks strings, objects, and arrays defensively. */
export function extractVideoUrl(output: unknown): string | null {
  let firstHttp: string | null = null;
  const visit = (v: unknown): string | null => {
    if (typeof v === "string") {
      if (/^https?:\/\/\S+\.mp4(\?|$)/i.test(v)) return v;
      if (firstHttp === null && /^https?:\/\//i.test(v)) firstHttp = v;
      return null;
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        const hit = visit(x);
        if (hit) return hit;
      }
      return null;
    }
    if (v && typeof v === "object") {
      // check the common keys first, then everything
      const o = v as Record<string, unknown>;
      for (const k of ["video_url", "videoUrl", "url", "video", "output", "result", "assets"]) {
        if (k in o) {
          const hit = visit(o[k]);
          if (hit) return hit;
        }
      }
      for (const x of Object.values(o)) {
        const hit = visit(x);
        if (hit) return hit;
      }
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
