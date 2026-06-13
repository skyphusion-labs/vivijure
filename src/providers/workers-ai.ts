// Workers AI chat dispatch (v0.19.3).
//
// Extracted from src/index.ts as the final stage of the v0.19.x provider
// dispatcher split. Owns the streaming chat path for all Workers AI chat
// models (Llama, Qwen, DeepSeek, Mistral, Gemma, GLM, Nemotron, Granite,
// Hermes, GPT-OSS, Kimi).
//
// Unlike the other three providers, Workers AI has no separate non-streaming
// "callWorkersAI" function: the non-streaming path calls aiRun directly with
// { messages } and unwraps the response inline in the dispatch. Only the
// streaming path needs its own dispatcher because it consumes a ReadableStream
// and parses SSE frames.

import type { Env } from "../env";
import type { ModelEntry } from "../models";
import type { ProviderStreamEvent } from "../parsers/types";
import { aiRun } from "../ai-binding";
import { extractSSEDataPayloads } from "../parsers/sse-framer";
import { interpretWorkersAISSEFrame } from "../parsers/workers-ai-sse";

// Async generator: drives a Workers AI chat model via env.AI.run with
// stream:true and yields normalized text + usage events.
//
// Workers AI streaming returns a ReadableStream from env.AI.run, already
// SSE-formatted. Event shape is OpenAI-compatible:
//   data: {"response":"..."}                       // one per token chunk
//   data: {"response":"","usage":{...}}            // final usage chunk
//   data: [DONE]                                   // terminal sentinel
//
// Abort handling: env.AI.run doesn't accept an AbortSignal directly, so we
// bridge by listening for the signal on the consumer side and calling
// reader.cancel() to release the upstream stream when the client disconnects.

export async function* callWorkersAIStream(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  const result = await aiRun(env, model.id, { messages, stream: true });

  if (!(result instanceof ReadableStream)) {
    throw new Error(`Workers AI did not return a stream (got ${typeof result}). Ensure stream:true is honored by this model.`);
  }

  const reader = result.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Bridge AbortSignal -> reader.cancel(). If the signal is already aborted
  // by the time we get here, cancel immediately.
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
        for (const event of interpretWorkersAISSEFrame(data)) yield event;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}
