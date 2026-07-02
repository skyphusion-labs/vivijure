// alibaba-wan25: a motion.backend module worker (vivijure-module/1), Alibaba Wan 2.5 I2V on RunPod.
// ASYNC: cloud i2v takes minutes, longer than a Worker request can hold, so:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit the job, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; finalize (download + store to R2) on completion
// The caller (the core / an orchestrator) polls /poll until it is no longer pending. Each call is
// fast (a status check; only the final one downloads), so nothing holds a multi-minute request.
//
// Phase 1 (#187): video-only. Wan 2.5 has no audio output param; the core's score/mux chain owns
// audio, exactly like the Wan 2.6 (alibaba-wan) reference. Same input schema as Wan 2.6 -- only
// the RunPod endpoint slug differs.

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
import { buildWan25Body, extractVideoUrl, clipKey, clampDuration, encodePoll, decodePoll, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS } from "./wan25";

interface Env {
  RUNPOD_API_KEY: string;
  R2_RENDERS: { put(key: string, value: ArrayBuffer): Promise<unknown> };
}

const ENDPOINT = "https://api.runpod.ai/v2/wan-2-5";
const OUT_FPS = 24;

const MANIFEST: ModuleManifest = {
  name: "alibaba-wan25",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Alibaba Wan 2.5 (cloud i2v)" }],
  config_schema: {
    enable_prompt_expansion: { type: "bool", default: false, label: "expand prompt" },
  },
  ui: { section: "motion", order: 90, locality: "cloud", cost: "Pay per render", blurb: "Rents datacenter GPUs by the second -- top quality, scale-to-zero; you pay only for render seconds." },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const auth = (env: Env) => ({ authorization: "Bearer " + env.RUNPOD_API_KEY });

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(env: Env): Promise<boolean> {
  try {
    const r = await fetch(ENDPOINT + "/health", { headers: auth(env) });
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to fail: a hung-error job otherwise HOLDS the
 *  billed worker until someone cancels it by hand (F17 spend leak). Never throws; the honest
 *  failure below is the point, the cancel is damage control. */
async function cancelRunpodJobBestEffort(env: Env, jobId: string): Promise<void> {
  try {
    await fetch(ENDPOINT + "/cancel/" + jobId, { method: "POST", headers: auth(env) });
  } catch {
    /* best-effort */
  }
}


/** /invoke: validate, submit to RunPod, return a poll token immediately. No blocking. */
async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.keyframe_url || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt" };
  }
  if (!env.RUNPOD_API_KEY) return { ok: false, error: "alibaba-wan25: RUNPOD_API_KEY not configured" };
  try {
    const r = await fetch(ENDPOINT + "/run", {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify(buildWan25Body(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "alibaba-wan25 /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "alibaba-wan25 /run returned no job id" };
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, seconds: clampDuration(input.seconds), submittedAt: Date.now() }),
    };
  } catch (e) {
    return { ok: false, error: "alibaba-wan25 submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on completion download the clip + store it in R2 and return output. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "alibaba-wan25: bad poll token" };
  if (!env.RUNPOD_API_KEY) return { ok: false, error: "alibaba-wan25: RUNPOD_API_KEY not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(ENDPOINT + "/status/" + st.jobId, { headers: auth(env) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; poll again
  }
  if (runpodJobGone(httpStatus, s)) {
    const now = Date.now();
    if (classifyGoneState(st.submittedAt, now) === "gone-failed") {
      // Cold-start tolerance: a virgin host's image pull can outlive the grace window while the job
      // 404s. If no worker has EVER come up, this is "still initializing", not "dropped" -- keep
      // polling up to the cold cap instead of false-failing the first-ever job.
      if (
        classifyGoneState(st.submittedAt, now, RUNPOD_COLD_GRACE_MS) === "gone-grace" &&
        (await endpointStillCold(env))
      ) {
        return { ok: true, pending: true };
      }
      return { ok: false, error: "alibaba-wan25 job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "alibaba-wan25 job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Surface the REAL error (never "not found") and cancel to stop the spend.
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(env, st.jobId);
      return { ok: false, error: "alibaba-wan25 backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }

  const url = extractVideoUrl(s.output);
  if (!url) return { ok: false, error: "alibaba-wan25 output had no video url" };
  let bytes: ArrayBuffer;
  try {
    const v = await fetch(url);
    if (!v.ok) return { ok: false, error: "fetch alibaba-wan25 video -> " + v.status };
    bytes = await v.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download alibaba-wan25 video failed: " + (e as Error).message };
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
