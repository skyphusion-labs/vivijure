import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { isPublicId, newPublicId } from "../src/public-id";
import { getCastIdByPublicId } from "../src/cast-db";
import { getProjectIdByPublicId } from "../src/storyboard-projects-db";
import { getRenderIdByPublicId } from "../src/renders-db";
import type { Env } from "../src/env";

// S9 (F13): the externally-addressable resources (cast / projects / renders) expose an opaque
// UUID-v4 public id, never their sequential integer PK. These tests pin the two guarantees:
//   1. a bare integer :id (an enumeration probe) never resolves -- the route 404s;
//   2. the API returns the opaque public id as `id`, never the internal integer.

const KNOWN = "6b1f0a3c-9d2e-4a7b-8c1d-2e3f4a5b6c7d";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("isPublicId / newPublicId (the shape gate)", () => {
  it("rejects a bare sequential integer -- the enumeration probe", () => {
    expect(isPublicId("1")).toBe(false);
    expect(isPublicId("5")).toBe(false);
    expect(isPublicId("12345")).toBe(false);
    expect(isPublicId(5 as unknown)).toBe(false);
  });
  it("rejects empty / non-UUID / malformed strings", () => {
    expect(isPublicId("")).toBe(false);
    expect(isPublicId("not-a-uuid")).toBe(false);
    expect(isPublicId(undefined)).toBe(false);
    expect(isPublicId(null)).toBe(false);
    // wrong version nibble (must be 4) / wrong variant nibble (must be 8-b)
    expect(isPublicId("6b1f0a3c-9d2e-3a7b-8c1d-2e3f4a5b6c7d")).toBe(false);
    expect(isPublicId("6b1f0a3c-9d2e-4a7b-7c1d-2e3f4a5b6c7d")).toBe(false);
  });
  it("accepts a canonical UUID v4", () => {
    expect(isPublicId(KNOWN)).toBe(true);
  });
  it("newPublicId mints ids that pass the shape gate", () => {
    for (let i = 0; i < 50; i++) expect(isPublicId(newPublicId())).toBe(true);
  });
  it("newPublicId is unique across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newPublicId());
    expect(seen.size).toBe(200);
  });
});

// A fake D1 that resolves ONLY the known public id, and returns a full cast raw row by internal id.
// prepares[] records every SQL string so a test can assert the DB was never even queried for an
// integer probe (isPublicId short-circuits before the lookup).
function fakeEnv() {
  const prepares: string[] = [];
  const castRaw = {
    id: 1, public_id: KNOWN, slug: "hero", name: "Hero", bible: null,
    portrait_key: null, portrait_mime: null, ref_keys_json: "[]", source_keys_json: "[]",
    created_at: "t", updated_at: "t", lora_key: null, lora_status: "idle",
    lora_job_id: null, lora_error: null, lora_trained_at: null, voice_id: null,
  };
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    DB: {
      prepare(sql: string) {
        prepares.push(sql);
        let bound: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { bound = a; return stmt; },
          async first() {
            if (/WHERE public_id = \?/.test(sql)) {
              return bound[0] === KNOWN ? { id: castRaw.id } : null;
            }
            if (/WHERE id = \?/.test(sql)) {
              return bound[0] === castRaw.id ? (castRaw as unknown) : null;
            }
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
          async all() { return { results: [] }; },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, prepares };
}

describe("db resolvers: public id -> internal int (or null)", () => {
  it("getCastIdByPublicId returns the int for a match, null otherwise", async () => {
    const { env } = fakeEnv();
    expect(await getCastIdByPublicId(env, KNOWN)).toBe(1);
    expect(await getCastIdByPublicId(env, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
  it("getProjectIdByPublicId / getRenderIdByPublicId share the same contract", async () => {
    const { env } = fakeEnv();
    // The fake resolves any WHERE public_id = KNOWN regardless of table, so a match returns the int.
    expect(await getProjectIdByPublicId(env, KNOWN)).toBe(1);
    expect(await getRenderIdByPublicId(env, KNOWN)).toBe(1);
    expect(await getProjectIdByPublicId(env, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });
});

describe("route :id is opaque -- a bare integer 404s, never resolves (F13)", () => {
  const intProbes: Array<[string, string]> = [
    ["GET", "https://s.example/api/cast/7"],
    ["GET", "https://s.example/api/storyboard/projects/7"],
    ["DELETE", "https://s.example/api/storyboard/renders/7"],
    ["GET", "https://s.example/api/cast/export/7"],
  ];
  for (const [method, url] of intProbes) {
    it(`${method} ${url.split("/api/")[1]} -> 404 (and never hits the DB)`, async () => {
      const { env, prepares } = fakeEnv();
      const res = await worker.fetch(new Request(url, { method }), env, ctx);
      expect(res.status).toBe(404);
      // isPublicId rejects "7" BEFORE any lookup: no public_id query was issued.
      expect(prepares.some((s) => /public_id/.test(s))).toBe(false);
    });
  }

  it("GET /api/cast/:publicId resolves and returns the OPAQUE id as `id` (no int leak)", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(
      new Request(`https://s.example/api/cast/${KNOWN}`, { method: "GET" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cast: { id: unknown; public_id?: unknown } };
    expect(body.cast.id).toBe(KNOWN);
    expect(typeof body.cast.id).toBe("string");
    // the internal integer PK never crosses the boundary
    expect(body.cast).not.toHaveProperty("public_id");
    expect(body.cast.id).not.toBe(1);
  });
});
