// xAI SSE interpreter (v0.18.1).
//
// xAI's streaming API is OpenAI-compatible: each `data:` frame contains
// JSON of the shape:
//   {
//     "id": "...", "object": "chat.completion.chunk", "created": N,
//     "model": "grok-X", "choices": [{ "delta": { "content": "..." } }]
//   }
// followed by a usage frame (when stream_options.include_usage:true):
//   { ..., "usage": { "prompt_tokens": N, "completion_tokens": M, "total_tokens": K } }
// terminated by `data: [DONE]` (which the SSE framer drops before we see it).
//
// We extract text deltas from choices[0].delta.content and usage from the
// top-level usage object. Empty-string deltas are normal on the usage frame
// and are dropped.

import type { ProviderStreamEvent } from "./types";

export function interpretXaiSSEFrame(data: unknown): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  const d = data as {
    choices?: Array<{ delta?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = d.choices?.[0]?.delta?.content;
  if (typeof text === "string" && text.length > 0) {
    events.push({ type: "text", text });
  }

  if (d.usage) {
    events.push({
      type: "usage",
      in_: d.usage.prompt_tokens ?? null,
      out_: d.usage.completion_tokens ?? null,
    });
  }

  return events;
}
