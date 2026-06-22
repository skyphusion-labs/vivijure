import { describe, it, expect } from "vitest";
import { clampDuration, buildKlingBody, extractVideoUrl, clipKey, encodePoll, decodePoll, runpodJobGone, classifyGoneState, RUNPOD_NOTFOUND_GRACE_MS } from "../modules/kling/src/kling";

describe("kling pure logic", () => {
  it("clampDuration snaps to Kling's allowed enum {5,10} (up, never shorter)", () => {
    expect(clampDuration(5)).toBe(5);
    expect(clampDuration(4)).toBe(5); // the bug: 4 used to pass through and 400 at the provider
    expect(clampDuration(99)).toBe(10);
    expect(clampDuration(1)).toBe(5);
    expect(clampDuration(0)).toBe(5);
    expect(clampDuration(7)).toBe(10); // 5 < 7 -> next allowed up is 10 (don't clip a 7s shot to 5)
    expect(clampDuration(10)).toBe(10);
  });
  it("buildKlingBody maps input + config", () => {
    const b = buildKlingBody({ shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 5 },
      { guidance_scale: 0.8, negative_prompt: "blurry", enable_safety_checker: false });
    expect(b.input).toMatchObject({ prompt: "p", image: "u", negative_prompt: "blurry", guidance_scale: 0.8, duration: 5, enable_safety_checker: false });
  });
  it("buildKlingBody falls back to defaults", () => {
    const b = buildKlingBody({ shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 7 }, {});
    expect(b.input).toMatchObject({ negative_prompt: "", guidance_scale: 0.5, duration: 10, enable_safety_checker: true });
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

describe("kling RunPod gone-detection + grace (#141)", () => {
  it("round-trips submittedAt; legacy token decodes undefined", () => {
    const s = { jobId: "j", project: "p", shotId: "shot_07", seconds: 5, submittedAt: 1_700_000_000_000 };
    expect(decodePoll(encodePoll(s))).toEqual(s);
    expect(decodePoll(encodePoll({ jobId: "j", project: "p", shotId: "s", seconds: 5 }))?.submittedAt).toBeUndefined();
  });
  it("runpodJobGone detects 404 / numeric-404 / not-found, not a real run state", () => {
    expect(runpodJobGone(404, { status: 404 })).toBe(true);
    expect(runpodJobGone(200, { status: 404, title: "Not Found" } as never)).toBe(true);
    expect(runpodJobGone(200, { title: "Not Found" })).toBe(true);
    expect(runpodJobGone(200, { status: "COMPLETED" })).toBe(false);
    expect(runpodJobGone(200, { status: "IN_QUEUE" })).toBe(false);
  });
  it("classifyGoneState: grace vs fail vs legacy", () => {
    const now = 5_000_000;
    expect(classifyGoneState(now - (RUNPOD_NOTFOUND_GRACE_MS - 1), now)).toBe("gone-grace");
    expect(classifyGoneState(now - (RUNPOD_NOTFOUND_GRACE_MS + 1), now)).toBe("gone-failed");
    expect(classifyGoneState(undefined, now)).toBe("gone-failed");
  });
});
