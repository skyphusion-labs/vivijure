import { describe, it, expect } from "vitest";

import { resolveCastLoras, untrainedCastMessage, type SkippedCast } from "../src/cast-loras";
import type { Env } from "../src/env";

// resolveCastLoras is the gate the render path FAILS HARD on: any bound character whose cast LoRA is
// not ready lands in `skipped` (and `skippedDetail`), and hSubmitRender rejects rather than letting
// the GPU silently inline-retrain. These tests pin that resolution + the per-character message.
//
// S9 (F13): castLoras values are OPAQUE cast public ids (UUID v4), not sequential ints. A bare
// integer is an enumeration PROBE and must land in "not a valid cast id" with NO row data attached,
// so the untrained-cast error message can never become a name-harvesting oracle.

type FakeRow = {
  id: number; public_id: string; name: string;
  lora_key: string | null; lora_status: string | null; voice_id: string | null;
};

// Minimal fake D1 that answers BOTH boundary queries from an in-memory table:
//   - the resolver `SELECT id FROM cast_members WHERE public_id = ?` (opaque id -> internal int), and
//   - getCastById's `SELECT ... FROM cast_members WHERE id = ?` (internal int -> full row).
// An id / public_id with no row resolves to null. No row is ever `training`, so refreshTrainingLora is
// not hit.
function fakeEnv(rows: FakeRow[]): Env {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byPublic = new Map(rows.map((r) => [r.public_id, r]));
  return {
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first<T>(): Promise<T | null> {
            if (/WHERE public_id = \?/.test(sql)) {
              const r = byPublic.get(bound[0] as string);
              return r ? ({ id: r.id } as unknown as T) : null;
            }
            const r = byId.get(bound[0] as number);
            if (!r) return null;
            return {
              id: r.id, public_id: r.public_id, slug: "c" + r.id, name: r.name, bible: null,
              portrait_key: null, portrait_mime: null, ref_keys_json: null, source_keys_json: null,
              created_at: "t", updated_at: "t",
              lora_key: r.lora_key, lora_status: r.lora_status, lora_job_id: null, lora_error: null,
              lora_trained_at: null, voice_id: r.voice_id,
            } as unknown as T;
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
}

const PUB_READY = "aaaa1111-0000-4000-8000-000000000001";
const PUB_NOT_READY = "aaaa2222-0000-4000-8000-000000000002";
const PUB_UNKNOWN = "ffff9999-0000-4000-8000-000000000099"; // well-formed, no row
const READY: FakeRow = { id: 1, public_id: PUB_READY, name: "Jane", lora_key: "loras/jane.safetensors", lora_status: "ready", voice_id: null };
const NOT_READY: FakeRow = { id: 2, public_id: PUB_NOT_READY, name: "Bob", lora_key: null, lora_status: "failed", voice_id: null };

describe("resolveCastLoras gate (fail-hard inputs)", () => {
  it("resolves a ready cast LoRA (by opaque id) to a pretrained key with nothing skipped", async () => {
    const env = fakeEnv([READY]);
    const r = await resolveCastLoras(env, { A: PUB_READY });
    expect(r.pretrained).toEqual({ A: "loras/jane.safetensors" });
    // castIds stays the INTERNAL int (the LoRA bank-back keys off it) -- never leaves the core.
    expect(r.castIds).toEqual({ A: 1 });
    expect(r.skipped).toEqual([]);
    expect(r.skippedDetail).toEqual([]);
  });

  it("skips a bound-but-untrained character, naming it with a reason", async () => {
    const env = fakeEnv([READY, NOT_READY]);
    const r = await resolveCastLoras(env, { A: PUB_READY, B: PUB_NOT_READY });
    expect(r.pretrained).toEqual({ A: "loras/jane.safetensors" });
    expect(r.skipped).toEqual(["B"]);
    expect(r.skippedDetail).toEqual<SkippedCast[]>([
      { slot: "B", name: "Bob", reason: "no trained LoRA" },
    ]);
  });

  it("an INTEGER probe is rejected as 'not a valid cast id' with NO row data (no enumeration oracle)", async () => {
    const env = fakeEnv([READY, NOT_READY]);
    // Ints and non-UUID junk both fail the opaque-id shape gate BEFORE any lookup, so a caller cannot
    // count 1,2,3 and harvest names/LoRA status from the skip reasons.
    const r = await resolveCastLoras(env, { A: 1, B: 2, C: 0, D: "nope", E: "99" } as unknown as Record<string, unknown>);
    expect(r.pretrained).toEqual({});
    expect(r.castIds).toEqual({});
    expect(r.skippedDetail).toEqual<SkippedCast[]>([
      { slot: "A", reason: "not a valid cast id" },
      { slot: "B", reason: "not a valid cast id" },
      { slot: "C", reason: "not a valid cast id" },
      { slot: "D", reason: "not a valid cast id" },
      { slot: "E", reason: "not a valid cast id" },
    ]);
  });

  it("a well-formed opaque id with no row is 'cast member not found' (also nameless)", async () => {
    const env = fakeEnv([READY]);
    const r = await resolveCastLoras(env, { A: PUB_READY, B: PUB_UNKNOWN });
    expect(r.pretrained).toEqual({ A: "loras/jane.safetensors" });
    expect(r.skipped).toEqual(["B"]);
    expect(r.skippedDetail).toEqual<SkippedCast[]>([
      { slot: "B", reason: "cast member not found" },
    ]);
  });

  it("does not gate a render with no cast bindings (no characters needing a LoRA)", async () => {
    const env = fakeEnv([]);
    for (const castLoras of [undefined, {}]) {
      const r = await resolveCastLoras(env, castLoras);
      expect(r.skipped).toEqual([]);
      expect(r.skippedDetail).toEqual([]);
      expect(r.pretrained).toEqual({});
    }
  });
});

describe("untrainedCastMessage", () => {
  it("names each untrained character and points to the Cast page", () => {
    const msg = untrainedCastMessage([
      { slot: "A", name: "Bob", reason: "no trained LoRA" },
      { slot: "B", name: "Mae", reason: "LoRA still training" },
    ]);
    expect(msg).toBe(
      "These characters have no trained LoRA -- train them on the Cast page first: Bob, Mae (still training).",
    );
  });

  it("falls back to the slot id when the cast row did not resolve", () => {
    const msg = untrainedCastMessage([{ slot: "C", reason: "cast member not found" }]);
    expect(msg).toContain("slot C");
  });
});
