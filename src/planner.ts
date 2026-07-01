// Storyboard planner dispatcher (v0.28.0).
//
// Takes a brief + character bible + model selection, dispatches to one of
// callAnthropic (Unified Billing), callGemini (Unified Billing), callXai
// (BYOK), or aiRun (Workers AI / OpenAI binding) for
// a single non-streaming completion, strips ```json fences, JSON.parses
// the result, runs validateStoryboard, and returns the validated
// StoryboardValidated or the error list. Does NOT submit anything to
// RunPod; the caller takes the result and either re-prompts the model
// with the errors or hands the validated value to serializeStoryboardYaml
// for the bundle.
//
// Auth lives inside the provider modules; this file never reads secrets
// directly. Anthropic rides Cloudflare Unified Billing (CF_AIG_TOKEN), xAI is
// BYOK (XAI_API_KEY), and Workers AI runs through aiRun (env.AI + GATEWAY_ID).

import type { Env } from "./env";
import { callAnthropic } from "./providers/anthropic";
import { callGemini } from "./providers/google";
import { callXai } from "./providers/xai";
import { aiRun, aiLogId } from "./ai-binding";
import { plannerAiMockEnabled, mockPlannerRaw } from "./planner-ai-mock";
import { extractOutput, detectProviderFailure } from "./output-extract";
import {
  validateStoryboard,
  type StoryboardValidated,
} from "./storyboard-validate";
import {
  type PlanningProvider,
  findPlanningModel,
  plannerProviderFor,
} from "./planner-catalog";
import {
  type PlannerCharacter,
  buildPlanningSystemPrompt,
  buildPlanningUserMessage,
  buildRefinementSystemPrompt,
  buildRefinementUserMessage,
  stripJsonFences,
} from "./planner-prompt";

export type { PlannerCharacter, PlanningProvider };

export interface PlanStoryboardArgs {
  brief: string;
  // v0.165.0 (#143): optional so hPlan can safely default to [] when the
  // client omits the field (new project with no cast assigned yet).
  characters: PlannerCharacter[];
  // PlanningModel.id from planner-catalog, e.g. "anthropic/claude-opus-4-7"
  // or "@cf/zai-org/glm-4.7-flash".
  model: string;
  // Optional beat-synced timing block (beat-timing.buildBeatTimingBlock).
  // When set, it is injected into the planning user message to pin the shot
  // count + per-shot pacing to an audio bed.
  beatBlock?: string;
}

export type PlanStoryboardResult =
  | {
      ok: true;
      storyboard: StoryboardValidated;
      raw: string;
      provider: PlanningProvider;
      model: string;
      logId: string | null;
    }
  | {
      ok: false;
      errors: string[];
      raw: string | null;
      provider: PlanningProvider | null;
      model: string;
      logId: string | null;
    };

