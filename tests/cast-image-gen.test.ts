import { describe, it, expect } from "vitest";
import {
  isFlux2,
  base64ToBytes,
  bytesToBase64,
  extractProxiedImageUrl,
  proxiedParams,
  REF_MAX_DIM,
} from "../modules/cast-image/src/image-gen";

describe("cast-image image-gen helpers (ported from the playground)", () => {
  it("isFlux2 picks the @cf FLUX-2 family (the multipart-multiref path)", () => {
    expect(isFlux2("@cf/black-forest-labs/flux-2-klein-9b")).toBe(true);
    expect(isFlux2("@cf/black-forest-labs/flux-2-dev")).toBe(true);
    expect(isFlux2("google/nano-banana-pro")).toBe(false);
    expect(isFlux2("@cf/black-forest-labs/flux-1-schnell")).toBe(false);
  });

  it("base64ToBytes round-trips bytes (FLUX-2's { image: base64 } result)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(Array.from(base64ToBytes(btoa(bin)))).toEqual([0, 1, 2, 250, 255]);
  });

  it("extractProxiedImageUrl reads the wrapped + bare shapes (nano-banana URL result)", () => {
    expect(extractProxiedImageUrl({ state: "Completed", result: { image: "https://cdn/x.png" } })).toBe("https://cdn/x.png");
    expect(extractProxiedImageUrl({ image: "https://cdn/y.png" })).toBe("https://cdn/y.png");
    expect(extractProxiedImageUrl({ result: {} })).toBeNull();
    expect(extractProxiedImageUrl("nope")).toBeNull();
    expect(extractProxiedImageUrl(null)).toBeNull();
  });

  it("proxiedParams is provider-keyed + prompt-only with no refs (ported from buildProxiedImageParams)", () => {
    expect(proxiedParams("google/nano-banana-pro", "p")).toEqual({ prompt: "p", output_format: "png" });
    expect(proxiedParams("openai/gpt-image-1.5", "p")).toEqual({ prompt: "p", quality: "high", size: "1024x1024" });
    expect(proxiedParams("recraft/recraftv4", "p")).toEqual({ prompt: "p", size: "1024x1024", style: "digital_illustration" });
    expect(proxiedParams("something/else", "p")).toEqual({ prompt: "p" });
  });

  it("proxiedParams wires reference images into image_input[] for google, capped at 3", () => {
    const refs = ["data:image/png;base64,a", "data:image/png;base64,b", "data:image/png;base64,c", "data:image/png;base64,d"];
    expect(proxiedParams("google/nano-banana-pro", "p", refs)).toEqual({
      prompt: "p",
      output_format: "png",
      image_input: refs.slice(0, 3), // nano-banana image_input maxItems: 3
    });
  });

  it("proxiedParams uses images[] for openai (cap 16) and ignores refs for providers without ref input", () => {
    expect(proxiedParams("openai/gpt-image-1.5", "p", ["data:image/png;base64,a"])).toEqual({
      prompt: "p", quality: "high", size: "1024x1024", images: ["data:image/png;base64,a"],
    });
    // recraft has no documented ref input -> refs dropped
    expect(proxiedParams("recraft/recraftv4", "p", ["data:image/png;base64,a"])).toEqual({
      prompt: "p", size: "1024x1024", style: "digital_illustration",
    });
  });

  it("bytesToBase64 round-trips with base64ToBytes (the image_input data-URI payload)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([0, 1, 2, 250, 255, 128, 64]);
  });

  it("REF_MAX_DIM is FLUX-2's 512px input cap", () => {
    expect(REF_MAX_DIM).toBe(512);
  });
});
