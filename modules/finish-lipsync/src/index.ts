// finish-lipsync: a finish module worker (vivijure-module/1). MuseTalk audio-driven lip-sync,
// dispatched to the dedicated vivijure-musetalk RunPod endpoint (cu128; separate from vivijure-backend).
// Rewrites a shot's mouth to match its dialogue audio -- the "talking characters" finish stage.
//
// ASYNC: GPU lip-sync runs frame-by-frame and exceeds a Worker request budget:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport: the endpoint reads `clip_key` + `audio_key` and writes `output_key` in the shared
// bucket itself (exactly as finish-upscale / vivijure-backend do), so this worker holds no R2 creds.
//
// Failures are DATA, never an exception across the wire. For a chain hook the soft degrade (pass the
// input clip through unchanged, but RECORDED) is preferred over a hard ok:false unless the job cannot
// be submitted at all. A shot with no dialogue `audio_key` is an intentional NO-OP, not a degrade.

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
} from "./lipsync";

interface Env {
  RUNPOD_API_KEY: string;
  RUNPOD_ENDPOINT_ID: string;
}

const MANIFEST: ModuleManifest = {
  name: "finish-lipsync",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["finish"],
  provides: [
    { id: "lipsync", label: "Lip-sync to dialogue (MuseTalk)" },
  ],
  config_schema: {
    version:    { type: "enum", values: ["v15", "v1"], default: "v15", label: "MuseTalk version (v15 = v1.5, best)" },
    bbox_shift: { type: "int",  default: 0, min: -20, max: 20, label: "mouth crop shift" },
  },
  // Order < the upscaler's 20 so a lip-synced shot is then upscaled (the 256px face region wants it).
  ui: { section: "finish", icon: "mic", order: 15 },
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

/** Soft degrade: pass the input clip through unchanged (a no-op beats a crash in a chain), but ALWAYS
 *  record why -- `passthroughOutput` tags `applied` and sets `degraded` for a real failure, or tags a
 *  bare `noop:` for the legitimate no-dialogue case, so the two are never indistinguishable (#77). */
function passthrough(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): InvokeResponse<FinishOutput> {
  const output = passthroughOutput(input, reason, opts);
  if (output.degraded) console.warn(`finish-lipsync: passthrough (${output.degraded}) shot=${input.shot_id}`);
  return { ok: true, output };
}

async function submit(env: Env, req: InvokeRequest<FinishInput>): Promise<InvokeResponse<FinishOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.clip_key) {
    return { ok: false, error: "finish-lipsync: input needs shot_id and clip_key" };
  }
  // No dialogue for this shot -> nothing to lip-sync to. Intentional no-op, NOT a degrade.
  if (!input.audio_key) {
    return passthrough(input, "no-dialogue", { degraded: false });
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
      poll: encodePoll({ jobId, shotId: input.shot_id, clipKey: input.clip_key, srcFps: input.src_fps ?? 24, frames: input.frames ?? 0, submittedAt: Date.now() }),
    };
  } catch (e) {
    return passthrough(input, "exception", { detail: (e as Error).message });
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "finish-lipsync: bad poll token" };
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) return { ok: false, error: "finish-lipsync: not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(runpodBase(env) + "/status/" + st.jobId, { headers: auth(env) });
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
      return { ok: false, error: "finish-lipsync job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "finish-lipsync job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true };

  // The endpoint's R2-mode result: { ok, clip_key, applied, ... }. If the handler soft-degraded
  // (e.g. no detectable face), ok is false and clip_key is absent -> pass the original clip through.
  const o = (s.output ?? {}) as { ok?: unknown; error?: unknown };
  if (o.ok === false) {
    return {
      ok: true,
      output: passthroughOutput(
        { shot_id: st.shotId, clip_key: st.clipKey, src_fps: st.srcFps, frames: st.frames, width: 0, height: 0 },
        "backend-soft-degrade",
        { detail: typeof o.error === "string" ? o.error.slice(0, 120) : undefined },
      ),
    };
  }
  const out = parseBackendOutput(s.output);
  if (!out?.clip_key) return { ok: false, error: "finish-lipsync: backend returned no clip_key" };
  return {
    ok: true,
    output: {
      shot_id: st.shotId,
      clip_key: out.clip_key,
      out_fps: st.srcFps,    // lip-sync preserves fps + frame count
      frames: st.frames,
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
