// seedance: a motion.backend module worker (vivijure-module/2), ByteDance Seedance V1.5 Pro I2V on
// RunPod. ASYNC: cloud i2v takes minutes, longer than a Worker request can hold, so:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit the job, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; finalize (download + store to R2) on completion
// The caller (the core / an orchestrator) polls /poll until it is no longer pending. Each call is
// fast (a status check; only the final one downloads), so nothing holds a multi-minute request.
//
// Failures are DATA, never an exception across the wire.

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
import { buildSeedanceBody, extractVideoUrl, clipKey, clampDuration, MIN_DURATION, MAX_DURATION, RESOLUTIONS, DEFAULT_RESOLUTION, encodePoll, decodePoll, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS } from "./seedance";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  R2_RENDERS: { put(key: string, value: ArrayBuffer): Promise<unknown> };
}

const ENDPOINT = "https://api.runpod.ai/v2/seedance-v1-5-pro-i2v";
const OUT_FPS = 24;

const MANIFEST: ModuleManifest = {
  name: "seedance",
  version: "0.2.2",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Seedance V1.5 Pro (cloud i2v)" }],
  config_schema: {
    // values MUST stay = what the provider accepts (RESOLUTIONS, single source of truth): an
    // over-promising enum passes the core clamp and fails every shot at the provider after the
    // keyframe spend (#577).
    resolution: { type: "enum", values: RESOLUTIONS, default: DEFAULT_RESOLUTION, label: "resolution" },
    aspect_ratio: { type: "enum", values: ["16:9", "9:16", "1:1"], default: "16:9", label: "aspect ratio" },
    camera_fixed: { type: "bool", default: false, label: "lock camera" },
    generate_audio: { type: "bool", default: false, label: "generate audio" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "motion", order: 10, locality: "cloud", cost: "Pay per render", blurb: "Rents datacenter GPUs by the second -- top quality, scale-to-zero; you pay only for render seconds." },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const auth = (apiKey: string) => ({ authorization: "Bearer " + apiKey });

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(apiKey: string): Promise<boolean> {
  try {
    const r = await fetch(ENDPOINT + "/health", { headers: auth(apiKey) });
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to fail: a hung-error job otherwise HOLDS the
 *  billed worker until someone cancels it by hand (F17 spend leak). Never throws; the honest
 *  failure below is the point, the cancel is damage control. */
async function cancelRunpodJobBestEffort(apiKey: string, jobId: string): Promise<void> {
  try {
    await fetch(ENDPOINT + "/cancel/" + jobId, { method: "POST", headers: auth(apiKey) });
  } catch {
    /* best-effort */
  }
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

/** /invoke: validate, submit to RunPod, return a poll token immediately. No blocking. */
async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.keyframe_url || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt" };
  }
  const apiKey = await secretValue(env.RUNPOD_API_KEY);
  if (!apiKey) return { ok: false, error: "seedance: RUNPOD_API_KEY not configured" };
  // Non-silent duration snap (#279): seedance requires duration in [4, 12]; record when a sub-4s shot
  // is snapped up so the timing change is observable, never silent.
  const requestedDuration = Math.round(Number(input.seconds) || 5);
  const sentDuration = clampDuration(input.seconds);
  if (sentDuration !== requestedDuration) {
    console.log(
      "seedance shot " + input.shot_id + ": duration snapped " + requestedDuration + "s -> " +
      sentDuration + "s (endpoint allows [" + MIN_DURATION + ", " + MAX_DURATION + "])",
    );
  }
  try {
    const r = await fetch(ENDPOINT + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(buildSeedanceBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "seedance /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "seedance /run returned no job id" };
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, seconds: clampDuration(input.seconds), submittedAt: Date.now() }),
    };
  } catch (e) {
    return { ok: false, error: "seedance submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on completion download the clip + store it in R2 and return output. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "seedance: bad poll token" };
  const apiKey = await secretValue(env.RUNPOD_API_KEY);
  if (!apiKey) return { ok: false, error: "seedance: RUNPOD_API_KEY not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(ENDPOINT + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; poll again
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): the numeric 404 status would otherwise read as
  // "not COMPLETED" and the poll would report pending forever (issue #141). seedance downloads + writes
  // R2 only on COMPLETED, so a never-completed job has no recoverable artifact: past the grace window
  // (or a legacy token) fail the shot; inside it keep polling (post-submit race).
  if (runpodJobGone(httpStatus, s)) {
    const now = Date.now();
    if (classifyGoneState(st.submittedAt, now) === "gone-failed") {
      // Cold-start tolerance: a virgin host's image pull can outlive the grace window while the job
      // 404s. If no worker has EVER come up, this is "still initializing", not "dropped" -- keep
      // polling up to the cold cap instead of false-failing the first-ever job.
      if (
        classifyGoneState(st.submittedAt, now, RUNPOD_COLD_GRACE_MS) === "gone-grace" &&
        (await endpointStillCold(apiKey))
      ) {
        return { ok: true, pending: true };
      }
      return { ok: false, error: "seedance job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "seedance job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Surface the REAL error (never "not found") and cancel to stop the spend.
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(apiKey, st.jobId);
      return { ok: false, error: "seedance backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS
  }

  const url = extractVideoUrl(s.output);
  if (!url) return { ok: false, error: "seedance output had no video url" };
  let bytes: ArrayBuffer;
  try {
    const v = await fetch(url);
    if (!v.ok) return { ok: false, error: "fetch seedance video -> " + v.status };
    bytes = await v.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download seedance video failed: " + (e as Error).message };
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
