import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { deleteCastArtifacts } from "../src/cast-media";
import type { Env } from "../src/env";
import type { CastMember } from "../src/cast-db";

// Issue #298: DELETE /api/cast/:id used to drop the D1 row but leak every R2 artifact (portrait,
// the ref set / LoRA training images, the raw source uploads, and the trained lora_key) -- a cost
// trap for cost-watching operators. These tests pin that the delete now reclaims all of them, and
// that the cleanup is best-effort (an already-absent or transient-failing key never aborts the rest).

const ref = (key: string): { key: string; mime: string } => ({ key, mime: "image/png" });

const castFixture = (over: Partial<CastMember> = {}): CastMember => ({
  id: 9,
  public_id: "6b1f0a3c-9d2e-4a7b-8c1d-2e3f4a5b6c7d",
  slug: "wren-matrix-test-2",
  name: "Wren",
  bible: null,
  portrait_key: "cast/9/portrait.png",
  portrait_mime: "image/png",
  ref_keys: [ref("cast/9/refs/r1.png"), ref("cast/9/refs/r2.png")],
  source_keys: [ref("cast/9/sources/s1.png")],
  created_at: "t",
  updated_at: "t",
  lora_key: "loras/lora-wren-matrix-test-2-1782009575/lora.safetensors",
  lora_status: "ready",
  lora_job_id: null,
  lora_error: null,
  lora_trained_at: "t",
  voice_id: null,
  ...over,
});

function fakeR2(opts: { failOn?: string } = {}) {
  const deleted: string[] = [];
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    R2_RENDERS: {
      async delete(key: string) {
        if (opts.failOn && key === opts.failOn) throw new Error("transient R2 error");
        deleted.push(key);
      },
    },
  } as unknown as Env;
  return { env, deleted };
}

describe("deleteCastArtifacts (issue #298)", () => {
  it("deletes portrait + every ref + every source + lora_key", async () => {
    const { env, deleted } = fakeR2();
    await deleteCastArtifacts(env, castFixture());
    expect(deleted).toEqual([
      "cast/9/portrait.png",
      "cast/9/refs/r1.png",
      "cast/9/refs/r2.png",
      "cast/9/sources/s1.png",
      "loras/lora-wren-matrix-test-2-1782009575/lora.safetensors",
    ]);
  });

  it("skips null/empty keys (a cast with no portrait or untrained lora)", async () => {
    const { env, deleted } = fakeR2();
    await deleteCastArtifacts(env, castFixture({ portrait_key: null, lora_key: null, source_keys: [] }));
    expect(deleted).toEqual(["cast/9/refs/r1.png", "cast/9/refs/r2.png"]);
  });

  it("is best-effort: a failing delete does not abort the remaining keys", async () => {
    const { env, deleted } = fakeR2({ failOn: "cast/9/refs/r1.png" });
    await deleteCastArtifacts(env, castFixture());
    // r1 threw and was swallowed; everything else still got deleted.
    expect(deleted).toEqual([
      "cast/9/portrait.png",
      "cast/9/refs/r2.png",
      "cast/9/sources/s1.png",
      "loras/lora-wren-matrix-test-2-1782009575/lora.safetensors",
    ]);
  });
});

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("DELETE /api/cast/:id reclaims R2 (issue #298)", () => {
  it("issues R2 deletes for the deleted row's artifacts, then 200s", async () => {
    // getCastById -> rowToCast parses the *_json columns, so the fake returns the RAW row shape.
    const rawRow = {
      id: 9, public_id: "6b1f0a3c-9d2e-4a7b-8c1d-2e3f4a5b6c7d", slug: "wren-matrix-test-2", name: "Wren", bible: null,
      portrait_key: "cast/9/portrait.png", portrait_mime: "image/png",
      ref_keys_json: JSON.stringify([ref("cast/9/refs/r1.png"), ref("cast/9/refs/r2.png")]),
      source_keys_json: JSON.stringify([ref("cast/9/sources/s1.png")]),
      created_at: "t", updated_at: "t",
      lora_key: "loras/lora-wren-matrix-test-2-1782009575/lora.safetensors",
      lora_status: "ready", lora_job_id: null, lora_error: null, lora_trained_at: "t",
      voice_id: null,
    };
    const deleted: string[] = [];
    const env = {
    ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
      DB: {
        prepare(sql: string) {
          const stmt = {
            bind() { return stmt; },
            async first() {
              // getCastById (inside deleteCast) returns the row; the DELETE returns nothing.
              return /^\s*DELETE/.test(sql) ? null : (rawRow as unknown);
            },
            async run() { return { meta: { changes: 1 } }; },
          };
          return stmt;
        },
      },
      R2_RENDERS: {
        async delete(key: string) { deleted.push(key); },
      },
    } as unknown as Env;

    const res = await worker.fetch(
      new Request("https://studio.example/api/cast/6b1f0a3c-9d2e-4a7b-8c1d-2e3f4a5b6c7d", { method: "DELETE" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: "6b1f0a3c-9d2e-4a7b-8c1d-2e3f4a5b6c7d" });
    expect(deleted).toEqual([
      "cast/9/portrait.png",
      "cast/9/refs/r1.png",
      "cast/9/refs/r2.png",
      "cast/9/sources/s1.png",
      "loras/lora-wren-matrix-test-2-1782009575/lora.safetensors",
    ]);
  });
});
