// Image generation for the cast-image module -- ported from the playground's proven path
// (skyphusion-llm-public: src/index.ts `runImage` + proxied-image-params + output-extract), so the
// studio OWNS cast-ref image gen instead of reaching back to the playground's /api/chat. Two shapes:
//   @cf FLUX-2 : multipart FormData (prompt + input_image_0..3 reference blobs), gateway-BYPASSED,
//                returns { image: base64 } -> PNG bytes. The reference-conditioned path (the portrait).
//   proxied    : env.AI.run THROUGH the gateway, prompt-only params, returns a URL (the nano-banana
//                fallback -- prompt-only, no reference conditioning, matching the playground).
// `generateImage` does I/O (fetches the refs + the result URL); the small helpers below are pure +
// unit-tested.

/** Minimal AI binding shape: `.run(model, params, opts?)`. The gateway opt is omitted for FLUX-2
 *  (multipart + gateway-incompatible, run direct) and passed for the proxied path. */
export interface AiRun {
  run(model: string, params: unknown, opts?: { gateway?: { id: string } }): Promise<unknown>;
}

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

/** Prompt-only params per proxied provider (ported from proxied-image-params.buildProxiedImageParams).
 *  cast-image only uses the google (nano-banana) fallback today, but keep the shape faithful +
 *  provider-keyed so the other proxied models drop in cleanly. */
export function proxiedParams(model: string, prompt: string): Record<string, unknown> {
  if (model.startsWith("google/")) return { prompt, output_format: "png" };
  if (model.startsWith("openai/")) return { prompt, quality: "high", size: "1024x1024" };
  if (model.startsWith("recraft/")) return { prompt, size: "1024x1024", style: "digital_illustration" };
  return { prompt };
}

/** Fetch the reference images (presigned URLs) into Blobs for FLUX-2's input_image_N form fields.
 *  Caps at 4 (FLUX-2's max); skips any that fail to fetch. */
async function fetchRefBlobs(refUrls: string[]): Promise<Blob[]> {
  const blobs: Blob[] = [];
  for (const u of refUrls) {
    if (blobs.length >= 4) break;
    try {
      const r = await fetch(u);
      if (r.ok) blobs.push(await r.blob());
    } catch {
      /* skip a ref that fails to fetch */
    }
  }
  return blobs;
}

/** Generate ONE image. FLUX-2: multipart-multiref, gateway-bypassed, base64 result. Proxied: prompt-
 *  only through the gateway, URL result. Returns image bytes + mime. Throws on no-image / a flagged
 *  generation so the caller can retry / fall back. */
export async function generateImage(
  ai: AiRun,
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
    for (const blob of await fetchRefBlobs(refUrls)) {
      form.append(`input_image_${i}`, blob, `ref-${i}.png`);
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
    return { bytes: base64ToBytes(b64).buffer as ArrayBuffer, mime: "image/png" };
  }
  // proxied (e.g. the nano-banana fallback): prompt-only, through the gateway, URL result.
  const opts = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  const result = await ai.run(model, proxiedParams(model, prompt), opts);
  const url = extractProxiedImageUrl(result);
  if (!url) throw new Error("proxied image model returned no url");
  const v = await fetch(url);
  if (!v.ok) throw new Error("fetch proxied image -> " + v.status);
  return { bytes: await v.arrayBuffer(), mime: v.headers.get("content-type") || "image/png" };
}
