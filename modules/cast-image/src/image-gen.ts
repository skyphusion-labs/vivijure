// Image generation for the cast-image module. Two shapes:
//   @cf FLUX-2 : multipart FormData (prompt + input_image_0..3 reference blobs), gateway-BYPASSED,
//                returns { image: base64 } -> PNG bytes. The reference-conditioned path (the portrait).
//   proxied    : env.AI.run THROUGH the gateway, returns a URL (the nano-banana fallback). Reference
//                images go in image_input[] (<=3, base64 data URIs) so the fallback keeps character
//                identity instead of being prompt-only.
// `generateImage` does I/O (fetches/downscales the refs + fetches the result URL); the small helpers
// below are pure + unit-tested.
//
// Reference images are DOWNSCALED to <=512px before use (via the Images binding): FLUX-2 caps inputs
// at 512x512 per image (sending bigger gets rejected upstream), and bounding the nano-banana data
// URIs keeps the gateway JSON payload sane. The browser used to do this client-side
// (cast.js downscaleToDataUrl); it now lives server-side with the rest of the generation.

/** Minimal AI binding shape: `.run(model, params, opts?)`. The gateway opt is omitted for FLUX-2
 *  (multipart + gateway-incompatible, run direct) and passed for the proxied path. */
export interface AiRun {
  run(model: string, params: unknown, opts?: { gateway?: { id: string } }): Promise<unknown>;
}

/** Minimal Cloudflare Images binding shape (env.IMAGES): chainable input -> transform -> output.
 *  Used only to downscale reference images; optional so the module still runs (refs un-resized) if a
 *  deployment has not bound it. */
interface ImagesTransformer {
  transform(opts: Record<string, unknown>): ImagesTransformer;
  output(opts: { format: string }): Promise<{ response(): Response }>;
}
export interface ImagesBinding {
  input(stream: ReadableStream): ImagesTransformer;
}

/** FLUX-2 input cap (512x512 per image) -- also the downscale target for the nano-banana refs. */
export const REF_MAX_DIM = 512;
const FLUX2_MAX_REFS = 4;   // FLUX-2 takes up to 4 input_image_N
const PROXIED_MAX_REFS = 3; // nano-banana image_input[] maxItems

export function isFlux2(model: string): boolean {
  return model.startsWith("@cf/black-forest-labs/flux-2-");
}

/** base64 -> bytes. FLUX-2 returns { image: "<base64>" }. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** bytes -> base64. Used to build the nano-banana image_input data URIs. Chunked so a large ref does
 *  not blow the call stack (String.fromCharCode.apply on a big array throws). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Sniff the real image type from the leading magic bytes and return its `{ mime, ext }`. FLUX-2
 *  klein returns JPEG bytes (not PNG), so the FLUX-2 path can't assume a type -- it reads it off the
 *  buffer instead. Recognizes JPEG / PNG / WEBP; defaults to png for anything unrecognized (the
 *  historical assumption, kept as the safe fallback). */
export function sniffImageMime(bytes: ArrayBuffer | Uint8Array): { mime: string; ext: string } {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // PNG: 89 50 4E 47
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  // WEBP: "RIFF" (52 49 46 46) .... "WEBP" (57 45 42 50) at offset 8
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return { mime: "image/png", ext: "png" };
}

/** Pull the URL out of a proxied image-gen response (ported from output-extract.extractProxiedImageUrl):
 *  the wrapped { state, result: { image: "<url>" } } or the bare { image: "<url>" }. */
export function extractProxiedImageUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { result?: { image?: unknown }; image?: unknown };
  const wrapped = r.result?.image;
  if (typeof wrapped === "string" && wrapped.length > 0) return wrapped;
  if (typeof r.image === "string" && r.image.length > 0) return r.image;
  return null;
}

/** Params per proxied provider (ported from proxied-image-params.buildProxiedImageParams), now with
 *  reference images: google (nano-banana) takes image_input[] (<=3); openai takes images[] (<=16);
 *  recraft has no documented ref input. cast-image only uses the google fallback today, but keep the
 *  shape faithful + provider-keyed so the other proxied models drop in cleanly. imageInputs are
 *  base64 data URIs (the form the image-edit models accept). */
