// Registry-driven render module config: the wire shape the planner sends as render_overrides
// and the core resolves into per-hook module configs before starting a film job.

import { resolveRenderPipeline, pickOneForHook, type RenderPipelineSelection } from "./modules/render-pipeline";
import { servingForHook } from "./modules/registry";
import type { RegisteredModule, RenderConfigProjection } from "./modules/types";

/** The render quality tier the core injects into the keyframe (as quality_tier) and motion (as
 *  quality) modules. This is core render knowledge, NOT module config -- it is a cross-cutting choice
 *  the host owns, so the single source of truth lives here next to injectQualityTier. The planner
 *  projects the picker from QUALITY_TIERS (served on GET /api/modules) instead of hand-authoring the
 *  <option>s in markup -- adding a tier here is automatically picked up by the UI. */
export type RenderTier = "draft" | "standard" | "final";

export interface QualityTierOption {
  value: RenderTier;
  label: string;
  blurb: string;
}

export const QUALITY_TIERS: readonly QualityTierOption[] = [
  { value: "draft", label: "draft", blurb: "33 frames, 8 steps; fastest, lowest quality" },
  { value: "standard", label: "standard", blurb: "8-step keyframes + 20-step EasyCache i2v; balanced" },
  { value: "final", label: "final", blurb: "97 frames, 22 steps; production quality" },
];

export const DEFAULT_QUALITY_TIER: RenderTier = "final";

/** The core-owned render-config projection served on GET /api/modules, so the planner renders the
 *  tier picker from the registry instead of hand-authoring <option>s. Single source = QUALITY_TIERS. */
export function renderConfigProjection(): RenderConfigProjection {
  return {
    quality_tiers: QUALITY_TIERS.map((t) => ({ value: t.value, label: t.label, blurb: t.blurb })),
    default_tier: DEFAULT_QUALITY_TIER,
  };
}

/** Planner / API wire format for module render overrides (stored on render rows). */
export interface ModuleRenderOverridesWire {
  motion_backend?: string;
  keyframe_backend?: string;
  config?: Record<string, Record<string, unknown>>;
}

export interface ResolvedModuleRenderConfigs {
  motion_backend?: string;
  keyframe_backend?: string;
  keyframe_config: Record<string, unknown>;
  motion_config: Record<string, unknown>;
  finish_config: Record<string, Record<string, unknown>>;
  speech_config: Record<string, Record<string, unknown>>;
  film_finish_config: Record<string, Record<string, unknown>>;
  master_config: Record<string, Record<string, unknown>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Parse render_overrides into a pipeline selection. Supports the module wire format and legacy
 *  { keyframe, i2v, lora } namespaced overrides from older rows / expert JSON. */
export function parseModuleRenderOverrides(raw: unknown): ModuleRenderOverridesWire {
  if (!isRecord(raw)) return {};
  if (isRecord(raw.config) || typeof raw.motion_backend === "string" || typeof raw.keyframe_backend === "string") {
    const out: ModuleRenderOverridesWire = {};
    if (typeof raw.motion_backend === "string" && raw.motion_backend.trim()) {
      out.motion_backend = raw.motion_backend.trim();
    }
    if (typeof raw.keyframe_backend === "string" && raw.keyframe_backend.trim()) {
      out.keyframe_backend = raw.keyframe_backend.trim();
    }
    if (isRecord(raw.config)) {
      const config: Record<string, Record<string, unknown>> = {};
      for (const [name, cfg] of Object.entries(raw.config)) {
        if (isRecord(cfg)) config[name] = { ...cfg };
      }
      if (Object.keys(config).length) out.config = config;
    }
    return out;
  }

  // Legacy namespaced shape -> module configs (best-effort field mapping).
  const config: Record<string, Record<string, unknown>> = {};
  const kf = raw.keyframe;
  if (isRecord(kf)) {
    const mapped: Record<string, unknown> = {};
    if (typeof kf.steps === "number") mapped.steps = kf.steps;
    if (typeof kf.guidance_scale === "number") mapped.guidance_scale = kf.guidance_scale;
    if (typeof kf.seed === "number" && kf.seed >= 0) mapped.seed = kf.seed;
    if (typeof kf.resolution === "string") {
      const m = kf.resolution.trim().match(/^(\d+)x(\d+)$/i);
      if (m) {
        mapped.width = parseInt(m[1], 10);
        mapped.height = parseInt(m[2], 10);
      }
    }
    if (Object.keys(mapped).length) config.keyframe = mapped;
  }
  const i2v = raw.i2v;
  if (isRecord(i2v)) {
    const mapped: Record<string, unknown> = {};
    if (typeof i2v.fps === "number") mapped.fps = i2v.fps;
    if (typeof i2v.flow_shift === "number") mapped.flow_shift = i2v.flow_shift;
    if (typeof i2v.seed === "number" && i2v.seed >= 0) mapped.seed = i2v.seed;
    // DELIBERATE literal, not locality classification: this parser is pure legacy-row compat, and
    // every row carrying the old { i2v } namespaced shape was rendered by the own-gpu module by
    // definition (the shape predates locality and the other doors). Targeting whatever gpu door is
    // installed TODAY would misdeliver old knobs to a module with a different config_schema.
    if (Object.keys(mapped).length) config["own-gpu"] = mapped;
  }
  return Object.keys(config).length ? { config } : {};
}

function injectQualityTier(
  config: Record<string, Record<string, unknown>>,
  tier: RenderTier,
  modules: RegisteredModule[],
  keyframeChoice?: string,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(config)) out[name] = { ...cfg };

