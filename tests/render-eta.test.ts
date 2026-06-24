import { describe, expect, it } from "vitest";

import {
  PIPELINE_PHASES,
  progressFraction,
  remainingMs,
  type RenderProgressOutput,
} from "../public/render-eta.js";

// #115: the render-status poll envelope only carries a `progress` float during
// the i2v phase; keyframe pins scene_index=1 and finish/assemble/mux carry no
// per-unit signal. The old fraction math returned 0 (keyframe) or null
// (assemble/mux), so the UI sat at "?% eta computing..." for the whole render.
// progressFraction maps phases onto cumulative bands so overall completion is
// always defined and monotonic across phases.

const out = (o: Partial<RenderProgressOutput>): RenderProgressOutput => o as RenderProgressOutput;

describe("progressFraction phase bands (#115)", () => {
  it("bands are ordered, contiguous, and sum to 1", () => {
    let cursor = 0;
    for (const b of PIPELINE_PHASES) {
      expect(b.start).toBeCloseTo(cursor, 6);
      cursor += b.span;
    }
    expect(cursor).toBeCloseTo(1, 6);
  });

  it("keyframe sits at the band floor (no per-keyframe signal)", () => {
    expect(progressFraction(out({ phase: "keyframe", scene_index: 1, scene_total: 6 }))).toBeCloseTo(0, 6);
  });

  it("i2v uses the progress float within its band", () => {
    // i2v band = [0.35, 0.85). progress 0.5 -> 0.35 + 0.5*0.5 = 0.60.
    expect(progressFraction(out({ phase: "i2v", progress: 0.5, scene_index: 3, scene_total: 6 }))).toBeCloseTo(0.6, 6);
  });

  it("i2v falls back to completed-scene count when no progress float", () => {
    // scene_index 4 -> (4-1)/6 = 0.5 -> 0.35 + 0.5*0.5 = 0.60.
    expect(progressFraction(out({ phase: "i2v", scene_index: 4, scene_total: 6 }))).toBeCloseTo(0.6, 6);
  });

  it("finish / assemble / mux are defined (NOT null) at their band floors -- the #115 bug", () => {
    expect(progressFraction(out({ phase: "finish", scene_total: 6 }))).toBeCloseTo(0.85, 6);
    expect(progressFraction(out({ phase: "assemble", scene_total: 6 }))).toBeCloseTo(0.93, 6);
    expect(progressFraction(out({ phase: "mux", scene_total: 6 }))).toBeCloseTo(0.98, 6);
  });

  it("is monotonic across the pipeline phase sequence", () => {
    const seq = [
      progressFraction(out({ phase: "keyframe", scene_index: 1, scene_total: 4 })),
      progressFraction(out({ phase: "i2v", progress: 0.5 })),
      progressFraction(out({ phase: "finish", scene_index: 2, scene_total: 4 })),
      progressFraction(out({ phase: "assemble" })),
      progressFraction(out({ phase: "mux" })),
    ];
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1] as number);
    }
  });

  it("clamps an out-of-range within-phase signal into the band", () => {
    // scene_index past total must not push past the band ceiling.
    const f = progressFraction(out({ phase: "i2v", scene_index: 99, scene_total: 6 }));
    expect(f).toBeLessThanOrEqual(0.85);
    expect(f).toBeGreaterThanOrEqual(0.35);
  });
});

describe("progressFraction legacy / non-film fallback", () => {
  it("uses a bare progress float when no phase is present", () => {
    expect(progressFraction(out({ progress: 0.42 }))).toBeCloseTo(0.42, 6);
  });
  it("uses scene_index/scene_total when no phase or progress", () => {
    expect(progressFraction(out({ scene_index: 3, scene_total: 4 }))).toBeCloseTo(0.5, 6);
  });
  it("parses the latest Scene N/M out of the log", () => {
    expect(progressFraction(out({ log: ["Scene 1/4 ...", "Scene 2/4 ..."] }))).toBeCloseTo(0.25, 6);
  });
  it("falls back to legacy signals when the phase string is unknown", () => {
    expect(progressFraction(out({ phase: "warmup", progress: 0.2 }))).toBeCloseTo(0.2, 6);
  });
  it("returns null when there is no signal at all", () => {
    expect(progressFraction(out({ phase: "assemble-unknown" }))).toBeNull();
    expect(progressFraction(out({}))).toBeNull();
    expect(progressFraction(null)).toBeNull();
  });
});

describe("remainingMs ETA extrapolation (#115)", () => {
  it("extrapolates linearly: total = elapsed/fraction, remaining = total - elapsed", () => {
    // 50% done after 60s -> total ~120s -> ~60s remaining.
    expect(remainingMs(0.5, 60_000)).toBeCloseTo(60_000, 6);
  });
  it("withholds a number below the fraction floor (early model-load skew)", () => {
    expect(remainingMs(0.01, 60_000)).toBeNull();
  });
  it("withholds a number below the elapsed floor", () => {
    expect(remainingMs(0.5, 5_000)).toBeNull();
  });
  it("returns null for a non-positive or missing fraction", () => {
    expect(remainingMs(0, 60_000)).toBeNull();
    expect(remainingMs(null, 60_000)).toBeNull();
  });
  it("never returns negative remaining", () => {
    expect(remainingMs(1, 60_000)).toBe(0);
  });
});
