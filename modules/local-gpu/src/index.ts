// local-gpu: a motion.backend module worker (vivijure-module/2) that renders image-to-video on the
// user's OWN LOCAL consumer GPU in their homelab, via a vivijure-local-backend job server (the
// i2v_clip action). The module is model-agnostic: one module serves BOTH local doors -- the LTX-Video
// 12GB backend (vivijure-local-12gb) and the CogVideoX-5B-I2V 16GB backend (vivijure-local-16gb). The
// homelabber points LOCAL_BACKEND_URL at whichever they run; the wire contract is identical, so the
// same control plane drives either.
//
// This is the LOCAL-CONSUMER door: the deliberate opposite of the RunPod datacenter backend. Unlike
// own-gpu (which still runs on a RunPod endpoint the user provisions), this targets a long-running
// server on the user's own box, reached over a configured URL (a Cloudflare tunnel terminates at the
// homelab). The job-input contract is identical to vivijure-backend's i2v_clip, so the same control
// plane drives either door -- it just discovers another motion.backend module and the user picks it.
//
// Like own-gpu, the backend SHARES our R2 bucket: it reads the keyframe by key and WRITES the finished
// clip itself, returning the clip_key. So this module never downloads or re-uploads -- it submits,
// polls, and surfaces the key the backend reported.
//
// ASYNC + cancelable (GPU generation on a consumer card far exceeds a single Worker request):
//   GET  /module.json -> manifest
//   POST /invoke      -> submit i2v_clip, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; surface the clip on completion
//   POST /cancel      -> { poll } -> stop an in-flight job so a cancelled render does not orphan it
// The caller polls /poll until it is no longer pending. Failures are DATA, never an exception.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type CancelRequest,
  type CancelResponse,
  type MotionBackendInput,
  type MotionBackendOutput,
} from "./contract";
import type { DurationGridDecl } from "./contract";
import { buildI2vBody, readOutput, readDurationGrid, encodePoll, decodePoll, jobGone, classifyGoneState } from "./i2v";

interface Env {
  // The base URL of the user's local backend (a Cloudflare tunnel hostname terminating at the homelab
  // box), e.g. "https://render.myhomelab.example". Kept a secret: it is the only network handle to the
  // box, and a leaked URL is an unauthenticated GPU-spend / DoS trigger (the same #38 discipline that
  // keeps the RunPod endpoint id a secret).
  LOCAL_BACKEND_URL: SecretsStoreSecret;
  // Optional bearer token the local server checks (a shared secret minted by the homelabber). The
  // service-binding trust boundary is the primary auth (this module has no public surface), but a
  // tunnel origin is reachable if its hostname leaks, so the token is defense in depth. Absent => the
  // body still submits; the server may run open on a trusted LAN tunnel.
  LOCAL_BACKEND_TOKEN?: SecretsStoreSecret;
}

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, #124) can assert this
// module's `quality` enum stays in lockstep with the core QUALITY_TIERS set. The enum VALUES are the
// core's shared vocabulary (draft/standard/final); the local backend maps each to an engine config its
// card can HONESTLY deliver ("final" = the card's honest ceiling, NOT datacenter parity) -- LTX scales
// the tiers one way, CogVideoX by inference steps. Same names, backend-specific mapping -- exactly as
// the Wan datacenter backend maps the tiers to its steps.
export const MANIFEST: ModuleManifest = {
  name: "local-gpu",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-local-gpu", label: "Local GPU (image-to-video on your own card)" }],
  config_schema: {
    quality: { type: "enum", values: ["draft", "standard", "final"], default: "standard", label: "quality" },
    fps: { type: "int", default: 24, min: 8, max: 30, label: "fps (backend may pin its own; e.g. CogVideoX = 8)" },
    flow_shift: { type: "float", default: 5.0, min: 1, max: 12, label: "motion (flow shift; LTX door only, ignored otherwise)" },
    negative_prompt: { type: "string", default: "", label: "negative prompt (additive)" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "motion", order: 4, locality: "local", cost: "Free after hardware", blurb: "Renders on your own GPU -- no cloud, no per-render cost; quality scales with your card and chosen backend (12GB LTX floor, 16GB CogVideoX).", limits: ["Runs whichever local backend you point it at: LTX (12GB floor) or CogVideoX (16GB floor); bigger cards add headroom", "Short i2v clips (draft / standard / final tiers); resolution + cadence set by the backend", "One clip at a time (a consumer card runs a single i2v job)"] }, // ahead of own-gpu (5): a truly-local card needs no rent at all
  cancelable: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- duration-grid relay (#707) ------------------------------------------------------------------
//
// The door DECLARES its fixed duration grid (pinned fps + per-tier frame caps) on /health; this
// module RELAYS it in the manifest so core preflight can warn about duration clamping at storyboard
// time. Best-effort with a short timeout and an in-isolate cache (positive AND negative results, so
// a down door is not re-probed on every manifest fetch and discovery never hangs on it). On any
// failure the manifest simply omits the field: absence = no declared constraint, never fabricated.
const GRID_CACHE_TTL_MS = 5 * 60_000;
const GRID_FETCH_TIMEOUT_MS = 1_500;
let gridCache: { at: number; grid: DurationGridDecl | null } | null = null;

/** Test hook: drop the in-isolate grid cache. */
export function _resetGridCache(): void {
  gridCache = null;
}

export async function doorDurationGrid(
  env: Env,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<DurationGridDecl | null> {
  if (gridCache && nowMs - gridCache.at < GRID_CACHE_TTL_MS) return gridCache.grid;
  let grid: DurationGridDecl | null = null;
  try {
    const { baseUrl, token } = await backendCfg(env);
    if (baseUrl) {
      const r = await fetcher(baseUrl + "/health", {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(GRID_FETCH_TIMEOUT_MS),
      });
      if (r.ok) grid = readDurationGrid(((await r.json()) as { duration_grid?: unknown }).duration_grid);
    }
  } catch {
    // down / slow / non-JSON door: omit the field this TTL window; the manifest stays honest.
  }
  gridCache = { at: nowMs, grid };
  return grid;
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

/** Resolve the backend URL + optional token once per request. The URL is normalized without a trailing
 *  slash so the path joins below are unambiguous. */
async function backendCfg(env: Env): Promise<{ baseUrl: string; token: string }> {
  const [rawUrl, token] = await Promise.all([
    secretValue(env.LOCAL_BACKEND_URL),
    secretValue(env.LOCAL_BACKEND_TOKEN),
  ]);
  return { baseUrl: rawUrl.replace(/\/+$/, ""), token };
}

/** Auth header for the local server, when a token is configured. */
function authHeaders(token: string): Record<string, string> {
  return token ? { authorization: "Bearer " + token } : {};
}

/** /invoke: validate, submit the i2v_clip job to the local backend, return a poll token immediately. */
async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id and prompt" };
  }
  const { baseUrl, token } = await backendCfg(env);
  if (!baseUrl) return { ok: false, error: "local-gpu: LOCAL_BACKEND_URL not configured" };
  try {
    const r = await fetch(baseUrl + "/run", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(buildI2vBody(input, req.config, req.context.project)),
    });
    if (!r.ok) return { ok: false, error: "local-gpu /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "local-gpu /run returned no job id" };
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, submittedAt: Date.now() }),
      jobId,
    };
  } catch (e) {
    return { ok: false, error: "local-gpu submit failed: " + (e as Error).message };
  }
}

