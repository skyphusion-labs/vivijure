// OpenAI SSE interpreter (v0.21.0).
//
// OpenAI chat models are proxied through Cloudflare Unified Billing via
// env.AI.run("openai/<model>", { messages, stream: true }). Empirically the
// binding can hand back one of two known frame shapes for a streamed proxied
// model, and which one is not contractually documented:
//
//   1. OpenAI-native delta (same wire format as xAI):
//        { "choices": [{ "delta": { "content": "..." } }], "usage"?: {...} }
//   2. CF-normalized flat (same shape Workers AI hosted models emit):
//        { "response": "...", "usage"?: {...} }
//
// Rather than guess which one the proxy uses (and ship a parser that silently
// yields empty output if the guess is wrong), this interpreter handles BOTH.
// The two shapes don't collide: an OpenAI-native frame has no `response` key,
// a flat frame has no `choices`, so checking each independently is safe. If a
// future third shape appears, add a branch here with a fixture test.
//
// `data: [DONE]` is dropped by the SSE framer before frames reach here. Empty
// content/response strings (normal on the trailing usage frame) are dropped.
// Usage naming is accepted in both OpenAI (prompt_tokens/completion_tokens)
// and Anthropic-derived (input_tokens/output_tokens) forms for safety.

import type { ProviderStreamEvent } from "./types";

export function interpretOpenAISSEFrame(data: unknown): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  if (!data || typeof data !== "object") return events;
  const d = data as {
    choices?: Array<{ delta?: { content?: string } }>;
    response?: unknown;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  // Shape 1: OpenAI-native delta.
  const delta = d.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta.length > 0) {
    events.push({ type: "text", text: delta });
  }

  // Shape 2: CF-normalized flat `response`.
  if (typeof d.response === "string" && d.response.length > 0) {
    events.push({ type: "text", text: d.response });
  }

  if (d.usage) {
    events.push({
      type: "usage",
      in_: d.usage.prompt_tokens ?? d.usage.input_tokens ?? null,
      out_: d.usage.completion_tokens ?? d.usage.output_tokens ?? null,
    });
  }

  return events;
}
