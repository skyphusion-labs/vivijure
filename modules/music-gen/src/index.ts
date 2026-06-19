// music-gen: a `score` module worker (vivijure-module/1). Generates a music bed via MiniMax Music
// 2.6 through Workers AI + the AI Gateway for the music / narration / beat-sync chain.
//
// ASYNC: generation blocks ~30-90s, so:
//   GET  /module.json -> manifest
//   POST /invoke      -> validate ScoreInput, persist run state, kick off background generation, return poll
//   POST /poll        -> read run state; pending until done -> ScoreOutput
//
// Failures are DATA (ok:false), never thrown across the wire.

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
  BITRATES,
  SAMPLE_RATES,
  FORMATS,
  buildMusicParams,
  parseAudioUrl,
  mimeForFormat,
  encodePoll,
  decodePoll,
  stateKey,
  audioKey,
  appliedTags,
  readOutput,
  normalizeConfig,
  promptFromScoreInput,
  type RunState,
} from "./music-gen";

interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

interface AiRun {
  run(model: string, params: unknown, opts?: { gateway?: { id: string } }): Promise<unknown>;
}

interface Env {
  AI: AiRun;
  GATEWAY_ID: string;
  R2_RENDERS: R2Bucket;
}

const MANIFEST: ModuleManifest = {
  name: "music-gen",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["score"],
  provides: [{ id: "minimax-music", label: "MiniMax Music 2.6 (Workers AI)" }],
  config_schema: {
    prompt: {
      type: "string",
      default: "",
      label: "music prompt (blank = derive from storyboard)",
    },
    lyrics: {
      type: "string",
      default: "",
      label: "lyrics (optional; blank uses [Instrumental] unless auto-generating)",
    },
    is_instrumental: { type: "bool", default: true, label: "instrumental (no vocals)" },
    lyrics_optimizer: { type: "bool", default: false, label: "auto-generate lyrics from prompt" },
    format: { type: "enum", values: [...FORMATS], default: "mp3", label: "audio format" },
    bitrate: {
      type: "enum",
      values: BITRATES.map(String),
      default: "128000",
      label: "bitrate",
    },
    sample_rate: {
      type: "enum",
      values: SAMPLE_RATES.map(String),
      default: "44100",
      label: "sample rate",
    },
  },
  ui: { section: "score", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function writeState(env: Env, jobId: string, state: RunState): Promise<void> {
  await env.R2_RENDERS.put(stateKey(jobId), JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function readState(env: Env, jobId: string): Promise<RunState | null> {
  const obj = await env.R2_RENDERS.get(stateKey(jobId));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as RunState;
  } catch {
    return null;
  }
}

async function runGeneration(
  env: Env,
  jobId: string,
  input: ScoreInput,
  config: ReturnType<typeof normalizeConfig>,
): Promise<void> {
  const format = config.format ?? "mp3";
  const applied = appliedTags(format, config);
  try {
    if (!env.GATEWAY_ID) throw new Error("GATEWAY_ID not configured");
    const prompt = promptFromScoreInput(input, config);
    const params = buildMusicParams(prompt, config);
    const result = await env.AI.run(MODEL, params, { gateway: { id: env.GATEWAY_ID } });
    const url = parseAudioUrl(result);
    if (!url) throw new Error("model completed but returned no audio URL");
    const aresp = await fetch(url);
    if (!aresp.ok) throw new Error(`audio fetch ${aresp.status}`);
    const mime = aresp.headers.get("content-type")?.split(";")[0]?.trim() || mimeForFormat(format);
    const bytes = await aresp.arrayBuffer();
    const key = audioKey(jobId, format);
    await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
    await writeState(env, jobId, {
      status: "done",
      film_key: input.film_key,
      audio_key: key,
      mime,
      applied: [...applied, `audio:${key}`],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeState(env, jobId, { status: "failed", error: msg.slice(0, 500), applied });
  }
}

async function submit(
  env: Env,
  ctx: ExecutionContext,
  req: InvokeRequest<ScoreInput>,
): Promise<InvokeResponse<ScoreOutput>> {
  const input = req.input;
  const filmKey = typeof input?.film_key === "string" ? input.film_key.trim() : "";
  if (!filmKey) return { ok: false, error: "score: input.film_key required" };
  if (!env.GATEWAY_ID) return { ok: false, error: "score: GATEWAY_ID not configured" };

  const config = normalizeConfig(req.config ?? {});
  const scoredInput = { ...input, film_key: filmKey };
  try {
    buildMusicParams(promptFromScoreInput(scoredInput, config), config);
  } catch (e) {
    return { ok: false, error: "score: " + (e as Error).message };
  }

  const jobId = req.context?.job_id || crypto.randomUUID();
  const applied = appliedTags(config.format ?? "mp3", config);
  try {
    await writeState(env, jobId, {
      status: "running",
      started_at: Math.floor(Date.now() / 1000),
      film_key: filmKey,
      applied,
    });
  } catch (e) {
    return { ok: false, error: "score: could not persist run state: " + (e as Error).message };
  }

  ctx.waitUntil(runGeneration(env, jobId, { ...input, film_key: filmKey }, config));
  return { ok: true, pending: true, poll: encodePoll({ job_id: jobId }) };
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<ScoreOutput>> {
  const token = decodePoll(body.poll);
  if (!token) return { ok: false, error: "score: bad poll token" };
  const state = await readState(env, token.job_id);
  if (!state) return { ok: false, error: "score: run state not found (expired or bad token)" };
  if (state.status === "running") return { ok: true, pending: true };
  if (state.status === "failed") return { ok: false, error: state.error || "generation failed" };
  return { ok: true, output: readOutput(state) };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      return json(await submit(env, ctx, req));
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