export async function planStoryboard(
  env: Env,
  args: PlanStoryboardArgs,
): Promise<PlanStoryboardResult> {
  const modelEntry = findPlanningModel(args.model);
  if (!modelEntry) {
    return {
      ok: false,
      errors: [`model "${args.model}" is not in the planning catalog`],
      raw: null,
      provider: null,
      model: args.model,
      logId: null,
    };
  }

  const provider = plannerProviderFor(modelEntry);
  const systemPrompt = buildPlanningSystemPrompt();
  const userMessage = buildPlanningUserMessage(args.brief, args.characters, args.beatBlock);

  let result: unknown;
  let logId: string | null = null;

  try {
    if (plannerAiMockEnabled(env)) {
      // Dev-only (#411): replace the live provider call with a deterministic canned completion so
      // the planner flow is drivable in the fully-local module-bound dev env (which has no AI
      // binding). The result still runs the real extract/parse/validate pipeline below. In prod
      // PLANNER_AI_MOCK is unset, so this branch is dead and the live path is unchanged.
      result = mockPlannerRaw(userMessage);
      logId = "dev-ai-mock";
    } else if (provider === "anthropic") {
      // Anthropic Messages API takes system as a top-level field, so we
      // hand systemPrompt to callAnthropic separately and put only the
      // user content in messages.
      const messages = [{ role: "user", content: userMessage }];
      const r = await callAnthropic(env, modelEntry, systemPrompt, messages);
      result = r.raw;
      logId = r.logId;
    } else if (provider === "xai") {
      // xAI is OpenAI-compatible; system rides as the first message.
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      const r = await callXai(env, modelEntry, messages);
      result = r.raw;
      logId = r.logId;
    } else if (provider === "google") {
      // Gemini hoists the system prompt to systemInstruction (like Anthropic),
      // so hand it to callGemini separately and put only the user content in
      // messages. callGemini builds the Gemini-specific contents body.
      const messages = [{ role: "user", content: userMessage }];
      const r = await callGemini(env, modelEntry, systemPrompt, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      // Workers AI / OpenAI binding (env.AI.run via aiRun). Same system-as-
      // first-message convention as xAI; the binding accepts the OpenAI-style
      // role+content shape across the @cf/... and openai/... text models.
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      result = await aiRun(env, modelEntry.id, { messages });
      logId = aiLogId(env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [`provider call failed: ${message}`],
      raw: null,
      provider,
      model: args.model,
      logId,
    };
  }

  const providerFailure = detectProviderFailure(result);
  if (providerFailure) {
    return {
      ok: false,
      errors: [`model execution failed: ${providerFailure}`],
      raw: null,
      provider,
      model: args.model,
      logId,
    };
  }

  const completion = extractOutput(result);
  const json = stripJsonFences(completion);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [
        `model output was not valid JSON: ${message}`,
        `raw output starts with: ${json.slice(0, 200)}`,
      ],
      raw: completion,
      provider,
      model: args.model,
      logId,
    };
  }

  const validation = validateStoryboard(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      raw: completion,
      provider,
      model: args.model,
      logId,
    };
  }

  return {
    ok: true,
    storyboard: validation.value,
    raw: completion,
    provider,
    model: args.model,
    logId,
  };
}

// ---------- Refinement dispatcher (v0.50.0) ----------
//
// Mirrors planStoryboard's plumbing (provider dispatch, JSON parse, validation)
// but builds a different prompt: the system message tells the model to apply
// ONE delta and preserve everything else, and the user message ships the
// current storyboard JSON + the new instruction.

export interface RefineStoryboardArgs {
  storyboard: unknown;
  message: string;
  model: string;
}

export async function refineStoryboard(
  env: Env,
  args: RefineStoryboardArgs,
): Promise<PlanStoryboardResult> {
  const modelEntry = findPlanningModel(args.model);
  if (!modelEntry) {
    return {
      ok: false,
      errors: [`model "${args.model}" is not in the planning catalog`],
      raw: null,
      provider: null,
      model: args.model,
      logId: null,
    };
  }

  const provider = plannerProviderFor(modelEntry);
  const systemPrompt = buildRefinementSystemPrompt();
  const userMessage = buildRefinementUserMessage(args.storyboard, args.message);

  let result: unknown;
  let logId: string | null = null;

  try {
    if (plannerAiMockEnabled(env)) {
      // Dev-only (#411): replace the live provider call with a deterministic canned completion so
      // the planner flow is drivable in the fully-local module-bound dev env (which has no AI
      // binding). The result still runs the real extract/parse/validate pipeline below. In prod
      // PLANNER_AI_MOCK is unset, so this branch is dead and the live path is unchanged.
      result = mockPlannerRaw(userMessage);
      logId = "dev-ai-mock";
    } else if (provider === "anthropic") {
      const messages = [{ role: "user", content: userMessage }];
      const r = await callAnthropic(env, modelEntry, systemPrompt, messages);
      result = r.raw;
      logId = r.logId;
    } else if (provider === "xai") {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      const r = await callXai(env, modelEntry, messages);
      result = r.raw;
      logId = r.logId;
    } else if (provider === "google") {
      const messages = [{ role: "user", content: userMessage }];
      const r = await callGemini(env, modelEntry, systemPrompt, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      result = await aiRun(env, modelEntry.id, { messages });
      logId = aiLogId(env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [`provider call failed: ${message}`],
      raw: null,
      provider,
      model: args.model,
      logId,
    };
  }

  const providerFailure = detectProviderFailure(result);
  if (providerFailure) {
    return {
      ok: false,
      errors: [`model execution failed: ${providerFailure}`],
      raw: null,
      provider,
      model: args.model,
      logId,
    };
  }

  const completion = extractOutput(result);
  const jsonStr = stripJsonFences(completion);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [
        `model output was not valid JSON: ${message}`,
        `raw output starts with: ${jsonStr.slice(0, 200)}`,
      ],
      raw: completion,
      provider,
      model: args.model,
      logId,
    };
  }

  const validation = validateStoryboard(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      raw: completion,
      provider,
      model: args.model,
      logId,
    };
  }

  return {
    ok: true,
    storyboard: validation.value,
    raw: completion,
    provider,
    model: args.model,
    logId,
  };
}

