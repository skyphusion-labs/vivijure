// Registry-driven render module config: the wire shape the planner sends as render_overrides
// and the core resolves into per-hook module configs before starting a film job.

import { resolveRenderPipeline, type RenderPipelineSelection } from "./modules/render-pipeline";
import { servingForHook, validateConfig } from "./modules/registry";
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
  config?: Record<string, Record<string, unknown>>;
}

export interface ResolvedModuleRenderConfigs {
  motion_backend?: string;
  keyframe_config: Record<string, unknown>;
  motion_config: Record<string, unknown>;
  finish_config: Record<string, Record<string, unknown>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Parse render_overrides into a pipeline selection. Supports the module wire format and legacy
 *  { keyframe, i2v, lora } namespaced overrides from older rows / expert JSON. */
export function parseModuleRenderOverrides(raw: unknown): ModuleRenderOverridesWire {
  if (!isRecord(raw)) return {};
  if (isRecord(raw.config) || typeof raw.motion_backend === "string") {
    const out: ModuleRenderOverridesWire = {};
    if (typeof raw.motion_backend === "string" && raw.motion_backend.trim()) {
      out.motion_backend = raw.motion_backend.trim();
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
    if (Object.keys(mapped).length) config["own-gpu"] = mapped;
  }
  return Object.keys(config).length ? { config } : {};
}

function injectQualityTier(
  config: Record<string, Record<string, unknown>>,
  tier: RenderTier,
  modules: RegisteredModule[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(config)) out[name] = { ...cfg };

  const kf = servingForHook(modules, "keyframe")[0];
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
  const config = injectQualityTier(parsed.config ?? {}, tier, modules);
  const selection: RenderPipelineSelection = {
    motion_backend_choice: parsed.motion_backend,
    config,
  };
  const pipeline = resolveRenderPipeline(modules, selection);

  const kfMod = servingForHook(modules, "keyframe")[0];
  const keyframe_config = kfMod
    ? validateConfig(kfMod.config_schema, config[kfMod.name])
    : { quality_tier: tier };

  const finish_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.finish) finish_config[m.name] = m.config;

  return {
    motion_backend: pipeline.motion_backend?.name,
    keyframe_config,
    motion_config: pipeline.motion_backend?.config ?? {},
    finish_config,
  };
}
