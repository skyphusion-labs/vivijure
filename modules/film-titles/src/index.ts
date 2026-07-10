// film-titles: a film.finish module worker (vivijure-module/2). Adds an opening TITLE card and an
// end CREDIT card to the assembled+muxed film, via the always-on video-finish CPU container's
// video-finish route over Workers VPC (VIDEO_FINISH_VPC).
//
// ASYNC job+poll (#602): a card concat on a LONG film can outlast a Worker request budget, so this
// module submits to the container's async route and returns { ok, pending, poll }; the core polls
// /poll across ticks (mirroring the GPU finish satellites). It FALLS BACK to the synchronous
// /film-titles route when the container has no async support (a pre-#602 container 404s the async
// route), so an old container keeps working unchanged.
//
// CREDENTIALLESS by design: the core presigns the film GET + the result PUT and hands them in the
// input. This module forwards the spec to the container and reports the output key. It never touches
// R2 or holds S3 creds.
//
// Soft degrade: no title and no credits -> pass the film through unchanged (noop:no-cards). A
// container failure -> passthrough the original film tagged "passthrough:container-failed", degraded.
// A film.finish module must never drop the film it was handed.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type FilmFinishInput,
  type FilmFinishOutput,
} from "./contract";
import {
  coerceConfig, hasCards, hasTitleCard, buildContainerSpec, passthroughOutput,
  encodePoll, decodePoll, completedOutput, CONTAINER_NOTFOUND_GRACE_MS,
} from "./film-titles";

interface Env {
  VIDEO_FINISH_VPC: { fetch(url: RequestInfo, init?: RequestInit): Promise<Response> };
}

// The container route this module drives (sync POST /film-titles, async POST /async/film-titles).
const ROUTE = "film-titles";

