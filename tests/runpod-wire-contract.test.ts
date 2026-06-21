import { describe, it, expect } from "vitest";
import {
  buildSubmitPayload,
  buildFinalizePayload,
  normalizeRenderOverrides,
  deriveProjectFromBundleKey,
} from "../src/runpod-submit";

// Issue #9 (lead suite): the snake_case WIRE CONTRACT the clean-room vivijure-backend reads off the
// job input. This is exactly the recurring backend-mismatch bug class (a control-plane field the pod
// never reads, or a renamed field) -- lock the field NAMES and the on/off-the-wire rules.

describe("buildSubmitPayload wire contract", () => {
  it("derives project from the bundle key when omitted, defaults quality_tier to final", () => {
    const { input } = buildSubmitPayload({ bundleKey: "bundles/myfilm.tar.gz" });
    expect(input.project).toBe("myfilm");
    expect(input.bundle_key).toBe("bundles/myfilm.tar.gz");
    expect(input.quality_tier).toBe("final");
    // nothing optional leaks onto the wire
    expect(Object.keys(input).sort()).toEqual(["bundle_key", "project", "quality_tier"]);
  });

  it("prefers an explicit (trimmed) project over the derived one", () => {
    const { input } = buildSubmitPayload({ bundleKey: "bundles/x.tar.gz", project: "  hero  " });
    expect(input.project).toBe("hero");
  });

  it("keyframesOnly selects the first-class action=preview (NOT a render_overrides flag)", () => {
    const { input } = buildSubmitPayload({ bundleKey: "bundles/x.tar.gz", keyframesOnly: true });
    expect(input.action).toBe("preview");
    // must not smuggle a keyframes_only flag into render_overrides
    expect(input.render_overrides).toBeUndefined();
  });

  it("maps camelCase args to the exact snake_case wire fields", () => {
    const { input } = buildSubmitPayload({
      bundleKey: "bundles/x.tar.gz",
      qualityTier: "draft",
      audioKey: "audio/bed.mp3",
      pretrainedLoras: { hero: "loras/hero.safetensors" },
      processShotIds: ["shot_01", "shot_02"],
    });
    expect(input.quality_tier).toBe("draft");
    expect(input.audio_key).toBe("audio/bed.mp3");
    expect(input.pretrained_loras).toEqual({ hero: "loras/hero.safetensors" });
    expect(input.process_shot_ids).toEqual(["shot_01", "shot_02"]);
  });

  it("keeps empty optionals OFF the wire (no empty strings / arrays / maps)", () => {
    const { input } = buildSubmitPayload({
      bundleKey: "bundles/x.tar.gz",
      audioKey: "",
      pretrainedLoras: {},
      processShotIds: [],
    });
    expect("audio_key" in input).toBe(false);
    expect("pretrained_loras" in input).toBe(false);
    expect("process_shot_ids" in input).toBe(false);
  });

  it("copies the pretrained_loras / process_shot_ids containers (no caller aliasing)", () => {
    const loras = { hero: "loras/hero.safetensors" };
    const shots = ["shot_01"];
    const { input } = buildSubmitPayload({ bundleKey: "bundles/x.tar.gz", pretrainedLoras: loras, processShotIds: shots });
    expect(input.pretrained_loras).not.toBe(loras);
    expect(input.process_shot_ids).not.toBe(shots);
  });
});

describe("buildFinalizePayload wire contract", () => {
  it("stamps action=finalize and mirrors the submit field names", () => {
    const { input } = buildFinalizePayload({
      project: "hero", bundleKey: "bundles/hero.tar.gz", qualityTier: "standard",
      processShotIds: ["shot_03"], audioKey: "audio/a.mp3",
      pretrainedLoras: { hero: "loras/h.safetensors" },
    });
    expect(input.action).toBe("finalize");
    expect(input.project).toBe("hero");
    expect(input.bundle_key).toBe("bundles/hero.tar.gz");
    expect(input.quality_tier).toBe("standard");
    expect(input.process_shot_ids).toEqual(["shot_03"]);
    expect(input.audio_key).toBe("audio/a.mp3");
    expect(input.pretrained_loras).toEqual({ hero: "loras/h.safetensors" });
  });

  it("defaults quality_tier to final and drops empty shot lists", () => {
    const { input } = buildFinalizePayload({ project: "p", bundleKey: "bundles/p.tar.gz", processShotIds: [] });
    expect(input.quality_tier).toBe("final");
    expect("process_shot_ids" in input).toBe(false);
  });
});

describe("normalizeRenderOverrides (drop anything the backend does not read)", () => {
  it("passes the namespaced sections + the finish_offloaded flag through verbatim", () => {
    const out = normalizeRenderOverrides({
      keyframe: { steps: 30 }, i2v: { backend: "wan" }, lora: { rank: 16 }, finish_offloaded: true,
    });
    expect(out).toEqual({ keyframe: { steps: 30 }, i2v: { backend: "wan" }, lora: { rank: 16 }, finish_offloaded: true });
  });

  it("drops unknown sections (the old vivijure-serverless *_overrides blocks) and non-object sections", () => {
    const out = normalizeRenderOverrides({
      keyframe: { steps: 8 },
      multi_character: { x: 1 },   // unknown -> dropped
      wan_diffusion: { y: 2 },     // unknown -> dropped
      i2v: [1, 2, 3],              // array, not an object -> dropped
      finish_offloaded: "yes",     // not a boolean -> dropped
    });
    expect(out).toEqual({ keyframe: { steps: 8 } });
  });

  it("returns undefined when nothing survives (so it never lands on the wire empty)", () => {
    expect(normalizeRenderOverrides({ junk: 1 })).toBeUndefined();
    expect(normalizeRenderOverrides(null)).toBeUndefined();
    expect(normalizeRenderOverrides("nope")).toBeUndefined();
    expect(normalizeRenderOverrides([1, 2])).toBeUndefined();
  });
});

describe("deriveProjectFromBundleKey", () => {
  it("strips the bundles/<name>.tar.gz convention", () => {
    expect(deriveProjectFromBundleKey("bundles/a-film.tar.gz")).toBe("a-film");
  });
  it("falls back to the raw key when the shape does not match", () => {
    expect(deriveProjectFromBundleKey("custom/key")).toBe("custom/key");
  });
});
