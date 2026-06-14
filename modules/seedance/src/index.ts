// seedance: a motion.backend module worker (vivijure-module/1) wrapping ByteDance Seedance V1.5 Pro
// I2V on RunPod. GET /module.json -> manifest; POST /invoke -> submit a keyframe + motion prompt to
// the Seedance endpoint, poll to completion, store the clip in R2, return MotionBackendOutput.
//
// Failures are DATA: a bad request, a failed/late job, or a download error all return { ok:false },
// so the core degrades (this is a pick_one hook -> the core can fall back to its built-in path).

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type MotionBackendInput,
  type MotionBackendOutput,
} from "./contract";
import { buildSeedanceBody, extractVideoUrl, clipKey, clampDuration } from "./seedance";

interface Env {
  RUNPOD_API_KEY: string;
  R2_RENDERS: { put(key: string, value: ArrayBuffer): Promise<unknown> };
}

const ENDPOINT = "https://api.runpod.ai/v2/seedance-v1-5-pro-i2v";
const OUT_FPS = 24; // Seedance output fps (used to estimate frame count)
const POLL_MS = 4000;
const POLL_MAX = 45; // ~3 minutes ceiling, then a graceful timeout

const MANIFEST: ModuleManifest = {
  name: "seedance",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Seedance V1.5 Pro (cloud i2v)" }],
  config_schema: {
    resolution: { type: "enum", values: ["480p", "720p", "1080p"], default: "720p", label: "resolution" },
    aspect_ratio: { type: "enum", values: ["16:9", "9:16", "1:1"], default: "16:9", label: "aspect ratio" },
    camera_fixed: { type: "bool", default: false, label: "lock camera" },
    generate_audio: { type: "bool", default: false, label: "generate audio" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "motion", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const auth = (env: Env) => ({ authorization: "Bearer " + env.RUNPOD_API_KEY });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runSeedance(
  env: Env,
  req: InvokeRequest<MotionBackendInput>,
): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.keyframe_url || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt" };
  }
  if (!env.RUNPOD_API_KEY) return { ok: false, error: "seedance: RUNPOD_API_KEY not configured" };

  // 1. submit
  let jobId: string | undefined;
  try {
    const r = await fetch(ENDPOINT + "/run", {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify(buildSeedanceBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "seedance /run -> " + r.status };
    jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "seedance /run returned no job id" };
  } catch (e) {
    return { ok: false, error: "seedance submit failed: " + (e as Error).message };
  }

  // 2. poll to completion
  let output: unknown;
  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(POLL_MS);
    let s: { status?: string; output?: unknown; error?: unknown };
    try {
      s = (await (await fetch(ENDPOINT + "/status/" + jobId, { headers: auth(env) })).json()) as typeof s;
    } catch {
      continue; // transient; keep polling
    }
    if (s.status === "COMPLETED") {
      output = s.output;
      break;
    }
    if (s.status === "FAILED") {
      return { ok: false, error: "seedance job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
    }
  }
  if (output === undefined) return { ok: false, error: "seedance job did not complete within the poll window" };

  // 3. fetch the video + store it in R2
  const url = extractVideoUrl(output);
  if (!url) return { ok: false, error: "seedance output had no video url" };
  let bytes: ArrayBuffer;
  try {
    const v = await fetch(url);
    if (!v.ok) return { ok: false, error: "fetch seedance video -> " + v.status };
    bytes = await v.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download seedance video failed: " + (e as Error).message };
  }
  const key = clipKey(req.context.project, input.shot_id);
  try {
    await env.R2_RENDERS.put(key, bytes);
  } catch (e) {
    return { ok: false, error: "R2 put failed: " + (e as Error).message };
  }

  return {
    ok: true,
    output: { shot_id: input.shot_id, clip_key: key, fps: OUT_FPS, frames: clampDuration(input.seconds) * OUT_FPS },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);
    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<MotionBackendInput>;
      try {
        req = (await request.json()) as InvokeRequest<MotionBackendInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "motion.backend") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await runSeedance(env, req));
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