  // Stamp the tier onto the CHOSEN keyframe module (the planner's pick over the ui.order default), so a
  // user-selected backend gets the tier, not whichever module leads by order.
  const kf = pickOneForHook(modules, "keyframe", keyframeChoice) ?? servingForHook(modules, "keyframe")[0];
  if (kf) {
    out[kf.name] = { ...(out[kf.name] ?? {}), quality_tier: tier };
  }
  for (const m of servingForHook(modules, "motion.backend")) {
    if (m.config_schema?.quality) {
      out[m.name] = { ...(out[m.name] ?? {}), quality: tier };
    }
  }
  return out;
}

/** Resolve render_overrides + quality tier into configs the film orchestrator consumes. */
export function resolveModuleRenderConfigs(
  overrides: unknown,
  tier: RenderTier,
  modules: RegisteredModule[],
): ResolvedModuleRenderConfigs {
  const parsed = parseModuleRenderOverrides(overrides);
  const config = injectQualityTier(parsed.config ?? {}, tier, modules, parsed.keyframe_backend);
  const selection: RenderPipelineSelection = {
    motion_backend_choice: parsed.motion_backend,
    keyframe_backend_choice: parsed.keyframe_backend,
    config,
  };
  const pipeline = resolveRenderPipeline(modules, selection);

  // The chosen keyframe module (planner pick honored over the ui.order default), so a user can select
  // cloud-keyframe over the GPU keyframe module. Its name is threaded to the keyframe phase as
  // keyframe_backend; its clamped config as keyframe_config.
  // pipeline.keyframe is already resolved (config clamped against its schema by resolveRenderPipeline),
  // so use its config directly -- same shape as motion_config. Fallback to the bare tier when no module.
  const keyframe_config = pipeline.keyframe ? pipeline.keyframe.config : { quality_tier: tier };

  const finish_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.finish) finish_config[m.name] = m.config;

  // speech is a chain hook exactly like finish: clamp each serving speech module's config (planner ->
  // render_overrides -> here) by module name, so the speech phase's enable/denoise toggles actually
  // reach the module instead of always defaulting (the dead-config gap closed pre-v0.3.0).
  const speech_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.speech) speech_config[m.name] = m.config;

  // film.finish (subtitle / film-titles) + master (audio-master) are chain hooks too: clamp each
  // serving module's planner config by name so the post-mux card / caption styling and the audio
  // master knobs actually reach the module instead of dispatching with {} (the same dead-config
  // pattern Conrad caught for speech -- every config_schema-bearing hook is now wired).
  const film_finish_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.filmFinish) film_finish_config[m.name] = m.config;
  const master_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.master) master_config[m.name] = m.config;

  return {
    motion_backend: pipeline.motion_backend?.name,
    keyframe_backend: pipeline.keyframe?.name,
    keyframe_config,
    motion_config: pipeline.motion_backend?.config ?? {},
    finish_config,
    speech_config,
    film_finish_config,
    master_config,
  };
}
