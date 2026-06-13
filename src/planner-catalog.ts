// Curated subset of MODELS for the storyboard planner picker (v0.28.0).
//
// Stays small and stable so the planner UI is not flooded with frontier
// models the user has not specifically vetted for JSON-schema output
// discipline. Each row reuses the full ModelEntry from src/models.ts so
// the UI's existing model-row renderer keeps working without changes.
//
// Adding a model: append its id to PLANNING_MODEL_IDS; the row must
// already exist in MODELS. The catalog test (tests/planner-catalog.
// test.ts) fails fast if an id is dangling. Note the dispatch constraint:
// the planner can only reach providers plannerProviderFor() maps to a real
// path (anthropic, xai, google, workers-ai/aiRun); OpenAI rides the
// workers-ai/aiRun else-branch.

import { MODELS, type ModelEntry } from "./models";

export type PlanningProvider = "anthropic" | "xai" | "google" | "workers-ai";

const PLANNING_MODEL_IDS: readonly string[] = [
  // Anthropic (Unified Billing)
  "anthropic/claude-opus-4-8",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  // OpenAI (Unified Billing; rides aiRun like the main chat path)
  "openai/gpt-5.5",
  // Google (Unified Billing; dispatched via callGemini, not the bare aiRun
  // else-branch, because Gemini needs the systemInstruction + contents body)
  "google/gemini-3.1-pro",
  // xAI BYOK
  "xai/grok-4.3",
  "xai/grok-4.20-multi-agent-0309",
  // Workers AI text (frontier; v0.89.0 added Kimi K2.6, Gemma 4 26B,
  // Qwen3 30B MoE so users have open-weight options alongside the
  // BYOK frontier models)
  "@cf/zai-org/glm-4.7-flash",
  "@cf/openai/gpt-oss-120b",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/qwen/qwen3-30b-a3b-fp8",
] as const;

const PLANNING_ID_SET: ReadonlySet<string> = new Set(PLANNING_MODEL_IDS);

export const PLANNING_MODELS: ModelEntry[] = MODELS.filter((m) =>
  PLANNING_ID_SET.has(m.id),
);

export function findPlanningModel(id: string): ModelEntry | undefined {
  return PLANNING_MODELS.find((m) => m.id === id);
}

// Maps a planning-catalog ModelEntry to one of the dispatch paths.
// Workers AI (aiRun) is the default when no explicit provider is set on the
// ModelEntry, and also carries OpenAI, which rides aiRun with a plain
// {messages} body (matches src/index.ts's chat path). Google is split out
// because Gemini needs its own request body via callGemini.
export function plannerProviderFor(model: ModelEntry): PlanningProvider {
  if (model.provider === "anthropic") return "anthropic";
  if (model.provider === "xai") return "xai";
  if (model.provider === "google") return "google";
  return "workers-ai";
}
