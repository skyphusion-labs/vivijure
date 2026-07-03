// cast-image: a cast.image module worker (vivijure-module/2). Generates a character's LoRA TRAINING
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
import { generateImage, type AiRun, type ImagesBinding } from "./image-gen";

// Minimal binding shapes this module needs.
interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}
interface Env {
  AI: AiRun;              // AI binding: FLUX 2 run direct (gateway-bypassed), proxied models via the gateway
  GATEWAY_ID: SecretsStoreSecret;     // AI Gateway slug (secret); needed for the proxied / nano-banana fallback path
  R2_RENDERS: R2Bucket;   // the shared `vivijure` bucket: run state + generated refs land here
  IMAGES?: ImagesBinding; // Cloudflare Images: downscale refs to <=512px (FLUX-2's input cap; bounds nano-banana payloads)
}

const MODELS = [
  "@cf/black-forest-labs/flux-2-klein-9b",
  "google/nano-banana-pro",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-dev",
];

const MANIFEST: ModuleManifest = {
  name: "cast-image",
  version: "0.1.1",
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
  const gatewayId = await secretValue(env.GATEWAY_ID);

  for (let i = 0; i < PER_POLL && state.prompts.length > 0; i++) {
    const prompt = state.prompts[0];
    let img: { bytes: ArrayBuffer; mime: string };
    try {
      img = await generateImage(env.AI, env.IMAGES, gatewayId, state.model, prompt, state.ref_urls);
    } catch (e) {
      if (isFlaggedError((e as Error).message) && state.model !== FLAG_FALLBACK_MODEL) {
        state.model = FLAG_FALLBACK_MODEL;
        state.fallback_used = true;
        try {
          img = await generateImage(env.AI, env.IMAGES, gatewayId, state.model, prompt, state.ref_urls);
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
