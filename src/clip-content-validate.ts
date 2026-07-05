// #523 Layer 2: pixel-content clip validation at the film finish gate.
//
// Layer 1 (src/clip-validate.ts) rejects STRUCTURAL corruption in-Worker but cannot decode pixels, so a
// structurally-valid clip of pure latent noise (local-16gb#35: CogVideoX on a vGPU) passes it. Layer 2
// closes that: it asks the video-finish CPU container (which already runs ffmpeg, and is already the
// finish/assemble dependency) to look at the actual frames, at the SAME clip-intake seam, BEFORE the
// finish / upscale GPU spend. Bytes never touch the Worker: the core presigns GET URLs and the container
// fetches them (the /finish presign pattern).
//
// Posture (warn-and-degrade default, #523's false-positive concern -- deliberately-abstract films exist):
//   - "corrupt": the container is CONFIDENT (the clip's first frame does not resemble its conditioning
//     keyframe -- the #35 signature). FAIL the shot with the real reason, before finish/upscale spend.
//   - "suspect": the weaker content-only heuristic (chromatic-noise signature) fired. WARN: record a
//     degrade marker; the film still completes. Never a hard fail on the heuristic alone.
//   - "ok" / "skip": pass. "skip" = the tier is not installed (self-host), the container was unreachable,
//     or the inspect errored -- a down inspector must never fail a real render.
//
// Runs at the film finish gate ONLY (where finish/upscale spend happens), not on the standalone clips
// route (which has no downstream spend); Layer 1 covers that route.

import type { Env } from "./env";
import type { ClipJob } from "./render-orchestrator";
import { presignR2Get } from "./r2-presign";

const INSPECT_TTL_SECONDS = 1800;

/** The video-finish container's POST /inspect response (containers/video-finish/app.py + inspect_core.py). */
export interface InspectResult {
  ok: boolean;
  verdict: "ok" | "suspect" | "corrupt";
  reason?: string;
  metrics?: { sat_mean: number; gray_std_mean: number; chroma_structure_ratio: number; frames: number };
  keyframe_similarity?: number | null;
  error?: string;
}

/** Call the video-finish container's POST /inspect, retrying the transient gateway statuses (503/504) the
 *  way callVideoFinish does for /finish. backoffMs is injectable so tests do not wait. Returns the parsed
 *  result, or null on an unreachable container / non-JSON / non-2xx (the caller treats null as skip). */
export async function callVideoFinishInspect(
  env: Env,
  payload: { clipUrl: string; keyframeUrl?: string },
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<InspectResult | null> {
  if (!env.VIDEO_FINISH_VPC) return null; // tier not installed (stock self-host): skip, never fail
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  let resp: Response | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await env.VIDEO_FINISH_VPC.fetch("http://video-finish/inspect", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503 && resp.status !== 504) break;
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, backoffMs));
  }
  if (!resp || !resp.ok) return null;
  try {
    return (await resp.json()) as InspectResult;
  } catch {
    return null;
  }
}

export interface ContentVerdict {
  verdict: "ok" | "suspect" | "corrupt" | "skip";
  reason?: string;
  metrics?: InspectResult["metrics"];
  keyframe_similarity?: number | null;
}

/** Presign the clip (and its keyframe, when known) and ask the container for a content verdict. Skips
 *  honestly (never throws, never fails a render) when the tier is unavailable. */
export async function contentValidateClip(env: Env, clipKey: string, keyframeKey?: string): Promise<ContentVerdict> {
  if (!env.VIDEO_FINISH_VPC) return { verdict: "skip", reason: "video-finish tier not installed (VIDEO_FINISH_VPC unbound)" };
  let clipUrl: string;
  let keyframeUrl: string | undefined;
  try {
    clipUrl = await presignR2Get(env, clipKey, INSPECT_TTL_SECONDS);
    if (keyframeKey) keyframeUrl = await presignR2Get(env, keyframeKey, INSPECT_TTL_SECONDS);
  } catch (e) {
    return { verdict: "skip", reason: `presign failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = await callVideoFinishInspect(env, { clipUrl, keyframeUrl });
  if (!r || !r.ok || !r.verdict) return { verdict: "skip", reason: "video-finish /inspect unreachable or errored" };
  return { verdict: r.verdict, reason: r.reason, metrics: r.metrics, keyframe_similarity: r.keyframe_similarity };
}

/** #523 Layer 2 pass over a clip job's done clips, at the film finish gate. For each structurally-valid
 *  (Layer 1) done clip not yet content-checked, ask the container: a "corrupt" verdict FAILS the shot with
 *  the real reason BEFORE finish/upscale spend (honest failure); a "suspect" verdict records a warn/degrade
 *  marker and lets the film complete; "ok"/"skip" pass. Idempotent per shot (content_validated). Emits one
 *  `clip.content_validate` structured event per shot. Returns true iff it changed any shot; the CALLER owns
 *  the job-doc write. A no-op (returns false immediately) when the video-finish tier is not installed. */
export async function contentValidateDoneClips(
  env: Env,
  job: ClipJob,
  inspect: (env: Env, clipKey: string, keyframeKey?: string) => Promise<ContentVerdict> = contentValidateClip,
): Promise<boolean> {
  if (!env.VIDEO_FINISH_VPC) return false; // tier not installed: Layer 2 is unavailable, Layer 1 stands
  let changed = false;
  for (const shot of job.shots) {
    if (shot.status !== "done" || !shot.clip_key || shot.content_validated) continue;
    const v = await inspect(env, shot.clip_key, shot.keyframe_key);
    shot.content_validated = v.verdict;
    console.log(JSON.stringify({
      ev: "clip.content_validate",
      job_id: job.job_id,
      shot_id: shot.shot_id,
      verdict: v.verdict,
      ...(v.keyframe_similarity != null ? { keyframe_similarity: v.keyframe_similarity } : {}),
      ...(v.metrics ? { metrics: v.metrics } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
    }));
    if (v.verdict === "corrupt") {
      shot.status = "failed";
      shot.error = `clip failed content validation: ${v.reason ?? "does not resemble its keyframe"}`;
      shot.poll = undefined;
      changed = true;
    } else if (v.verdict === "suspect") {
      shot.content_degraded = v.reason ?? "chromatic-noise signature"; // warn-and-degrade: film still completes
      changed = true;
    }
  }
  return changed;
}
