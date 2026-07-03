import { describe, it, expect } from "vitest";
import {
  buildAnalyzeBody,
  normalizeConfig,
  parseAudioBeatPlan,
  parseContainerResponse,
} from "../modules/beat-sync/src/beat-sync";
import { beatPlanFromModuleOutput, beatSyncScoreModules } from "../src/beat-analyze";
import type { RegisteredModule } from "../src/modules/types";

describe("beat-sync pure logic", () => {
  it("buildAnalyzeBody maps config to container camelCase", () => {
    expect(
      buildAnalyzeBody(
        { clip_seconds: 6, mode: "beat", min_scene_s: 2, max_scene_s: 10 },
        "https://example.com/a.mp3",
        "audio/foo.mp3",
      ),
    ).toEqual({
      audioUrl: "https://example.com/a.mp3",
      audioKey: "audio/foo.mp3",
      clipSeconds: 6,
      mode: "beat",
      minSceneS: 2,
      maxSceneS: 10,
    });
  });

  it("buildAnalyzeBody includes forceShots when set", () => {
    const body = buildAnalyzeBody({ force_shots: 8 }, "https://x", "k");
    expect(body.forceShots).toBe(8);
  });

  it("parseAudioBeatPlan normalizes snake_case container plan", () => {
    const plan = parseAudioBeatPlan({
      mode: "beat",
      audio_key: "audio/x.mp3",
      duration_seconds: 120,
      bpm: 128,
      beat_count: 256,
      suggested_shots: 4,
      clip_seconds: 8,
      film_seconds: 120,
      remainder_seconds: 0,
      timed_scenes: [{ index: 0, start: 0, end: 8, target_seconds: 8 }],
      note: "ok",
    });
    expect(plan?.mode).toBe("beat");
    expect(plan?.timedScenes[0].targetSeconds).toBe(8);
  });

  it("parseContainerResponse rejects bad plans", () => {
    expect(parseContainerResponse({ ok: false, error: "bad audio" })).toEqual({
      ok: false,
      error: "bad audio",
    });
    expect(parseContainerResponse({ ok: true, mode: "nope" }).ok).toBe(false);
  });

  it("normalizeConfig applies defaults", () => {
    expect(normalizeConfig({})).toMatchObject({
      clip_seconds: 8,
      mode: "beat",
      min_scene_s: 2.5,
      max_scene_s: 12,
    });
  });
});

describe("beat-analyze helpers", () => {
  it("beatSyncScoreModules keeps score modules with clip_seconds only", () => {
    const beat = {
      name: "beat-sync",
      version: "0.1.0",
      api: "vivijure-module/2" as const,
      binding: "MODULE_BEAT_SYNC",
      hooks: ["score" as const],
      config_schema: { clip_seconds: { type: "float" as const, default: 8 } },
    } as unknown as RegisteredModule;
    const music = {
      name: "music-gen",
      version: "0.1.0",
      api: "vivijure-module/2" as const,
      binding: "MODULE_MUSIC_GEN",
      hooks: ["score" as const],
      config_schema: { prompt: { type: "string" as const, default: "" } },
    } as unknown as RegisteredModule;
    expect(beatSyncScoreModules([beat, music])).toEqual([beat]);
  });

  it("beatPlanFromModuleOutput reads camelCase beat_plan", () => {
    const plan = {
      mode: "beat" as const,
      audioKey: "a.mp3",
      durationSeconds: 10,
      suggestedShots: 1,
      clipSeconds: 8,
      filmSeconds: 10,
      remainderSeconds: 0,
      timedScenes: [],
      note: "",
    };
    expect(
      beatPlanFromModuleOutput({ film_key: "x", applied: [], beat_plan: plan }),
    ).toEqual(plan);
  });
});
