import { describe, expect, it } from "vitest";

import {
  validateStoryboard,
  SCENE_MAX_SECONDS,
  STORYBOARD_MAX_SECONDS,
} from "../src/storyboard-validate";

const sb = (over: Record<string, unknown> = {}) => ({
  title: "t",
  scenes: [{ prompt: "a shot" }],
  ...over,
});

const errs = (r: ReturnType<typeof validateStoryboard>) =>
  r.ok ? "" : r.errors.join(" ");

describe("duration caps (stop a storyboard from billing unbounded GPU)", () => {
  it("rejects a per-shot target_seconds over the cap", () => {
    const r = validateStoryboard(sb({ scenes: [{ prompt: "x", target_seconds: SCENE_MAX_SECONDS + 1 }] }));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/target_seconds/);
  });
  it("accepts target_seconds exactly at the cap", () => {
    const r = validateStoryboard(sb({ scenes: [{ prompt: "x", target_seconds: SCENE_MAX_SECONDS }] }));
    expect(r.ok).toBe(true);
  });
  it("rejects an end-start span over the cap (but allows a large absolute end)", () => {
    const over = validateStoryboard(sb({ scenes: [{ prompt: "x", start: 0, end: SCENE_MAX_SECONDS + 5 }] }));
    expect(over.ok).toBe(false);
    expect(errs(over)).toMatch(/span/);
    // a shot late in the film with a short span is fine
    const ok = validateStoryboard(sb({ scenes: [{ prompt: "x", start: 300, end: 305 }] }));
    expect(ok.ok).toBe(true);
  });
  it("rejects duration_seconds over the storyboard cap", () => {
    const r = validateStoryboard(sb({ duration_seconds: STORYBOARD_MAX_SECONDS + 1 }));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/duration_seconds/);
  });
  it("rejects clip_seconds over the per-shot cap", () => {
    const r = validateStoryboard(sb({ clip_seconds: SCENE_MAX_SECONDS + 1 }));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/clip_seconds/);
  });
});

describe("duplicate shot ids", () => {
  it("rejects an authored id that collides with an auto-numbered one", () => {
    // scene 0 authored "shot_02"; scene 1 unlabeled -> coerced to "shot_02"
    const r = validateStoryboard(sb({ scenes: [{ prompt: "a", id: "shot_02" }, { prompt: "b" }] }));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/duplicate shot id/);
  });
  it("accepts distinct ids", () => {
    const r = validateStoryboard(sb({ scenes: [{ prompt: "a" }, { prompt: "b" }] }));
    expect(r.ok).toBe(true);
  });
});

describe("normalizeStyleNone trims the value (issue #17)", () => {
  it("returns the TRIMMED style, not the raw padded value", () => {
    const r = validateStoryboard(sb({ style_category: "  anime  ", style_preset: "\tcinematic\n" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.style_category).toBe("anime");
      expect(r.value.style_preset).toBe("cinematic");
    }
  });
  it("collapses whitespace-only / missing to the literal None", () => {
    const r = validateStoryboard(sb({ style_category: "   " }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.style_category).toBe("None");
  });
});
