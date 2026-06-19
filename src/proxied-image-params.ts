// Per-provider request params for proxied (non-@cf) image models (text-to-image only).

import type { Provider } from "./models";

export function buildProxiedImageParams(
  provider: Provider | undefined,
  prompt: string,
): Record<string, unknown> {
  switch (provider) {
    case "google":
      return { prompt, output_format: "png" };
    case "openai":
      return { prompt, quality: "high", size: "1024x1024" };
    case "recraft":
      return { prompt, size: "1024x1024", style: "digital_illustration" };
    default:
      return { prompt };
  }
}
