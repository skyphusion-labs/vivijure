import { describe, it, expect } from "vitest";
import {
  TRAINING_PROMPTS,
  FLAG_FALLBACK_MODEL,
  isFlaggedError,
  composeTrainingPrompt,
  clampNumImages,
  buildState,
  encodePoll,
  decodePoll,
  stateKey,
  refKey,
  readOutput,
} from "../modules/cast-image/src/cast-image";

describe("cast-image pure logic", () => {
  it("composeTrainingPrompt: art-style lead + template + capped bible (lifted from cast.js)", () => {
    expect(composeTrainingPrompt("close-up portrait")).toBe("close-up portrait");
    expect(composeTrainingPrompt("close-up", "a weathered detective", "anime")).toBe(
      "anime art style, anime illustration. close-up. a weathered detective",
    );
    const out = composeTrainingPrompt("t", "x".repeat(800));
    expect(out).toBe("t. " + "x".repeat(600)); // bible capped at 600 chars
  });

  it("clampNumImages bounds to [4, prompt-set] with default 10", () => {
    expect(clampNumImages(10)).toBe(10);
    expect(clampNumImages(0)).toBe(10); // 0 -> default 10
    expect(clampNumImages(2)).toBe(4); // floor 4 (the LoRA-training minimum)
    expect(clampNumImages(99)).toBe(TRAINING_PROMPTS.length);
  });

  it("buildState composes n prompts, carries ref_urls, starts empty", () => {
    const s = buildState(
      { cast_id: 7, portrait_url: "https://r2/p.png", source_urls: ["https://r2/s1.png"], bible: "b", art_style: "anime" },
      "google/nano-banana-pro",
      5,
    );
    expect(s.cast_id).toBe(7);
    expect(s.model).toBe("google/nano-banana-pro");
    expect(s.total).toBe(5);
    expect(s.prompts).toHaveLength(5);
    expect(s.prompts[0]).toContain("anime art style");
    expect(s.ref_urls).toEqual(["https://r2/p.png", "https://r2/s1.png"]);
    expect(s.done).toEqual([]);
    expect(s.fallback_used).toBe(false);
  });

  it("refKey sanitizes ext + zero-pads the index", () => {
    expect(refKey(7, 1, "png")).toBe("cast-gen/7/ref_01.png");
    expect(refKey(7, 12, "JPG")).toBe("cast-gen/7/ref_12.jpg");
    expect(refKey(7, 3, "gif")).toBe("cast-gen/7/ref_03.png"); // unknown ext -> png
  });

  it("stateKey is per cast + job", () => {
    expect(stateKey(7, "abc")).toBe("cast-gen/7/abc.state.json");
  });

  it("encodePoll/decodePoll round-trip the stable pointer (state lives in R2, not the token)", () => {
    const t = { cast_id: 7, job_id: "abc-123" };
    expect(decodePoll(encodePoll(t))).toEqual(t);
    expect(decodePoll("not-a-valid-token")).toBeNull();
  });

  it("isFlaggedError catches safety flags, not real errors", () => {
    expect(isFlaggedError("error 3030: has been flagged")).toBe(true);
    expect(isFlaggedError("please choose another prompt")).toBe(true);
    expect(isFlaggedError("connection reset")).toBe(false);
    expect(FLAG_FALLBACK_MODEL).toBe("google/nano-banana-pro");
  });

  it("readOutput maps state -> hook output + applied tags", () => {
    const s = buildState({ cast_id: 7, portrait_url: "u" }, "@cf/black-forest-labs/flux-2-klein-9b", 4);
    s.done = [
      { key: "cast-gen/7/ref_01.png", mime: "image/png" },
      { key: "cast-gen/7/ref_02.png", mime: "image/png" },
    ];
    const out = readOutput(s);
    expect(out.cast_id).toBe(7);
    expect(out.images).toHaveLength(2);
    expect(out.applied).toContain("generated:2");
    expect(out.applied[0]).toContain("model:@cf/black-forest-labs/flux-2-klein-9b");
  });
});
