// Render-pipeline resolution: the core's half of render-flow dispatch.
//
// Given the installed module registry and the user's per-hook selection (from the self-assembling
// pipeline UI), DECIDE which module serves each render hook: motion.backend (pick one), finish,
// score, and speech (chains, in ui.order), each with its user config clamped against the module's schema. The
// core only RESOLVES here; EXECUTION of these hooks happens on the GPU/cloud side (the backend, or a
// downstream invoker) -- this is the plan it hands off. Pure + dependency-free, so it unit-tests
// without bindings.

import type { HookName, RegisteredModule } from "./types";
import { servingForHook, validateConfig } from "./registry";

/** One resolved module in a render pipeline: who serves the hook + the clamped config to send it. */
export interface ResolvedModule {
  name: string;
  binding: string;
  config: Record<string, unknown>;
}

/** The render pipeline the core resolved from the registry + selection. `motion_backend` is null
 *  when no module serves it (the backend's built-in path runs); the chains are empty when none. */
export interface RenderPipelinePlan {
  motion_backend: ResolvedModule | null;
  finish: ResolvedModule[];
  score: ResolvedModule[];
  speech: ResolvedModule[];
  filmFinish: ResolvedModule[];
  master: ResolvedModule[];
}

/** The user's per-hook selection (mirrors the studio UI / window.__pipeline). `config` is keyed by
 *  module name; unknown/missing values fall back to each field's default during clamping. */
export interface RenderPipelineSelection {
  motion_backend_choice?: string;
  config?: Record<string, Record<string, unknown>>;
}

function resolve(m: RegisteredModule, userConfig: Record<string, unknown> | undefined): ResolvedModule {
  return { name: m.name, binding: m.binding, config: validateConfig(m.config_schema, userConfig) };
}

/** Resolve the full render pipeline. pick_one (motion.backend) honors an optional choice (default is
 *  the first serving module); chains (finish, score) fold every serving module in ui.order. */
export function resolveRenderPipeline(
  modules: RegisteredModule[],
  selection: RenderPipelineSelection = {},
): RenderPipelinePlan {
  const cfg = selection.config ?? {};
  const chain = (hook: HookName): ResolvedModule[] =>
    servingForHook(modules, hook).map((m) => resolve(m, cfg[m.name]));
  // motion.backend is pick_one: honor an explicit choice, else default to the first by ui.order
  // (servingForHook is ui.order-sorted, so the default matches how a chain would lead).
  const motionServing = servingForHook(modules, "motion.backend");
  const motion = selection.motion_backend_choice
    ? motionServing.find((m) => m.name === selection.motion_backend_choice) ?? null
    : motionServing[0] ?? null;
  return {
    motion_backend: motion ? resolve(motion, cfg[motion.name]) : null,
    finish: chain("finish"),
    score: chain("score"),
    speech: chain("speech"),
    filmFinish: chain("film.finish"),
    master: chain("master"),
  };
}
