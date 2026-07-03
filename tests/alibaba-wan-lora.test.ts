import { describe, it, expect } from "vitest";
import {
  clampDuration,
  parseLoras,
  buildWanLoraBody,
  extractVideoUrl,
  extractCost,
  clipKey,
  encodePoll,
  decodePoll,
  runpodJobGone,
  classifyGoneState,
  RUNPOD_NOTFOUND_GRACE_MS,
  ALLOWED_DURATIONS,
} from "../modules/alibaba-wan-lora/src/wan-lora";
import { MANIFEST } from "../modules/alibaba-wan-lora/src/index";
import { checkManifest, checkHookOutput, allPass, failures } from "../src/modules/conformance";

describe("alibaba-wan-lora pure logic", () => {
  it("clampDuration snaps to the endpoint allowed set {5,8} (<=6 -> 5, else 8); never an arbitrary value (#279)", () => {
    expect(clampDuration(5)).toBe(5);
    expect(clampDuration(8)).toBe(8);
    expect(clampDuration(3)).toBe(5); // 3 was REJECTED by the endpoint (the #279 break)
    expect(clampDuration(4)).toBe(5); // the test bundle's 4s shots also failed pre-fix
    expect(clampDuration(6)).toBe(5);
    expect(clampDuration(7)).toBe(8);
    expect(clampDuration(0)).toBe(5); // 0 -> default 5
    expect(clampDuration(999)).toBe(8); // snaps to the top allowed value
    // only the allowed set is EVER emitted, for any requested seconds
    for (let s = 0; s <= 20; s++) expect(ALLOWED_DURATIONS as readonly number[]).toContain(clampDuration(s));
  });

  it("parseLoras accepts a JSON string of [{path,scale}] and validates entries", () => {
    expect(parseLoras('[{"path":"https://hf.co/a.safetensors","scale":0.8}]')).toEqual([
      { path: "https://hf.co/a.safetensors", scale: 0.8 },
    ]);
    // already-parsed array is accepted too
    expect(parseLoras([{ path: "p", scale: 1.2 }])).toEqual([{ path: "p", scale: 1.2 }]);
    // missing scale -> default 1.0
    expect(parseLoras('[{"path":"p"}]')).toEqual([{ path: "p", scale: 1 }]);
  });

  it("parseLoras is liberal but safe: empty / bad / pathless inputs -> [] (plain Wan i2v, no throw)", () => {
    expect(parseLoras("[]")).toEqual([]);
    expect(parseLoras("")).toEqual([]);
    expect(parseLoras(undefined)).toEqual([]);
    expect(parseLoras("not json")).toEqual([]);
    expect(parseLoras('[{"scale":1}]')).toEqual([]); // no path -> dropped
    expect(parseLoras('{"path":"p"}')).toEqual([]); // not an array
  });

  it("buildWanLoraBody maps the hook input onto the documented endpoint body, LoRAs off by default", () => {
    const body = buildWanLoraBody(
      { shot_id: "shot_01", keyframe_url: "https://r2/x.png", prompt: "a city at dawn", seconds: 5 },
      {},
    );
    expect(body.input).toEqual({
      prompt: "a city at dawn",
      image: "https://r2/x.png", // the keyframe passed straight through as the start image
      duration: 5,
      seed: -1,
      enable_safety_checker: true,
    });
    // no LoRA keys when the lists are empty
    expect("high_noise_loras" in body.input).toBe(false);
    expect("low_noise_loras" in body.input).toBe(false);
  });

  it("buildWanLoraBody passes custom LoRAs through both passes plus seed + safety overrides", () => {
    const body = buildWanLoraBody(
      { shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 8 },
      {
        high_noise_loras: '[{"path":"https://hf.co/hi.safetensors","scale":1.1}]',
        low_noise_loras: '[{"path":"https://hf.co/lo.safetensors","scale":0.6}]',
        seed: 42,
        enable_safety_checker: false,
      },
    );
    expect(body.input).toMatchObject({
      prompt: "p",
      image: "u",
      duration: 8,
      seed: 42,
      enable_safety_checker: false,
      high_noise_loras: [{ path: "https://hf.co/hi.safetensors", scale: 1.1 }],
      low_noise_loras: [{ path: "https://hf.co/lo.safetensors", scale: 0.6 }],
    });
  });

  it("extractVideoUrl finds the video url across output shapes", () => {
    expect(extractVideoUrl({ video_url: "https://cdn/y.mp4" })).toBe("https://cdn/y.mp4");
    expect(extractVideoUrl({ output: { result: ["https://cdn/z.mp4"] } })).toBe("https://cdn/z.mp4");
    expect(extractVideoUrl({ nothing: true })).toBeNull();
  });

  it("extractCost reads the reported USD cost when present", () => {
    expect(extractCost({ video_url: "https://cdn/x.mp4", cost: 0.35 })).toBe(0.35);
    expect(extractCost({ video_url: "https://cdn/x.mp4" })).toBeNull();
  });

  it("clipKey is per-project, per-shot, sanitized, with the wanlora suffix", () => {
    expect(clipKey("My Film!", "shot/01")).toBe("renders/My_Film_/clips/shot_01_wanlora.mp4");
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

describe("alibaba-wan-lora conformance (vivijure-module/2)", () => {
  it("manifest is a valid motion.backend module manifest", () => {
    const checks = checkManifest(MANIFEST);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
    expect(MANIFEST.hooks).toContain("motion.backend");
  });

  it("a finalized poll output honors the motion.backend output contract", () => {
    const out = { shot_id: "s1", clip_key: "renders/p/clips/s1_wanlora.mp4", fps: 24, frames: 120 };
    expect(checkHookOutput("motion.backend", out).pass).toBe(true);
  });

  it("checkHookOutput rejects a malformed motion.backend output (missing clip_key)", () => {
    const out = { shot_id: "s1", fps: 24, frames: 120 };
    expect(checkHookOutput("motion.backend", out).pass).toBe(false);
  });
});
