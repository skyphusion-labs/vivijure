// cast-image: a cast.image module worker (vivijure-module/1). Generates a character's LoRA TRAINING
// reference set from a portrait + bible, via the studio's image models (FLUX 2 Klein / Nano Banana
// Pro) with the safety-flag fallback. Lifts the proven browser-side generator (public/cast.js
// generateTrainingSet) server-side so it is swappable AND no longer blocks the cast page for minutes.
//
// ASYNC: a 10-image set can't render inside one Worker request, so:
//   GET  /module.json -> manifest
//   POST /invoke      -> compose prompts, write run state to R2, return { ok, pending, poll }
//   POST /poll        -> render the next prompt(s), update state, return pending until done -> output
// PollResponse carries no token, so the run state lives in R2 and the poll token is a stable pointer.
// Failures are DATA, never an exception across the wire.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type CastImageInput,
  type CastImageOutput,
} from "./contract";
import {
  TRAINING_PROMPTS,
  FLAG_FALLBACK_MODEL,
  isFlaggedError,
  buildState,
  encodePoll,
  decodePoll,
  stateKey,
  refKey,
  readOutput,
  type CastImageState,
} from "./cast-image";

// Minimal binding shapes this module needs.
interface AiBinding { run(model: string, input: Record<string, unknown>): Promise<unknown>; }
interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}
interface Env {
  AI: AiBinding;          // AI Gateway binding (FLUX 2 via Workers AI; Google via Unified Billing)
  R2_RENDERS: R2Bucket;   // the shared `vivijure` bucket: run state + generated refs land here
}

const MODELS = [
  "@cf/black-forest-labs/flux-2-klein-9b",
  "google/nano-banana-pro",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-dev",
];

const MANIFEST: ModuleManifest = {
  name: "cast-image",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["cast.image"],
  provides: [{ id: "cast-refs", label: "Training references (FLUX 2 / Nano Banana)" }],
  config_schema: {
    model: { type: "enum", values: MODELS, default: MODELS[0], label: "image model" },
    num_images: { type: "int", default: 10, min: 4, max: TRAINING_PROMPTS.length, label: "training images" },
  },
  ui: { section: "cast", order: 10 },
};

// Images rendered per /poll cycle: keeps each poll inside the Worker time budget while finishing the
// set in a handful of polls.
const PER_POLL = 1;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Generate ONE image from a prompt + the portrait/source refs; return the bytes + mime.
 *
 *  WIRING TODO -- the one integration point of this scaffold: reconcile the `env.AI.run` image
 *  PAYLOAD + RESULT extraction with the core's `src/ai-binding.ts` + `src/output-extract.ts`. The core
 *  already handles FLUX-2 multi-reference input, the Nano-Banana URL-result shape, and the AI Gateway
 *  envelope -- this best-effort shape captures the intent (prompt + reference images in, image bytes
 *  out) but the exact field names / extraction must match the core before this is deploy-functional.
 *  (Cleanest path: extract a tiny shared `imageGen()` from ai-binding the module can vendor.) Throws
 *  on a flagged / refused generation so the caller can fall back. */
async function generateImage(env: Env, model: string, prompt: string, refUrls: string[]): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const refs: string[] = [];
  for (const u of refUrls) {
    const r = await fetch(u);
    if (!r.ok) continue;
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    refs.push(btoa(bin));
  }
  const out = await env.AI.run(model, { prompt, image_b64: refs });
  // best-effort extraction: a URL (the Nano-Banana family returns one), or base64 image bytes.
  const o = out as { image?: string; url?: string; images?: string[] };
  const url = typeof out === "string" && /^https?:\/\//.test(out) ? out : o.url;
  if (url) {
    const v = await fetch(url);
    return { bytes: await v.arrayBuffer(), mime: v.headers.get("content-type") || "image/png" };
  }
  const b64 = o.image || o.images?.[0];
  if (b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes: bytes.buffer, mime: "image/png" };
  }
  throw new Error("cast-image: model returned no image");
}

/** /invoke: validate, compose the prompt set, persist the run state to R2, return a stable poll
 *  pointer. No generation here -- /poll does the work, a few images at a time. */
async function submit(env: Env, req: InvokeRequest<CastImageInput>): Promise<InvokeResponse<CastImageOutput>> {
  const input = req.input;
  if (!input || typeof input.cast_id !== "number" || !input.portrait_url) {
    return { ok: false, error: "cast.image: input needs cast_id and portrait_url" };
  }
  const model = typeof req.config.model === "string" && MODELS.includes(req.config.model) ? req.config.model : MODELS[0];
  const num = typeof req.config.num_images === "number" ? req.config.num_images : 10;
  const state = buildState(input, model, num);
  const job_id = crypto.randomUUID();
  try {
    await env.R2_RENDERS.put(stateKey(input.cast_id, job_id), JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
  } catch (e) {
    return { ok: false, error: "cast.image: could not persist run state: " + (e as Error).message };
  }
  return { ok: true, pending: true, poll: encodePoll({ cast_id: input.cast_id, job_id }) };
}

/** /poll: load the run state, render the next prompt(s), persist progress, return pending until the
 *  prompt queue drains -> the CastImageOutput with every generated ref key. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<CastImageOutput>> {
  const token = decodePoll(body.poll);
  if (!token) return { ok: false, error: "cast.image: bad poll token" };
  const sk = stateKey(token.cast_id, token.job_id);
  const obj = await env.R2_RENDERS.get(sk);
  if (!obj) return { ok: false, error: "cast.image: run state not found (expired or bad token)" };
  const state = JSON.parse(await obj.text()) as CastImageState;
  if (state.prompts.length === 0) return { ok: true, output: readOutput(state) };

  for (let i = 0; i < PER_POLL && state.prompts.length > 0; i++) {
    const prompt = state.prompts[0];
    let img: { bytes: ArrayBuffer; mime: string };
    try {
      img = await generateImage(env, state.model, prompt, state.ref_urls);
    } catch (e) {
      if (isFlaggedError((e as Error).message) && state.model !== FLAG_FALLBACK_MODEL) {
        state.model = FLAG_FALLBACK_MODEL;
        state.fallback_used = true;
        try {
          img = await generateImage(env, state.model, prompt, state.ref_urls);
        } catch (e2) {
          return { ok: false, error: "cast.image: generation failed (post-fallback): " + (e2 as Error).message };
        }
      } else {
        return { ok: false, error: "cast.image: generation failed: " + (e as Error).message };
      }
    }
    const ext = img.mime.includes("jpeg") ? "jpg" : img.mime.includes("webp") ? "webp" : "png";
    const key = refKey(state.cast_id, state.done.length + 1, ext);
    try {
      await env.R2_RENDERS.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    } catch (e) {
      return { ok: false, error: "cast.image: R2 put failed: " + (e as Error).message };
    }
    state.done.push({ key, mime: img.mime });
    state.prompts.shift();
  }

  try {
    await env.R2_RENDERS.put(sk, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
  } catch {
    /* best-effort: the next poll re-reads the prior state and continues */
  }
  return state.prompts.length === 0 ? { ok: true, output: readOutput(state) } : { ok: true, pending: true };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<CastImageInput>;
      try {
        req = (await request.json()) as InvokeRequest<CastImageInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "cast.image") {
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
