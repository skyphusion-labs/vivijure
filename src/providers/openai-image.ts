// OpenAI direct (BYOK) image generation for transparent PNG (v0.22.1).
//
// Why this exists separately from the proxied image path: the Cloudflare
// Unified Billing proxy for openai/gpt-image-1.5 exposes a strict schema
// { prompt, images, quality, size, style } and 7003-rejects `background` and
// `output_format`. OpenAI's own /v1/images/generations endpoint DOES accept
// both (verified against OpenAI's API reference + image cookbook), so a direct
// BYOK call is the only way to get a real alpha channel.
//
// GPT image models ALWAYS return base64 (data[0].b64_json); the `url` response
// format is unsupported for them, so there is no URL to fetch, we decode the
// base64 directly. `background: "transparent"` with `output_format: "png"`
// yields an RGBA PNG.
import type { Env } from "../env";
import { base64ToBytes } from "../utils";

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: string;
}

// modelId is the catalog id, e.g. "openai/gpt-image-1.5"; OpenAI wants the bare
// model string, so we strip the "openai/" routing prefix.
export async function generateOpenAIImage(
  apiKey: string,
  modelId: string,
  prompt: string,
): Promise<GeneratedImage> {
  const model = modelId.replace(/^openai\//, "");

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      output_format: "png",
    }),
  });

  if (!resp.ok) {
    let detail = "";
    try {
      const e = (await resp.json()) as { error?: { message?: string } };
      detail = e?.error?.message ? `: ${e.error.message}` : "";
    } catch {
      /* non-JSON error body; status alone is enough */
    }
    throw new Error(`OpenAI image API ${resp.status}${detail}`);
  }

  const data = (await resp.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI image API returned no b64_json image data");
  }

  return { bytes: base64ToBytes(b64), mime: "image/png" };
}
