// Text-model output + usage extraction (v0.21.0).
//
// Extracted from src/index.ts so these pure functions are unit-testable
// without importing index.ts (which pulls in `cloudflare:workers` and so
// can't be loaded under the plain-Node vitest pool). Mirrors the same
// extraction discipline used for parsers, chunking, discord, and ai-binding.
//
// Both functions normalize the many response shapes that reach the
// non-streaming chat path. The shapes come from: Workers AI hosted models
// (env.AI.run), Anthropic Messages API, Gemini, and OpenAI-style responses
// (both chat-completions and the Responses API) returned by unified-billing
// proxied models routed through env.AI.run. New shapes should be added here
// with a unit test in tests/output-extract.test.ts rather than inlined at a
// call site.

export function extractOutput(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as Record<string, unknown>;

  if (typeof r?.response === "string") return r.response;
  if (typeof r?.result === "string")   return r.result;

  // OpenAI chat-completions shape (also what AI Gateway returns for most
  // proxied OpenAI/OpenAI-compatible chat models): { choices: [{ message }] }
  const choices = r?.choices as Array<{ message?: { content?: string } }> | undefined;
  if (Array.isArray(choices) && typeof choices[0]?.message?.content === "string") {
    return choices[0].message.content;
  }

  // Anthropic Messages API: top-level content array
  const content = r?.content as Array<{ type?: string; text?: string }> | undefined;
  if (Array.isArray(content)) {
    const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    if (text) return text;
  }

  // OpenAI Responses API shape (used by gpt-5.x-pro and similar): a top-level
  // `output` array of items, each with a `content` array of typed blocks.
  // Output text lives in blocks of type "output_text" (or plain "text").
  const out = r?.output as Array<unknown> | undefined;
  if (Array.isArray(out)) {
    const text = out
      .flatMap((block) => {
        const b = block as { content?: Array<{ type?: string; text?: string }> };
        return (b?.content ?? [])
          .filter((c) => c?.type === "output_text" || c?.type === "text")
          .map((c) => c.text ?? "");
      })
      .join("");
    if (text) return text;
  }

  // Gemini-native (google/gemini-* via the binding, v0.21.3):
  // { candidates: [{ content: { parts: [{ text }] } }] }
  const candidates = r?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
  if (Array.isArray(candidates)) {
    const text = (candidates[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    if (text) return text;
  }

  // LLaVA 1.5 image-to-text (@cf/llava-hf/llava-1.5-7b-hf): { description }
  if (typeof r?.description === "string") return r.description;

  return JSON.stringify(result);
}

export function extractUsage(result: unknown): { in_: number | null; out_: number | null } {
  const r = result as Record<string, unknown>;
  // OpenAI / Anthropic: usage object on result. OpenAI uses
  // prompt_tokens/completion_tokens; Anthropic uses input_tokens/output_tokens.
  const u = r?.usage as Record<string, number> | undefined;
  if (u) {
    return {
      in_:  u.prompt_tokens ?? u.input_tokens ?? null,
      out_: u.completion_tokens ?? u.output_tokens ?? null,
    };
  }
  // Gemini-native usage (v0.21.3): usageMetadata.promptTokenCount /
  // candidatesTokenCount (thoughtsTokenCount is reasoning, not counted as out).
  const um = r?.usageMetadata as Record<string, number> | undefined;
  if (um) {
    return {
      in_:  um.promptTokenCount ?? null,
      out_: um.candidatesTokenCount ?? null,
    };
  }
  return { in_: null, out_: null };
}

// Detect a provider failure envelope returned as a normal resolved value
// rather than thrown. Unified-billing proxied models (seen first with the
// OpenAI chat models in v0.21.0) can return { state: "Failed", error: "..." }
// from env.AI.run instead of rejecting; the gateway uses the same envelope
// the LongRunWorkflow already checks for video/music. Without catching it,
// extractOutput would JSON.stringify the envelope into chats.output and a
// failed turn would persist as if it succeeded.
//
// Sync chat responses (OpenAI {choices}, Anthropic {content}, Workers AI
// {response}) carry no `state` field, so a present `state` that isn't
// "Completed" is the signal. Returns the upstream error message (for the
// caller to surface as a 502) or null when the result looks normal.
export function detectProviderFailure(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.state === "string" && r.state !== "Completed") {
    return typeof r.error === "string" && r.error.trim()
      ? r.error
      : `provider returned state "${r.state}"`;
  }
  return null;
}

// Pull the generated-image URL out of a proxied image-gen response. Proxied
// image models (the Google nano-banana family, added v0.21.2) return a URL,
// not base64, wrapped in the same { state, result } envelope as video/music:
//   { state: "Completed", result: { image: "<url>" } }
// The bare { image: "<url>" } form (the documented Output schema, without the
// binding wrapper) is accepted too. Returns the URL string or null.
export function extractProxiedImageUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { result?: { image?: unknown }; image?: unknown };
  const wrapped = r.result?.image;
  if (typeof wrapped === "string" && wrapped.length > 0) return wrapped;
  if (typeof r.image === "string" && r.image.length > 0) return r.image;
  return null;
}
