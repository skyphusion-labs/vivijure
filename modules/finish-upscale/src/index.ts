// finish-upscale: a finish module worker (vivijure-module/1). Real-ESRGAN spatial upscale (2x/4x),
// dispatched to the dedicated vivijure-upscale RunPod endpoint (CUDA; separate from vivijure-backend).
//
// ASYNC: GPU upscale runs frame-by-frame and exceeds a Worker request budget:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport: the endpoint reads `clip_key` and writes `output_key` in the shared bucket itself
// (exactly as vivijure-backend does for finish-rife), so this worker holds no R2 creds.
//
// Failures are DATA, never an exception across the wire. For a chain hook the soft degrade (pass the
// input clip through unchanged, but RECORDED) is preferred over a hard ok:false unless the job cannot
// be submitted at all.

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
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput, passthroughOutput,
  runpodJobGone, classifyGoneState,
} from "./finish";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
}

const MANIFEST: ModuleManifest = {
  name: "finish-upscale",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["finish"],
  provides: [
    { id: "upscale", label: "Upscale resolution (Real-ESRGAN)" },
  ],
  config_schema: {
    scale: { type: "int",  default: 2, min: 2, max: 4, label: "upscale factor", enum_labels: { "2": "2x", "4": "4x" } },
    model: { type: "enum", values: ["realesr-animevideov3", "RealESRGAN_x4plus"], default: "realesr-animevideov3", label: "model" },
  },
  ui: { section: "finish", icon: "expand", order: 20 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function runpodBase(endpointId: string): string {
  return `https://api.runpod.ai/v2/${endpointId}`;
}

function auth(apiKey: string) {
  return { authorization: "Bearer " + apiKey };
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value.
 *  Returns "" if unset/unreadable so the existing "not configured" guards still fire. */
async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  if (typeof s === "string") return s;
  if (!s) return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + (e as Error).message);
    return "";
  }
}

/** Resolve both RunPod secrets once per request. */
async function runpodCreds(env: Env): Promise<{ apiKey: string; endpointId: string }> {
  const [apiKey, endpointId] = await Promise.all([
    secretValue(env.RUNPOD_API_KEY),
    secretValue(env.RUNPOD_ENDPOINT_ID),
  ]);
  return { apiKey, endpointId };
}

/** Soft degrade: pass the input clip through unchanged (a no-op beats a crash in a chain), but ALWAYS
 *  record why -- `passthroughOutput` tags `applied` and sets `degraded`, so a real misconfig/backend
 *  failure is never indistinguishable from a legitimate no-op (#77). A real degrade is also warned. */
function passthrough(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): InvokeResponse<FinishOutput> {
  const output = passthroughOutput(input, reason, opts);
  if (output.degraded) console.warn(`finish-upscale: passthrough (${output.degraded}) shot=${input.shot_id}`);
  return { ok: true, output };
}

async function submit(env: Env, req: InvokeRequest<FinishInput>): Promise<InvokeResponse<FinishOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.clip_key) {
    return { ok: false, error: "finish-upscale: input needs shot_id and clip_key" };
  }
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) {
    return passthrough(input, "no-runpod-secrets");  // not configured: degrade, but say so
  }

  const cfg = coerceConfig(req.config);
  try {
    const r = await fetch(runpodBase(endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg)),
    });
    if (!r.ok) return passthrough(input, "runpod-run-failed", { detail: "HTTP " + r.status });
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input, "no-jobid");
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, shotId: input.shot_id, srcFps: input.src_fps ?? 24, frames: input.frames ?? 0, submittedAt: Date.now() }),
    };
  } catch (e) {
    return passthrough(input, "exception", { detail: (e as Error).message });
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "finish-upscale: bad poll token" };
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) return { ok: false, error: "finish-upscale: not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(runpodBase(endpointId) + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = await resp.json() as typeof s;
  } catch {
    return { ok: true, pending: true };
  }
  // RunPod GC'd the job (HTTP 404 / numeric "status":404): without this guard a 404 reads as
  // "not COMPLETED" and the poll reports pending forever (#141). Past the grace window fail; inside it
  // keep polling (post-submit race).
  if (runpodJobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return { ok: false, error: "finish-upscale job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "finish-upscale job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true };

  const out = parseBackendOutput(s.output);
  if (!out?.clip_key) return { ok: false, error: "finish-upscale: backend returned no clip_key" };
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
