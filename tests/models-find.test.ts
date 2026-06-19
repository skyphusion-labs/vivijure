import { describe, expect, it } from "vitest";
import { findModel } from "../src/models";

describe("findModel", () => {
  it("finds image models used by the cast page", () => {
    expect(findModel("@cf/black-forest-labs/flux-2-klein-9b")?.type).toBe("image");
    expect(findModel("google/nano-banana-pro")?.type).toBe("image");
  });

  it("finds planning chat models", () => {
    expect(findModel("anthropic/claude-sonnet-4-6")?.type).toBe("chat");
  });

  it("returns undefined for unknown ids", () => {
    expect(findModel("not-a-real/model")).toBeUndefined();
  });
});
