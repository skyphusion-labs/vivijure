// Reference-conditioned image generation for the cloud-keyframe module. Two shapes, mirroring
// modules/cast-image/src/image-gen.ts (the proven path):
//   @cf FLUX-2 : multipart FormData (prompt + width/height + input_image_0..3 reference blobs),
//                gateway-BYPASSED, returns { image: base64 } -> image bytes.
//   proxied    : env.AI.run THROUGH the gateway, returns a URL. Reference images go in image_input[]
//                (<=3, base64 data URIs) so identity carries; aspect goes in aspect_ratio (google).
//
// Unlike cast-image's generateImage (which fetches presigned ref URLs), this module already holds the
// reference portraits as Blobs (staged in R2, read via the binding), so generateImage takes Blobs
// directly. The small helpers are pure + unit-tested.

/** Minimal AI binding shape: `.run(model, params, opts?)`. The gateway opt is omitted for FLUX-2
 *  (multipart + gateway-incompatible) and passed for the proxied path. */
export interface AiRun {
  run(model: string, params: unknown, opts?: { gateway?: { id: string } }): Promise<unknown>;
}

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
 *  not blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Sniff the real image type from the leading magic bytes. FLUX-2 klein returns JPEG (not PNG), so
 *  the FLUX-2 path can't assume a type -- it reads it off the buffer. Recognizes JPEG / PNG / WEBP;
 *  defaults to png. */
export function sniffImageMime(bytes: ArrayBuffer | Uint8Array): { mime: string; ext: string } {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return { mime: "image/png", ext: "png" };
}

/** Pull the URL out of a proxied image-gen response: the wrapped { result: { image } } or the bare
 *  { image }. */
export function extractProxiedImageUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { result?: { image?: unknown }; image?: unknown };
  const wrapped = r.result?.image;
  if (typeof wrapped === "string" && wrapped.length > 0) return wrapped;
  if (typeof r.image === "string" && r.image.length > 0) return r.image;
  return null;
}

// The aspect ratios nano-banana-pro (and the other proxied image models) accept. We snap the
// configured width/height to the nearest of these so a square-defaulting model still produces a
// keyframe in the intended shape (the probe showed nano-banana picks its own aspect from the prompt
// otherwise; keyframe aspect drives the downstream i2v clip aspect, so it must be pinned).
const SUPPORTED_RATIOS: { label: string; value: number }[] = [
  { label: "1:1", value: 1 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "3:2", value: 3 / 2 },
  { label: "2:3", value: 2 / 3 },
];

/** Snap width/height to the nearest aspect-ratio string a proxied model accepts. We REQUEST this from
 *  nano-banana so it FRAMES the composition for the target aspect from the start (a full-body
 *  establishing shot stays composed for 16:9 instead of being shot square and later body-cropped).
 *  The exact-dimension finish then happens in the caller's normalizeKeyframe, where the crop is
 *  trivial because the frame already arrived near-target. Two halves of one aspect pin. */
export function nearestAspectRatio(width: number, height: number): string {
  const r = width > 0 && height > 0 ? width / height : 1;
  let best = SUPPORTED_RATIOS[0];
  let bestDiff = Infinity;
  for (const cand of SUPPORTED_RATIOS) {
    const diff = Math.abs(cand.value - r);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = cand;
    }
  }
  return best.label;
}

/** Params per proxied provider, with reference images + aspect. google (nano-banana) takes
 *  image_input[] (<=3) + aspect_ratio; openai takes images[] (<=16) + an explicit size. */
export function proxiedParams(
  model: string,
  prompt: string,
  imageInputs: string[],
  width: number,
  height: number,
): Record<string, unknown> {
  if (model.startsWith("google/")) {
    const p: Record<string, unknown> = { prompt, output_format: "png", aspect_ratio: nearestAspectRatio(width, height) };
    if (imageInputs.length) p.image_input = imageInputs.slice(0, PROXIED_MAX_REFS);
    return p;
  }
  if (model.startsWith("openai/")) {
    const p: Record<string, unknown> = { prompt, quality: "high", size: `${width}x${height}` };
    if (imageInputs.length) p.images = imageInputs.slice(0, 16);
    return p;
  }
  return { prompt };
}

/** Generate ONE keyframe from a prompt + already-fetched reference blobs. FLUX-2: multipart-multiref
 *  with width/height, gateway-bypassed, base64 result. Proxied: refs as image_input[] base64 data
 *  URIs + aspect_ratio, through the gateway, URL result. Returns image bytes + mime. Throws on a
 *  no-image / flagged generation so the caller HARD-FAILS the shot (a keyframe that did not render
 *  cannot be animated -- no soft-degrade on the foundation stage). */
export async function generateImage(
  ai: AiRun,
  gatewayId: string | undefined,
  model: string,
  prompt: string,
  refBlobs: Blob[],
  width: number,
  height: number,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  if (isFlux2(model)) {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    let i = 0;
    for (const blob of refBlobs) {
      if (i >= FLUX2_MAX_REFS) break;
      form.append(`input_image_${i}`, blob, `ref-${i}.png`);
      i++;
    }
    // FLUX-2 needs multipart and is gateway-incompatible, so run the binding DIRECTLY (no gateway opt).
    const fr = new Response(form);
    const result = await ai.run(model, {
      multipart: { body: fr.body, contentType: fr.headers.get("content-type") },
    });
    const b64 = (result as { image?: string })?.image;
    if (!b64 || typeof b64 !== "string") throw new Error("flux-2 returned no image");
    const bytes = base64ToBytes(b64).buffer as ArrayBuffer;
    return { bytes, mime: sniffImageMime(bytes).mime };
  }
  // proxied (e.g. nano-banana-pro): reference-condition via image_input[], through the gateway.
  const cap = model.startsWith("openai/") ? 16 : PROXIED_MAX_REFS;
  const imageInputs: string[] = [];
  for (const blob of refBlobs) {
    if (imageInputs.length >= cap) break;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    imageInputs.push(`data:image/png;base64,${bytesToBase64(bytes)}`);
  }
  const opts = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  const result = await ai.run(model, proxiedParams(model, prompt, imageInputs, width, height), opts);
  const url = extractProxiedImageUrl(result);
  if (!url) throw new Error("proxied image model returned no url");
  const v = await fetch(url);
  if (!v.ok) throw new Error("fetch proxied image -> " + v.status);
  return { bytes: await v.arrayBuffer(), mime: v.headers.get("content-type") || "image/png" };
}
