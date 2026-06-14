// OpenAI proxied chat streaming (v0.21.0).
//
// OpenAI chat models route through Cloudflare Unified Billing, not BYOK, so
// the streaming path is the env.AI.run binding path (same as Workers AI),
// NOT a direct provider-endpoint fetch (the way Anthropic and xAI stream).
// We call aiRun with stream:true, get a ReadableStream of SSE frames, and
// parse them with interpretOpenAISSEFrame, which tolerates both the
// OpenAI-native delta shape and the CF-normalized flat `response` shape.
//
// Structurally identical to callWorkersAIStream (the other binding-based
// streaming path); only the frame interpreter differs. Abort is bridged the
// same way: env.AI.run takes no AbortSignal, so we cancel the reader when the
// consumer signal fires.

import type { Env } from "../env";
import type { ModelEntry } from "../models";
import type { ProviderStreamEvent } from "../parsers/types";
import { aiRun } from "../ai-binding";
import { extractSSEDataPayloads } from "../parsers/sse-framer";
import { interpretOpenAISSEFrame } from "../parsers/openai-sse";

export async function* callOpenAIStream(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  const result = await aiRun(env, model.id, { messages, stream: true });

  if (!(result instanceof ReadableStream)) {
    throw new Error(`OpenAI proxied model did not return a stream (got ${typeof result}). The binding may not honor stream:true for this model; use POST /api/chat instead.`);
  }

  const reader = result.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => { try { reader.cancel(); } catch { /* fine */ } };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const { payloads, remainder } = extractSSEDataPayloads(buffer);
      buffer = remainder;

      for (const payload of payloads) {
        let data: unknown;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const event of interpretOpenAISSEFrame(data)) yield event;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}