/** /poll: check the local job; on completion the backend has already stored the clip in R2, so we just
 *  surface the clip_key it reported. No download, no re-upload. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "local-gpu: bad poll token" };
  const { baseUrl, token } = await backendCfg(env);
  if (!baseUrl) return { ok: false, error: "local-gpu: LOCAL_BACKEND_URL not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(baseUrl + "/status/" + st.jobId, { headers: authHeaders(token) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient (tunnel hiccup); poll again
  }
  // The local box restarted / GC'd the job (HTTP 404 / "job not found"): without this guard the poll
  // below would treat the numeric 404 as "not COMPLETED" and report pending forever (#141). Past the
  // grace window (or for a legacy token with no submit stamp) fail the shot so it stops polling a dead
  // job; inside the window keep polling (a momentary post-submit propagation race).
  if (jobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return { ok: false, error: "local-gpu job not found (box restarted or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true }; // still inside the grace window
  }
  if (s.status === "FAILED") return { ok: false, error: "local-gpu job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS

  const output = readOutput(st.shotId, s.output);
  if (!output) return { ok: false, error: "local-gpu output had no clip_key" };
  return { ok: true, output };
}

/** /cancel: stop the in-flight local job named by this poll token. The local server's cancel is POST
 *  /cancel/<id>. Idempotent by contract: a 200 (cancelled) and a 404 (job already gone / terminal)
 *  both mean the job is NOT running on the box, so both report ok:true. Any other status is surfaced as
 *  ok:false so the core degrade-logs the orphan rather than assuming it stopped. */
async function cancel(env: Env, body: CancelRequest): Promise<CancelResponse> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "local-gpu: bad poll token" };
  const { baseUrl, token } = await backendCfg(env);
  if (!baseUrl) return { ok: false, error: "local-gpu: LOCAL_BACKEND_URL not configured" };
  try {
    const resp = await fetch(baseUrl + "/cancel/" + st.jobId, { method: "POST", headers: authHeaders(token) });
    if (resp.ok || resp.status === 404) return { ok: true };
    return { ok: false, error: "local-gpu /cancel -> " + resp.status };
  } catch (e) {
    return { ok: false, error: "local-gpu cancel failed: " + (e as Error).message };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") {
      // #707: relay the door-declared duration grid when the door reports one (cached, best-effort).
      const grid = await doorDurationGrid(env);
      return json(grid ? { ...MANIFEST, duration_grid: grid } : MANIFEST);
    }

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

    if (request.method === "POST" && url.pathname === "/cancel") {
      let body: CancelRequest;
      try {
        body = (await request.json()) as CancelRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as CancelResponse);
      }
      if (!body || typeof body.poll !== "string") {
        return json({ ok: false, error: "poll token required" } as CancelResponse);
      }
      return json(await cancel(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
