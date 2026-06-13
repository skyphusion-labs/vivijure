// Anthropic SSE interpreter (v0.18.1).
//
// Anthropic's streaming format uses named events distinguished by a `type`
// field inside each `data:` payload (the framer ignores the `event:` header
// line since the payload's own `type` carries the same information).
//
// Event types and our handling:
//   - message_start    -> usage event (initial input_tokens + small initial output_tokens)
//   - content_block_start -> ignored
//   - content_block_delta (with delta.type=text_delta) -> text event
//   - content_block_delta (with delta.type=input_json_delta) -> ignored (tool-use)
//   - content_block_stop -> ignored
//   - message_delta    -> usage event (final output_tokens count)
//   - message_stop     -> ignored
//   - ping             -> ignored (keep-alive)
//
// Usage appears in TWO places: message_start carries the initial input_tokens
// plus a low output_tokens estimate, and message_delta later carries the final
// accurate output_tokens. Consumers typically take the last usage event of
// each kind. Both are emitted; downstream code decides what to do with them.

import type { ProviderStreamEvent } from "./types";

export function interpretAnthropicSSEFrame(data: unknown): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  const d = data as Record<string, unknown>;
  const evType = d.type as string | undefined;

  if (evType === "content_block_delta") {
    const delta = d.delta as { type?: string; text?: string } | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      events.push({ type: "text", text: delta.text });
    }
  } else if (evType === "message_start") {
    const msg = d.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
    if (msg?.usage) {
      events.push({
        type: "usage",
        in_: msg.usage.input_tokens ?? null,
        out_: msg.usage.output_tokens ?? null,
      });
    }
  } else if (evType === "message_delta") {
    const usage = d.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      events.push({
        type: "usage",
        in_: usage.input_tokens ?? null,
        out_: usage.output_tokens ?? null,
      });
    }
  }
  // content_block_start, content_block_stop, message_stop, ping: ignored

  return events;
}
