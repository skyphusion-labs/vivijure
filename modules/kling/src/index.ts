// kling: a motion.backend module worker (vivijure-module/1), Kuaishou Kling V2.1 I2V Pro on RunPod.
// Async (same shape as seedance): GET /module.json, POST /invoke (submit -> poll token), POST /poll
// (check GET /status, finalize to R2 on completion). The second motion.backend backend -> the UI's
// pick_one hook now has a real choice. Failures are DATA.

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
import { buildKlingBody, extractVideoUrl, clipKey, clampDuration, encodePoll, decodePoll, runpodJobGone, classifyGoneState } from "./kling";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  R2_RENDERS: { put(key: string, value: ArrayBuffer): Promise<unknown> };
}

const ENDPOINT = "https://api.runpod.ai/v2/kling-v2-1-i2v-pro";
const OUT_FPS = 24;

const MANIFEST: ModuleManifest = {
  name: "kling",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Kling V2.1 Pro (cloud i2v)" }],
  config_schema: {
    guidance_scale: { type: "float", default: 0.5, min: 0, max: 1, label: "guidance scale" },
    negative_prompt: { type: "string", default: "", label: "negative prompt" },
    enable_safety_checker: { type: "bool", default: true, label: "safety checker" },
  },
  ui: { section: "motion", order: 20, locality: "cloud", cost: "Pay per render", blurb: "Rents datacenter GPUs by the second -- top quality, scale-to-zero; you pay only for render seconds." },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const auth = (apiKey: string) => ({ authorization: "Bearer " + apiKey });

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

async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.keyframe_url || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt" };
  }
  const apiKey = await secretValue(env.RUNPOD_API_KEY);
  if (!apiKey) return { ok: false, error: "kling: RUNPOD_API_KEY not configured" };
  try {
    const r = await fetch(ENDPOINT + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(buildKlingBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "kling /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "kling /run returned no job id" };
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, seconds: clampDuration(input.seconds), submittedAt: Date.now() }),
    };
  } catch (e) {
    return { ok: false, error: "kling submit failed: " + (e as Error).message };
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "kling: bad poll token" };
  const apiKey = await secretValue(env.RUNPOD_API_KEY);
  if (!apiKey) return { ok: false, error: "kling: RUNPOD_API_KEY not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(ENDPOINT + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true };
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): the numeric 404 status would otherwise read as
  // "not COMPLETED" and the poll would report pending forever (issue #141). kling downloads + writes R2
  // only on COMPLETED, so a never-completed job has no recoverable artifact: past the grace window (or a
  // legacy token) fail the shot; inside it keep polling (post-submit race).
  if (runpodJobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return { ok: false, error: "kling job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "kling job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true };

  const url = extractVideoUrl(s.output);
  if (!url) return { ok: false, error: "kling output had no video url" };
  let bytes: ArrayBuffer;
  try {
    const v = await fetch(url);
    if (!v.ok) return { ok: false, error: "fetch kling video -> " + v.status };
    bytes = await v.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download kling video failed: " + (e as Error).message };
  }
  const key = clipKey(st.project, st.shotId);
  try {
    await env.R2_RENDERS.put(key, bytes);
  } catch (e) {
    return { ok: false, error: "R2 put failed: " + (e as Error).message };
  }
  return { ok: true, output: { shot_id: st.shotId, clip_key: key, fps: OUT_FPS, frames: st.seconds * OUT_FPS } };
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
      if (!body || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as PollResponse);
      return json(await poll(env, body));
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
