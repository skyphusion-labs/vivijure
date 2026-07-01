import { describe, it, expect } from "vitest";
import { updateRenderFromView, getRenderByIdForUser } from "../src/renders-db";
import type { Env } from "../src/env";
import type { RunpodJobView } from "../src/runpod-submit";

// Issue #15: on a terminal poll, the best-effort per-render log write must run via
// ctx.waitUntil (off the poll hot path) when an ExecutionContext is supplied, and
// fall back to awaiting when it is not. Fakes for D1 + R2 + ctx, no network.

function makeEnv(opts: { hangPut?: boolean } = {}) {
  const putCalls: string[] = [];
  const stmt = {
    bind: () => stmt,
    run: async () => ({ success: true }),
    first: async () => null,
  };
  const env = {
    DB: { prepare: () => stmt },
    R2_RENDERS: {
      put: async (key: string) => {
        putCalls.push(key);
        if (opts.hangPut) await new Promise(() => {}); // never resolves
      },
    },
  } as unknown as Env;
  return { env, putCalls };
}

function makeCtx() {
  const scheduled: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { scheduled.push(p); } } as unknown as ExecutionContext;
  return { ctx, scheduled };
}

const terminalView: RunpodJobView = { jobId: "job-1", status: "COMPLETED", statusRaw: "COMPLETED" };

describe("updateRenderFromView log write (issue #15: waitUntil off the hot path)", () => {
  it("hands the log write to ctx.waitUntil and returns without blocking on it", async () => {
    // The R2 PUT hangs forever; with ctx, updateRenderFromView must STILL resolve
    // (it only schedules the task via waitUntil, never awaits it). If it awaited
    // inline this test would time out -- the definitive proof the write is off the
    // poll hot path.
    const { env, putCalls } = makeEnv({ hangPut: true });
    const { ctx, scheduled } = makeCtx();
    await updateRenderFromView(env, terminalView, ctx);
    expect(scheduled.length).toBe(1);   // the log task went to waitUntil
    expect(putCalls).toEqual(["renders/logs/job-1.txt"]); // and it did start (in the background)
  });

  it("awaits the log write inline when no ctx is supplied (no waitUntil)", async () => {
    const { env, putCalls } = makeEnv();
    await updateRenderFromView(env, terminalView);
    expect(putCalls).toEqual(["renders/logs/job-1.txt"]); // completed before return
  });

  it("writes no log for a non-terminal status", async () => {
    const { env, putCalls } = makeEnv();
    const { ctx, scheduled } = makeCtx();
    await updateRenderFromView(env, { jobId: "job-2", status: "IN_PROGRESS", statusRaw: "IN_PROGRESS" }, ctx);
    expect(scheduled.length).toBe(0);
    expect(putCalls.length).toBe(0);
  });

  it("writes the log on terminal status regardless of row owner (never throws)", async () => {
    // The per-render log no longer carries a per-user ownership stamp (the studio is
    // single-tenant behind CF Access), so the write runs on terminal status alone.
    const { env, putCalls } = makeEnv();
    const { ctx, scheduled } = makeCtx();
    await updateRenderFromView(env, terminalView, ctx);
    await Promise.all(scheduled);
    expect(putCalls).toEqual(["renders/logs/job-1.txt"]);
  });
});


// #411 (Joan finding): D1 returns a SQL-NULL column as JS null, and
// String(null) === "null". normalizeRow used to coerce project / bundle_key /
// quality_tier with a bare String(), so a NULL-fielded row shipped the literal
// truthy string "null", defeating every planner falsy guard (labels,
// download names, and re-render eligibility that keys off a truthy bundle_key).
// The fix coerces SQL NULL -> "" to preserve the non-null string contract with
// a falsy value.
function makeRowEnv(row: Record<string, unknown> | null) {
  const stmt = {
    bind: () => stmt,
    first: async () => row,
  };
  return { DB: { prepare: () => stmt } } as unknown as Env;
}

describe("normalizeRow SQL-NULL coercion (#411)", () => {
  it('maps SQL-NULL project / bundle_key / quality_tier to "" not the literal "null"', async () => {
    // A schema-permitted row (migrations/0001_init.sql) with those three columns NULL.
    const env = makeRowEnv({
      id: 7,
      job_id: "job-null",
      project: null,
      bundle_key: null,
      quality_tier: null,
      status: "COMPLETED",
      submitted_at: 1000,
      updated_at: 1000,
    });
    const r = await getRenderByIdForUser(env, 7);
    expect(r).not.toBeNull();
    expect(r!.project).toBe("");
    expect(r!.bundle_key).toBe("");
    expect(r!.quality_tier).toBe("");
    // The literal "null" would be truthy and slip past the planner guards.
    expect(r!.project).not.toBe("null");
    expect(r!.bundle_key).not.toBe("null");
    expect(r!.quality_tier).not.toBe("null");
    // Falsy, so the existing frontend truthiness gating becomes correct on its own.
    expect(Boolean(r!.bundle_key)).toBe(false);
  });

  it("preserves real string values unchanged", async () => {
    const env = makeRowEnv({
      id: 8,
      job_id: "job-real",
      project: "my-film",
      bundle_key: "bundles/my-film/abc.tar",
      quality_tier: "full",
      status: "COMPLETED",
      submitted_at: 2000,
      updated_at: 2000,
    });
    const r = await getRenderByIdForUser(env, 8);
    expect(r!.project).toBe("my-film");
    expect(r!.bundle_key).toBe("bundles/my-film/abc.tar");
    expect(r!.quality_tier).toBe("full");
  });
});
