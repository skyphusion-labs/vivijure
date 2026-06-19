import { describe, expect, it } from "vitest";
import { deriveLoraDestKey, extractTrainedLoraKey } from "../src/lora-bundle";

describe("deriveLoraDestKey", () => {
  it("builds the per-cast timestamped key", () => {
    expect(deriveLoraDestKey(7, 1780000000)).toBe("loras/cast-7/1780000000.safetensors");
  });
});

describe("extractTrainedLoraKey", () => {
  it("reads the clean-room nested shape (output.lora[slot].lora_id)", () => {
    const out = { project: "p", lora: { A: { lora_id: "loras/cast-7/123.safetensors" } } };
    expect(extractTrainedLoraKey(out)).toBe("loras/cast-7/123.safetensors");
  });

  it("still reads the legacy top-level lora_key shape", () => {
    expect(extractTrainedLoraKey({ lora_key: "loras/x/old.safetensors" })).toBe("loras/x/old.safetensors");
  });

  it("takes the first usable nested entry (single-slot cast bundle, but robust to more)", () => {
    const out = { lora: { A: { lora_id: "loras/a.safetensors" }, B: { lora_id: "loras/b.safetensors" } } };
    expect(extractTrainedLoraKey(out)).toBe("loras/a.safetensors");
  });

  it("returns null when neither shape carries a key", () => {
    expect(extractTrainedLoraKey({ project: "p" })).toBeNull();
    expect(extractTrainedLoraKey({ lora: {} })).toBeNull();
    expect(extractTrainedLoraKey({ lora: { A: {} } })).toBeNull();
    expect(extractTrainedLoraKey({ lora_key: "" })).toBeNull();
    expect(extractTrainedLoraKey(null)).toBeNull();
    expect(extractTrainedLoraKey("nope")).toBeNull();
  });
});
