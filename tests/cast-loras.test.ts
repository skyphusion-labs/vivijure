import { describe, it, expect } from "vitest";

import { resolveCastLoras, untrainedCastMessage, type SkippedCast } from "../src/cast-loras";
import type { Env } from "../src/env";

// resolveCastLoras is the gate the render path FAILS HARD on: any bound character whose cast LoRA is
// not ready lands in `skipped` (and `skippedDetail`), and hSubmitRender rejects rather than letting
// the GPU silently inline-retrain. These tests pin that resolution + the per-character message.

type FakeRow = {
  id: number; name: string;
  lora_key: string | null; lora_status: string | null; voice_id: string | null;
};

// Minimal fake D1 that answers getCastById's `SELECT ... FROM cast_members WHERE id = ?` from an
// in-memory table, keyed on id. An id with no row resolves to null (a deleted cast member). No row is
// ever `training`, so refreshTrainingLora is not hit.
function fakeEnv(rows: FakeRow[]): Env {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    DB: {
      prepare(_sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first<T>(): Promise<T | null> {
            const id = bound[0] as number;
            const r = byId.get(id);
            if (!r) return null;
            return {
              id: r.id, user_email: "u@e.com", slug: "c" + r.id, name: r.name, bible: null,
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

const READY = { id: 1, name: "Jane", lora_key: "loras/jane.safetensors", lora_status: "ready", voice_id: null };
const NOT_READY = { id: 2, name: "Bob", lora_key: null, lora_status: "failed", voice_id: null };

describe("resolveCastLoras gate (fail-hard inputs)", () => {
  it("resolves a ready cast LoRA to a pretrained key with nothing skipped", async () => {
    const env = fakeEnv([READY]);
    const r = await resolveCastLoras(env, { A: 1 });
    expect(r.pretrained).toEqual({ A: "loras/jane.safetensors" });
    expect(r.castIds).toEqual({ A: 1 });
    expect(r.skipped).toEqual([]);
    expect(r.skippedDetail).toEqual([]);
  });

  it("skips a bound-but-untrained character, naming it with a reason", async () => {
    const env = fakeEnv([READY, NOT_READY]);
    const r = await resolveCastLoras(env, { A: 1, B: 2 });
    expect(r.pretrained).toEqual({ A: "loras/jane.safetensors" });
    expect(r.skipped).toEqual(["B"]);
    expect(r.skippedDetail).toEqual<SkippedCast[]>([
      { slot: "B", castId: 2, name: "Bob", reason: "no trained LoRA" },
    ]);
  });

  it("skips a missing cast row and a malformed id with distinct reasons", async () => {
    const env = fakeEnv([READY]);
    const r = await resolveCastLoras(env, { A: 1, B: 99, C: 0, D: "nope" });
    expect(r.pretrained).toEqual({ A: "loras/jane.safetensors" });
    expect(r.skipped).toEqual(["B", "C", "D"]);
    expect(r.skippedDetail).toEqual<SkippedCast[]>([
      { slot: "B", castId: 99, reason: "cast member not found" },
      { slot: "C", reason: "not a valid cast id" },
      { slot: "D", reason: "not a valid cast id" },
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
      { slot: "A", castId: 2, name: "Bob", reason: "no trained LoRA" },
      { slot: "B", castId: 3, name: "Mae", reason: "LoRA still training" },
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
