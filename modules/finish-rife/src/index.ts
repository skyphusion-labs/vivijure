// finish-rife: a finish module worker (vivijure-module/2). RIFE frame interpolation + GFPGAN face
// restore, dispatched as action="finish_clip" to the shared vivijure-backend RunPod endpoint.
//
// ASYNC: GPU finishing takes 30s-3min, longer than a Worker request can hold:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// Failures are DATA, never an exception across the wire. For a chain hook the soft degrade
// (pass the input clip through unchanged) is preferred over a hard ok:false unless the job
// cannot be submitted at all.

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
  runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS,
} from "./finish";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
}

const MANIFEST: ModuleManifest = {
  name: "finish-rife",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["finish"],
  provides: [
    { id: "interpolate", label: "Smooth motion (RIFE frame interpolation)" },
    { id: "face_restore", label: "Relock faces (GFPGAN)" },
  ],
  config_schema: {
    interpolate:          { type: "bool",  default: true,   label: "smooth motion" },
    interpolation_factor: { type: "int",   default: 2, min: 1, max: 8, label: "smoothness", enum_labels: { "1": "off", "2": "2x", "4": "4x", "8": "8x" } },
    face_restore:         { type: "enum",  values: ["none", "gfpgan", "codeformer"], default: "none", label: "face restore" },
    face_fidelity:        { type: "float", default: 0.7, min: 0, max: 1, label: "fidelity (0 = max restore, 1 = max fidelity)" },
    only_faces:           { type: "bool",  default: true,   label: "faces only (leave background untouched)" },
  },
  ui: { section: "finish", icon: "wand", order: 10 },
  // Declared artifact conventions (S6): the container names its output off the shot id, and its
  // applied marker depends on the interpolate knob. The core's R2 recovery reads THIS, not our name.
  finish_artifacts: {
    output_key: { kind: "shot_named", filename: "_finished.mp4" },
    applied: [
      { when: { knob: "interpolate", equals: false }, tag: "noop:interpolate-off" },
      { tag: "interpolate:{interpolation_factor|2}x" },
    ],
  },
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

/** Best-effort cancel of a RunPod job we are about to fail: a hung-error job otherwise HOLDS the
 *  billed worker until someone cancels it by hand (F17 spend leak). Never throws; the honest
 *  failure below is the point, the cancel is damage control. */
async function cancelRunpodJobBestEffort(apiKey: string, endpointId: string, jobId: string): Promise<void> {
  try {
    await fetch(runpodBase(endpointId) + "/cancel/" + jobId, { method: "POST", headers: auth(apiKey) });
  } catch {
    /* best-effort */
  }
}


/** Soft degrade: pass the input clip through unchanged (for a chain hook a no-op beats a crash), but
 *  ALWAYS record why -- `passthroughOutput` tags `applied` with the reason and sets `degraded`, so a
 *  real misconfig/backend failure is never indistinguishable from the legitimate no-op (#77). A real
 *  degrade is also warned to the log (observability is on, so `wrangler tail` surfaces it); the
 *  intentional no-op (`degraded:false`) is silent. */
function passthrough(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): InvokeResponse<FinishOutput> {
  const output = passthroughOutput(input, reason, opts);
  if (output.degraded) console.warn(`finish-rife: passthrough (${output.degraded}) shot=${input.shot_id}`);
  return { ok: true, output };
}

async function submit(env: Env, req: InvokeRequest<FinishInput>): Promise<InvokeResponse<FinishOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.clip_key) {
    return { ok: false, error: "finish-rife: input needs shot_id and clip_key" };
  }
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) {
    return passthrough(input, "no-runpod-secrets");  // not configured: degrade, but say so
  }

  const cfg = coerceConfig(req.config);
  // Nothing enabled: a real, intentional no-op (NOT a degrade) -- skip the GPU round-trip.
  if (!cfg.interpolate && cfg.face_restore === "none") {
    return passthrough(input, "nothing-enabled", { degraded: false });
  }

  try {
    const r = await fetch(runpodBase(endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg, req.context.project)),
    });
    if (!r.ok) return passthrough(input, "runpod-run-failed", { detail: "HTTP " + r.status });
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input, "no-jobid");
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, shotId: input.shot_id, srcFps: input.src_fps ?? 24, frames: input.frames ?? 0, submittedAt: Date.now() }),
    };
  } catch (e) {
    return passthrough(input, "exception", { detail: (e as Error).message });
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "finish-rife: bad poll token" };
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) return { ok: false, error: "finish-rife: not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(runpodBase(endpointId) + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = await resp.json() as typeof s;
  } catch {
    return { ok: true, pending: true };
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): without this guard the numeric 404 status reads as
  // "not COMPLETED" and the poll reports pending forever (issue #141). Past the grace window (or a legacy
  // token) fail; inside it keep polling (post-submit race).
  if (runpodJobGone(httpStatus, s)) {
    const now = Date.now();
    if (classifyGoneState(st.submittedAt, now) === "gone-failed") {
      // Cold-start tolerance: a virgin host's image pull can outlive the grace window while the job
      // 404s. If no worker has EVER come up, this is "still initializing", not "dropped" -- keep
      // polling up to the cold cap instead of false-failing the first-ever job.
      if (
        classifyGoneState(st.submittedAt, now, RUNPOD_COLD_GRACE_MS) === "gone-grace" &&
        (await endpointStillCold(apiKey, endpointId))
      ) {
        return { ok: true, pending: true };
      }
      return { ok: false, error: "finish-rife job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "finish-rife job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Surface the REAL error (never "not found") and cancel to stop the spend.
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(apiKey, endpointId, st.jobId);
      return { ok: false, error: "finish-rife backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }

  const out = parseBackendOutput(s.output);
  if (!out?.clip_key) return { ok: false, error: "finish-rife: backend returned no clip_key" };
  return {
    ok: true,
    output: {
      shot_id: out.shot_id ?? st.shotId,
      clip_key: out.clip_key,
      out_fps: out.out_fps ?? st.srcFps,
      frames: out.frames ?? st.frames,
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
