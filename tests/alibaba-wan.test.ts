import { describe, it, expect } from "vitest";
import {
  clampDuration,
  buildWanBody,
  extractVideoUrl,
  clipKey,
  encodePoll,
  decodePoll,
  runpodJobGone,
  classifyGoneState,
  RUNPOD_NOTFOUND_GRACE_MS,
} from "../modules/alibaba-wan/src/wan";

describe("alibaba-wan pure logic", () => {
  it("clampDuration snaps to Wan's allowed enum {5,10,15} (up, never shorter)", () => {
    expect(clampDuration(5)).toBe(5);
    expect(clampDuration(4)).toBe(5); // the bug: 4 used to pass through and 400 at the provider
    expect(clampDuration(0)).toBe(5); // 0 -> default 5
    expect(clampDuration(99)).toBe(15);
    expect(clampDuration(1)).toBe(5);
    expect(clampDuration(7.6)).toBe(10); // round 8 -> next allowed up is 10
    expect(clampDuration(15)).toBe(15);
  });

  it("buildWanBody maps the hook input + config onto the RunPod body", () => {
    const body = buildWanBody(
      { shot_id: "shot_01", keyframe_url: "https://r2/x.png", prompt: "a city at dawn", seconds: 5 },
      { enable_prompt_expansion: true },
    );
    expect(body.input).toMatchObject({
      prompt: "a city at dawn",
      image: "https://r2/x.png",
      negative_prompt: "",
      size: "720p",
      duration: 5,
      shot_type: "single",
      seed: -1,
      enable_prompt_expansion: true,
      enable_safety_checker: true,
    });
  });

  it("buildWanBody defaults enable_prompt_expansion OFF when config is empty", () => {
    const body = buildWanBody(
      { shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 5 },
      {},
    );
    expect(body.input).toMatchObject({ enable_prompt_expansion: false, duration: 5, size: "720p", negative_prompt: "" });
  });

  it("extractVideoUrl finds the video url across output shapes", () => {
    expect(extractVideoUrl("https://cdn/x.mp4")).toBe("https://cdn/x.mp4");
    expect(extractVideoUrl({ video_url: "https://cdn/y.mp4" })).toBe("https://cdn/y.mp4");
    expect(extractVideoUrl({ output: { result: ["https://cdn/z.mp4"] } })).toBe("https://cdn/z.mp4");
    expect(extractVideoUrl({ nothing: true })).toBeNull();
  });

  it("clipKey is per-project, per-shot, sanitized, with the wan suffix", () => {
    expect(clipKey("My Film!", "shot/01")).toBe("renders/My_Film_/clips/shot_01_wan.mp4");
  });

  it("encodePoll / decodePoll round-trips the poll state", () => {
    const token = encodePoll({ jobId: "j1", project: "p", shotId: "s1", seconds: 5, submittedAt: 1000 });
    expect(decodePoll(token)).toEqual({ jobId: "j1", project: "p", shotId: "s1", seconds: 5, submittedAt: 1000 });
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
