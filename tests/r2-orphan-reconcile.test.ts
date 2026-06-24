import { describe, expect, it } from "vitest";

import {
  buildOwnerIndex,
  classifyKey,
  reconcile,
  loraDirOf,
  type CastRowLite,
} from "../src/r2-orphan-reconcile";

// #309: sweep the pre-#298 backlog of cast-delete-orphaned R2 artifacts SAFELY.
// The cardinal rule under test is verify-by-id: a LoRA whose dir merely shares a
// slug with a deleted cast must NOT be deleted if a LIVE cast (by id) still owns
// it. This is the loras/lora-wren-1782248711/ near-miss from the #298 GC.

const refs = (id: number, prefix: string) =>
  JSON.stringify(Array.from({ length: 2 }, (_, i) => ({ key: `${prefix}/${id}/ref_0${i + 1}.jpg`, mime: "image/jpeg" })));

// Mirrors the live D1 snapshot: cast id 4 ("wren") owns lora-wren-1782248711.
const castRows: CastRowLite[] = [
  { id: 4, portrait_key: "uploads/wren.jpg", lora_key: "loras/lora-wren-1782248711/A/pytorch_lora_weights.safetensors", ref_keys_json: refs(4, "cast-gen") },
  { id: 13, portrait_key: "cast/13/portrait.jpg", lora_key: null, ref_keys_json: refs(13, "cast-gen") },
];

const idx = buildOwnerIndex({
  castRows,
  // fur_and_circuits = a film LoRA a render references (non-cast-scheme).
  // lora-ghost-1780000000 = a cast-scheme LoRA a render still references even
  // though no live cast owns it (a deleted cast's LoRA used by an old render).
  renderLoraDirs: ["fur_and_circuits", "lora-ghost-1780000000"],
  seedPrefixes: ["loras/wren_talks_test_2/"],
});

const obj = (key: string, size = 100) => ({ key, size });
const decide = (key: string) => classifyKey(obj(key), idx).decision;

describe("loraDirOf", () => {
  it("extracts the dir segment under loras/", () => {
    expect(loraDirOf("loras/lora-wren-1782248711/A/x.safetensors")).toBe("lora-wren-1782248711");
    expect(loraDirOf("cast/9/portrait.jpg")).toBeNull();
  });
});

describe("verify-by-id: the #298 lora-wren near-miss is NEVER an orphan", () => {
  it("keeps a LoRA owned by a live cast even though its slug matches a wiped one", () => {
    const c = classifyKey(obj("loras/lora-wren-1782248711/A/pytorch_lora_weights.safetensors"), idx);
    expect(c.decision).toBe("keep");
  });
  it("keeps the live cast's referenced portrait + refs directly", () => {
    expect(decide("uploads/wren.jpg")).toBe("keep");
    expect(decide("cast-gen/4/ref_01.jpg")).toBe("keep");
    expect(decide("cast/13/portrait.jpg")).toBe("keep");
  });
});

describe("id-based cast trees (cast/ + cast-gen/)", () => {
  it("orphans a dead cast id tree", () => {
    expect(decide("cast/3/portrait.jpg")).toBe("orphan");
    expect(decide("cast-gen/9/ref_01.jpg")).toBe("orphan");
  });
  it("keeps a live cast id tree even when the specific key is not directly referenced", () => {
    // cast/4/ exists from before a portrait regen; id 4 is live -> never touch it.
    expect(decide("cast/4/portrait-old.jpg")).toBe("keep");
    expect(decide("cast-gen/13/ref_99.jpg")).toBe("keep");
  });
});

describe("cast-scheme LoRA dirs", () => {
  it("orphans a cast-<id> LoRA for a dead id but keeps a live one", () => {
    expect(decide("loras/cast-9/A/pytorch_lora_weights.safetensors")).toBe("orphan");
    expect(decide("loras/cast-4/A/pytorch_lora_weights.safetensors")).toBe("keep");
  });
  it("orphans a slug-ts LoRA with no live cast or render reference", () => {
    expect(decide("loras/lora-aria-1780941077/A/pytorch_lora_weights.safetensors")).toBe("orphan");
  });
  it("keeps a cast-scheme slug-ts LoRA a render still references (deleted cast, live render)", () => {
    expect(decide("loras/lora-ghost-1780000000/A/pytorch_lora_weights.safetensors")).toBe("keep");
  });
});

describe("out-of-scope: non-cast artifacts are NEVER deleted", () => {
  it("leaves arbitrary-named LoRA dirs (films, load tests, smokes) alone", () => {
    expect(decide("loras/loadtest-00/A/pytorch_lora_weights.safetensors")).toBe("out-of-scope");
    expect(decide("loras/neon-smoke-v015/A/pytorch_lora_weights.safetensors")).toBe("out-of-scope");
    expect(decide("loras/EMBER/A/pytorch_lora_weights.safetensors")).toBe("out-of-scope");
  });
  it("leaves a non-cast-scheme LoRA out-of-scope even if a render references it (safe; never deleted)", () => {
    expect(decide("loras/fur_and_circuits/A/pytorch_lora_weights.safetensors")).toBe("out-of-scope");
  });
  it("leaves unrecognized prefixes alone", () => {
    expect(decide("renders/fur_and_circuits/full.mp4")).toBe("out-of-scope");
    expect(decide("bundles/x.tar.gz")).toBe("out-of-scope");
  });
});

describe("explicit operator seed", () => {
  it("orphans the authorized seed prefix (not cast-scheme, so only via seed)", () => {
    expect(decide("loras/wren_talks_test_2/A/pytorch_lora_weights.safetensors")).toBe("orphan");
  });
  it("a sibling lipsync test LoRA is left out-of-scope (not seeded)", () => {
    expect(decide("loras/talking_lipsync/A/pytorch_lora_weights.safetensors")).toBe("out-of-scope");
  });
});

describe("reconcile() aggregates", () => {
  it("groups, counts, and sums orphan bytes", () => {
    const r = reconcile(
      [
        obj("cast/3/portrait.jpg", 500),
        obj("loras/cast-9/A/pytorch_lora_weights.safetensors", 1000),
        obj("loras/lora-wren-1782248711/A/pytorch_lora_weights.safetensors", 9999), // live -> keep
        obj("loras/loadtest-00/A/pytorch_lora_weights.safetensors", 7), // out-of-scope
      ],
      idx,
    );
    expect(r.orphanCount).toBe(2);
    expect(r.orphanBytes).toBe(1500);
    expect(r.kept).toHaveLength(1);
    expect(r.outOfScope).toHaveLength(1);
  });
});
