import { describe, it, expect } from "vitest";
import { clampDuration, buildKlingBody, extractVideoUrl, clipKey, encodePoll, decodePoll } from "../modules/kling/src/kling";

describe("kling pure logic", () => {
  it("clampDuration bounds to Kling range (3-10)", () => {
    expect(clampDuration(5)).toBe(5);
    expect(clampDuration(99)).toBe(10);
    expect(clampDuration(1)).toBe(3);
    expect(clampDuration(0)).toBe(5);
  });
  it("buildKlingBody maps input + config", () => {
    const b = buildKlingBody({ shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 5 },
      { guidance_scale: 0.8, negative_prompt: "blurry", enable_safety_checker: false });
    expect(b.input).toMatchObject({ prompt: "p", image: "u", negative_prompt: "blurry", guidance_scale: 0.8, duration: 5, enable_safety_checker: false });
  });
  it("buildKlingBody falls back to defaults", () => {
    const b = buildKlingBody({ shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 7 }, {});
    expect(b.input).toMatchObject({ negative_prompt: "", guidance_scale: 0.5, duration: 7, enable_safety_checker: true });
  });
  it("extractVideoUrl finds the url across shapes", () => {
    expect(extractVideoUrl({ output: { video_url: "https://cdn/x.mp4" } })).toBe("https://cdn/x.mp4");
    expect(extractVideoUrl({ nope: 1 })).toBeNull();
  });
  it("clipKey uses the _kling suffix", () => {
    expect(clipKey("p", "shot_01")).toBe("renders/p/clips/shot_01_kling.mp4");
  });
  it("encodePoll/decodePoll round-trip", () => {
    const st = { jobId: "j", project: "p", shotId: "s", seconds: 5 };
    expect(decodePoll(encodePoll(st))).toEqual(st);
    expect(decodePoll("bad-token")).toBeNull();
  });
});
