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
  if (input.pretrained_loras && Object.keys(input.pretrained_loras).length) {
    body.pretrained_loras = { ...input.pretrained_loras };
  }
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

/** Extract the trained/reused LoRA R2 keys from the backend result. The handler returns
 *  RenderResult.to_dict() = { ..., lora: { <slot>: { lora_id: <r2 key> } } } for every slot it
 *  trained or reused; RunPod nests it under `output`. Returns slot -> R2 key (drops malformed). */
export function parseTrainedLoras(result: unknown): Record<string, string> {
  const root = (result && typeof result === "object" && "keyframes" in (result as object))
    ? (result as Record<string, unknown>)
    : ((result as { output?: unknown })?.output as Record<string, unknown> | undefined);
  const lora = root && root.lora && typeof root.lora === "object"
    ? (root.lora as Record<string, unknown>)
    : {};
  const out: Record<string, string> = {};
  for (const [slot, v] of Object.entries(lora)) {
    const id = v && typeof v === "object" ? (v as Record<string, unknown>).lora_id : undefined;
    if (typeof id === "string" && id) out[slot] = id;
  }
  return out;
}

// --- async poll token --------------------------------------------------------------------------

// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141). Optional for
// back-compat with tokens issued before the field.
export interface PollState {
  jobId: string;
  project: string;
  submittedAt?: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.project === "string") {
      return {
        jobId: o.jobId, project: o.project,
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
 *  {"status":404,"title":"Not Found",...} where `status` is the NUMBER 404, not a run state. (#141) */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: "gone-failed" past the grace window (or for a legacy token); "gone-grace" inside it. (#141) */
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
