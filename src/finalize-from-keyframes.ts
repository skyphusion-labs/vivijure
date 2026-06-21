// Finalize / cloud-animate / hybrid-animate from a completed keyframes-only preview row.
// Skips the keyframe module; drives motion.backend per shot (own-gpu or cloud modules), then
// finish + assemble via the film orchestrator.

import type { Env } from "./env";
import {
  startFilmFromKeyframes,
  joinKeyframesToScenes,
  type FilmScene,
  type FilmKeyframeRef,
} from "./film-orchestrator";
import { filmJobToPollView, mapRenderOverridesToModuleConfigs } from "./film-render-bridge";
import { readBundleScenes } from "./bundle-storyboard";
import { discoverModules, servingForHook } from "./modules/registry";
import { coerceQualityTier } from "./runpod-submit";
import type { RenderRow } from "./renders-db";
import { insertRender, type NewRenderRow } from "./renders-db";
import type { RunpodJobView } from "./runpod-submit";
import { normalizePerShotModels } from "./storyboard-validate";
import { presignR2Get } from "./r2-presign";
import type { ClipJob, ClipShotInput } from "./render-orchestrator";

export interface AnimateFromPreviewArgs {
  parent: RenderRow;
  userEmail: string;
  deriveMode: "finalized" | "cloud-finalized";
  motionBackend?: string;
  perShotModels?: Record<string, string>;
  hybridBackends?: Record<string, { backend: "gpu" | "cloud"; model?: string }>;
  defaultBackend?: "gpu" | "cloud";
  defaultCloudModel?: string;
  audioKey?: string;
}

async function allowedCloudModules(env: Env): Promise<string[]> {
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  return servingForHook(modules, "motion.backend")
    .map((m) => m.name)
    .filter((n) => n !== "own-gpu");
}

function resolveCloudModel(requested: string | undefined, allowed: string[]): string {
  if (requested && allowed.includes(requested)) return requested;
  return allowed[0] ?? "seedance";
}

/** Scene metadata for each shot: parent output, else bundle storyboard.yaml. */
export async function resolvePreviewScenes(env: Env, parent: RenderRow): Promise<FilmScene[]> {
  const fromOutput = normalizeFilmScenesFromOutput(parent.output);
  if (fromOutput.length) return fromOutput;
  const parsed = await readBundleScenes(env, parent.bundle_key);
  return parsed.map((s) => ({ shot_id: s.shot_id, prompt: s.prompt, seconds: s.seconds }));
}

function normalizeFilmScenesFromOutput(output: unknown): FilmScene[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const scenes = (output as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) return [];
  const out: FilmScene[] = [];
  for (const e of scenes) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const shot_id = typeof o.shot_id === "string" ? o.shot_id.trim() : "";
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
    const seconds = typeof o.seconds === "number" && o.seconds > 0 ? o.seconds : 4;
    if (shot_id && prompt) out.push({ shot_id, prompt, seconds });
  }
  return out;
}

/** Keyframes to animate, honoring locked_shots when any are set. */
export function selectPreviewKeyframes(parent: RenderRow): FilmKeyframeRef[] {
  const kfs = parent.keyframes ?? [];
  const locked = parent.locked_shots;
  if (Array.isArray(locked) && locked.length > 0) {
    const allow = new Set(locked);
    return kfs.filter((k) => allow.has(k.shot_id)).map((k) => ({ shot_id: k.shot_id, keyframe_key: k.key }));
  }
  return kfs.map((k) => ({ shot_id: k.shot_id, keyframe_key: k.key }));
}

function scenesForKeyframes(allScenes: FilmScene[], keyframes: FilmKeyframeRef[]): FilmScene[] {
  const allow = new Set(keyframes.map((k) => k.shot_id));
  return allScenes.filter((s) => allow.has(s.shot_id));
}

function perShotMotionFromHybrid(
  scenes: FilmScene[],
  backends: Record<string, { backend: "gpu" | "cloud"; model?: string }>,
  defaultBackend: "gpu" | "cloud",
  defaultCloud: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sc of scenes) {
    const entry = backends[sc.shot_id];
    if (entry?.backend === "cloud") out[sc.shot_id] = entry.model ?? defaultCloud;
    else if (entry?.backend === "gpu") out[sc.shot_id] = "own-gpu";
    else if (defaultBackend === "cloud") out[sc.shot_id] = defaultCloud;
    else out[sc.shot_id] = "own-gpu";
  }
  return out;
}

function perShotMotionFromCloud(
  scenes: FilmScene[],
  defaultModel: string,
  perShot?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sc of scenes) {
    out[sc.shot_id] = perShot?.[sc.shot_id] ?? defaultModel;
  }
  return out;
}

export function validatePreviewParent(parent: RenderRow): string | null {
  if (parent.mode !== "keyframes-only") return "parent render is not a keyframes-only preview";
  if (parent.status !== "COMPLETED") return "parent preview is not completed";
  if (!parent.bundle_key) return "parent render has no bundle_key";
  if (!parent.keyframes?.length) return "parent preview has no keyframes";
  return null;
}

