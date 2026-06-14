import { describe, it, expect } from "vitest";
import { joinKeyframesToScenes, applyFinishOutput, orderFinalClips, resolveFinishConfigs, type FilmScene, type FinishShot } from "../src/film-orchestrator";
import type { ConfigSchema } from "../src/modules/types";

const finishShot = (over: Partial<FinishShot> = {}): FinishShot => ({
  shot_id: "shot_01", clip_key: "clips/shot_01.mp4", chain: ["MODULE_FINISH_RIFE"], idx: 0,
  status: "pending", applied: [], ...over,
});

describe("applyFinishOutput (chain fold)", () => {
  it("single-module chain: folds the output and marks done", () => {
    const fs = finishShot();
    applyFinishOutput(fs, { shot_id: "shot_01", clip_key: "clips/shot_01_finished.mp4", out_fps: 32, frames: 160, applied: ["interpolate:2x"] });
    expect(fs.clip_key).toBe("clips/shot_01_finished.mp4");
    expect(fs.applied).toEqual(["interpolate:2x"]);
    expect(fs.idx).toBe(1);
    expect(fs.poll).toBeUndefined();
    expect(fs.status).toBe("done");
  });

  it("multi-module chain: stays pending until the chain is exhausted, accumulating applied + chaining clips", () => {
    const fs = finishShot({ chain: ["MODULE_A", "MODULE_B"] });
    applyFinishOutput(fs, { shot_id: "shot_01", clip_key: "clips/after_a.mp4", out_fps: 32, frames: 160, applied: ["interpolate:2x"] });
    expect(fs.idx).toBe(1);
    expect(fs.status).toBe("pending"); // module B still to run
    expect(fs.clip_key).toBe("clips/after_a.mp4"); // B will finish A's output
    applyFinishOutput(fs, { shot_id: "shot_01", clip_key: "clips/after_b.mp4", out_fps: 32, frames: 160, applied: ["face_restore:gfpgan"] });
    expect(fs.idx).toBe(2);
    expect(fs.status).toBe("done");
    expect(fs.applied).toEqual(["interpolate:2x", "face_restore:gfpgan"]);
    expect(fs.clip_key).toBe("clips/after_b.mp4");
  });
});

const scenes: FilmScene[] = [
  { shot_id: "shot_01", prompt: "a city at dawn", seconds: 5 },
  { shot_id: "shot_02", prompt: "a chase", seconds: 7 },
  { shot_id: "shot_03", prompt: "the reveal", seconds: 6 },
];

describe("joinKeyframesToScenes", () => {
  it("joins every scene to its keyframe by shot_id, carrying prompt + seconds", () => {
    const { matched, missing } = joinKeyframesToScenes(scenes, [
      { shot_id: "shot_01", keyframe_key: "k/shot_01.png" },
      { shot_id: "shot_02", keyframe_key: "k/shot_02.png" },
      { shot_id: "shot_03", keyframe_key: "k/shot_03.png" },
    ]);
    expect(missing).toEqual([]);
    expect(matched).toEqual([
      { shot_id: "shot_01", keyframe_key: "k/shot_01.png", prompt: "a city at dawn", seconds: 5 },
      { shot_id: "shot_02", keyframe_key: "k/shot_02.png", prompt: "a chase", seconds: 7 },
      { shot_id: "shot_03", keyframe_key: "k/shot_03.png", prompt: "the reveal", seconds: 6 },
    ]);
  });

  it("reports scenes with no keyframe in `missing` and keeps the rest", () => {
    const { matched, missing } = joinKeyframesToScenes(scenes, [
      { shot_id: "shot_01", keyframe_key: "k/shot_01.png" },
      { shot_id: "shot_03", keyframe_key: "k/shot_03.png" },
    ]);
    expect(matched.map((m) => m.shot_id)).toEqual(["shot_01", "shot_03"]);
    expect(missing).toEqual(["shot_02"]);
  });

  it("ignores keyframes for shots not in the storyboard, and preserves scene order", () => {
    const { matched, missing } = joinKeyframesToScenes(scenes, [
      { shot_id: "shot_99", keyframe_key: "k/orphan.png" },
      { shot_id: "shot_02", keyframe_key: "k/shot_02.png" },
    ]);
    expect(matched.map((m) => m.shot_id)).toEqual(["shot_02"]);
    expect(missing).toEqual(["shot_01", "shot_03"]);
  });

  it("returns all missing when no keyframes were produced", () => {
    const { matched, missing } = joinKeyframesToScenes(scenes, []);
    expect(matched).toEqual([]);
    expect(missing).toEqual(["shot_01", "shot_02", "shot_03"]);
  });
});

describe("orderFinalClips", () => {
  it("orders clips by scene order regardless of completion order, for assemble", () => {
    // clips arrive out of order (shot_03 finished first, shot_01 last)
    const out = orderFinalClips(scenes, [
      { shot_id: "shot_03", clip_key: "c/shot_03.mp4" },
      { shot_id: "shot_01", clip_key: "c/shot_01.mp4" },
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
    ]);
    expect(out).toEqual([
      { shot_id: "shot_01", clip_key: "c/shot_01.mp4" },
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
      { shot_id: "shot_03", clip_key: "c/shot_03.mp4" },
    ]);
  });

  it("drops shots that produced no clip (never rendered), keeping the rest in scene order", () => {
    const out = orderFinalClips(scenes, [
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
      { shot_id: "shot_01", clip_key: "c/shot_01.mp4" },
    ]);
    expect(out.map((c) => c.shot_id)).toEqual(["shot_01", "shot_02"]);
  });

  it("ignores clips for shots not in the storyboard", () => {
    const out = orderFinalClips(scenes, [
      { shot_id: "shot_99", clip_key: "c/orphan.mp4" },
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
    ]);
    expect(out).toEqual([{ shot_id: "shot_02", clip_key: "c/shot_02.mp4" }]);
  });

  it("returns empty when nothing rendered", () => {
    expect(orderFinalClips(scenes, [])).toEqual([]);
  });
});

describe("resolveFinishConfigs (issue #75: finish modules must get their schema defaults)", () => {
  // a finish-rife-like schema: defaults turn interpolation on
  const rifeSchema: ConfigSchema = {
    interpolate: { type: "bool", default: true },
    interpolation_factor: { type: "int", default: 2, min: 1, max: 8 },
    face_restore: { type: "enum", values: ["none", "gfpgan", "codeformer"], default: "none" },
  };
  const serving = [{ name: "finish-rife", config_schema: rifeSchema }];

  it("applies schema defaults when the caller supplies no finish_config (the no-op bug fix)", () => {
    const [cfg] = resolveFinishConfigs(serving, undefined);
    // defaults present -> the module actually runs (interpolate true), not {} -> no-op
    expect(cfg).toEqual({ interpolate: true, interpolation_factor: 2, face_restore: "none" });
  });

  it("merges + clamps user overrides keyed by module name, keeping unspecified defaults", () => {
    const [cfg] = resolveFinishConfigs(serving, {
      "finish-rife": { interpolation_factor: 99, face_restore: "gfpgan" }, // 99 clamps to max 8
    });
    expect(cfg).toEqual({ interpolate: true, interpolation_factor: 8, face_restore: "gfpgan" });
  });

  it("returns configs in chain order, one per module", () => {
    const two = [
      { name: "a", config_schema: { x: { type: "int", default: 1 } } as ConfigSchema },
      { name: "b", config_schema: { y: { type: "bool", default: false } } as ConfigSchema },
    ];
    expect(resolveFinishConfigs(two, { b: { y: true } })).toEqual([{ x: 1 }, { y: true }]);
  });
});
