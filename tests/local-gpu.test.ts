// local-gpu module: pure-logic + conformance tests. No runtime, no GPU, no spend.
//
// Proves the local-consumer motion.backend door honors the contract: the i2v_clip wire mapping, the
// async poll token, the #141 gone-detection + grace, the #124 tier vocabulary, and -- the load-bearing
// one -- that the MotionBackendOutput this module surfaces passes the core's checkHookOutput.

import { describe, it, expect } from "vitest";
import {
  framesFor,
  buildI2vBody,
  readOutput,
  encodePoll,
  decodePoll,
  jobGone,
  classifyGoneState,
  JOB_NOTFOUND_GRACE_MS,
} from "../modules/local-gpu/src/i2v";
import { MANIFEST } from "../modules/local-gpu/src/index";
import { checkHookOutput } from "../src/modules/conformance";
import { QUALITY_TIERS } from "../src/render-module-config";
import type { ConfigField } from "../src/modules/types";

describe("local-gpu i2v pure logic", () => {
  it("framesFor derives a frame count from shot seconds * fps", () => {
    expect(framesFor(5, 24)).toBe(120); // backend snaps to its stride (LTX 8k+1 -> 121)
    expect(framesFor(3, 24)).toBe(72);
    expect(framesFor(0, 24)).toBe(120); // 0 -> default 5s
    expect(framesFor(0.1, 24)).toBe(24); // floor of ~1s of frames
  });

  it("buildI2vBody maps the hook input + config onto the i2v_clip action body (same wire as datacenter)", () => {
    const body = buildI2vBody(
      { shot_id: "shot_02", keyframe_url: "https://r2/x.png", prompt: "slow dolly in", seconds: 5 },
      { quality: "final", fps: 24, flow_shift: 5, seed: 42, negative_prompt: "blurry" },
      "the-film",
    );
    expect(body.input).toMatchObject({
      action: "i2v_clip",
      project: "the-film",
      shot_id: "shot_02",
      prompt: "slow dolly in",
      config: { quality: "final", num_frames: 120, fps: 24, seed: 42, flow_shift: 5, negative_prompt: "blurry" },
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
    expect(cfg).toMatchObject({ quality: "standard", num_frames: 120, fps: 24 }); // tier + cadence defaults
  });

  it("readOutput maps the backend's i2v_clip output into MotionBackendOutput", () => {
    expect(
      readOutput("shot_02", { clip_key: "renders/f/clips/shot_02_i2v.mp4", shot_id: "shot_02", fps: 24, num_frames: 121, seconds: 5.04, distilled: true }),
    ).toEqual({ shot_id: "shot_02", clip_key: "renders/f/clips/shot_02_i2v.mp4", fps: 24, frames: 121 });
  });

  it("readOutput returns null when the backend reported no clip_key (treated as a failure)", () => {
    expect(readOutput("s", { shot_id: "s", fps: 24 })).toBeNull();
    expect(readOutput("s", {})).toBeNull();
    expect(readOutput("s", undefined)).toBeNull();
  });

  it("encodePoll/decodePoll round-trip the async job state, including submittedAt (#141)", () => {
    const st = { jobId: "abc123", project: "My Proj", shotId: "shot_01", submittedAt: 1_700_000_000_000 };
    expect(decodePoll(encodePoll(st))).toEqual(st);
    const legacy = decodePoll(encodePoll({ jobId: "j", project: "p", shotId: "s" }));
    expect(legacy?.submittedAt).toBeUndefined();
    expect(decodePoll("not-valid-token")).toBeNull();
  });
});

describe("local-gpu job-gone detection + grace (#141)", () => {
  it("jobGone: HTTP 404 is gone", () => {
    expect(jobGone(404, { status: 404, title: "Not Found" })).toBe(true);
  });
  it("jobGone: a numeric 404 status in a 200 envelope is gone", () => {
    expect(jobGone(200, { status: 404, title: "Not Found" } as never)).toBe(true);
  });
  it("jobGone: a not-found title with no run state is gone", () => {
    expect(jobGone(200, { title: "Not Found" })).toBe(true);
  });
  it("jobGone: a real run state is NOT gone", () => {
    expect(jobGone(200, { status: "IN_PROGRESS" })).toBe(false);
    expect(jobGone(200, { status: "COMPLETED" })).toBe(false);
    expect(jobGone(200, { status: "IN_QUEUE" })).toBe(false);
  });
  it("classifyGoneState: inside the grace window keeps polling", () => {
    const now = 1_000_000;
    expect(classifyGoneState(now - (JOB_NOTFOUND_GRACE_MS - 1000), now)).toBe("gone-grace");
  });
  it("classifyGoneState: past the grace window fails", () => {
    const now = 1_000_000;
    expect(classifyGoneState(now - (JOB_NOTFOUND_GRACE_MS + 1000), now)).toBe("gone-failed");
  });
  it("classifyGoneState: a legacy token (no submittedAt) fails immediately (a 404 now is a real loss)", () => {
    expect(classifyGoneState(undefined, 1_000_000)).toBe("gone-failed");
  });
});

describe("local-gpu manifest conformance", () => {
  it("the output this module surfaces passes the core's checkHookOutput for motion.backend", () => {
    const output = readOutput("shot_01", {
      clip_key: "renders/f/clips/shot_01_i2v.mp4",
      shot_id: "shot_01",
      fps: 24,
      num_frames: 121,
    });
    const check = checkHookOutput("motion.backend", output);
    expect(check.pass, check.detail).toBe(true);
  });

  it("declares motion.backend, is cancelable, and targets vivijure-module/2", () => {
    expect(MANIFEST.hooks).toContain("motion.backend");
    expect(MANIFEST.cancelable).toBe(true);
    expect(MANIFEST.api).toBe("vivijure-module/2");
  });

  it("quality enum matches the core QUALITY_TIERS set (#124 -- else the injected tier silently drops)", () => {
    const core = QUALITY_TIERS.map((t) => t.value).slice().sort();
    const f = MANIFEST.config_schema?.quality as Extract<ConfigField, { type: "enum" }> | undefined;
    expect(f?.type).toBe("enum");
    expect(f!.values.slice().sort()).toEqual(core);
    expect(core).toContain(f!.default);
  });
});
