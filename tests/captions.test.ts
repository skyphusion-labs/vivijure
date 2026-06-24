import { describe, it, expect } from "vitest";
import { buildCaptionCues, type CaptionScene, type CaptionLine } from "../src/captions";

const scenes = (xs: [string, number][]): CaptionScene[] => xs.map(([shot_id, seconds]) => ({ shot_id, seconds }));
const lines = (xs: [string, string][]): CaptionLine[] => xs.map(([shot_id, text]) => ({ shot_id, text }));

describe("buildCaptionCues", () => {
  it("times each line to its shot's cumulative window (authored seconds)", () => {
    const cues = buildCaptionCues(
      scenes([["shot_01", 3], ["shot_02", 4], ["shot_03", 2]]),
      lines([["shot_01", "Hello there"], ["shot_03", "Goodbye"]]),
    );
    // shot_01: [0,3); shot_02 has no line (advances time only); shot_03: [7,9)
    expect(cues).toEqual([
      { start: 0, end: 3, text: "Hello there" },
      { start: 7, end: 9, text: "Goodbye" },
    ]);
  });

  it("prefers real bundle durations over authored scene seconds", () => {
    const cues = buildCaptionCues(
      scenes([["shot_01", 3], ["shot_02", 3]]),
      lines([["shot_02", "synced to the trim"]]),
      { shot_01: 2.5, shot_02: 4 }, // beat-trimmed targets differ from authored
    );
    // start = real shot_01 duration (2.5), end = start + real shot_02 (4) = 6.5
    expect(cues).toEqual([{ start: 2.5, end: 6.5, text: "synced to the trim" }]);
  });

  it("falls back to authored seconds when a shot is missing from the durations map", () => {
    const cues = buildCaptionCues(
      scenes([["shot_01", 3], ["shot_02", 5]]),
      lines([["shot_02", "fallback timing"]]),
      { shot_01: 2 }, // shot_02 absent -> use authored 5
    );
    expect(cues).toEqual([{ start: 2, end: 7, text: "fallback timing" }]);
  });

  it("returns no cues for a silent film (no dialogue lines)", () => {
    expect(buildCaptionCues(scenes([["shot_01", 3], ["shot_02", 4]]), [])).toEqual([]);
  });

  it("ignores empty / whitespace-only lines and trims text", () => {
    const cues = buildCaptionCues(
      scenes([["shot_01", 3], ["shot_02", 4]]),
      lines([["shot_01", "   "], ["shot_02", "  trimmed  "]]),
    );
    expect(cues).toEqual([{ start: 3, end: 7, text: "trimmed" }]);
  });

  it("last line wins when a shot is addressed twice", () => {
    const cues = buildCaptionCues(
      scenes([["shot_01", 3]]),
      lines([["shot_01", "first"], ["shot_01", "second"]]),
    );
    expect(cues).toEqual([{ start: 0, end: 3, text: "second" }]);
  });

  it("guarantees a minimum cue length for a zero-duration shot with a line", () => {
    const cues = buildCaptionCues(scenes([["shot_01", 0]]), lines([["shot_01", "blink"]]));
    expect(cues).toHaveLength(1);
    expect(cues[0].start).toBe(0);
    expect(cues[0].end).toBeGreaterThan(cues[0].start);
  });

  it("keeps cues in play order regardless of line order", () => {
    const cues = buildCaptionCues(
      scenes([["a", 2], ["b", 2], ["c", 2]]),
      lines([["c", "third"], ["a", "first"], ["b", "second"]]),
    );
    expect(cues.map((c) => c.text)).toEqual(["first", "second", "third"]);
    expect(cues.map((c) => c.start)).toEqual([0, 2, 4]);
  });
});
