// openai-sora: a motion.backend module worker (vivijure-module/1), OpenAI Sora 2 I2V on RunPod.
// ASYNC: cloud i2v takes minutes, longer than a Worker request can hold, so:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit the job, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; finalize (download + store to R2) on completion
// The caller (the core / an orchestrator) polls /poll until it is no longer pending. Each call is
// fast (a status check; only the final one downloads), so nothing holds a multi-minute request.
//
// Phase 1 (#186): video-only. The sora-2-i2v RunPod endpoint exposes no audio output param; the
// core's score/mux chain owns audio, exactly like the seedance/hailuo reference.

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
import { buildSoraBody, extractVideoUrl, clipKey, clampDuration, encodePoll, decodePoll, runpodJobGone, classifyGoneState } from "./sora";

interface Env {
  RUNPOD_API_KEY: string;
  R2_RENDERS: { put(key: string, value: ArrayBuffer): Promise<unknown> };
}

const ENDPOINT = "https://api.runpod.ai/v2/sora-2-i2v";
const OUT_FPS = 24;

const MANIFEST: ModuleManifest = {
  name: "openai-sora",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "OpenAI Sora 2 (cloud i2v)" }],
  ui: { section: "motion", order: 80 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const auth = (env: Env) => ({ authorization: "Bearer " + env.RUNPOD_API_KEY });

/** /invoke: validate, submit to RunPod, return a poll token immediately. No blocking. */
async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.keyframe_url || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt" };
  }
  if (!env.RUNPOD_API_KEY) return { ok: false, error: "openai-sora: RUNPOD_API_KEY not configured" };
  try {
    const r = await fetch(ENDPOINT + "/run", {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify(buildSoraBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "openai-sora /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "openai-sora /run returned no job id" };
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, seconds: clampDuration(input.seconds), submittedAt: Date.now() }),
    };
  } catch (e) {
    return { ok: false, error: "openai-sora submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on completion download the clip + store it in R2 and return output. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "openai-sora: bad poll token" };
  if (!env.RUNPOD_API_KEY) return { ok: false, error: "openai-sora: RUNPOD_API_KEY not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(ENDPOINT + "/status/" + st.jobId, { headers: auth(env) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; poll again
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): the numeric 404 status would otherwise read as
  // "not COMPLETED" and the poll would report pending forever (issue #141). We download + write R2
  // only on COMPLETED, so a never-completed job has no recoverable artifact: past the grace window
  // (or a legacy token) fail the shot; inside it keep polling (post-submit race).
  if (runpodJobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return { ok: false, error: "openai-sora job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "openai-sora job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS

  const url = extractVideoUrl(s.output);
  if (!url) return { ok: false, error: "openai-sora output had no video url" };
  let bytes: ArrayBuffer;
  try {
    const v = await fetch(url);
    if (!v.ok) return { ok: false, error: "fetch openai-sora video -> " + v.status };
    bytes = await v.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download openai-sora video failed: " + (e as Error).message };
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
      if (!body || typeof body.poll !== "string") {
        return json({ ok: false, error: "poll token required" } as PollResponse);
      }
      return json(await poll(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