// ---------- One-shot text completion (planner UI helpers) ------------------
//
// Same provider dispatch as plan/refine, but returns plain text instead of
// parsing/validating storyboard JSON. Used by POST /api/chat for music-prompt
// suggestion and other one-liner LLM calls from the planner frontend.

export interface ChatCompleteArgs {
  model: string;
  user_input: string;
  system_prompt?: string;
}

export type ChatCompleteResult =
  | { ok: true; output: string; model: string; logId: string | null }
  | { ok: false; error: string; model: string };

export async function chatComplete(
  env: Env,
  args: ChatCompleteArgs,
): Promise<ChatCompleteResult> {
  const modelEntry = findPlanningModel(args.model);
  if (!modelEntry) {
    return {
      ok: false,
      error: `model "${args.model}" is not in the planning catalog`,
      model: args.model,
    };
  }

  const provider = plannerProviderFor(modelEntry);
  const systemPrompt = args.system_prompt?.trim() || "You are a helpful assistant.";
  const userMessage = args.user_input;

  let result: unknown;
  let logId: string | null = null;

  try {
    if (plannerAiMockEnabled(env)) {
      // Dev-only (#411): replace the live provider call with a deterministic canned completion so
      // the planner flow is drivable in the fully-local module-bound dev env (which has no AI
      // binding). The result still runs the real extract/parse/validate pipeline below. In prod
      // PLANNER_AI_MOCK is unset, so this branch is dead and the live path is unchanged.
      result = mockPlannerRaw(userMessage);
      logId = "dev-ai-mock";
    } else if (provider === "anthropic") {
      const messages = [{ role: "user", content: userMessage }];
      const r = await callAnthropic(env, modelEntry, systemPrompt, messages);
      result = r.raw;
      logId = r.logId;
    } else if (provider === "xai") {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      const r = await callXai(env, modelEntry, messages);
      result = r.raw;
      logId = r.logId;
    } else if (provider === "google") {
      const messages = [{ role: "user", content: userMessage }];
      const r = await callGemini(env, modelEntry, systemPrompt, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      result = await aiRun(env, modelEntry.id, { messages });
      logId = aiLogId(env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `provider call failed: ${message}`, model: args.model };
  }

  const providerFailure = detectProviderFailure(result);
  if (providerFailure) {
    return {
      ok: false,
      error: `model execution failed: ${providerFailure}`,
      model: args.model,
    };
  }

  const output = extractOutput(result).trim();
  if (!output) {
    return { ok: false, error: "model returned empty output", model: args.model };
  }

  return { ok: true, output, model: args.model, logId };
}
