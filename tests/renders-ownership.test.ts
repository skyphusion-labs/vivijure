import { describe, it, expect } from "vitest";
import {
  getRenderByIdForUser,
  setRenderLabel,
  deleteRenderRow,
  classifyMissingJob,
  PHANTOM_GRACE_SECONDS,
} from "../src/renders-db";
import type { Env } from "../src/env";

// Issue #9: render row access by id (studio-wide visibility) and the phantom-job
// classifier (the source of the past cron phantom-fail).

const ROW = {
  id: 7, job_id: "job-7", project: "hero", bundle_key: "bundles/hero.tar.gz",
  quality_tier: "final", status: "COMPLETED", submitted_at: 100, updated_at: 100,
  render_overrides: null, output_key: null, output: null, error: null,
  execution_time_ms: null, delay_time_ms: null, completed_at: null, label: null,
  keyframes_json: null, mode: "full", locked_shots_json: null, project_id: null,
  folder_path: null, tags_json: null, parent_id: null,
};

function fakeEnv() {
  const env = {
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first() {
            const id = bound[bound.length - 1];
            return id === ROW.id ? { ...ROW } : null;
          },
          async run() {
            const id = bound[bound.length - 1];
            const changes = id === ROW.id ? 1 : 0;
            return { success: true, meta: { changes } };
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return env;
}

describe("render row access by id (issue #9)", () => {
  it("getRenderByIdForUser returns the row when the id exists", async () => {
    const row = await getRenderByIdForUser(fakeEnv(), 7);
    expect(row?.id).toBe(7);
  });

  it("getRenderByIdForUser returns null for a wrong id", async () => {
    expect(await getRenderByIdForUser(fakeEnv(), 999)).toBeNull();
  });

  it("setRenderLabel updates by id", async () => {
    expect(await setRenderLabel(fakeEnv(), 7, "keep")).toBe(true);
    expect(await setRenderLabel(fakeEnv(), 999, "nope")).toBe(false);
  });

  it("deleteRenderRow removes by id", async () => {
    expect(await deleteRenderRow(fakeEnv(), 7)).toBe(true);
    expect(await deleteRenderRow(fakeEnv(), 999)).toBe(false);
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
    expect(classifyMissingJob("IN_PROGRESS", 1000, 1000 + PHANTOM_GRACE_SECONDS)).toBe("phantom");
    expect(classifyMissingJob("IN_PROGRESS", 1000, 1000 + PHANTOM_GRACE_SECONDS - 1)).toBe("confirming");
  });
});
