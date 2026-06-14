// Shared SSE framer (v0.18.1).
//
// Extracted from callXaiStream, callWorkersAIStream, and callAnthropicStream
// in src/index.ts. All three providers emit OpenAI/Anthropic-compatible SSE
// where event boundaries are blank-line-delimited (`\n\n`) and the payload
// we care about lives on `data:` lines; per-provider event-type semantics
// live in their respective interpreters (xai-sse.ts, workers-ai-sse.ts,
// anthropic-sse.ts).
//
// Behavior preserved from the inline implementations:
//   - Multi-line `data:` fields use "last line wins" rather than concat
//     (none of our three providers emit multi-line data fields; spec-correct
//     SSE would concat with newlines, but we match the pre-extraction
//     behavior exactly).
//   - Both `"data: "` (with space) and `"data:"` (compact) prefixes work.
//   - `[DONE]` sentinel is dropped.
//   - Blank or whitespace-only events are dropped.
//   - `event:`, `id:`, `retry:` lines are ignored; the parser only reads `data:`.

export function extractSSEDataPayloads(
  buffer: string,
): { payloads: string[]; remainder: string } {
  const payloads: string[] = [];
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() ?? "";

  for (const part of parts) {
    if (!part.trim()) continue;
    let payload = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("data: ")) payload = line.slice(6);
      else if (line.startsWith("data:")) payload = line.slice(5);
    }
    if (!payload || payload === "[DONE]") continue;
    payloads.push(payload);
  }

  return { payloads, remainder };
}
