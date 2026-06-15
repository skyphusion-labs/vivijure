import { describe, it, expect } from "vitest";
import { framesFor, buildI2vBody, readOutput, encodePoll, decodePoll } from "../modules/own-gpu/src/i2v";

describe("own-gpu i2v pure logic", () => {
  it("framesFor derives a frame count from shot seconds * fps", () => {
    expect(framesFor(5, 16)).toBe(80); // backend snaps to 4k+1 (81)
    expect(framesFor(3, 24)).toBe(72);
    expect(framesFor(0, 16)).toBe(80); // 0 -> default 5s
    expect(framesFor(0.1, 16)).toBe(16); // floor of ~1s of frames
  });

  it("buildI2vBody maps the hook input + config onto the i2v_clip action body", () => {
    const body = buildI2vBody(
      { shot_id: "shot_02", keyframe_url: "https://r2/x.png", prompt: "slow dolly in", seconds: 5 },
      { quality: "final", fps: 16, flow_shift: 5, seed: 42, negative_prompt: "blurry" },
      "the-film",
    );
    expect(body.input).toMatchObject({
      action: "i2v_clip",
      project: "the-film",
      shot_id: "shot_02",
      prompt: "slow dolly in",
      config: { quality: "final", num_frames: 80, fps: 16, seed: 42, flow_shift: 5, negative_prompt: "blurry" },
    });
  });

  it("buildI2vBody omits keyframe_key unless the caller gives an explicit one (backend owns the convention)", () => {
    const without = buildI2vBody({ shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 5 }, {}, "proj");
    expect("keyframe_key" in without.input).toBe(false);
    const withKey = buildI2vBody(
      { shot_id: "s", keyframe_url: "u", keyframe_key: "renders/proj/keyframes/hero.png", prompt: "p", seconds: 5 },
      {},
      "proj",
    );
    expect(withKey.input.keyframe_key).toBe("renders/proj/keyframes/hero.png");
  });

  it("buildI2vBody drops a random seed (-1) and an empty negative, keeping config minimal", () => {
    const body = buildI2vBody({ shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 5 }, { seed: -1, negative_prompt: "" }, "proj");
    const cfg = body.input.config as Record<string, unknown>;
    expect("seed" in cfg).toBe(false);
    expect("negative_prompt" in cfg).toBe(false);
    expect(cfg).toMatchObject({ quality: "standard", num_frames: 80, fps: 16 }); // tier + cadence defaults
  });

  it("readOutput maps the backend's i2v_clip output into MotionBackendOutput", () => {
    expect(
      readOutput("shot_02", { clip_key: "renders/f/clips/shot_02_i2v.mp4", shot_id: "shot_02", fps: 16, num_frames: 81, seconds: 5.06, distilled: false }),
    ).toEqual({ shot_id: "shot_02", clip_key: "renders/f/clips/shot_02_i2v.mp4", fps: 16, frames: 81 });
  });

  it("readOutput returns null when the backend reported no clip_key (treated as a failure)", () => {
    expect(readOutput("s", { shot_id: "s", fps: 16 })).toBeNull();
    expect(readOutput("s", {})).toBeNull();
    expect(readOutput("s", undefined)).toBeNull();
  });

  it("encodePoll/decodePoll round-trip the async job state", () => {
    const st = { jobId: "abc123", project: "My Proj", shotId: "shot_01" };
    expect(decodePoll(encodePoll(st))).toEqual(st);
    expect(decodePoll("not-valid-token")).toBeNull();
  });
});
