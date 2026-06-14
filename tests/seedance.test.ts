import { describe, it, expect } from "vitest";
import { clampDuration, buildSeedanceBody, extractVideoUrl, clipKey, encodePoll, decodePoll } from "../modules/seedance/src/seedance";

describe("seedance pure logic", () => {
  it("clampDuration bounds the shot length into Seedance range", () => {
    expect(clampDuration(5)).toBe(5);
    expect(clampDuration(0)).toBe(5); // 0 -> default 5
    expect(clampDuration(99)).toBe(12);
    expect(clampDuration(1)).toBe(3);
    expect(clampDuration(7.6)).toBe(8);
  });

  it("buildSeedanceBody maps the hook input + config onto the RunPod body", () => {
    const body = buildSeedanceBody(
      { shot_id: "shot_01", keyframe_url: "https://r2/x.png", prompt: "a city at dawn", seconds: 5 },
      { resolution: "1080p", aspect_ratio: "9:16", camera_fixed: true, generate_audio: true, seed: 42 },
    );
    expect(body.input).toMatchObject({
      prompt: "a city at dawn",
      image: "https://r2/x.png",
      duration: 5,
      resolution: "1080p",
      aspect_ratio: "9:16",
      camera_fixed: true,
      generate_audio: true,
      seed: 42,
    });
  });

  it("buildSeedanceBody falls back to sane defaults for missing config", () => {
    const body = buildSeedanceBody(
      { shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 8 },
      {},
    );
    expect(body.input).toMatchObject({ resolution: "720p", aspect_ratio: "16:9", camera_fixed: false, generate_audio: false, seed: -1, duration: 8 });
  });

  it("extractVideoUrl finds the video url across output shapes", () => {
    expect(extractVideoUrl("https://cdn/x.mp4")).toBe("https://cdn/x.mp4");
    expect(extractVideoUrl({ video_url: "https://cdn/y.mp4" })).toBe("https://cdn/y.mp4");
    expect(extractVideoUrl({ output: { url: "https://cdn/z.mp4" } })).toBe("https://cdn/z.mp4");
    expect(extractVideoUrl([{ foo: 1 }, { video: "https://cdn/a.mp4" }])).toBe("https://cdn/a.mp4");
    expect(extractVideoUrl({ nope: 1 })).toBeNull();
  });

  it("extractVideoUrl prefers an mp4 but falls back to the first http url", () => {
    expect(extractVideoUrl({ thumb: "https://cdn/t.jpg", clip: "https://cdn/v.mp4" })).toBe("https://cdn/v.mp4");
    expect(extractVideoUrl({ only: "https://cdn/asset" })).toBe("https://cdn/asset");
  });

  it("clipKey sanitizes project + shot into an R2 path", () => {
    expect(clipKey("My Project!", "shot 01")).toBe("renders/My_Project_/clips/shot_01_seedance.mp4");
  });

  it("encodePoll/decodePoll round-trip the async job state", () => {
    const st = { jobId: "abc123", project: "My Proj", shotId: "shot_01", seconds: 5 };
    expect(decodePoll(encodePoll(st))).toEqual(st);
    expect(decodePoll("not-valid-token")).toBeNull();
  });
});
