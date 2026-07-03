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
  api: "vivijure-module/2" as const,
  binding: "MODULE_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {
    quality_tier: { type: "enum" as const, values: ["draft", "standard", "final"], default: "final" },
    steps: { type: "int" as const, default: 30, min: 1, max: 60 },
    seed: { type: "int" as const, default: -1, min: -1 },
  },
  ui: { section: "keyframe", order: 10 }, // GPU keyframe leads by ui.order (the default pick)
} as unknown as RegisteredModule;

const cloudKeyframeMod = {
  name: "cloud-keyframe",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_CLOUD_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {
    model: { type: "enum" as const, values: ["flux-2", "nano-banana-pro"], default: "flux-2" },
    width: { type: "int" as const, default: 1344, min: 512, max: 1536 },
  },
  ui: { section: "keyframe", order: 20 }, // loses the ui.order tiebreak -> only reachable via a choice
} as unknown as RegisteredModule;

const ownGpuMod = {
  name: "own-gpu",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
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
  api: "vivijure-module/2" as const,
  binding: "MODULE_SPEECH_UPSCALE",
  hooks: ["speech" as const],
  config_schema: {
    enable: { type: "bool" as const, default: false },
    denoise: { type: "bool" as const, default: false },
  },
} as unknown as RegisteredModule;

const subtitleMod = {
  name: "subtitle",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_SUBTITLE",
  hooks: ["film.finish" as const],
  config_schema: {
    enabled: { type: "bool" as const, default: true },
    mode: { type: "enum" as const, values: ["burn", "sidecar", "both"], default: "burn" },
    font_size: { type: "int" as const, default: 28, min: 8, max: 120 },
  },
} as unknown as RegisteredModule;

const audioMasterMod = {
  name: "audio-master",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_AUDIO_MASTER",
  hooks: ["master" as const],
  config_schema: {
    target_lufs: { type: "float" as const, default: -14, min: -24, max: -9 },
    upscale: { type: "bool" as const, default: true },
    format: { type: "enum" as const, values: ["wav", "mp3"], default: "wav" },
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

  it("defaults the keyframe backend to the ui.order leader (GPU keyframe) when no choice is submitted", () => {
    const resolved = resolveModuleRenderConfigs({}, "standard", [keyframeMod, cloudKeyframeMod, ownGpuMod]);
    // keyframe is pick_one: GPU keyframe (order 10) leads cloud-keyframe (order 20). The bug was this was
    // the ONLY reachable keyframe backend -- cloud-keyframe could never be selected.
    expect(resolved.keyframe_backend).toBe("keyframe");
    expect(resolved.keyframe_config).toMatchObject({ quality_tier: "standard" });
  });

  it("honors a submitted keyframe_backend, selecting cloud-keyframe over the GPU default", () => {
    const resolved = resolveModuleRenderConfigs(
      { keyframe_backend: "cloud-keyframe", config: { "cloud-keyframe": { model: "nano-banana-pro", width: 9999 } } },
      "standard",
      [keyframeMod, cloudKeyframeMod, ownGpuMod],
    );
    // The fix: the planner's keyframe pick wins over ui.order, so the GPUless cost-door lane is reachable.
    // The chosen module's config is clamped (width 9999 -> 1536) and threaded as keyframe_config.
    expect(resolved.keyframe_backend).toBe("cloud-keyframe");
    expect(resolved.keyframe_config).toMatchObject({ model: "nano-banana-pro", width: 1536 });
  });

  it("an unknown keyframe_backend resolves to no module (render fails loud, never a silent backend swap)", () => {
    const resolved = resolveModuleRenderConfigs(
      { keyframe_backend: "does-not-exist" },
      "standard",
      [keyframeMod, cloudKeyframeMod, ownGpuMod],
    );
    expect(resolved.keyframe_backend).toBeUndefined();
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

  it("resolves a submitted film.finish (subtitle) config so the post-mux chain styles/toggles it, not just defaults", () => {
    const resolved = resolveModuleRenderConfigs(
      { config: { subtitle: { enabled: false, mode: "sidecar", font_size: 200 } } },
      "standard",
      [keyframeMod, ownGpuMod, subtitleMod],
    );
    // The widened fix: a submitted film.finish config must reach film_finish_config by module name,
    // clamped (font_size 200 -> 120) -- this is what applyFilmFinish's configFor reads so subtitle sees
    // enabled:false / mode:sidecar instead of dispatching with {}.
    expect(resolved.film_finish_config["subtitle"]).toEqual({ enabled: false, mode: "sidecar", font_size: 120 });
  });

  it("resolves a submitted master (audio-master) config so the master phase applies the knobs, not just defaults", () => {
    const resolved = resolveModuleRenderConfigs(
      { config: { "audio-master": { target_lufs: -16, upscale: false, format: "mp3" } } },
      "standard",
      [keyframeMod, ownGpuMod, audioMasterMod],
    );
    expect(resolved.master_config["audio-master"]).toEqual({ target_lufs: -16, upscale: false, format: "mp3" });
  });

  it("film_finish_config / master_config carry module defaults when no override is submitted", () => {
    const resolved = resolveModuleRenderConfigs({}, "standard", [keyframeMod, ownGpuMod, subtitleMod, audioMasterMod]);
    expect(resolved.film_finish_config["subtitle"]).toMatchObject({ enabled: true, mode: "burn", font_size: 28 });
    expect(resolved.master_config["audio-master"]).toMatchObject({ target_lufs: -14, upscale: true, format: "wav" });
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
