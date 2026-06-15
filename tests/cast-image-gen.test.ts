import { describe, it, expect } from "vitest";
import {
  isFlux2,
  base64ToBytes,
  extractProxiedImageUrl,
  proxiedParams,
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

  it("proxiedParams is provider-keyed + prompt-only (ported from buildProxiedImageParams)", () => {
    expect(proxiedParams("google/nano-banana-pro", "p")).toEqual({ prompt: "p", output_format: "png" });
    expect(proxiedParams("openai/gpt-image-1.5", "p")).toEqual({ prompt: "p", quality: "high", size: "1024x1024" });
    expect(proxiedParams("recraft/recraftv4", "p")).toEqual({ prompt: "p", size: "1024x1024", style: "digital_illustration" });
    expect(proxiedParams("something/else", "p")).toEqual({ prompt: "p" });
  });
});
