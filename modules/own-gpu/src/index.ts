// own-gpu: a motion.backend module worker (vivijure-module/1) that renders image-to-video on YOUR
// OWN GPU via the vivijure-backend RunPod serverless endpoint (Wan2.2-I2V), the i2v_clip action.
// This is the BYO-GPU default -- no rent, own keys -- so it sorts ahead of the cloud i2v modules.
//
// Unlike a cloud i2v module, the backend SHARES our R2 bucket: it reads the keyframe by key and
// WRITES the finished clip itself, returning the clip_key. So this module never downloads or
// re-uploads -- it submits, polls, and surfaces the key the backend reported.
//
// ASYNC (GPU generation + a cold worker exceed a single Worker request):
//   GET  /module.json -> manifest
//   POST /invoke      -> submit i2v_clip, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; surface the clip on completion
// The caller polls /poll until it is no longer pending. Failures are DATA, never an exception.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type MotionBackendInput,
  type MotionBackendOutput,
} from "./contract";
import { buildI2vBody, readOutput, encodePoll, decodePoll } from "./i2v";

interface Env {
  RUNPOD_API_KEY: string;
  RUNPOD_ENDPOINT_ID: string;
}

const MANIFEST: ModuleManifest = {
  name: "own-gpu",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-own-gpu", label: "Own GPU (Wan2.2 i2v)" }],
  config_schema: {
    quality: { type: "enum", values: ["draft", "standard", "final"], default: "standard", label: "quality" },
    fps: { type: "int", default: 16, min: 8, max: 30, label: "fps" },
    flow_shift: { type: "float", default: 5.0, min: 1, max: 12, label: "motion (flow shift, lower = faster)" },
    negative_prompt: { type: "string", default: "", label: "negative prompt (additive)" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "motion", order: 5 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const auth = (env: Env) => ({ authorization: "Bearer " + env.RUNPOD_API_KEY });
const endpoint = (env: Env) => "https://api.runpod.ai/v2/" + env.RUNPOD_ENDPOINT_ID;
const configured = (env: Env) => Boolean(env.RUNPOD_API_KEY && env.RUNPOD_ENDPOINT_ID);

/** /invoke: validate, submit the i2v_clip job to our backend, return a poll token immediately. */
async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id and prompt" };
  }
  if (!configured(env)) return { ok: false, error: "own-gpu: RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured" };
  try {
    const r = await fetch(endpoint(env) + "/run", {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify(buildI2vBody(input, req.config, req.context.project)),
    });
    if (!r.ok) return { ok: false, error: "own-gpu /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "own-gpu /run returned no job id" };
    return { ok: true, pending: true, poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id }) };
  } catch (e) {
    return { ok: false, error: "own-gpu submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on completion the backend has already stored the clip in R2, so we
 *  just surface the clip_key it reported. No download, no re-upload. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "own-gpu: bad poll token" };
  if (!configured(env)) return { ok: false, error: "own-gpu: RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured" };

  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    s = (await (await fetch(endpoint(env) + "/status/" + st.jobId, { headers: auth(env) })).json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; poll again
  }
  if (s.status === "FAILED") return { ok: false, error: "own-gpu job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS

  const output = readOutput(st.shotId, s.output);
  if (!output) return { ok: false, error: "own-gpu output had no clip_key" };
  return { ok: true, output };
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
      return json(await submit(env, req));
    }

    if (request.method === "POST" && url.pathname === "/poll") {
      let body: PollRequest;
      try {
        body = (await request.json()) as PollRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as PollResponse);
      }
      if (!body || typeof body.poll !== "string") {
        return json({ ok: false, error: "poll token required" } as PollResponse);
      }
      return json(await poll(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