export function proxiedParams(model: string, prompt: string, imageInputs: string[] = []): Record<string, unknown> {
  if (model.startsWith("google/")) {
    const p: Record<string, unknown> = { prompt, output_format: "png" };
    if (imageInputs.length) p.image_input = imageInputs.slice(0, PROXIED_MAX_REFS);
    return p;
  }
  if (model.startsWith("openai/")) {
    const p: Record<string, unknown> = { prompt, quality: "high", size: "1024x1024" };
    if (imageInputs.length) p.images = imageInputs.slice(0, 16);
    return p;
  }
  if (model.startsWith("recraft/")) return { prompt, size: "1024x1024", style: "digital_illustration" };
  return { prompt };
}

/** Fetch one reference image (a presigned URL) into a Blob, or null if it fails. */
async function fetchRef(url: string): Promise<Blob | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

/** Downscale a reference blob to fit within REF_MAX_DIM (long edge), preserving aspect, never
 *  upscaling (fit: scale-down). Best-effort: with no Images binding, or on a transform failure, the
 *  original blob is returned (FLUX-2 may then reject an oversized ref -- that surfaces as a gen error
 *  the caller already handles, rather than a crash here). */
async function downscaleRef(images: ImagesBinding | undefined, blob: Blob): Promise<Blob> {
  if (!images) return blob;
  try {
    const out = await images
      .input(blob.stream())
      .transform({ width: REF_MAX_DIM, height: REF_MAX_DIM, fit: "scale-down" })
      .output({ format: "image/png" });
    return await out.response().blob();
  } catch {
    return blob;
  }
}

/** Generate ONE image. FLUX-2: multipart-multiref (refs downscaled to <=512px), gateway-bypassed,
 *  base64 result. Proxied: refs as image_input[] base64 data URIs, through the gateway, URL result.
 *  Returns image bytes + mime. Throws on no-image / a flagged generation so the caller can retry /
 *  fall back. */
export async function generateImage(
  ai: AiRun,
  images: ImagesBinding | undefined,
  gatewayId: string | undefined,
  model: string,
  prompt: string,
  refUrls: string[],
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  if (isFlux2(model)) {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", "1024");
    form.append("height", "1024");
    let i = 0;
    for (const url of refUrls) {
      if (i >= FLUX2_MAX_REFS) break;
      const blob = await fetchRef(url);
      if (!blob) continue;
      const small = await downscaleRef(images, blob); // <=512px (FLUX-2's hard input cap)
      form.append(`input_image_${i}`, small, `ref-${i}.png`);
      i++;
    }
    // FLUX-2 needs multipart and is gateway-incompatible, so run the binding DIRECTLY (no gateway opt).
    // FormData doesn't expose its serialized body/boundary; wrap in a Response to get both.
    const fr = new Response(form);
    const result = await ai.run(model, {
      multipart: { body: fr.body, contentType: fr.headers.get("content-type") },
    });
    const b64 = (result as { image?: string })?.image;
    if (!b64 || typeof b64 !== "string") throw new Error("flux-2 returned no image");
    // FLUX-2 klein returns JPEG (not PNG) -- sniff the actual type so the stored mime + R2 key
    // suffix match the real bytes instead of a hardcoded "image/png".
    const bytes = base64ToBytes(b64).buffer as ArrayBuffer;
    return { bytes, mime: sniffImageMime(bytes).mime };
  }
  // proxied (e.g. the nano-banana fallback): reference-condition via image_input[], through the gateway.
  const cap = model.startsWith("openai/") ? 16 : PROXIED_MAX_REFS;
  const imageInputs: string[] = [];
  for (const url of refUrls) {
    if (imageInputs.length >= cap) break;
    const blob = await fetchRef(url);
    if (!blob) continue;
    const small = await downscaleRef(images, blob);
    const bytes = new Uint8Array(await small.arrayBuffer());
    imageInputs.push(`data:image/png;base64,${bytesToBase64(bytes)}`);
  }
  const opts = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  const result = await ai.run(model, proxiedParams(model, prompt, imageInputs), opts);
  const url = extractProxiedImageUrl(result);
  if (!url) throw new Error("proxied image model returned no url");
  const v = await fetch(url);
  if (!v.ok) throw new Error("fetch proxied image -> " + v.status);
  return { bytes: await v.arrayBuffer(), mime: v.headers.get("content-type") || "image/png" };
}
