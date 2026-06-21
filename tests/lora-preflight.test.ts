import { describe, expect, it } from "vitest";

import {
  isCastLoraReady,
  unreadyBoundLoraSlots,
  loraSlotSignature,
  type CastMember,
} from "../public/lora-preflight.js";

// The catalog mirrors /api/cast rows: id, name, lora_status, lora_key.
const ready = (id: number, name: string): CastMember => ({
  id, name, lora_status: "ready", lora_key: "loras/" + name + ".safetensors",
});
const idle = (id: number, name: string): CastMember => ({ id, name, lora_status: "idle" });
const training = (id: number, name: string): CastMember => ({ id, name, lora_status: "training" });

const slots = (unready: ReturnType<typeof unreadyBoundLoraSlots>) => unready.map((u) => u.slot);
const names = (unready: ReturnType<typeof unreadyBoundLoraSlots>) => unready.map((u) => u.name);

describe("isCastLoraReady (mirrors the server reuse gate)", () => {
  it("is true only for ready status with a loras/ key", () => {
    expect(isCastLoraReady(ready(1, "wren"))).toBe(true);
  });
  it("is false when status is ready but the key is missing", () => {
    expect(isCastLoraReady({ id: 1, name: "wren", lora_status: "ready" })).toBe(false);
  });
  it("is false for non-ready statuses", () => {
    expect(isCastLoraReady(idle(1, "wren"))).toBe(false);
    expect(isCastLoraReady(training(1, "wren"))).toBe(false);
  });
  it("is false for null / undefined", () => {
    expect(isCastLoraReady(null)).toBe(false);
    expect(isCastLoraReady(undefined)).toBe(false);
  });
});

describe("unreadyBoundLoraSlots (which bound slots will be retrained inline)", () => {
  it("flags a bound character whose LoRA is not ready", () => {
    const catalog = [ready(1, "ada"), idle(2, "wren")];
    const out = unreadyBoundLoraSlots({ A: 1, B: 2 }, catalog);
    expect(slots(out)).toEqual(["B"]);
    expect(names(out)).toEqual(["wren"]);
    expect(out[0].castId).toBe(2);
  });

  it("returns nothing when every bound character is ready (the happy path)", () => {
    const catalog = [ready(1, "ada"), ready(2, "wren")];
    expect(unreadyBoundLoraSlots({ A: 1, B: 2 }, catalog)).toEqual([]);
  });

  it("ignores unbound-but-unready catalog members", () => {
    const catalog = [ready(1, "ada"), idle(2, "wren")];
    // wren (unready) is in the catalog but NOT bound to a slot.
    expect(unreadyBoundLoraSlots({ A: 1 }, catalog)).toEqual([]);
  });

  it("skips bindings whose cast id is no longer in the catalog", () => {
    const catalog = [ready(1, "ada")];
    expect(unreadyBoundLoraSlots({ A: 1, B: 99 }, catalog)).toEqual([]);
  });

  it("skips invalid binding ids", () => {
    const catalog = [idle(2, "wren")];
    expect(unreadyBoundLoraSlots({ A: 0, B: -1, C: 2 }, catalog)).toEqual([
      { slot: "C", castId: 2, name: "wren" },
    ]);
  });

  it("sorts by slot for a stable warning order", () => {
    const catalog = [idle(1, "ada"), training(2, "wren"), idle(3, "kit")];
    const out = unreadyBoundLoraSlots({ C: 3, A: 1, B: 2 }, catalog);
    expect(slots(out)).toEqual(["A", "B", "C"]);
  });

  it("tolerates empty / nullish inputs", () => {
    expect(unreadyBoundLoraSlots({}, [])).toEqual([]);
    expect(unreadyBoundLoraSlots(null, null)).toEqual([]);
  });
});

describe("loraSlotSignature (acknowledge the same warning, not a changed one)", () => {
  it("is order-independent over the slot set", () => {
    const catalog = [idle(1, "ada"), idle(2, "wren")];
    const a = unreadyBoundLoraSlots({ A: 1, B: 2 }, catalog);
    const b = unreadyBoundLoraSlots({ B: 2, A: 1 }, catalog);
    expect(loraSlotSignature(a)).toBe(loraSlotSignature(b));
  });

  it("changes when the unready set changes", () => {
    const catalog = [idle(1, "ada"), idle(2, "wren"), ready(3, "kit")];
    const before = unreadyBoundLoraSlots({ A: 1, B: 2 }, catalog);
    const after = unreadyBoundLoraSlots({ A: 1, B: 2, C: 3 }, catalog); // kit is ready
    expect(loraSlotSignature(before)).toBe(loraSlotSignature(after)); // kit adds nothing
    const grew = unreadyBoundLoraSlots({ A: 1 }, catalog);
    expect(loraSlotSignature(grew)).not.toBe(loraSlotSignature(before));
  });
});
