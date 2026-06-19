// Planner beat analysis via the installed beat-sync score module (registry-driven).
//
// When MODULE_BEAT_SYNC is bound, POST /api/audio/analyze invokes the module worker, which calls
// the always-on audio-beat-sync container on the Hetzner fleet over Workers VPC. Falls back to a
// direct core VPC call when the module is not installed (legacy path).

import type { Env } from "./env";
import {
  discoverModules,
  invokeModule,
  servingForHook,
  validateConfig,
} from "./modules/registry";
import type { RegisteredModule, ScoreInput } from "./modules/types";
import { presignR2Get } from "./r2-presign";
import {
  type AudioAnalyzeRequest,
  type AudioBeatPlan,
  parseAudioBeatPlan,
} from "./runpod-submit";

interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

function isFetcher(v: unknown): v is FetcherLike {
  return !!v && typeof (v as { fetch?: unknown }).fetch === "function";
}

/** Score modules that analyze beat timing (config_schema.clip_seconds). */
export function beatSyncScoreModules(modules: RegisteredModule[]): RegisteredModule[] {
  return servingForHook(modules, "score").filter(
    (m) => m.config_schema != null && m.config_schema.clip_seconds != null,
  );
}

function fetcherForModule(env: Env, mod: RegisteredModule): FetcherLike | null {
  const f = env[mod.binding as keyof Env];
  return isFetcher(f) ? f : null;
}

function resolveBeatSyncModule(
  modules: RegisteredModule[],
  moduleName?: string,
): RegisteredModule | null {
  const candidates = beatSyncScoreModules(modules);
  if (candidates.length === 0) return null;
  if (moduleName) return candidates.find((m) => m.name === moduleName) ?? null;
  return candidates[0];
}

interface BeatSyncModuleOutput {
  film_key: string;
  applied: string[];
  beat_plan?: AudioBeatPlan;
}

export function beatPlanFromModuleOutput(output: BeatSyncModuleOutput | null | undefined): AudioBeatPlan | null {
  const plan = output?.beat_plan;
  if (!plan || (plan.mode !== "beat" && plan.mode !== "duration")) return null;
  return plan;
}

function userConfigFromRequest(req: AudioAnalyzeRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof req.clipSeconds === "number") out.clip_seconds = req.clipSeconds;
  if (req.mode === "beat" || req.mode === "duration") out.mode = req.mode;
  if (typeof req.minSceneS === "number") out.min_scene_s = req.minSceneS;
  if (typeof req.maxSceneS === "number") out.max_scene_s = req.maxSceneS;
  if (typeof req.forceShots === "number") out.force_shots = req.forceShots;
  return out;
}

async function analyzeViaVpc(
  env: Env,
  audioUrl: string,
  req: AudioAnalyzeRequest,
): Promise<{ ok: true; plan: AudioBeatPlan } | { ok: false; error: string }> {
  const resp = await env.AUDIO_BEAT_SYNC_VPC.fetch("http://audio-beat-sync/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      audioUrl,
      audioKey: req.audioKey,
      clipSeconds: req.clipSeconds ?? 8,
      mode: req.mode ?? "beat",
      minSceneS: req.minSceneS ?? 2.5,
      maxSceneS: req.maxSceneS ?? 12,
      forceShots: req.forceShots,
    }),
  });
  const plan = parseAudioBeatPlan(await resp.json());
  if (!plan) return { ok: false, error: "beat-sync container returned an unrecognized plan" };
  return { ok: true, plan };
}

export type BeatAnalyzeResult =
  | { ok: true; plan: AudioBeatPlan; module: string }
  | { ok: false; error: string };

export async function analyzeAudioBeats(
  env: Env,
  req: AudioAnalyzeRequest,
  moduleName?: string,
): Promise<BeatAnalyzeResult> {
  const audioKey = req.audioKey?.trim();
  if (!audioKey) return { ok: false, error: "audioKey required" };

  let audioUrl: string;
  try {
    audioUrl = await presignR2Get(env, audioKey, 300);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "could not presign audio: " + msg.slice(0, 200) };
  }

  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const mod = resolveBeatSyncModule(modules, moduleName?.trim() || undefined);

  if (mod) {
    const fetcher = fetcherForModule(env, mod);
    if (!fetcher) {
      return { ok: false, error: `beat-sync module "${mod.name}" binding ${mod.binding} is not reachable` };
    }

    const config = {
      ...validateConfig(mod.config_schema, userConfigFromRequest(req)),
      audio_url: audioUrl,
      audio_key: audioKey,
    };

    const r = await invokeModule<ScoreInput, BeatSyncModuleOutput>(fetcher, {
      hook: "score",
      input: { film_key: "beat-analyze/planner", seconds: 0 },
      config,
      context: { job_id: crypto.randomUUID(), project: "planner" },
    });

    if (!r.ok) return { ok: false, error: r.error || `${mod.name} invoke failed` };
    if (!("output" in r)) {
      return { ok: false, error: `${mod.name} returned async poll (beat analysis is synchronous)` };
    }
    const plan = beatPlanFromModuleOutput(r.output);
    if (!plan) return { ok: false, error: `${mod.name} finished but returned no beat plan` };
    return { ok: true, plan, module: mod.name };
  }

  const direct = await analyzeViaVpc(env, audioUrl, req);
  if (!direct.ok) return direct;
  return { ok: true, plan: direct.plan, module: "core-vpc" };
}
