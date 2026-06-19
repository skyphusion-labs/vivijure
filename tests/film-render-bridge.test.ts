import { describe, it, expect } from "vitest";
import {
  isFilmJobId,
  mapRenderOverridesToModuleConfigs,
  normalizeFilmScenes,
  filterScenesByShotIds,
  filmJobToPollView,
} from "../src/film-render-bridge";
import type { FilmJob } from "../src/film-orchestrator";
import type { RegisteredModule } from "../src/modules/types";

describe("isFilmJobId", () => {
  it("recognizes film orchestrator job ids", () => {
    expect(isFilmJobId("film-abc")).toBe(true);
    expect(isFilmJobId("runpod-xyz")).toBe(false);
  });
});

describe("mapRenderOverridesToModuleConfigs", () => {
  const modules = [
    {
      name: "keyframe",
      version: "0.1.0",
      api: "vivijure-module/1" as const,
      binding: "MODULE_KEYFRAME",
      hooks: ["keyframe" as const],
      config_schema: {
        quality_tier: { type: "enum" as const, values: ["draft", "standard", "final"], default: "final" },
        steps: { type: "int" as const, default: 30, min: 1, max: 60 },
        guidance_scale: { type: "float" as const, default: 6.5, min: 0, max: 20 },
        seed: { type: "int" as const, default: -1, min: -1 },
        width: { type: "int" as const, default: 1024, min: 512, max: 1536 },
        height: { type: "int" as const, default: 1024, min: 512, max: 1536 },
      },
    },
    {
      name: "own-gpu",
      version: "0.1.0",
      api: "vivijure-module/1" as const,
      binding: "MODULE_OWN_GPU",
      hooks: ["motion.backend" as const],
      config_schema: {
        quality: { type: "enum" as const, values: ["draft", "standard", "final"], default: "standard" },
        fps: { type: "int" as const, default: 16, min: 8, max: 30 },
        flow_shift: { type: "float" as const, default: 5, min: 1, max: 12 },
        seed: { type: "int" as const, default: -1, min: -1 },
      },
      ui: { order: 5 },
    },
  ] as RegisteredModule[];

  it("maps module wire overrides into module config fields", () => {
    const mapped = mapRenderOverridesToModuleConfigs(
      {
        config: {
          keyframe: { steps: 25, guidance_scale: 7, seed: 42, width: 1024, height: 768 },
          "own-gpu": { fps: 24, flow_shift: 4.5 },
        },
      },
      "standard",
      modules,
    );
    expect(mapped.keyframe_config).toEqual({
      quality_tier: "standard",
      steps: 25,
      guidance_scale: 7,
      seed: 42,
      width: 1024,
      height: 768,
    });
    expect(mapped.motion_config).toEqual({ quality: "standard", fps: 24, flow_shift: 4.5, seed: -1 });
    expect(mapped.motion_backend).toBe("own-gpu");
  });
});

describe("normalizeFilmScenes", () => {
  it("drops scenes without prompt or shot_id", () => {
    expect(
      normalizeFilmScenes([
        { shot_id: "shot_01", prompt: "a dawn", seconds: 5 },
        { shot_id: "shot_02", prompt: "  " },
        { prompt: "orphan" },
      ]),
    ).toEqual([{ shot_id: "shot_01", prompt: "a dawn", seconds: 5 }]);
  });
});

describe("filterScenesByShotIds", () => {
  const scenes = [
    { shot_id: "shot_01", prompt: "a", seconds: 4 },
    { shot_id: "shot_02", prompt: "b", seconds: 4 },
  ];
  it("returns all scenes when no filter", () => {
    expect(filterScenesByShotIds(scenes, undefined)).toEqual(scenes);
  });
  it("restricts to listed shot ids", () => {
    expect(filterScenesByShotIds(scenes, ["shot_02"])).toEqual([scenes[1]]);
  });
});

describe("filmJobToPollView", () => {
  const base: FilmJob = {
    film_id: "film-1",
    project: "demo",
    bundle_key: "bundles/demo.tar.gz",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 5 }],
    motion_backend: "own-gpu",
    motion_config: {},
    finish_config: {},
    keyframe_binding: "MODULE_KEYFRAME",
    phase: "clips",
    created_at: Date.now() - 60_000,
  };

  it("maps in-progress clip phase with progress", () => {
    const view = filmJobToPollView(base, {
      job_id: "clip-1",
      project: "demo",
      motion_backend: "own-gpu",
      binding: "MODULE_OWN_GPU",
      shots: [{ shot_id: "shot_01", keyframe_url: "u", prompt: "x", seconds: 5, status: "done", clip_key: "c" }],
      created_at: Date.now(),
    });
    expect(view.status).toBe("IN_PROGRESS");
    expect(view.output).toMatchObject({ phase: "i2v", scene_total: 1, progress: 1 });
  });

  it("maps keyframes-only completion with thumbnail keys", () => {
    const view = filmJobToPollView(
      {
        ...base,
        phase: "done",
        keyframes_only: true,
        keyframes: [{ shot_id: "shot_01", keyframe_key: "k/shot_01.png" }],
      },
      null,
    );
    expect(view.status).toBe("COMPLETED");
    expect(view.output).toMatchObject({
      mode: "keyframes-only",
      keyframes: [{ shot_id: "shot_01", key: "k/shot_01.png" }],
    });
  });

  it("maps cancelled jobs", () => {
    const view = filmJobToPollView({ ...base, phase: "failed", cancelled: true, error: "cancelled" }, null);
    expect(view.status).toBe("CANCELLED");
  });
});
