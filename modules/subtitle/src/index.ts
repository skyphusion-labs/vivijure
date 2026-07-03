// subtitle: a film.finish module worker (vivijure-module/2). Burns time-synced dialogue CAPTIONS onto
// the assembled+muxed film (and/or emits a soft .srt sidecar), via the always-on video-finish CPU
// container's /subtitle route over Workers VPC (VIDEO_FINISH_VPC).
//
// SYNCHRONOUS: an SRT burn is a single libx264 re-encode pass on a ~30 s film; it completes within the
// Worker timeout, so there is no /poll. The core runs the film.finish chain on the assembled film
// (post-mux, before done), folding modules in ui.order. This module sits at ui.order 5 -- BEFORE
// film-titles (10) -- so captions burn onto the 0-based assembled timeline before a title card shifts
// it (the cue times are measured from the film's start, not from after a prepended card).
//
// CREDENTIALLESS by design: the core presigns the film GET + the result PUT (+ an optional .srt
// sidecar PUT) and hands them in the input, along with the TIMED cues it computed from the film's
// per-shot dialogue + real shot durations. This module formats the SRT, forwards the spec, and reports
// the output key. It never touches R2 or holds S3 creds, and it never computes timing.
//
// Soft degrade (a polish step never fails the chain): no cues -> pass the film through unchanged
// (noop:no-dialogue); disabled -> noop:disabled; a sidecar-only run with no sidecar URL ->
// passthrough degraded; a container failure -> passthrough the original film tagged
// "passthrough:container-failed", degraded. A film.finish module must never drop the film it was handed.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type FilmFinishInput,
  type FilmFinishOutput,
} from "./contract";
import { coerceConfig, hasCaptions, buildSrt, buildContainerSpec, passthroughOutput } from "./subtitle";

interface Env {
  VIDEO_FINISH_VPC: { fetch(url: RequestInfo, init?: RequestInit): Promise<Response> };
}

const MANIFEST: ModuleManifest = {
  name: "subtitle",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["film.finish"],
  provides: [{ id: "subtitle", label: "Time-synced dialogue captions (burned-in + .srt)" }],
  config_schema: {
    enabled:   { type: "bool", default: true, label: "burn captions onto the finished film" },
    mode:      { type: "enum", values: ["burn", "sidecar", "both"], default: "burn", label: "burned-in, soft .srt sidecar, or both" },
    font:      { type: "string", default: "DejaVu Sans", label: "caption font (installed in the video-finish container)" },
    font_size: { type: "int", default: 28, min: 8, max: 120, label: "caption font size (px)" },
    color:     { type: "string", default: "white", label: "caption text color (white / black / yellow, or ASS &HBBGGRR)" },
    position:  { type: "enum", values: ["bottom", "top", "middle"], default: "bottom", label: "caption position" },
    box_style: { type: "enum", values: ["outline", "box"], default: "outline", label: "outline text or opaque box behind it" },
    margin_v:  { type: "int", default: 36, min: 0, max: 400, label: "vertical margin from the frame edge (px)" },
  },
  // Order 5: BEFORE film-titles (10) so captions land on the 0-based timeline before a title card shifts it.
  ui: { section: "film.finish", order: 5 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function passthrough(input: FilmFinishInput, reason: string, degraded = false): InvokeResponse<FilmFinishOutput> {
  const output = passthroughOutput(input, reason, { degraded });
  if (degraded) console.warn(`subtitle: passthrough (${reason}) film=${input.film_key}`);
  return { ok: true, output };
}

async function invoke(env: Env, req: InvokeRequest<FilmFinishInput>): Promise<InvokeResponse<FilmFinishOutput>> {
  const input = req.input;
  if (!input || !input.film_key || !input.video_url || !input.output_url || !input.output_key) {
    return { ok: false, error: "film.finish: input needs film_key, video_url, output_url, output_key" };
  }

  const cfg = coerceConfig(req.config);
  if (!cfg.enabled) return passthrough(input, "noop:disabled");
  if (!hasCaptions(input)) return passthrough(input, "noop:no-dialogue");
  if (!env.VIDEO_FINISH_VPC) return passthrough(input, "passthrough:no-vpc-binding", true);

  const wantSidecar = cfg.mode === "sidecar" || cfg.mode === "both";
  const haveSidecarUrl = wantSidecar && typeof input.sidecar_url === "string" && input.sidecar_url.length > 0;
  // Sidecar-only with no presigned sidecar URL: there is nothing this module can honestly do (it must
  // not burn in sidecar-only mode). Pass the film through and degrade -- never silently swallow it.
  if (cfg.mode === "sidecar" && !haveSidecarUrl) return passthrough(input, "passthrough:sidecar-no-url", true);

  const srt = buildSrt(input.captions);
  const spec = buildContainerSpec(input, cfg, srt);

  let resp: Response;
  try {
    // Absolute URL (the host is the VPC service, ignored by the binding). A bare "/subtitle" is not a
    // valid URL and throws in the Workers runtime, which the catch below would mask as
    // "container-unreachable", silently shipping the film UNCAPTIONED. (The #207 film-titles lesson.)
    resp = await env.VIDEO_FINISH_VPC.fetch("http://video-finish/subtitle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });
  } catch {
    return passthrough(input, "passthrough:container-unreachable", true);
  }
  if (!resp.ok) return passthrough(input, "passthrough:container-failed", true);

  let body: { ok?: boolean; key?: string; burned?: boolean; sidecar?: boolean };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    return passthrough(input, "passthrough:container-bad-response", true);
  }
  if (!body.ok) return passthrough(input, "passthrough:container-failed", true);

  // Compose an honest `applied`: "subtitle" only when captions were actually burned (the film_key
  // then points at the burned film); "subtitle:sidecar" when a .srt was written. A sidecar-only run
  // burns nothing, so the film_key stays the original (no fake burn tag).
  const applied: string[] = [];
  if (body.burned) applied.push("subtitle");
  if (body.sidecar) applied.push("subtitle:sidecar");
  if (!applied.length) applied.push("noop:no-dialogue"); // defensive: container did nothing
  const filmKey = body.burned ? (body.key || input.output_key) : input.film_key;
  return { ok: true, output: { film_key: filmKey, applied } };
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
