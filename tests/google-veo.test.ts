import { describe, it, expect } from "vitest";
import {
  clampDuration,
  buildVeoBody,
  extractVideoUrl,
  clipKey,
  encodePoll,
  decodePoll,
  runpodJobGone,
  classifyGoneState,
  RUNPOD_NOTFOUND_GRACE_MS,
} from "../modules/google-veo/src/veo";

describe("google-veo pure logic", () => {
  it("clampDuration snaps to the nearest allowed discrete value [4, 6, 8] (default 6)", () => {
    expect(clampDuration(6)).toBe(6);
    expect(clampDuration(0)).toBe(6);   // 0 -> default 6
    expect(clampDuration(99)).toBe(8);
    expect(clampDuration(1)).toBe(4);
    expect(clampDuration(7.6)).toBe(8); // rounds to 8 -> allowed
    expect(clampDuration(4)).toBe(4);
    expect(clampDuration(5)).toBe(4);   // 5 is between 4 and 6; ties go lower
    expect(clampDuration(7)).toBe(6);   // 7 is between 6 and 8; ties go lower
  });

  it("buildVeoBody maps the hook input + config onto the RunPod body", () => {
    const body = buildVeoBody(
      { shot_id: "shot_01", keyframe_url: "https://r2/x.png", prompt: "a city at dawn", seconds: 6 },
      { generate_audio: true },
    );
    expect(body.input).toMatchObject({
      prompt: "a city at dawn",
      image: "https://r2/x.png",
      aspect_ratio: "16:9",
      duration: 6,
      resolution: "720p",
      generate_audio: true,
      seed: 0,
    });
  });

  it("buildVeoBody defaults generate_audio OFF when config is empty", () => {
    const body = buildVeoBody(
      { shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 6 },
      {},
    );
    expect(body.input).toMatchObject({ generate_audio: false, duration: 6, aspect_ratio: "16:9" });
  });

  it("extractVideoUrl finds the video url across output shapes", () => {
    expect(extractVideoUrl("https://cdn/x.mp4")).toBe("https://cdn/x.mp4");
    expect(extractVideoUrl({ video_url: "https://cdn/y.mp4" })).toBe("https://cdn/y.mp4");
    expect(extractVideoUrl({ output: { result: ["https://cdn/z.mp4"] } })).toBe("https://cdn/z.mp4");
    expect(extractVideoUrl({ nothing: true })).toBeNull();
  });

  it("clipKey is per-project, per-shot, sanitized, with the veo suffix", () => {
    expect(clipKey("My Film!", "shot/01")).toBe("renders/My_Film_/clips/shot_01_veo.mp4");
  });

  it("encodePoll / decodePoll round-trips the poll state", () => {
    const token = encodePoll({ jobId: "j1", project: "p", shotId: "s1", seconds: 6, submittedAt: 1000 });
    expect(decodePoll(token)).toEqual({ jobId: "j1", project: "p", shotId: "s1", seconds: 6, submittedAt: 1000 });
    expect(decodePoll("not-base64-json")).toBeNull();
  });

  it("runpodJobGone detects a GC'd job (404 http or numeric body status) but not a live state", () => {
    expect(runpodJobGone(404, null)).toBe(true);
    expect(runpodJobGone(200, { status: 404, title: "Not Found" })).toBe(true);
    expect(runpodJobGone(200, { title: "Not Found" })).toBe(true);
    expect(runpodJobGone(200, { status: "IN_PROGRESS" })).toBe(false);
    expect(runpodJobGone(200, { status: "COMPLETED" })).toBe(false);
  });

  it("classifyGoneState fails past the grace window, holds inside it, fails a legacy token", () => {
    const t0 = 1_000_000;
    expect(classifyGoneState(t0, t0 + RUNPOD_NOTFOUND_GRACE_MS)).toBe("gone-failed");
    expect(classifyGoneState(t0, t0 + 1_000)).toBe("gone-grace");
    expect(classifyGoneState(undefined, t0)).toBe("gone-failed");
  });
});
