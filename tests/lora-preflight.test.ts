import { describe, expect, it } from "vitest";

import {
  isCastLoraReady,
  unreadyBoundLoraSlots,
  loraSlotSignature,
  type CastMember,
} from "../public/lora-preflight.js";

// S9 (F13): a cast id is an opaque public id (UUID v4 string), never a number.
// These fixtures use stable UUID-shaped ids so the helpers are exercised on the
// real wire shape (verbatim string compare, no Number() coercion).
const ADA = "11111111-1111-4111-8111-111111111111";
const WREN = "22222222-2222-4222-8222-222222222222";
const KIT = "33333333-3333-4333-8333-333333333333";
const GONE = "99999999-9999-4999-8999-999999999999";

// The catalog mirrors /api/cast rows: id, name, lora_status, lora_key.
const ready = (id: string, name: string): CastMember => ({
  id, name, lora_status: "ready", lora_key: "loras/" + name + ".safetensors",
});
const idle = (id: string, name: string): CastMember => ({ id, name, lora_status: "idle" });
const training = (id: string, name: string): CastMember => ({ id, name, lora_status: "training" });

const slots = (unready: ReturnType<typeof unreadyBoundLoraSlots>) => unready.map((u) => u.slot);
const names = (unready: ReturnType<typeof unreadyBoundLoraSlots>) => unready.map((u) => u.name);

describe("isCastLoraReady (mirrors the server reuse gate)", () => {
  it("is true only for ready status with a loras/ key", () => {
    expect(isCastLoraReady(ready(ADA, "wren"))).toBe(true);
  });
  it("is false when status is ready but the key is missing", () => {
    expect(isCastLoraReady({ id: ADA, name: "wren", lora_status: "ready" })).toBe(false);
  });
  it("is false for non-ready statuses", () => {
    expect(isCastLoraReady(idle(ADA, "wren"))).toBe(false);
    expect(isCastLoraReady(training(ADA, "wren"))).toBe(false);
  });
  it("is false for null / undefined", () => {
    expect(isCastLoraReady(null)).toBe(false);
    expect(isCastLoraReady(undefined)).toBe(false);
  });
});

describe("unreadyBoundLoraSlots (which bound slots will be retrained inline)", () => {
  it("flags a bound character whose LoRA is not ready", () => {
    const catalog = [ready(ADA, "ada"), idle(WREN, "wren")];
    const out = unreadyBoundLoraSlots({ A: ADA, B: WREN }, catalog);
    expect(slots(out)).toEqual(["B"]);
    expect(names(out)).toEqual(["wren"]);
    expect(out[0].castId).toBe(WREN);
  });

  it("returns nothing when every bound character is ready (the happy path)", () => {
    const catalog = [ready(ADA, "ada"), ready(WREN, "wren")];
    expect(unreadyBoundLoraSlots({ A: ADA, B: WREN }, catalog)).toEqual([]);
  });

  it("ignores unbound-but-unready catalog members", () => {
    const catalog = [ready(ADA, "ada"), idle(WREN, "wren")];
    // wren (unready) is in the catalog but NOT bound to a slot.
    expect(unreadyBoundLoraSlots({ A: ADA }, catalog)).toEqual([]);
  });

  it("skips bindings whose cast id is no longer in the catalog", () => {
    const catalog = [ready(ADA, "ada")];
    expect(unreadyBoundLoraSlots({ A: ADA, B: GONE }, catalog)).toEqual([]);
  });

  it("skips empty-string binding ids (never coerces)", () => {
    const catalog = [idle(WREN, "wren")];
    expect(unreadyBoundLoraSlots({ A: "", C: WREN }, catalog)).toEqual([
      { slot: "C", castId: WREN, name: "wren" },
    ]);
  });

  it("sorts by slot for a stable warning order", () => {
    const catalog = [idle(ADA, "ada"), training(WREN, "wren"), idle(KIT, "kit")];
    const out = unreadyBoundLoraSlots({ C: KIT, A: ADA, B: WREN }, catalog);
    expect(slots(out)).toEqual(["A", "B", "C"]);
  });

  it("tolerates empty / nullish inputs", () => {
    expect(unreadyBoundLoraSlots({}, [])).toEqual([]);
    expect(unreadyBoundLoraSlots(null, null)).toEqual([]);
  });
});

describe("loraSlotSignature (acknowledge the same warning, not a changed one)", () => {
  it("is order-independent over the slot set", () => {
    const catalog = [idle(ADA, "ada"), idle(WREN, "wren")];
    const a = unreadyBoundLoraSlots({ A: ADA, B: WREN }, catalog);
    const b = unreadyBoundLoraSlots({ B: WREN, A: ADA }, catalog);
    expect(loraSlotSignature(a)).toBe(loraSlotSignature(b));
  });

  it("changes when the unready set changes", () => {
    const catalog = [idle(ADA, "ada"), idle(WREN, "wren"), ready(KIT, "kit")];
    const before = unreadyBoundLoraSlots({ A: ADA, B: WREN }, catalog);
    const after = unreadyBoundLoraSlots({ A: ADA, B: WREN, C: KIT }, catalog); // kit is ready
    expect(loraSlotSignature(before)).toBe(loraSlotSignature(after)); // kit adds nothing
    const grew = unreadyBoundLoraSlots({ A: ADA }, catalog);
    expect(loraSlotSignature(grew)).not.toBe(loraSlotSignature(before));
  });
});
