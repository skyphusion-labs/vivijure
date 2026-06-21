import { describe, expect, it } from "vitest";

import {
  validateStoryboard,
  normalizeProjectName,
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

describe("path/key injection hardening (security #6)", () => {
  it("normalizeProjectName yields a path-safe single segment", () => {
    expect(normalizeProjectName("My Film")).toBe("My_Film"); // ordinary title: unchanged transform
    expect(normalizeProjectName("a/b")).toBe("a_b"); // a slash cannot create a nested key
    expect(normalizeProjectName("..")).toBe("project"); // bare traversal collapses to the fallback
    expect(normalizeProjectName("")).toBe("project");
    expect(normalizeProjectName("   ")).toBe("project");
    const traversal = normalizeProjectName("../../etc/passwd");
    expect(traversal).not.toContain("..");
    expect(traversal).not.toContain("/");
    // placed into the real bundle key, it can never escape the prefix
    expect(`bundles/${traversal}.tar.gz`.includes("..")).toBe(false);
  });

  it("rejects a scene start_image with traversal / absolute / scheme", () => {
    for (const bad of ["../x.png", "a/../b.png", "/abs.png", "http://evil/x.png"]) {
      const r = validateStoryboard(sb({ scenes: [{ prompt: "x", start_image: bad }] }));
      expect(r.ok).toBe(false);
      expect(errs(r)).toMatch(/start_image/);
    }
  });

  it("accepts a safe relative start_image", () => {
    const r = validateStoryboard(sb({ scenes: [{ prompt: "x", start_image: "refs/start_image.png" }] }));
    expect(r.ok).toBe(true);
  });

  it("rejects a refs_dir with traversal / absolute", () => {
    for (const bad of ["../refs", "/abs/refs", "refs/../../x"]) {
      const r = validateStoryboard(sb({ refs_dir: bad }));
      expect(r.ok).toBe(false);
      expect(errs(r)).toMatch(/refs_dir/);
    }
  });

  it("accepts a safe relative refs_dir", () => {
    const r = validateStoryboard(sb({ refs_dir: "refs/my_project" }));
    expect(r.ok).toBe(true);
  });
});

describe("shot dialogue (talking characters)", () => {
  // A speaking shot: the slot is loaded (use_characters), in the shot (character_slots), and speaks.
  const speaking = (dialogue: unknown) =>
    sb({
      use_characters: ["A", "B"],
      scenes: [{ prompt: "two of them talk", character_slots: ["A", "B"], dialogue }],
    });

  it("accepts a well-formed line from a slot present in the shot", () => {
    const r = validateStoryboard(speaking({ slot: "A", text: "We should not be here." }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scenes[0].dialogue).toEqual({ slot: "A", text: "We should not be here." });
  });

  it("trims the line", () => {
    const r = validateStoryboard(speaking({ slot: "B", text: "   hello   " }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scenes[0].dialogue?.text).toBe("hello");
  });

  it("rejects a speaker not in the shot's character_slots", () => {
    // C is not in this shot (nor loaded); the speaker has to be in the shot.
    const r = validateStoryboard(speaking({ slot: "C", text: "off-camera line" }));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/dialogue\.slot/);
  });

  it("rejects an invalid slot id", () => {
    const r = validateStoryboard(speaking({ slot: "Z", text: "x" }));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/dialogue\.slot/);
  });

  it("rejects empty text", () => {
    const r = validateStoryboard(speaking({ slot: "A", text: "   " }));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/dialogue\.text/);
  });

  it("rejects a line over the char cap", () => {
    const r = validateStoryboard(speaking({ slot: "A", text: "x".repeat(301) }));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/dialogue\.text/);
  });

  it("rejects a non-object dialogue", () => {
    const r = validateStoryboard(speaking("just a string"));
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/dialogue must be an object/);
  });

  it("a shot with no dialogue stays valid (silent shot)", () => {
    const r = validateStoryboard(
      sb({ use_characters: ["A"], scenes: [{ prompt: "silent", character_slots: ["A"] }] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scenes[0].dialogue).toBeUndefined();
  });
});
