import { describe, expect, it } from "vitest";
import { buildProxiedImageParams } from "../src/proxied-image-params";

describe("buildProxiedImageParams", () => {
  it("builds google params", () => {
    expect(buildProxiedImageParams("google", "a coin")).toEqual({
      prompt: "a coin",
      output_format: "png",
    });
  });

  it("builds openai params", () => {
    expect(buildProxiedImageParams("openai", "a coin sprite")).toEqual({
      prompt: "a coin sprite",
      quality: "high",
      size: "1024x1024",
    });
  });

  it("builds recraft params", () => {
    expect(buildProxiedImageParams("recraft", "a logo")).toEqual({
      prompt: "a logo",
      size: "1024x1024",
      style: "digital_illustration",
    });
  });

  it("defaults to prompt-only", () => {
    expect(buildProxiedImageParams(undefined, "x")).toEqual({ prompt: "x" });
  });
});
