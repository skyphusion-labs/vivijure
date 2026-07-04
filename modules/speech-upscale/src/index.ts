// speech-upscale: a `speech` module worker (vivijure-module/2). Dialogue SPEECH enhancement
// (resemble-enhance: denoise + restore + bandwidth-extend), dispatched to the dedicated
// vivijure-audio-upscale RunPod endpoint (CUDA). Pure audio: audio_key in -> enhanced audio_key out.
//
// The speech chain runs between the dialogue (TTS) phase and finish, so finish-lipsync (MuseTalk)
// drives off the cleaned audio. The orchestrator folds this module's output.audio_key back into
// job.dialogue_audio[shot] (a `degraded` output keeps the original, guarded by the core).
//
// ASYNC: GPU enhance exceeds a Worker request budget:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport: the endpoint reads `audio_key` and writes `output_key` itself, so this worker holds
// no R2 creds.
//
// POLISH step: a disabled toggle, a missing endpoint, OR an endpoint failure all SOFT-DEGRADE (input
// audio through unchanged, applied:[], `degraded` set) -- never a hard chain failure, never a fake
// success tag (#249/#77). The only hard ok:false is malformed input or a bad poll token.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type SpeechInput,
  type SpeechOutput,
} from "./contract";
import {
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput, passthroughOutput,
  successOutput, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput,
  RUNPOD_COLD_GRACE_MS, type PollState,
} from "./speech";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
}

const MANIFEST: ModuleManifest = {
  name: "speech-upscale",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["speech"],
  provides: [
    { id: "speech-upscale", label: "Clean dialogue audio (resemble-enhance)" },
  ],
  config_schema: {
    enable:  { type: "bool", default: false, label: "enhance dialogue audio (opt-in)" },
    denoise: { type: "bool", default: false, label: "extra denoise pass" },
  },
  ui: { section: "speech", icon: "wand", order: 10 },
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

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(apiKey: string, endpointId: string): Promise<boolean> {
  try {
    const r = await fetch(runpodBase(endpointId) + "/health", { headers: auth(apiKey) });
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to degrade away from: a hung-error job otherwise
 *  HOLDS the billed worker until someone cancels it by hand (F17 spend leak). Never throws. */
async function cancelRunpodJobBestEffort(apiKey: string, endpointId: string, jobId: string): Promise<void> {
  try {
    await fetch(runpodBase(endpointId) + "/cancel/" + jobId, { method: "POST", headers: auth(apiKey) });
  } catch {
    /* best-effort */
  }
}

/** Soft degrade: pass the input audio through unchanged, record `degraded`. `disabled` is the
 *  intentional opt-out (not warned); a real failure is warned so a misconfig/backend-down is never
 *  silent (#77). */
function passthrough(input: SpeechInput, reason: string, detail?: string): InvokeResponse<SpeechOutput> {
  if (reason !== "disabled") console.warn(`speech-upscale: passthrough (${reason}) shot=${input.shot_id}`);
  return { ok: true, output: passthroughOutput(input, reason, detail) };
}

/** Same soft-degrade, reconstructed from the stateless poll token (the input audio_key lives in it). */
function pollPassthrough(st: PollState, reason: string, detail?: string): PollResponse<SpeechOutput> {
  console.warn(`speech-upscale: poll passthrough (${reason}) shot=${st.shotId}`);
  return { ok: true, output: passthroughOutput({ shot_id: st.shotId, audio_key: st.audioKey }, reason, detail) };
}

async function submit(env: Env, req: InvokeRequest<SpeechInput>): Promise<InvokeResponse<SpeechOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.audio_key) {
    return { ok: false, error: "speech-upscale: input needs shot_id and audio_key" };
  }
  const cfg = coerceConfig(req.config);
  if (!cfg.enable) return passthrough(input, "disabled");              // opt-in off: clean no-op
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) return passthrough(input, "no-runpod-secrets");

  try {
    const r = await fetch(runpodBase(endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg)),
    });
    if (!r.ok) return passthrough(input, "runpod-run-failed", "HTTP " + r.status);
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input, "no-jobid");
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, shotId: input.shot_id, audioKey: input.audio_key, submittedAt: Date.now() }),
    };
  } catch (e) {
    return passthrough(input, "exception", (e as Error).message);
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<SpeechOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "speech-upscale: bad poll token" };
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) return pollPassthrough(st, "not-configured");

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(runpodBase(endpointId) + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = await resp.json() as typeof s;
  } catch {
    return { ok: true, pending: true };  // transient transport blip -> keep polling
  }
  // RunPod GC'd the job (HTTP 404 / numeric "status":404): inside the grace window it's a post-submit
  // race -> keep polling; past it the job is really gone -> SOFT-DEGRADE (polish step, never fail the
  // chain), lip-sync uses the original audio.
  if (runpodJobGone(httpStatus, s)) {
    const now = Date.now();
    if (classifyGoneState(st.submittedAt, now) === "gone-failed") {
      // Cold-start tolerance: a virgin host's image pull can outlive the grace window while the job
      // 404s. If no worker has EVER come up, keep polling up to the cold cap before degrading.
      if (
        classifyGoneState(st.submittedAt, now, RUNPOD_COLD_GRACE_MS) === "gone-grace" &&
        (await endpointStillCold(apiKey, endpointId))
      ) {
        return { ok: true, pending: true };
      }
      return pollPassthrough(st, "endpoint-gone");
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return pollPassthrough(st, "endpoint-failed", JSON.stringify(s.error ?? s).slice(0, 160));
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Cancel to stop the spend, then soft-degrade (polish step, never fail the chain).
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(apiKey, endpointId, st.jobId);
      return pollPassthrough(st, "endpoint-error", backendErr.slice(0, 160));
    }
    return { ok: true, pending: true };
  }

  const out = parseBackendOutput(s.output);
  // The endpoint soft-degrades (ok:false in its payload) on its own failures; without an output_key
  // there's no enhanced audio -> pass the original through. Otherwise return the cleaned key.
  if (!out?.output_key) return pollPassthrough(st, "no-output-key");
  return { ok: true, output: successOutput(st, out) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<SpeechInput>;
      try { req = await request.json() as InvokeRequest<SpeechInput>; }
      catch { return json({ ok: false, error: "invalid JSON body" } as InvokeResponse); }
      if (req.hook !== "speech") return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
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
