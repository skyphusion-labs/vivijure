// narration-gen: a `score` module worker (vivijure-module/1). Synthesizes narration via MiniMax
// Speech 02 HD on RunPod's hosted endpoint, using the SAME async submit+poll transport as seedance/kling.
//
// ASYNC: a synth takes tens of seconds, longer than a Worker request can hold, so (NOT Workers AI /
// ctx.waitUntil, which the runtime cancels ~30s after the response -> pending forever, #155):
//   GET  /module.json -> manifest
//   POST /invoke      -> submit the RunPod job, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; finalize (download + store to R2) on COMPLETED
// Each /poll is fast (a status check; only the final one downloads), so nothing holds a multi-minute
// request, and the durable poll (runpodJobGone + grace, #141) survives a worker recycle.
//
// Failures are DATA (ok:false), never thrown across the wire. Muxing onto the film is video-finish's job.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type ScoreInput,
  type ScoreOutput,
} from "./contract";
import {
  MODEL,
  DEFAULT_VOICE,
  EMOTIONS,
  SAMPLE_RATES,
  FORMATS,
  buildSpeechBody,
  extractAudioUrl,
  mimeForFormat,
  encodePoll,
  decodePoll,
  audioKey,
  appliedTags,
  normalizeConfig,
  textFromScoreInput,
  runpodJobGone,
  classifyGoneState,
} from "./narration-gen";

interface R2Bucket {
  put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

interface Env {
  RUNPOD_API_KEY: string;
  R2_RENDERS: R2Bucket;
}

const ENDPOINT = "https://api.runpod.ai/v2/" + MODEL;

const MANIFEST: ModuleManifest = {
  name: "narration-gen",
  version: "0.2.0",
  api: MODULE_API,
  hooks: ["score"],
  provides: [{ id: "minimax-speech", label: "MiniMax Speech 02 HD (RunPod)" }],
  config_schema: {
    text: {
      type: "string",
      default: "",
      label: "narration script (blank = derive from storyboard)",
    },
    voice_id: {
      type: "string",
      default: DEFAULT_VOICE,
      label: "voice id",
    },
    emotion: {
      type: "enum",
      values: [...EMOTIONS],
      default: "neutral",
      label: "emotion",
    },
    format: { type: "enum", values: [...FORMATS], default: "mp3", label: "audio format" },
    pitch: { type: "int", default: 0, min: -12, max: 12, label: "pitch" },
    speed: { type: "float", default: 1, min: 0.5, max: 2, label: "speed" },
    volume: { type: "float", default: 1, min: 0, max: 10, label: "volume" },
    sample_rate: {
      type: "enum",
      values: SAMPLE_RATES.map(String),
      default: "44100",
      label: "sample rate",
    },
  },
  ui: { section: "score", order: 20 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const auth = (env: Env) => ({ authorization: "Bearer " + env.RUNPOD_API_KEY });

/** /invoke: validate, submit to RunPod, return a poll token immediately. No blocking. */
async function submit(env: Env, req: InvokeRequest<ScoreInput>): Promise<InvokeResponse<ScoreOutput>> {
  const input = req.input;
  const filmKey = typeof input?.film_key === "string" ? input.film_key.trim() : "";
  if (!filmKey) return { ok: false, error: "score: input.film_key required" };
  if (!env.RUNPOD_API_KEY) return { ok: false, error: "narration-gen: RUNPOD_API_KEY not configured" };

  const config = normalizeConfig(req.config ?? {});
  let body: { input: Record<string, unknown> };
  try {
    body = buildSpeechBody(textFromScoreInput({ ...input, film_key: filmKey }, config), config);
  } catch (e) {
    return { ok: false, error: "score: " + (e as Error).message };
  }

  const jobId = req.context?.job_id || crypto.randomUUID();
  const format = config.format ?? "mp3";
  const applied = appliedTags(format, config);
  try {
    const r = await fetch(ENDPOINT + "/run", {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: "narration-gen /run -> " + r.status };
    const runpodJobId = ((await r.json()) as { id?: string }).id;
    if (!runpodJobId) return { ok: false, error: "narration-gen /run returned no job id" };
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId: runpodJobId, job_id: jobId, film_key: filmKey, format, applied, submittedAt: Date.now() }),
    };
  } catch (e) {
    return { ok: false, error: "narration-gen submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on COMPLETED download the audio + store it in R2 and return the output. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<ScoreOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "narration-gen: bad poll token" };
  if (!env.RUNPOD_API_KEY) return { ok: false, error: "narration-gen: RUNPOD_API_KEY not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(ENDPOINT + "/status/" + st.jobId, { headers: auth(env) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; poll again
  }
  // RunPod GC'd the job (HTTP 404): would otherwise read as not-COMPLETED forever (#141). narration writes
  // R2 only on COMPLETED, so a gone job has no recoverable artifact: fail past grace, keep polling inside it.
  if (runpodJobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return { ok: false, error: "narration-gen job not found on RunPod (GC'd or never ran) (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "narration-gen job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS

  const url = extractAudioUrl(s.output);
  if (!url) return { ok: false, error: "narration-gen output had no audio url" };
  let bytes: ArrayBuffer;
  let mime: string;
  try {
    const a = await fetch(url);
    if (!a.ok) return { ok: false, error: "fetch narration audio -> " + a.status };
    mime = a.headers.get("content-type")?.split(";")[0]?.trim() || mimeForFormat(st.format);
    bytes = await a.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download narration audio failed: " + (e as Error).message };
  }
  const key = audioKey(st.job_id, st.format);
  try {
    await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  } catch (e) {
    return { ok: false, error: "R2 put failed: " + (e as Error).message };
  }
  return { ok: true, output: { film_key: st.film_key, applied: [...st.applied, `audio:${key}`] } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<ScoreInput>;
      try {
        req = (await request.json()) as InvokeRequest<ScoreInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "score") {
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
