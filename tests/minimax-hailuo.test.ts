import { describe, it, expect } from "vitest";
import {
  clampDuration,
  buildHailuoBody,
  extractVideoUrl,
  clipKey,
  encodePoll,
  decodePoll,
  runpodJobGone,
  classifyGoneState,
  RUNPOD_NOTFOUND_GRACE_MS,
} from "../modules/minimax-hailuo/src/hailuo";

describe("minimax-hailuo pure logic", () => {
  it("clampDuration snaps to the nearest allowed discrete value [6, 10] (default 6)", () => {
    expect(clampDuration(6)).toBe(6);
    expect(clampDuration(0)).toBe(6);   // 0 -> default 6
    expect(clampDuration(99)).toBe(10);
    expect(clampDuration(1)).toBe(6);   // small values all snap to 6 (was 3, wrong)
    expect(clampDuration(7.6)).toBe(6); // rounds to 8, midpoint goes to 6 (was 8, wrong)
    expect(clampDuration(9)).toBe(10);  // > 8 snaps to 10
    expect(clampDuration(10)).toBe(10);
  });

  it("buildHailuoBody maps the hook input + config onto the RunPod body", () => {
    const body = buildHailuoBody(
      { shot_id: "shot_01", keyframe_url: "https://r2/x.png", prompt: "a city at dawn", seconds: 6 },
      { enable_prompt_expansion: false, go_fast: false },
    );
    expect(body.input).toMatchObject({
      prompt: "a city at dawn",
      image: "https://r2/x.png",
      duration: 6,
      enable_prompt_expansion: false,
      go_fast: false,
    });
  });

  it("buildHailuoBody defaults enable_prompt_expansion + go_fast ON when config is empty", () => {
    const body = buildHailuoBody(
      { shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 6 },
      {},
    );
    // duration snaps to nearest allowed: 6 (seconds=6 -> 6)
    expect(body.input).toMatchObject({ enable_prompt_expansion: true, go_fast: true, duration: 6 });
  });

  it("extractVideoUrl finds the video url across output shapes", () => {
    expect(extractVideoUrl("https://cdn/x.mp4")).toBe("https://cdn/x.mp4");
    expect(extractVideoUrl({ video_url: "https://cdn/y.mp4" })).toBe("https://cdn/y.mp4");
    expect(extractVideoUrl({ output: { result: ["https://cdn/z.mp4"] } })).toBe("https://cdn/z.mp4");
    expect(extractVideoUrl({ nothing: true })).toBeNull();
  });

  it("clipKey is per-project, per-shot, sanitized, with the hailuo suffix", () => {
    expect(clipKey("My Film!", "shot/01")).toBe("renders/My_Film_/clips/shot_01_hailuo.mp4");
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