export async function animateFromPreview(
  env: Env,
  args: AnimateFromPreviewArgs,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  const err = validatePreviewParent(args.parent);
  if (err) return { ok: false, error: err, status: 400 };

  const keyframes = selectPreviewKeyframes(args.parent);
  if (!keyframes.length) return { ok: false, error: "no keyframes selected (check locked shots)", status: 400 };

  const allScenes = await resolvePreviewScenes(env, args.parent);
  if (!allScenes.length) {
    return { ok: false, error: "could not resolve scene prompts from preview output or bundle", status: 400 };
  }
  const scenes = scenesForKeyframes(allScenes, keyframes);
  if (!scenes.length) return { ok: false, error: "no scenes match the selected keyframes", status: 400 };

  const tier = coerceQualityTier(args.parent.quality_tier) ?? "final";
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const mapped = mapRenderOverridesToModuleConfigs(args.parent.render_overrides ?? undefined, tier, modules);
  const cloudAllowed = await allowedCloudModules(env);

  let motionBackend: string | undefined;
  let perShotMotion: Record<string, string> | undefined;

  if (args.hybridBackends !== undefined) {
    const defaultCloud = resolveCloudModel(args.defaultCloudModel, cloudAllowed);
    perShotMotion = perShotMotionFromHybrid(
      scenes,
      args.hybridBackends,
      args.defaultBackend ?? "gpu",
      defaultCloud,
    );
    motionBackend = "own-gpu";
  } else if (args.deriveMode === "cloud-finalized") {
    const defaultCloud = resolveCloudModel(args.motionBackend ?? args.defaultCloudModel, cloudAllowed);
    const normalized = args.perShotModels
      ? normalizePerShotModels(args.perShotModels, new Set(cloudAllowed))
      : { perShot: {}, errors: [] as string[] };
    if (normalized.errors.length) return { ok: false, error: normalized.errors.join("; "), status: 400 };
    motionBackend = defaultCloud;
    perShotMotion = perShotMotionFromCloud(scenes, defaultCloud, normalized.perShot);
  } else {
    motionBackend = mapped.motion_backend ?? "own-gpu";
  }

  const motionInstalled = new Set(servingForHook(modules, "motion.backend").map((m) => m.name));
  const need = new Set<string>(Object.values(perShotMotion ?? {}));
  if (motionBackend) need.add(motionBackend);
  for (const n of need) {
    if (!motionInstalled.has(n)) {
      return { ok: false, error: `motion.backend module "${n}" is not installed`, status: 400 };
    }
  }

  const job = await startFilmFromKeyframes(env, {
    project: args.parent.project,
    bundle_key: args.parent.bundle_key,
    scenes,
    keyframes,
    motion_backend: motionBackend,
    per_shot_motion: perShotMotion,
    motion_config: mapped.motion_config,
    finish_config: mapped.finish_config,
    derive_mode: args.deriveMode,
    parent_render_id: args.parent.id,
    audio_key: args.audioKey,
    user_email: args.userEmail,
  });

  const view = filmJobToPollView(job, null);
  const row: NewRenderRow = {
    jobId: view.jobId,
    project: args.parent.project,
    bundleKey: args.parent.bundle_key,
    qualityTier: tier,
    renderOverrides: args.parent.render_overrides ?? undefined,
    status: view.status,
    mode: args.deriveMode,
    parentId: args.parent.id,
    projectId: args.parent.project_id,
  };
  await insertRender(env, row);

  return { ok: true, view };
}

/** Progress counters for cloud / hybrid animate rows during clip phase polling. */
export function clipAnimateProgress(clipJob: ClipJob): {
  done: number;
  total: number;
  gpu: { done: number; total: number; status?: string };
  cloud: { done: number; total: number };
} {
  let gpuDone = 0;
  let gpuTotal = 0;
  let cloudDone = 0;
  let cloudTotal = 0;
  for (const sh of clipJob.shots) {
    const mod = sh.motion_backend ?? clipJob.motion_backend ?? "own-gpu";
    if (mod === "own-gpu") {
      gpuTotal++;
      if (sh.status === "done") gpuDone++;
    } else {
      cloudTotal++;
      if (sh.status === "done") cloudDone++;
    }
  }
  const done = clipJob.shots.filter((s) => s.status === "done").length;
  const gpuStatus = gpuTotal > 0
    ? (gpuDone >= gpuTotal ? "done" : "rendering")
    : "done";
  return { done, total: clipJob.shots.length, gpu: { done: gpuDone, total: gpuTotal, status: gpuStatus }, cloud: { done: cloudDone, total: cloudTotal } };
}

export async function buildClipInputsFromKeyframes(
  env: Env,
  scenes: FilmScene[],
  keyframes: FilmKeyframeRef[],
): Promise<ClipShotInput[]> {
  const { matched } = joinKeyframesToScenes(scenes, keyframes);
  const shots: ClipShotInput[] = [];
  for (const m of matched) {
    shots.push({
      shot_id: m.shot_id,
      keyframe_url: await presignR2Get(env, m.keyframe_key, 1800),
      keyframe_key: m.keyframe_key,
      prompt: m.prompt,
      seconds: m.seconds,
    });
  }
  return shots;
}
