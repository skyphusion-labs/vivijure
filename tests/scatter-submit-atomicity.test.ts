import { describe, it, expect, vi } from "vitest";

import { finalizeScatterSubmit, ensureScatterRenderRow } from "../src/scatter-orchestrator";
import type { ScatterJob } from "../src/scatter-orchestrator-types";
import type { Env } from "../src/env";

// A minimal env recording the ORDER of store ops. prepare() tags each op by SQL verb
// (SELECT / INSERT / UPDATE), batch() and the R2 doc put get their own markers, so a test can
// assert "the runnable R2 doc was written before any D1 row write".
function fakeEnv(opts: { rowExists?: boolean; failD1?: boolean } = {}): { env: Env; events: string[] } {
  const events: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const verb = String(sql).trim().split(/\s+/)[0].toUpperCase();
        const stmt: Record<string, unknown> = {
          bind() {
            return stmt;
          },
          async run() {
            events.push(verb);
            if (opts.failD1) throw new Error("D1_ERROR: internal error -- transient blip");
            return { meta: { changes: 1 } };
          },
          async first() {
            events.push(verb);
            return opts.rowExists ? { id: 7 } : null;
          },
        };
        return stmt;
      },
      async batch(stmts: unknown[]) {
        events.push("BATCH:" + (stmts as unknown[]).length);
        if (opts.failD1) throw new Error("D1_ERROR: internal error -- transient blip");
        return [];
      },
    },
    R2_RENDERS: {
      async put() {
        events.push("R2PUT");
        return {};
      },
    },
  } as unknown as Env;
  return { env, events };
}

function jobFixture(over: Partial<ScatterJob> = {}): ScatterJob {
  return {
    scatter_id: "scatter-test-1",
    project: "demo",
    bundle_key: "bundles/demo.tar.gz",
    quality_tier: "draft",
    expected_shot_ids: ["s1", "s2"],
    shard_film_ids: ["film-a", "film-b"],
    shard_shots: [["s1"], ["s2"]],
    project_id: 7,
    render_overrides: { keyframe_backend: "cloud-keyframe" },
    phase: "shards",
    created_at: 0,
    ...over,
  };
}

const shardRows = [
  { jobId: "film-a", status: "IN_QUEUE" },
  { jobId: "film-b", status: "IN_QUEUE" },
];

describe("finalizeScatterSubmit -- runnability-first (#289)", () => {
  it("writes the runnable R2 doc BEFORE any D1 row write", async () => {
    const { env, events } = fakeEnv();
    await finalizeScatterSubmit(env, jobFixture(), shardRows);
    expect(events[0]).toBe("R2PUT"); // the doc that makes the render runnable lands first
    const r2 = events.indexOf("R2PUT");
    const firstD1 = events.findIndex((e) => e === "INSERT" || e.startsWith("BATCH"));
    expect(firstD1).toBeGreaterThan(r2);
    // parent INSERT, then the id lookup, then the shard rows as ONE batch
    expect(events).toContain("BATCH:2");
  });

  it("does NOT throw when the D1 row writes fail -- the render is still runnable, logged not failed", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { env, events } = fakeEnv({ failD1: true });
      await expect(finalizeScatterSubmit(env, jobFixture(), shardRows)).resolves.toBeUndefined();
      expect(events[0]).toBe("R2PUT"); // doc still written -> render runnable despite the D1 blip
      const lines = spy.mock.calls.map((c) => String(c[0]));
      const err = lines.filter((l) => l.includes('"ev":"d1.error"') && l.includes("scatter.submit.rows"));
      expect(err).toHaveLength(1); // the failure is surfaced as a structured, queryable log, not a 422
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ensureScatterRenderRow -- self-heal a missing UI-list row (#289)", () => {
  it("is a no-op when the row already exists (cheap read, no write)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { env, events } = fakeEnv({ rowExists: true });
      await ensureScatterRenderRow(env, jobFixture());
      expect(events).toEqual(["SELECT"]); // existence read only -- no INSERT/UPDATE
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("scatter.selfheal.row"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("inserts the row from the doc when it is missing, and logs the heal", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { env, events } = fakeEnv({ rowExists: false });
      await ensureScatterRenderRow(env, jobFixture());
      expect(events[0]).toBe("SELECT");
      expect(events).toContain("INSERT"); // missing -> reconstructed from the runnable doc
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('"ev":"scatter.selfheal.row"'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
