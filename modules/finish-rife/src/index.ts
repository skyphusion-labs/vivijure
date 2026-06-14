// finish-rife: a finish module worker (vivijure-module/1). RIFE frame interpolation + GFPGAN face
// restore, dispatched as action="finish_clip" to the shared vivijure-backend RunPod endpoint.
//
// ASYNC: GPU finishing takes 30s-3min, longer than a Worker request can hold:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// Failures are DATA, never an exception across the wire. For a chain hook the soft degrade
// (pass the input clip through unchanged) is preferred over a hard ok:false unless the job
// cannot be submitted at all.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type FinishInput,
  type FinishOutput,
} from "./contract";
import {
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput,
} from "./finish";

interface Env {
  RUNPOD_API_KEY: string;
  RUNPOD_ENDPOINT_ID: string;
}

const MANIFEST: ModuleManifest = {
  name: "finish-rife",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["finish"],
  provides: [
    { id: "interpolate", label: "Smooth motion (RIFE frame interpolation)" },
    { id: "face_restore", label: "Relock faces (GFPGAN)" },
  ],
  config_schema: {
    interpolate:          { type: "bool",  default: true,   label: "smooth motion" },
    interpolation_factor: { type: "int",   default: 2, min: 1, max: 8, label: "smoothness", enum_labels: { "1": "off", "2": "2x", "4": "4x", "8": "8x" } },
    face_restore:         { type: "enum",  values: ["none", "gfpgan", "codeformer"], default: "none", label: "face restore" },
    face_fidelity:        { type: "float", default: 0.7, min: 0, max: 1, label: "fidelity (0 = max restore, 1 = max fidelity)" },
    only_faces:           { type: "bool",  default: true,   label: "faces only (leave background untouched)" },
  },
  ui: { section: "finish", icon: "wand", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function runpodBase(env: Env): string {
  return `https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}`;
}

function auth(env: Env) {
  return { authorization: "Bearer " + env.RUNPOD_API_KEY };
}

/** Soft degrade: pass the input clip through unchanged (for a chain hook a no-op is better than a crash). */
function passthrough(input: FinishInput): InvokeResponse<FinishOutput> {
  return { ok: true, output: { shot_id: input.shot_id, clip_key: input.clip_key, out_fps: input.src_fps, frames: input.frames, applied: [] } };
}

async function submit(env: Env, req: InvokeRequest<FinishInput>): Promise<InvokeResponse<FinishOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.clip_key) {
    return { ok: false, error: "finish-rife: input needs shot_id and clip_key" };
  }
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return passthrough(input);  // not configured: pass through rather than hard-fail the chain
  }

  const cfg = coerceConfig(req.config);
  // If nothing is enabled, skip the GPU round-trip entirely.
  if (!cfg.interpolate && cfg.face_restore === "none") return passthrough(input);

  try {
    const r = await fetch(runpodBase(env) + "/run", {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg, req.context.project)),
    });
    if (!r.ok) return passthrough(input);   // RunPod unavailable: soft degrade
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input);
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, shotId: input.shot_id, srcFps: input.src_fps, frames: input.frames }),
    };
  } catch {
    return passthrough(input);
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "finish-rife: bad poll token" };
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) return { ok: false, error: "finish-rife: not configured" };

  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    s = await (await fetch(runpodBase(env) + "/status/" + st.jobId, { headers: auth(env) })).json() as typeof s;
  } catch {
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "finish-rife job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true };

  const out = parseBackendOutput(s.output);
  if (!out?.clip_key) return { ok: false, error: "finish-rife: backend returned no clip_key" };
  return {
    ok: true,
    output: {
      shot_id: out.shot_id ?? st.shotId,
      clip_key: out.clip_key,
      out_fps: out.out_fps ?? st.srcFps,
      frames: out.frames ?? st.frames,
      applied: out.applied ?? [],
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<FinishInput>;
      try { req = await request.json() as InvokeRequest<FinishInput>; }
      catch { return json({ ok: false, error: "invalid JSON body" } as InvokeResponse); }
      if (req.hook !== "finish") return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      return json(await submit(env, req));
    }

    if (request.method === "POST" && url.pathname === "/poll") {
      let body: PollRequest;
      try { body = await request.json() as PollRequest; }
      catch { return json({ ok: false, error: "invalid JSON body" } as PollResponse); }
      if (!body?.poll || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as PollResponse);
      return json(await poll(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