const MANIFEST: ModuleManifest = {
  name: "film-titles",
  version: "0.2.0",
  api: MODULE_API,
  hooks: ["film.finish"],
  provides: [{ id: "film-titles", label: "Title + credit cards on the finished film" }],
  config_schema: {
    font:           { type: "string", default: "DejaVu Sans", label: "card font (installed in the video-finish container)" },
    color:          { type: "string", default: "white", label: "card text color (name or #rrggbb)" },
    bg:             { type: "string", default: "black", label: "card background color" },
    title_seconds:  { type: "int", default: 3, min: 1, max: 15, label: "title card duration (s)" },
    credit_seconds: { type: "int", default: 5, min: 1, max: 30, label: "credit card duration (s)" },
  },
  ui: { section: "film.finish", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function passthrough(input: FilmFinishInput, reason: string, degraded = false): InvokeResponse<FilmFinishOutput> {
  const output = passthroughOutput(input, reason, { degraded });
  if (degraded) console.warn(`film-titles: passthrough (${reason}) film=${input.film_key}`);
  return { ok: true, output };
}

/** Try the container's async job route. On 202 + jobId -> the job id; on anything else (a pre-#602
 *  container 404s the route, a non-202, or a transport failure) -> null, so the caller falls back to
 *  the synchronous route. Absolute URL: the host is the VPC service, ignored by the binding. */
async function submitAsync(env: Env, spec: Record<string, unknown>): Promise<string | null> {
  let resp: Response;
  try {
    resp = await env.VIDEO_FINISH_VPC.fetch(`http://video-finish/async/${ROUTE}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec),
    });
  } catch { return null; }
  if (resp.status !== 202) return null;
  try {
    const body = (await resp.json()) as { ok?: boolean; jobId?: string };
    return body.ok === true && typeof body.jobId === "string" && body.jobId.length > 0 ? body.jobId : null;
  } catch { return null; }
}

/** Synchronous fallback: the pre-#602 behavior, unchanged. Used when the container has no async route. */
async function invokeSync(env: Env, input: FilmFinishInput, spec: Record<string, unknown>, titleSeconds: number): Promise<InvokeResponse<FilmFinishOutput>> {
  let resp: Response;
  try {
    resp = await env.VIDEO_FINISH_VPC.fetch("http://video-finish/film-titles", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec),
    });
  } catch {
    return passthrough(input, "passthrough:container-unreachable", true);
  }
  if (!resp.ok) return passthrough(input, "passthrough:container-failed", true);
  let body: { ok?: boolean; key?: string };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    return passthrough(input, "passthrough:container-bad-response", true);
  }
  if (!body.ok) return passthrough(input, "passthrough:container-failed", true);
  // Report prepend_seconds only when an opening TITLE card was actually rendered (it shifts the final
  // film`s timeline); credits are appended at the end and never shift cues (#663). titleSeconds is 0 when
  // there is no title card, so this passes through as no prepend.
  return { ok: true, output: { film_key: body.key || input.output_key, applied: ["film-titles"], ...(titleSeconds > 0 ? { prepend_seconds: titleSeconds } : {}) } };
}

async function invoke(env: Env, req: InvokeRequest<FilmFinishInput>): Promise<InvokeResponse<FilmFinishOutput>> {
  const input = req.input;
  if (!input || !input.film_key || !input.video_url || !input.output_url || !input.output_key) {
    return { ok: false, error: "film.finish: input needs film_key, video_url, output_url, output_key" };
  }
  if (!hasCards(input)) return passthrough(input, "noop:no-cards");
  if (!env.VIDEO_FINISH_VPC) return passthrough(input, "passthrough:no-vpc-binding", true);

  const cfg = coerceConfig(req.config);
  const spec = buildContainerSpec(input, cfg);

  // Prefer async so a long encode survives across request budgets; fall back to sync for a pre-#602
  // container (back-compat). A sync fallback that itself fails soft-degrades (#190), never drops the film.
  const titleSeconds = hasTitleCard(input) ? cfg.title_seconds : 0; // #663: shifts the final timeline
  const jobId = await submitAsync(env, spec);
  if (jobId) {
    return { ok: true, pending: true, poll: encodePoll({ jobId, filmKey: input.film_key, outputKey: input.output_key, submittedAt: Date.now(), titleSeconds }) };
  }
  return invokeSync(env, input, spec, titleSeconds);
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FilmFinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "film-titles: bad poll token" };
  if (!env.VIDEO_FINISH_VPC) return { ok: false, error: "film-titles: no VIDEO_FINISH_VPC binding" };

  let resp: Response;
  try {
    resp = await env.VIDEO_FINISH_VPC.fetch(`http://video-finish/async/status/${encodeURIComponent(st.jobId)}`);
  } catch {
    return { ok: true, pending: true }; // transport blip: re-poll next tick
  }
  if (resp.status === 404) {
    // The container lost the job (its store is in-process; a restart drops it). Brief grace for a
    // post-submit race; past it, report gone so the core re-dispatches -- the deterministic output key
    // makes a re-run idempotent (#141 GC-grace discipline, container flavor).
    return Date.now() - st.submittedAt < CONTAINER_NOTFOUND_GRACE_MS
      ? { ok: true, pending: true }
      : { ok: false, error: "film-titles: video-finish container job not found (restarted); resubmit" };
  }
  if (!resp.ok) return { ok: true, pending: true }; // 5xx gateway blip: re-poll
  let s: { status?: string; result?: { ok?: boolean; key?: string } | null; error?: string };
  try { s = (await resp.json()) as typeof s; } catch { return { ok: true, pending: true }; }
  if (s.status === "completed") {
    if (!s.result || s.result.ok !== true) return { ok: false, error: "film-titles: container completed without an ok result" };
    return { ok: true, output: completedOutput(s.result, st) };
  }
  if (s.status === "failed") return { ok: false, error: "film-titles: container job failed: " + (s.error ?? "unknown") };
  return { ok: true, pending: true }; // pending / unknown -> keep polling
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);
    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<FilmFinishInput>;
      try {
        req = (await request.json()) as InvokeRequest<FilmFinishInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "film.finish") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await invoke(env, req));
    }
    if (request.method === "POST" && url.pathname === "/poll") {
      let body: PollRequest;
      try { body = (await request.json()) as PollRequest; }
      catch { return json({ ok: false, error: "invalid JSON body" } as PollResponse); }
      if (!body?.poll || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as PollResponse);
      return json(await poll(env, body));
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
