// film-titles: a film.finish module worker (vivijure-module/1). Adds an opening TITLE card and an
// end CREDIT card to the assembled+muxed film, via the always-on video-finish CPU container's
// /film-titles route over Workers VPC (VIDEO_FINISH_VPC).
//
// SYNCHRONOUS: card generation + a 2-3 segment concat on a ~30 s film completes in a few seconds on
// the CPU container, within the Worker timeout. No /poll. The core runs the film.finish chain on the
// assembled film (post-mux, before done), folding modules in ui.order.
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
  type FilmFinishInput,
  type FilmFinishOutput,
} from "./contract";
import { coerceConfig, hasCards, buildContainerSpec, passthroughOutput } from "./film-titles";

interface Env {
  VIDEO_FINISH_VPC: { fetch(url: RequestInfo, init?: RequestInit): Promise<Response> };
}

const MANIFEST: ModuleManifest = {
  name: "film-titles",
  version: "0.1.0",
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

async function invoke(env: Env, req: InvokeRequest<FilmFinishInput>): Promise<InvokeResponse<FilmFinishOutput>> {
  const input = req.input;
  if (!input || !input.film_key || !input.video_url || !input.output_url || !input.output_key) {
    return { ok: false, error: "film.finish: input needs film_key, video_url, output_url, output_key" };
  }
  if (!hasCards(input)) return passthrough(input, "noop:no-cards");
  if (!env.VIDEO_FINISH_VPC) return passthrough(input, "passthrough:no-vpc-binding", true);

  const cfg = coerceConfig(req.config);
  const spec = buildContainerSpec(input, cfg);

  let resp: Response;
  try {
    resp = await env.VIDEO_FINISH_VPC.fetch("/film-titles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });
  } catch (e) {
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

  // The container wrote the carded film to output_key (behind output_url). Report it as the new film.
  return { ok: true, output: { film_key: body.key || input.output_key, applied: ["film-titles"] } };
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
    return json({ ok: false, error: "not found" }, 404);
  },
};
