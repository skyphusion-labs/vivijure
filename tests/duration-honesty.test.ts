// #697/#698: the duration honesty gate + caption-from-actuals pure helpers.
//
// A per-shot finish chain can adopt a truncated partial write (an outlived/retried encode race) and
// ship a 0.085s clip for a 4s speaking shot; the pixel gate (#558) checks content, not length, so it
// sails through. These pure helpers let the assemble step compare each clip`s ACTUAL probed seconds
// against its plan and fail loud, and time caption cues to the real cut instead of the bundle plan.

import { describe, it, expect } from "vitest";
import {
  resolveClipDurationFloor,
  mapClipDurationsToShots,
  resolvePlannedSeconds,
  findClipDurationShortfalls,
  captionDurations,
  DEFAULT_CLIP_DURATION_FLOOR,
} from "../src/film-model";
import { buildCaptionCues } from "../src/captions";

describe("resolveClipDurationFloor (#697 knob)", () => {
  it("defaults to 0.5 when unset / empty / non-numeric", () => {
    expect(resolveClipDurationFloor(undefined)).toBe(DEFAULT_CLIP_DURATION_FLOOR);
    expect(resolveClipDurationFloor("")).toBe(0.5);
    expect(resolveClipDurationFloor("abc")).toBe(0.5);
  });
  it("parses a valid fraction", () => {
    expect(resolveClipDurationFloor("0.75")).toBe(0.75);
    expect(resolveClipDurationFloor("0")).toBe(0); // explicit off switch
  });
  it("clamps out-of-range into [0,1]", () => {
    expect(resolveClipDurationFloor("1.5")).toBe(1);
    expect(resolveClipDurationFloor("-2")).toBe(0);
  });
});

describe("mapClipDurationsToShots (#697/#698)", () => {
  const clips = [{ shot_id: "shot_01" }, { shot_id: "shot_02" }];
  it("maps the container array onto shot ids by submit order", () => {
    expect(mapClipDurationsToShots(clips, [0.085, 4.01])).toEqual({ shot_01: 0.085, shot_02: 4.01 });
  });
  it("returns {} when the container reported none (older build)", () => {
    expect(mapClipDurationsToShots(clips, undefined)).toEqual({});
    expect(mapClipDurationsToShots(clips, null)).toEqual({});
  });
  it("drops non-numeric / negative entries, never fabricates a duration", () => {
    expect(mapClipDurationsToShots(clips, ["x", -1])).toEqual({});
    expect(mapClipDurationsToShots(clips, [4.0, "nan"])).toEqual({ shot_01: 4.0 });
  });
});

describe("resolvePlannedSeconds (#697)", () => {
  const scenes = [{ shot_id: "shot_01", seconds: 4 }, { shot_id: "shot_02", seconds: 3 }];
  it("prefers the bundle target over the authored scene seconds", () => {
    expect(resolvePlannedSeconds(scenes, { shot_01: 5, shot_02: 2 })).toEqual({ shot_01: 5, shot_02: 2 });
  });
  it("falls back to scene seconds when the bundle has no positive target", () => {
    expect(resolvePlannedSeconds(scenes, { shot_01: 0 })).toEqual({ shot_01: 4, shot_02: 3 });
  });
  it("omits a shot with no positive plan anywhere (cannot gate it)", () => {
    expect(resolvePlannedSeconds([{ shot_id: "s", seconds: 0 }], {})).toEqual({});
  });
});

describe("findClipDurationShortfalls (#697 gate)", () => {
  const clips = [{ shot_id: "shot_01" }, { shot_id: "shot_02" }];
  const planned = { shot_01: 4, shot_02: 4 };

  it("flags a truncated clip below the floor (the live #697 case)", () => {
    const out = findClipDurationShortfalls(clips, { shot_01: 0.085, shot_02: 4.01 }, planned, 0.5);
    expect(out).toEqual([{ shot_id: "shot_01", actual: 0.085, planned: 4, floor: 2 }]);
  });
  it("passes an at-floor clip (>= threshold is not a shortfall)", () => {
    expect(findClipDurationShortfalls(clips, { shot_01: 2.0, shot_02: 4.0 }, planned, 0.5)).toEqual([]);
  });
  it("passes a legitimate beat-trim just under plan", () => {
    expect(findClipDurationShortfalls(clips, { shot_01: 3.8, shot_02: 3.9 }, planned, 0.5)).toEqual([]);
  });
  it("fires on EVIDENCE only: a shot with no reported actual is not flagged", () => {
    expect(findClipDurationShortfalls(clips, { shot_02: 4.0 }, planned, 0.5)).toEqual([]);
  });
  it("a shot with no plan is not flagged", () => {
    expect(findClipDurationShortfalls(clips, { shot_01: 0.1, shot_02: 4.0 }, { shot_02: 4 }, 0.5)).toEqual([]);
  });
  it("fraction 0 disables the gate entirely", () => {
    expect(findClipDurationShortfalls(clips, { shot_01: 0.001, shot_02: 0.001 }, planned, 0)).toEqual([]);
  });
});

describe("captionDurations + buildCaptionCues from ACTUAL durations (#698)", () => {
  const scenes = [{ shot_id: "shot_01", seconds: 4 }, { shot_id: "shot_02", seconds: 4 }];
  const lines = [{ shot_id: "shot_01", text: "first line" }, { shot_id: "shot_02", text: "second line" }];

  it("actual per-shot seconds win; bundle plan fills a gap", () => {
    expect(captionDurations({ shot_01: 4, shot_02: 4 }, { shot_01: 2.1 })).toEqual({ shot_01: 2.1, shot_02: 4 });
  });

  it("times cue 2 to the ACTUAL cut, not the plan -- the #698 skew", () => {
    // Planned 4s+4s would put cue 2 at [4,8); the delivered film ran shot_01 ~2.1s, so cue 2 must start ~2.1.
    const actual = { shot_01: 2.1, shot_02: 4.0 };
    const durations = captionDurations({ shot_01: 4, shot_02: 4 }, actual);
    const cues = buildCaptionCues(scenes, lines, durations);
    expect(cues[0]).toEqual({ start: 0, end: 2.1, text: "first line" });
    expect(cues[1]).toEqual({ start: 2.1, end: 6.1, text: "second line" });
  });

  it("with no actuals, falls back to the bundle plan (legacy timeline)", () => {
    const cues = buildCaptionCues(scenes, lines, captionDurations({ shot_01: 4, shot_02: 4 }, undefined));
    expect(cues[0]).toEqual({ start: 0, end: 4, text: "first line" });
    expect(cues[1]).toEqual({ start: 4, end: 8, text: "second line" });
  });
});
