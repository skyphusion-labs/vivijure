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
  // Release set: the Anthropic Claude family only. Opus is the default and the
  // only model that reliably plans shots AND holds the storyboard.yaml schema;
  // Sonnet is the cheaper fallback for shorter scenes. Haiku is dropped -- it was
  // never validated for planning and is almost certainly underpowered for the
  // structured storyboard task. Everything else (OpenAI, Google, xAI, open-weight
  // Workers AI) returns later as opt-in expansion modules instead of shipping a
  // flooded default picker. (v0.165.0; Haiku dropped 2026-06-14)
  "anthropic/claude-opus-4-8",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6",
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
