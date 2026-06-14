// Pure keyframe mapping/parsing: build the vivijure-backend RunPod request (action=preview, the
// keyframes-only pass), parse the keyframes out of the result, and encode/decode the async poll
// token. No I/O here, so it unit-tests without the runtime, the GPU, or spend.

import type { KeyframeInput, KeyframeShot } from "./contract";

const TIERS = ["draft", "standard", "final"] as const;
type Tier = (typeof TIERS)[number];

/** Clamp a quality tier to one the backend accepts (default "final"). */
export function clampTier(v: unknown): Tier {
  return (TIERS as readonly string[]).includes(v as string) ? (v as Tier) : "final";
}

/** The render_overrides.keyframe block, built from the module config -- only fields the user set,
 *  so the backend's own defaults stand otherwise. */
function keyframeOverrides(cfg: Record<string, unknown>): Record<string, number> {
  const o: Record<string, number> = {};
  const num = (k: string, src: string) => {
    if (typeof cfg[src] === "number" && Number.isFinite(cfg[src] as number)) o[k] = cfg[src] as number;
  };
  num("width", "width");
  num("height", "height");
  num("steps", "steps");
  num("guidance_scale", "guidance_scale");
  // seed: -1 means "let the backend randomize", so only pass a real seed
  if (typeof cfg.seed === "number" && (cfg.seed as number) >= 0) o.seed = cfg.seed as number;
  return o;
}

/** The RunPod /run body for a keyframes-only (preview) render of a project, mapped from the hook
 *  input + the clamped module config. */
export function buildPreviewBody(input: KeyframeInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  const body: Record<string, unknown> = {
    action: "preview", // keyframes only: train/reuse LoRA -> SDXL keyframes, NO i2v, NO mp4
    project: input.project,
    bundle_key: input.bundle_key,
    quality_tier: clampTier(cfg.quality_tier),
  };
  const kf = keyframeOverrides(cfg);
  if (Object.keys(kf).length) body.render_overrides = { keyframe: kf };
  if (input.shot_ids && input.shot_ids.length) body.process_shot_ids = input.shot_ids;
  return { input: body };
}

/** Extract the generated keyframes from the backend result. The handler returns
 *  RenderResult.to_dict() = { keyframes: [{shot_id, key}], ... }; RunPod nests it under `output`.
 *  Accept either the raw result or the {output:...} wrapper, and either `key` or `keyframe_key`. */
export function parseKeyframes(result: unknown): KeyframeShot[] {
  const root = (result && typeof result === "object" && "keyframes" in (result as object))
    ? (result as Record<string, unknown>)
    : ((result as { output?: unknown })?.output as Record<string, unknown> | undefined);
  const arr = root && Array.isArray(root.keyframes) ? (root.keyframes as unknown[]) : [];
  const out: KeyframeShot[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const shot_id = typeof o.shot_id === "string" ? o.shot_id : null;
    const key = typeof o.key === "string" ? o.key : typeof o.keyframe_key === "string" ? o.keyframe_key : null;
    if (shot_id && key) out.push({ shot_id, keyframe_key: key });
  }
  return out;
}

// --- async poll token --------------------------------------------------------------------------

export interface PollState {
  jobId: string;
  project: string;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.project === "string") {
      return { jobId: o.jobId, project: o.project };
    }
  } catch {
    /* fall through */
  }
  return null;
}
