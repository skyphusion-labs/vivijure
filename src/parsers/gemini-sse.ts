// Gemini SSE interpreter (v0.21.4).
//
// Streamed via env.AI.run("google/gemini-*", { ...contents, stream: true }).
// Each SSE frame is a Gemini chunk shaped like the non-stream response:
//   { candidates: [{ content: { parts: [{ text }] } }], usageMetadata? }
//
// The interpreter is stateless and returns the frame's candidate text as-is
// (joined parts) plus any usage. The incremental-vs-cumulative question is
// handled OUTSIDE the interpreter, in the stream caller, via the reconciler
// below, because it needs cross-frame state. We don't probe which mode the
// binding uses, so we reconcile defensively (see makeGeminiDeltaReconciler).

import type { ProviderStreamEvent } from "./types";

export function interpretGeminiSSEFrame(data: unknown): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  if (!data || typeof data !== "object") return events;
  const d = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const parts = d.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts.map((p) => p?.text ?? "").join("");
    if (text.length > 0) events.push({ type: "text", text });
  }

  if (d.usageMetadata) {
    events.push({
      type: "usage",
      in_: d.usageMetadata.promptTokenCount ?? null,
      out_: d.usageMetadata.candidatesTokenCount ?? null,
    });
  }

  return events;
}

// Gemini stream chunks may be INCREMENTAL (each chunk's text is the new piece)
// or CUMULATIVE (each chunk's text is the full answer so far), depending on the
// binding. We don't probe it, so reconcile defensively:
//   - If the new frame text extends what we've already emitted (startsWith),
//     it's cumulative -> emit only the new suffix.
//   - Otherwise it's a fresh incremental piece -> emit it whole.
// Both modes produce correct, non-repeating deltas for the consumer to append.
// Edge case: an incremental piece that exactly equals emitted+suffix would be
// mis-sliced; astronomically unlikely in natural-language token streams. If a
// live test ever shows repeated or truncated text, the probe (raw frames) tells
// you the true mode and this can be hard-coded to one branch.
export function makeGeminiDeltaReconciler(): (frameText: string) => string {
  let emitted = "";
  return (t: string): string => {
    if (t.startsWith(emitted)) {
      const delta = t.slice(emitted.length);
      emitted = t;
      return delta;
    }
    emitted += t;
    return t;
  };
}
