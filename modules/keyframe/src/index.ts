// keyframe: a `keyframe` module worker (vivijure-module/1). Drives the vivijure-backend GPU render
// endpoint on RunPod in its keyframes-only mode (action=preview) to turn a project's storyboard into
// start keyframes -- the upstream stage the motion.backend orchestrator animates. Async like the
// other GPU modules: GET /module.json, POST /invoke (submit -> poll token), POST /poll (check
// GET /status, return the keyframe keys on completion). PROJECT-level: one job emits every shot's
// keyframe, reusing trained cast LoRAs -- never a per-shot job (that would re-train = GPU waste).
//
// The backend writes the keyframe PNGs to the shared `vivijure` R2 bucket itself (its own creds), so
// this module does no R2 I/O -- it just reports the keys; the core presigns them for the next stage.
// Failures are DATA (ok:false), never thrown across the wire.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type KeyframeInput,
  type KeyframeOutput,
} from "./contract";
import { buildPreviewBody, parseKeyframes, encodePoll, decodePoll, runpodJobGone, classifyGoneState } from "./keyframe";

interface Env {
  RUNPOD_API_KEY: string;
  // The vivijure-backend RunPod endpoint id. A SECRET (not hardcoded) so the public repo never
  // exposes the specific endpoint -- same rule as push-secrets.sh (#38).
  RUNPOD_ENDPOINT_ID: string;
}

const endpoint = (env: Env) => "https://api.runpod.ai/v2/" + env.RUNPOD_ENDPOINT_ID;
const auth = (env: Env) => ({ authorization: "Bearer " + env.RUNPOD_API_KEY });

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, issue #124) can assert
// this module's quality_tier enum stays in lockstep with the core QUALITY_TIERS set.
export const MANIFEST: ModuleManifest = {
  name: "keyframe",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["keyframe"],
  provides: [{ id: "gpu-keyframe", label: "GPU Keyframe (SDXL on RunPod)" }],
  config_schema: {
    quality_tier: {
      type: "enum",
      values: ["draft", "standard", "final"],
      default: "final",
      label: "quality tier",
    },
    // Default to a 16:9 landscape keyframe (SDXL-friendly 1344x768). Image-to-video backends conform
    // the clip to the KEYFRAME's aspect ratio (they ignore an aspect_ratio param once given an input
    // image), so a square keyframe forced square clips that the assembler then pillarboxed into 16:9
    // with black bars. A 16:9 keyframe makes the whole chain 16:9. Override via keyframe_config for
    // portrait/square. (fixes the square showcase clips)
    width: { type: "int", default: 1344, min: 512, max: 1536, label: "width" },
    height: { type: "int", default: 768, min: 512, max: 1536, label: "height" },
    steps: { type: "int", default: 30, min: 1, max: 60, label: "diffusion steps" },
    guidance_scale: { type: "float", default: 6.5, min: 0, max: 20, label: "guidance scale" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "keyframe", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function submit(env: Env, req: InvokeRequest<KeyframeInput>): Promise<InvokeResponse<KeyframeOutput>> {
  const input = req.input;
  if (!input || !input.project || !input.bundle_key) {
    return { ok: false, error: "keyframe: input needs project and bundle_key" };
  }
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return { ok: false, error: "keyframe: RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured" };
  }
  try {
    const r = await fetch(endpoint(env) + "/run", {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify(buildPreviewBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "keyframe /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "keyframe /run returned no job id" };
    return { ok: true, pending: true, poll: encodePoll({ jobId, project: input.project, submittedAt: Date.now() }) };
  } catch (e) {
    return { ok: false, error: "keyframe submit failed: " + (e as Error).message };
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<KeyframeOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "keyframe: bad poll token" };
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return { ok: false, error: "keyframe: RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured" };
  }

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(endpoint(env) + "/status/" + st.jobId, { headers: auth(env) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; caller polls again
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): the numeric 404 status would otherwise read as
  // "not COMPLETED" and the poll would report pending forever (issue #141). Past the grace window (or a
  // legacy token) fail; inside it keep polling (post-submit race).
  if (runpodJobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return { ok: false, error: "keyframe job not found on RunPod (GC'd or never ran); failing (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "keyframe job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true };

  const keyframes = parseKeyframes(s.output);
  if (!keyframes.length) return { ok: false, error: "keyframe job completed but returned no keyframes" };
  return { ok: true, output: { project: st.project, keyframes } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);
    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<KeyframeInput>;
      try {
        req = (await request.json()) as InvokeRequest<KeyframeInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "keyframe") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await submit(env, req));
    }
    if (request.method === "POST" && url.pathname === "/poll") {
      let body: PollRequest;
      try {
        body = (await request.json()) as PollRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as PollResponse);
      }
      if (!body || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as PollResponse);
      return json(await poll(env, body));
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
