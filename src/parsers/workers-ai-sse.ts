// Workers AI SSE interpreter (v0.18.1).
//
// Workers AI's streaming format uses a flat `response` field per chunk rather
// than OpenAI's nested choices/delta/content. Empty-string `response` is
// normal on the final chunk (which carries usage) and is dropped.
//
// Usage naming varies by underlying model wrapper: some Workers AI adapters
// (especially OpenAI-derived ones like gpt-oss-120b/20b) emit OpenAI naming
// `prompt_tokens`/`completion_tokens`; others (Anthropic-derived adapters)
// emit `input_tokens`/`output_tokens`. We accept both and prefer the OpenAI
// names when both are present.
//
// Reasoning models (gpt-oss-120b, qwq-32b, deepseek-r1-distill-qwen-32b)
// emit `<think>...</think>` blocks inside `response`. The interpreter passes
// them through unchanged; the UI is responsible for folding them if desired.

import type { ProviderStreamEvent } from "./types";

export function interpretWorkersAISSEFrame(data: unknown): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  const d = data as Record<string, unknown>;

  const resp = d.response;
  if (typeof resp === "string" && resp.length > 0) {
    events.push({ type: "text", text: resp });
  }

  const usage = d.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  } | undefined;
  if (usage) {
    events.push({
      type: "usage",
      in_: usage.prompt_tokens ?? usage.input_tokens ?? null,
      out_: usage.completion_tokens ?? usage.output_tokens ?? null,
    });
  }

  return events;
}
