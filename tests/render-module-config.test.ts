import { describe, it, expect } from "vitest";
import {
  parseModuleRenderOverrides,
  resolveModuleRenderConfigs,
  renderConfigProjection,
  QUALITY_TIERS,
  DEFAULT_QUALITY_TIER,
} from "../src/render-module-config";
import type { RegisteredModule } from "../src/modules/types";

const keyframeMod = {
  name: "keyframe",
  version: "0.1.0",
  api: "vivijure-module/1" as const,
  binding: "MODULE_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {
    quality_tier: { type: "enum" as const, values: ["draft", "standard", "final"], default: "final" },
    steps: { type: "int" as const, default: 30, min: 1, max: 60 },
    seed: { type: "int" as const, default: -1, min: -1 },
  },
} as unknown as RegisteredModule;

const ownGpuMod = {
  name: "own-gpu",
  version: "0.1.0",
  api: "vivijure-module/1" as const,
  binding: "MODULE_OWN_GPU",
  hooks: ["motion.backend" as const],
  config_schema: {
    quality: { type: "enum" as const, values: ["draft", "standard", "final"], default: "standard" },
    fps: { type: "int" as const, default: 16, min: 8, max: 30 },
  },
} as unknown as RegisteredModule;

const speechMod = {
  name: "speech-upscale",
  version: "0.1.0",
  api: "vivijure-module/1" as const,
  binding: "MODULE_SPEECH_UPSCALE",
  hooks: ["speech" as const],
  config_schema: {
    enable: { type: "bool" as const, default: false },
    denoise: { type: "bool" as const, default: false },
  },
} as unknown as RegisteredModule;

describe("parseModuleRenderOverrides", () => {
  it("reads module wire format", () => {
    expect(
      parseModuleRenderOverrides({
        motion_backend: "own-gpu",
        config: { keyframe: { steps: 25 }, "own-gpu": { fps: 24 } },
      }),
    ).toEqual({
      motion_backend: "own-gpu",
      config: { keyframe: { steps: 25 }, "own-gpu": { fps: 24 } },
    });
  });

  it("maps legacy keyframe/i2v into module config", () => {
    expect(
      parseModuleRenderOverrides({
        keyframe: { steps: 20, seed: 1, resolution: "1024x768" },
        i2v: { fps: 24, flow_shift: 4 },
      }),
    ).toEqual({
      config: {
        keyframe: { steps: 20, seed: 1, width: 1024, height: 768 },
        "own-gpu": { fps: 24, flow_shift: 4 },
      },
    });
  });
});

describe("resolveModuleRenderConfigs", () => {
  it("injects quality tier and resolves motion backend config", () => {
    const resolved = resolveModuleRenderConfigs(
      { config: { keyframe: { steps: 25 }, "own-gpu": { fps: 24 } } },
      "standard",
      [keyframeMod, ownGpuMod],
    );
    expect(resolved.keyframe_config).toMatchObject({ quality_tier: "standard", steps: 25 });
    expect(resolved.motion_config).toMatchObject({ quality: "standard", fps: 24 });
    expect(resolved.motion_backend).toBe("own-gpu");
  });

  it("resolves a submitted speech config (by module name) so the speech phase receives it, not just defaults", () => {
    const resolved = resolveModuleRenderConfigs(
      { config: { "speech-upscale": { enable: true, denoise: true } } },
      "standard",
      [keyframeMod, ownGpuMod, speechMod],
    );
    // The link the audit found broken: a submitted speech config must reach speech_config keyed by
    // module name, clamped against the schema -- this is what enterSpeechOrFinish reads as
    // job.speech_config so the module sees enable:true instead of its enable:false default.
    expect(resolved.speech_config["speech-upscale"]).toEqual({ enable: true, denoise: true });
  });

  it("speech_config carries the module's declared defaults when no override is submitted", () => {
    const resolved = resolveModuleRenderConfigs({}, "standard", [keyframeMod, ownGpuMod, speechMod]);
    expect(resolved.speech_config["speech-upscale"]).toEqual({ enable: false, denoise: false });
  });

  it("speech_config is empty when no speech module is installed", () => {
    const resolved = resolveModuleRenderConfigs(
      { config: { "speech-upscale": { enable: true } } },
      "standard",
      [keyframeMod, ownGpuMod],
    );
    expect(resolved.speech_config).toEqual({});
  });
});

describe("renderConfigProjection (core-owned render config the planner projects)", () => {
  it("serves every quality tier with value/label/blurb plus the default", () => {
    const p = renderConfigProjection();
    expect(p.quality_tiers.map((t) => t.value)).toEqual(["draft", "standard", "final"]);
    expect(p.quality_tiers.every((t) => t.label.length > 0 && t.blurb.length > 0)).toBe(true);
    expect(p.default_tier).toBe(DEFAULT_QUALITY_TIER);
  });

  it("the default tier is one of the served tiers (so the picker can always select it)", () => {
    const p = renderConfigProjection();
    expect(p.quality_tiers.some((t) => t.value === p.default_tier)).toBe(true);
  });

  it("is a faithful, decoupled copy of QUALITY_TIERS (mutating the projection cannot corrupt the source)", () => {
    const p = renderConfigProjection();
    p.quality_tiers.push({ value: "bogus", label: "b", blurb: "b" });
    expect(QUALITY_TIERS.map((t) => t.value)).toEqual(["draft", "standard", "final"]);
  });
});
