import { describe, it, expect, vi } from "vitest";
import { addRef, addRefs, removeRef, listCast } from "../src/cast-db";
import { listProjects } from "../src/storyboard-projects-db";
import { listUserTags } from "../src/renders-db";
import type { Env } from "../src/env";

// Issue #12: addRef/removeRef/addSource/removeSource were read-modify-write on a JSON-array column,
// so two concurrent writers clobbered each other. They now use a value-CAS with retry. The fake D1
// below routes by SQL: the raw-column read, the guarded UPDATE (CAS), and the getCastById full read.
// `injectConcurrentWrites` rewrites the stored value just before a CAS lands, forcing the miss/retry.

const baseRow = (refsJson: string | null) => ({
  id: 1, slug: "hero", name: "Hero", bible: null,
  portrait_key: null, portrait_mime: null,
  ref_keys_json: refsJson, source_keys_json: null,
  created_at: "t", updated_at: "t",
  lora_key: null, lora_status: null, lora_job_id: null, lora_error: null, lora_trained_at: null,
  voice_id: null,
});

function fakeCastEnv(opts: { raw: string | null; missing?: boolean; injectConcurrentWrites?: (string | null)[] }) {
  const state = { raw: opts.raw, missing: opts.missing ?? false };
  const queued = [...(opts.injectConcurrentWrites ?? [])];
  const calls = { selectRaw: 0, update: 0, casMiss: 0, selectFull: 0 };
  const env = {
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first() {
            if (/AS raw/.test(sql)) {
              calls.selectRaw++;
              return state.missing ? null : { raw: state.raw };
            }
            if (/^\s*UPDATE cast_members/.test(sql)) {
              calls.update++;
              if (queued.length > 0) state.raw = queued.shift() as string | null; // a concurrent write lands first
              const guard = bound[2] as string | null; // SET ?, WHERE id ?, col IS ?
              const matches = guard === state.raw || (guard == null && state.raw == null);
              if (!matches) { calls.casMiss++; return null; }
              state.raw = bound[0] as string; // apply
              return baseRow(state.raw);
            }
            calls.selectFull++; // getCastById
            return state.missing ? null : baseRow(state.raw);
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, state, calls };
}

const ref = (key: string) => ({ key, mime: "image/png" });

describe("cast-db array-column CAS (issue #12: no lost update)", () => {
  it("addRef appends with one read + one CAS write when uncontended", async () => {
    const { env, state, calls } = fakeCastEnv({ raw: JSON.stringify([ref("a")]) });
    const row = await addRef(env, 1, ref("b"));
    expect(row?.ref_keys.map((r) => r.key)).toEqual(["a", "b"]);
    expect(calls.selectRaw).toBe(1);
    expect(calls.update).toBe(1);
    expect(JSON.parse(state.raw as string).map((r: { key: string }) => r.key)).toEqual(["a", "b"]);
  });

  it("retries on a concurrent write and preserves BOTH refs (no clobber)", async () => {
    // Between our read of [a] and our CAS, another writer appends "concurrent".
    const { env, calls } = fakeCastEnv({
      raw: JSON.stringify([ref("a")]),
      injectConcurrentWrites: [JSON.stringify([ref("a"), ref("concurrent")])],
    });
    const row = await addRef(env, 1, ref("mine"));
    expect(row?.ref_keys.map((r) => r.key)).toEqual(["a", "concurrent", "mine"]); // nothing lost
    expect(calls.update).toBe(2);   // first CAS missed, retried
    expect(calls.casMiss).toBe(1);
    expect(calls.selectRaw).toBe(2); // re-read before the retry
  });

  it("addRefs batches an append in one CAS write", async () => {
    const { env, state } = fakeCastEnv({ raw: null }); // legacy NULL column
    const row = await addRefs(env, 1, [ref("x"), ref("y")]);
    expect(row?.ref_keys.map((r) => r.key)).toEqual(["x", "y"]);
    expect(JSON.parse(state.raw as string)).toHaveLength(2);
  });

  it("removeRef removes a present key and reports it", async () => {
    const { env, calls } = fakeCastEnv({ raw: JSON.stringify([ref("a"), ref("b")]) });
    const { row, removedKey } = await removeRef(env, 1, "a");
    expect(removedKey).toBe("a");
    expect(row?.ref_keys.map((r) => r.key)).toEqual(["b"]);
    expect(calls.update).toBe(1);
  });

  it("removeRef on an absent key writes nothing and reports null", async () => {
    const { env, calls } = fakeCastEnv({ raw: JSON.stringify([ref("a")]) });
    const { row, removedKey } = await removeRef(env, 1, "zzz");
    expect(removedKey).toBeNull();
    expect(row?.ref_keys.map((r) => r.key)).toEqual(["a"]);
    expect(calls.update).toBe(0); // no CAS attempted for a no-op
  });

  it("returns null when the cast member does not exist", async () => {
    const { env } = fakeCastEnv({ raw: null, missing: true });
    expect(await addRef(env, 1, ref("b"))).toBeNull();
    const { env: env2 } = fakeCastEnv({ raw: null, missing: true });
    expect(await removeRef(env2, 1, "a")).toEqual({ row: null, removedKey: null });
  });

  it("gives up after the bounded attempts under relentless contention (warns, no clobber)", async () => {
    // Every CAS sees a fresh concurrent value -> always misses. 6 attempts, then warn + current row.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, calls } = fakeCastEnv({
      raw: JSON.stringify([ref("a")]),
      injectConcurrentWrites: Array.from({ length: 10 }, (_, i) => JSON.stringify([ref(`w${i}`)])),
    });
    const row = await addRef(env, 1, ref("mine"));
    expect(calls.update).toBe(6); // maxAttempts
    expect(warn).toHaveBeenCalledOnce();
    expect(row).not.toBeNull(); // returns the current row, never a silent clobber
    warn.mockRestore();
  });
});

// Issue #12: the unbounded per-user SELECTs are now capped. A capture fake asserts the LIMIT + bind.
function captureAll() {
  const captured: { sql: string; bound: unknown[] } = { sql: "", bound: [] };
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) { captured.sql = sql; captured.bound = args; return this; },
          all: async () => ({ results: [] }),
        };
      },
    },
  } as unknown as Env;
  return { env, captured };
}

describe("bounded list queries (issue #12)", () => {
  it("listCast is LIMIT-bound", async () => {
    const { env, captured } = captureAll();
    await listCast(env);
    expect(captured.sql).toMatch(/LIMIT \?/);
    expect(captured.bound).toEqual([500]);
  });

  it("listProjects is LIMIT-bound", async () => {
    const { env, captured } = captureAll();
    await listProjects(env);
    expect(captured.sql).toMatch(/LIMIT \?/);
    expect(captured.bound).toEqual([500]);
  });

  it("listUserTags scans only the most recent tagged renders (ORDER BY + LIMIT)", async () => {
    const { env, captured } = captureAll();
    await listUserTags(env);
    expect(captured.sql).toMatch(/ORDER BY submitted_at DESC/);
    expect(captured.sql).toMatch(/LIMIT \?/);
    expect(captured.bound).toEqual([500]);
  });
});
