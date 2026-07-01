// Planner audio-bed / narration via installed `score` modules (registry-driven).
//
// Discovers score modules from the registry (music: config_schema.prompt; narration:
// config_schema.text), invokes the chosen one, and reads the R2 audio key from applied tags.

import type { Env } from "./env";
import {
  discoverModules,
  invokeModule,
  pollModule,
  resolveFetcher,
  servingForHook,
  validateConfig,
} from "./modules/registry";
import type { PlanEnhanceStoryboard, RegisteredModule, ScoreInput, ScoreOutput } from "./modules/types";
import { hookOutputViolation } from "./modules/conformance";

interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export type ScoreBedKind = "music" | "narration";

/** Score modules that generate a music bed (config_schema.prompt). */
export function musicScoreModules(modules: RegisteredModule[]): RegisteredModule[] {
  return servingForHook(modules, "score").filter(
    (m) => m.config_schema != null && m.config_schema.prompt != null,
  );
}

/** Score modules that synthesize narration (config_schema.text). */
export function narrationScoreModules(modules: RegisteredModule[]): RegisteredModule[] {
  return servingForHook(modules, "score").filter(
    (m) => m.config_schema != null && m.config_schema.text != null,
  );
}

/** User-facing label from a module manifest (provides[0].label, else name). */
export function scoreModuleLabel(mod: RegisteredModule): string {
  const label = mod.provides?.[0]?.label;
  return typeof label === "string" && label.trim() ? label.trim() : mod.name;
}

function fetcherForModule(env: Env, mod: RegisteredModule): FetcherLike | null {
  return resolveFetcher(env as unknown as Record<string, unknown>, mod.binding);
}

function candidatesForKind(modules: RegisteredModule[], kind: ScoreBedKind): RegisteredModule[] {
  return kind === "music" ? musicScoreModules(modules) : narrationScoreModules(modules);
}

function resolveScoreModule(
  modules: RegisteredModule[],
  kind: ScoreBedKind,
  moduleName?: string,
): RegisteredModule | null {
  const candidates = candidatesForKind(modules, kind);
  if (candidates.length === 0) return null;
  if (moduleName) return candidates.find((m) => m.name === moduleName) ?? null;
  return candidates[0];
}

function resolveScoreModuleByName(
  modules: RegisteredModule[],
  moduleName: string,
): RegisteredModule | null {
  return servingForHook(modules, "score").find((m) => m.name === moduleName) ?? null;
}

/** Parse `audio:<r2-key>` from a score module's applied tag list. */
export function audioKeyFromApplied(applied: string[]): { key: string; mime: string } | null {
  for (const tag of applied) {
    if (!tag.startsWith("audio:")) continue;
    const key = tag.slice("audio:".length).trim();
    if (!key) continue;
    const ext = key.split(".").pop()?.toLowerCase();
    const mime = ext === "wav" ? "audio/wav" : "audio/mpeg";
    return { key, mime };
  }
  return null;
}

export interface ScoreBedGenerateArgs {
  kind?: ScoreBedKind;
  prompt?: string;
  text?: string;
  module?: string;
  storyboard?: PlanEnhanceStoryboard;
  seconds?: number;
  config?: Record<string, unknown>;
}

export async function startScoreBedGenerate(
  env: Env,
  args: ScoreBedGenerateArgs,
): Promise<
  | { ok: true; status: "pending"; id: string; module: string; label: string }
  | { ok: false; error: string }
> {
  const kind: ScoreBedKind = args.kind === "narration" ? "narration" : "music";
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const mod = resolveScoreModule(modules, kind, args.module?.trim() || undefined);
  if (!mod) {
    const wanted = args.module?.trim();
    const hint = kind === "music" ? "config_schema.prompt" : "config_schema.text";
    return {
      ok: false,
      error: wanted
        ? `score module "${wanted}" is not installed or is not a ${kind} module`
        : `no ${kind} score module installed (bind a score module with ${hint})`,
    };
  }

  const fetcher = fetcherForModule(env, mod);
  if (!fetcher) {
    return { ok: false, error: `score module "${mod.name}" binding ${mod.binding} is not reachable` };
  }

  const seconds = typeof args.seconds === "number" && args.seconds > 0 ? args.seconds : 60;
  let userConfig: Record<string, unknown> = { ...(args.config ?? {}) };
  if (kind === "music") {
    const prompt = (args.prompt ?? "").trim();
    if (!prompt) return { ok: false, error: "prompt required" };
    userConfig = { ...userConfig, prompt };
  } else {
    const text = (args.text ?? "").trim();
    if (!text && !args.storyboard) {
      return { ok: false, error: "text or storyboard required for narration" };
    }
    userConfig = { ...userConfig, text };
  }
  const config = validateConfig(mod.config_schema, userConfig);

  const r = await invokeModule<ScoreInput, ScoreOutput>(fetcher, {
    hook: "score",
    input: {
      film_key: "audio-bed/planner",
      seconds,
      storyboard: args.storyboard,
    },
    config,
    context: { job_id: crypto.randomUUID(), project: "planner" },
  });

  if (!r.ok) return { ok: false, error: r.error || `${mod.name} invoke failed` };
  if (r.ok && (r as { pending?: boolean }).pending === true && typeof (r as { poll?: unknown }).poll === "string") {
    return {
      ok: true,
      status: "pending",
      id: (r as { poll: string }).poll,
      module: mod.name,
      label: scoreModuleLabel(mod),
    };
  }
  return { ok: false, error: `${mod.name} returned an unexpected synchronous response` };
}

export type ScoreBedPollResult =
  | { status: "pending" }
  | { status: "done"; output_artifact: { key: string; mime: string } }
  | { status: "failed"; job_error: string };

export async function pollScoreBedGenerate(
  env: Env,
  pollToken: string,
  moduleName: string,
): Promise<ScoreBedPollResult> {
  const name = moduleName.trim();
  if (!name) return { status: "failed", job_error: "module name required" };

  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const mod = resolveScoreModuleByName(modules, name);
  if (!mod) return { status: "failed", job_error: `score module "${name}" not found` };

  const fetcher = fetcherForModule(env, mod);
  if (!fetcher) {
    return { status: "failed", job_error: `score module "${name}" binding is not reachable` };
  }

  const token = pollToken.trim();
  if (!token) return { status: "failed", job_error: "poll token required" };

  const p = await pollModule<ScoreOutput>(fetcher, { poll: token });
  if (!p.ok) return { status: "failed", job_error: p.error || "poll failed" };
  if (p.ok && (p as { pending?: boolean }).pending === true) return { status: "pending" };

  const output = (p as { output: ScoreOutput }).output;
  const violation = hookOutputViolation(name, "score", output);
  if (violation) return { status: "failed", job_error: violation };
  const artifact = audioKeyFromApplied(output.applied ?? []);
  if (!artifact) {
    return { status: "failed", job_error: `${name} finished but returned no audio artifact` };
  }
  return { status: "done", output_artifact: artifact };
}
