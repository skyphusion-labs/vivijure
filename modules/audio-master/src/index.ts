// audio-master: a `master` module worker (vivijure-module/1). Film-level audio mastering -- music
// upscale (VHQ soxr resample to 48k + gentle high-shelf air lift) + LUFS loudness normalization --
// dispatched to the dedicated vivijure-audio-master RunPod endpoint (CPU ffmpeg, no GPU).
//
// It is the audio sibling of `finish` (which polishes a clip) and the dialogue / speech lane (which
// polishes per-shot voice): `master` runs ONCE, on the whole film's assembled audio bed, AFTER the mix
// is built (score + narration) and BEFORE the bed is muxed onto the silent film. A music-video maker
// reaches for it as cleanly as a dialogue maker reaches for the voice lane.
//
// ASYNC: a two-pass ffmpeg master (measure -> apply loudnorm, plus a soxr resample) can exceed a Worker
// request budget, so the work runs on RunPod and the core polls:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport: the endpoint reads `audio_key` and writes `output_key` in the shared bucket itself (as
// the finish endpoints do for clips), so this worker holds no R2 creds.
//
// Failures are DATA, never an exception across the wire. master is a POLISH step, so the soft degrade
// (pass the INPUT bed through unchanged, but RECORDED) is preferred over a hard ok:false unless the job
// cannot be submitted at all -- a master miss must never drop a fully-rendered film (#249 / #77).

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type MasterInput,
  type MasterOutput,
} from "./contract";
import {
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput, passthroughOutput,
  runpodJobGone, classifyGoneState,
} from "./master";

interface Env {
  RUNPOD_API_KEY: string;
  RUNPOD_ENDPOINT_ID: string;
}

const MANIFEST: ModuleManifest = {
  name: "audio-master",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["master"],
  provides: [
    { id: "master", label: "Master film audio (loudness + music upscale)" },
  ],
  config_schema: {
    target_lufs: { type: "float", default: -14, min: -24, max: -9, label: "loudness target (LUFS)" },
    upscale: { type: "bool", default: true, label: "music upscale (soxr 48k + air lift)" },
    format: { type: "enum", values: ["wav", "mp3"], default: "wav", label: "output format" },
  },
  ui: { section: "master", icon: "sliders", order: 10 },
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

/** Soft degrade: pass the INPUT bed through unchanged (a no-op beats a drop in the render), but ALWAYS
 *  record why -- `passthroughOutput` tags `applied` and sets `degraded`, so a real misconfig / backend
 *  failure is never indistinguishable from a no-op (#77). A real degrade is also warned. */
function passthrough(
  input: MasterInput,
  reason: string,
  opts: { detail?: string } = {},
): InvokeResponse<MasterOutput> {
  const output = passthroughOutput(input, reason, opts);
  console.warn(`audio-master: passthrough (${output.degraded}) film=${input.film_id}`);
  return { ok: true, output };
}

async function submit(env: Env, req: InvokeRequest<MasterInput>): Promise<InvokeResponse<MasterOutput>> {
  const input = req.input;
  if (!input?.film_id || !input?.audio_key) {
    return { ok: false, error: "audio-master: input needs film_id and audio_key" };
  }
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return passthrough(input, "no-runpod-secrets");  // not configured: degrade, but say so
  }

  const cfg = coerceConfig(req.config);
  try {
    const r = await fetch(runpodBase(env) + "/run", {
      method: "POST",
      headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg)),
    });
    if (!r.ok) return passthrough(input, "runpod-run-failed", { detail: "HTTP " + r.status });
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input, "no-jobid");
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, filmId: input.film_id, audioKey: input.audio_key, submittedAt: Date.now() }),
    };
  } catch (e) {
    return passthrough(input, "exception", { detail: (e as Error).message });
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<MasterOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "audio-master: bad poll token" };
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) return { ok: false, error: "audio-master: not configured" };

  // A terminal failure passes the ORIGINAL bed through (passthrough), it does NOT fail the render --
  // master is a polish step (#249 / #77). The token carries the input bed for exactly this.
  const degrade = (reason: string, detail?: string): PollResponse<MasterOutput> => ({
    ok: true,
    output: passthroughOutput({ film_id: st.filmId, audio_key: st.audioKey }, reason, detail ? { detail } : {}),
  });

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(runpodBase(env) + "/status/" + st.jobId, { headers: auth(env) });
    httpStatus = resp.status;
    s = await resp.json() as typeof s;
  } catch {
    return { ok: true, pending: true };
  }
  // RunPod GC'd the job (HTTP 404 / numeric "status":404): past the grace window soft-degrade to the
  // original bed; inside it keep polling (post-submit race). (#141)
  if (runpodJobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return degrade("runpod-job-gone", "GC'd or never ran");
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return degrade("runpod-job-failed", JSON.stringify(s.error ?? s).slice(0, 200));
  if (s.status !== "COMPLETED") return { ok: true, pending: true };

  const out = parseBackendOutput(s.output);
  if (!out?.audio_key) return degrade("no-audio-key", "backend returned no mastered key");
  return {
    ok: true,
    output: {
      audio_key: out.audio_key,
      applied: out.applied ?? [],
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<MasterInput>;
      try { req = await request.json() as InvokeRequest<MasterInput>; }
      catch { return json({ ok: false, error: "invalid JSON body" } as InvokeResponse); }
      if (req.hook !== "master") return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
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
