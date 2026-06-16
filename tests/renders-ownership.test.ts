import { describe, it, expect } from "vitest";
import {
  getRenderByIdForUser,
  setRenderLabel,
  deleteRenderRow,
  classifyMissingJob,
  PHANTOM_GRACE_SECONDS,
} from "../src/renders-db";
import type { Env } from "../src/env";

// Issue #9: D1 OWNERSHIP gating (a row is invisible / unmodifiable to a non-owner) and the phantom-job
// classifier (the source of the past cron phantom-fail). The fake D1 honors the (id, user_email)
// binding the queries scope on, so ownership is enforced exactly as SQLite would.

const OWNER = "owner@e.com";
const ROW = {
  id: 7, user_email: OWNER, job_id: "job-7", project: "hero", bundle_key: "bundles/hero.tar.gz",
  quality_tier: "final", status: "COMPLETED", submitted_at: 100, updated_at: 100,
  render_overrides: null, output_key: null, output: null, error: null,
  execution_time_ms: null, delay_time_ms: null, completed_at: null, label: null,
  keyframes_json: null, mode: "full", locked_shots_json: null, project_id: null,
  folder_path: null, tags_json: null, parent_id: null,
};

// A one-row fake. SELECT/UPDATE/DELETE all bind (..., id, user_email); the row answers only when both
// match its owner -- exactly the gate getRenderByIdForUser / setRenderLabel / deleteRenderRow rely on.
function fakeEnv() {
  const env = {
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first() {
            const [id, email] = bound.slice(-2); // both helpers bind (id, user_email) last
            return id === ROW.id && email === ROW.user_email ? { ...ROW } : null;
          },
          async run() {
            const [id, email] = bound.slice(-2);
            const changes = id === ROW.id && email === ROW.user_email ? 1 : 0;
            return { success: true, meta: { changes } };
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return env;
}

describe("D1 ownership gating (issue #9)", () => {
  it("getRenderByIdForUser returns the row to its owner", async () => {
    const row = await getRenderByIdForUser(fakeEnv(), 7, OWNER);
    expect(row?.id).toBe(7);
    expect(row?.user_email).toBe(OWNER);
  });

  it("getRenderByIdForUser returns null for a non-owner (row invisible)", async () => {
    expect(await getRenderByIdForUser(fakeEnv(), 7, "attacker@e.com")).toBeNull();
  });

  it("getRenderByIdForUser returns null for a wrong id", async () => {
    expect(await getRenderByIdForUser(fakeEnv(), 999, OWNER)).toBeNull();
  });

  it("setRenderLabel returns true for the owner, false for a non-owner", async () => {
    expect(await setRenderLabel(fakeEnv(), 7, OWNER, "keep")).toBe(true);
    expect(await setRenderLabel(fakeEnv(), 7, "attacker@e.com", "steal")).toBe(false);
  });

  it("deleteRenderRow returns true for the owner, false for a non-owner", async () => {
    expect(await deleteRenderRow(fakeEnv(), 7, OWNER)).toBe(true);
    expect(await deleteRenderRow(fakeEnv(), 7, "attacker@e.com")).toBe(false);
  });
});

describe("classifyMissingJob phantom classifier (issue #9)", () => {
  it("a terminal row whose job RunPod garbage-collected is 'terminal' (serve cached, do not fail)", () => {
    expect(classifyMissingJob("COMPLETED", 0, 10_000)).toBe("terminal");
    expect(classifyMissingJob("FAILED", 0, 10_000)).toBe("terminal");
    expect(classifyMissingJob("CANCELLED", 0, 10_000)).toBe("terminal");
  });

  it("a non-terminal row inside the grace window is 'confirming' (keep polling)", () => {
    expect(classifyMissingJob("IN_QUEUE", 1000, 1000 + PHANTOM_GRACE_SECONDS - 1)).toBe("confirming");
  });

  it("a non-terminal row past the grace window is 'phantom' (submission dropped -> fail)", () => {
    expect(classifyMissingJob("IN_QUEUE", 1000, 1000 + PHANTOM_GRACE_SECONDS + 1)).toBe("phantom");
  });

  it("the grace boundary is inclusive of 'confirming' right up to the cap", () => {
    // exactly at the cap is NOT yet phantom (strict <)
    expect(classifyMissingJob("IN_PROGRESS", 1000, 1000 + PHANTOM_GRACE_SECONDS)).toBe("phantom");
    expect(classifyMissingJob("IN_PROGRESS", 1000, 1000 + PHANTOM_GRACE_SECONDS - 1)).toBe("confirming");
  });
});
