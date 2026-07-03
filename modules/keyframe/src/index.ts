// keyframe: a `keyframe` module worker (vivijure-module/2). Drives the vivijure-backend GPU render
// endpoint on RunPod in its keyframes-only mode (action=preview) to turn a project's storyboard into
// start keyframes -- the upstream stage the motion.backend orchestrator animates. Async like the
// other GPU modules: GET /module.json, POST /invoke (submit -> poll token), POST /poll (check
// GET /status, return the keyframe keys on completion). PROJECT-level: one job emits every shot's
// keyframe, reusing trained cast LoRAs -- never a per-shot job (that would re-train = GPU waste).
//
// The backend writes the keyframe PNGs to the shared `vivijure` R2 bucket itself (its own creds), so
// this module does no R2 I/O -- it just reports the keys; the core presigns them for the next stage.
// Failures are DATA (ok:false), never thrown across the wire.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type CancelRequest,
  type CancelResponse,
  type KeyframeInput,
  type KeyframeOutput,
} from "./contract";
import { buildPreviewBody, parseKeyframes, parseTrainedLoras, encodePoll, decodePoll, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS } from "./keyframe";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  // The vivijure-backend RunPod endpoint id. A SECRET (not hardcoded) so the public repo never
  // exposes the specific endpoint -- same rule as push-secrets.sh (#38).
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
}

const endpoint = (endpointId: string) => "https://api.runpod.ai/v2/" + endpointId;
const auth = (apiKey: string) => ({ authorization: "Bearer " + apiKey });

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(apiKey: string, endpointId: string): Promise<boolean> {
  try {
    const r = await fetch(endpoint(endpointId) + "/health", { headers: auth(apiKey) });
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
    await fetch(endpoint(endpointId) + "/cancel/" + jobId, { method: "POST", headers: auth(apiKey) });
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

/** Resolve both RunPod secrets once per request. */
async function runpodCreds(env: Env): Promise<{ apiKey: string; endpointId: string }> {
  const [apiKey, endpointId] = await Promise.all([
    secretValue(env.RUNPOD_API_KEY),
    secretValue(env.RUNPOD_ENDPOINT_ID),
  ]);
  return { apiKey, endpointId };
}

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, issue #124) can assert
// this module's quality_tier enum stays in lockstep with the core QUALITY_TIERS set.
export const MANIFEST: ModuleManifest = {
  name: "keyframe",
  version: "0.2.1",
  api: MODULE_API,
  hooks: ["keyframe"],
  provides: [{ id: "gpu-keyframe", label: "GPU Keyframe (SDXL on RunPod)" }],
  config_schema: {
    quality_tier: {
      type: "enum",
      values: ["draft", "standard", "final"],
      default: "final",
      label: "quality tier",
    },
    // Default to a 16:9 landscape keyframe (SDXL-friendly 1344x768). Image-to-video backends conform
    // the clip to the KEYFRAME's aspect ratio (they ignore an aspect_ratio param once given an input
    // image), so a square keyframe forced square clips that the assembler then pillarboxed into 16:9
    // with black bars. A 16:9 keyframe makes the whole chain 16:9. Override via keyframe_config for
    // portrait/square. (fixes the square showcase clips)
    width: { type: "int", default: 1344, min: 512, max: 1536, label: "width" },
    height: { type: "int", default: 768, min: 512, max: 1536, label: "height" },
    steps: { type: "int", default: 30, min: 1, max: 60, label: "diffusion steps" },
    guidance_scale: { type: "float", default: 6.5, min: 0, max: 20, label: "guidance scale" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "keyframe", order: 10 },
  // This module is async + GPU-backed, so it implements POST /cancel: the core can stop an in-flight
  // RunPod job (a cancelled render, or an adopted keyframe phase) instead of orphaning it (#327/#328).
  cancelable: true,
  // #454: compact display token for the keyframe-stage backend, so the planner projects it inline
  // instead of hardcoding "SDXL". OPTIONAL/additive, mirrors src/modules/types.ts.
  keyframe_label: "SDXL",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function submit(env: Env, req: InvokeRequest<KeyframeInput>): Promise<InvokeResponse<KeyframeOutput>> {
  const input = req.input;
  if (!input || !input.project || !input.bundle_key) {
    return { ok: false, error: "keyframe: input needs project and bundle_key" };
  }
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) {
    return { ok: false, error: "keyframe: RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured" };
  }
  try {
    const r = await fetch(endpoint(endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(buildPreviewBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "keyframe /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "keyframe /run returned no job id" };
    return { ok: true, pending: true, poll: encodePoll({ jobId, project: input.project, submittedAt: Date.now() }), jobId };  // jobId (#318): lets the core read this RunPod job's keyframe_done snapshot
  } catch (e) {
    return { ok: false, error: "keyframe submit failed: " + (e as Error).message };
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<KeyframeOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "keyframe: bad poll token" };
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) {
    return { ok: false, error: "keyframe: RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured" };
  }

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(endpoint(endpointId) + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; caller polls again
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): the numeric 404 status would otherwise read as
  // "not COMPLETED" and the poll would report pending forever (issue #141). Past the grace window (or a
  // legacy token) fail; inside it keep polling (post-submit race).
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
      return { ok: false, error: "keyframe job " + st.jobId + " not found on RunPod (GC'd or never ran); failing (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") return { ok: false, error: "keyframe job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Surface the REAL error (never "not found") and cancel to stop the spend.
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(apiKey, endpointId, st.jobId);
      return { ok: false, error: "keyframe backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }

  const keyframes = parseKeyframes(s.output);
  if (!keyframes.length) return { ok: false, error: "keyframe job completed but returned no keyframes" };
  const trained_loras = parseTrainedLoras(s.output);
  return {
    ok: true,
    output: {
      project: st.project,
      keyframes,
      ...(Object.keys(trained_loras).length ? { trained_loras } : {}),
    },
  };
}

// Stop the in-flight RunPod job named by this poll token. RunPod's cancel is POST /v2/<id>/cancel/<job>.
// Idempotent by contract: a 200 (cancelled) and a 404 (job already GC'd / terminal) both mean the job is
// NOT running on our account, so both report ok:true. Any other status is surfaced as ok:false so the
// core degrade-logs the orphan rather than assuming it stopped. Failures are DATA, never thrown.
async function cancel(env: Env, body: CancelRequest): Promise<CancelResponse> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "keyframe: bad poll token" };
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) {
    return { ok: false, error: "keyframe: RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured" };
  }
  try {
    const resp = await fetch(endpoint(endpointId) + "/cancel/" + st.jobId, { method: "POST", headers: auth(apiKey) });
    if (resp.ok || resp.status === 404) return { ok: true };
    return { ok: false, error: "keyframe /cancel -> " + resp.status };
  } catch (e) {
    return { ok: false, error: "keyframe cancel failed: " + (e as Error).message };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);
    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<KeyframeInput>;
      try {
        req = (await request.json()) as InvokeRequest<KeyframeInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "keyframe") {
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
    if (request.method === "POST" && url.pathname === "/cancel") {
      let body: CancelRequest;
      try {
        body = (await request.json()) as CancelRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as CancelResponse);
      }
      if (!body || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as CancelResponse);
      return json(await cancel(env, body));
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
