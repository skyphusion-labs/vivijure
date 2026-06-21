import { describe, it, expect, vi } from "vitest";

import { isTransientD1Error, withD1Retry } from "../src/d1-retry";
import { updateRenderFromView } from "../src/renders-db";
import type { Env } from "../src/env";
import type { RunpodJobView } from "../src/runpod-submit";

const noSleep = () => Promise.resolve();

describe("isTransientD1Error", () => {
  it("treats D1 platform blips as transient (retryable)", () => {
    expect(isTransientD1Error(new Error("D1_ERROR: internal error"))).toBe(true);
    expect(isTransientD1Error(new Error("D1_ERROR: Internal error: storage operation was reset"))).toBe(true);
    expect(isTransientD1Error(new Error("Network connection lost"))).toBe(true);
    expect(isTransientD1Error(new Error("D1_ERROR: Service Unavailable (503)"))).toBe(true);
  });

  it("treats constraint / SQL / logic errors as FATAL (fail fast, never retry)", () => {
    expect(isTransientD1Error(new Error("D1_ERROR: UNIQUE constraint failed: renders.job_id"))).toBe(false);
    expect(isTransientD1Error(new Error("D1_ERROR: NOT NULL constraint failed: renders.user_email"))).toBe(false);
    expect(isTransientD1Error(new Error("D1_ERROR: no such column: bogus"))).toBe(false);
    expect(isTransientD1Error(new Error("D1_ERROR: near \"SELEC\": syntax error"))).toBe(false);
  });

  it("does not retry unrelated / unknown errors", () => {
    expect(isTransientD1Error(new Error("TypeError: undefined is not a function"))).toBe(false);
    expect(isTransientD1Error(undefined)).toBe(false);
    expect(isTransientD1Error("")).toBe(false);
  });
});

describe("withD1Retry", () => {
  it("self-heals: fails transiently N times then succeeds, returning the result", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("D1_ERROR: internal error");
      return "ok";
    });
    const result = await withD1Retry(fn, { attempts: 4, sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("fails fast on a constraint error -- no retry, no spin", async () => {
    const fn = vi.fn(async () => {
      throw new Error("D1_ERROR: UNIQUE constraint failed: renders.job_id");
    });
    await expect(withD1Retry(fn, { attempts: 4, sleep: noSleep })).rejects.toThrow("UNIQUE constraint");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-throws after exhausting attempts on a persistent transient error (bounded, no infinite loop)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("D1_ERROR: internal error");
    });
    await expect(withD1Retry(fn, { attempts: 4, sleep: noSleep })).rejects.toThrow("internal error");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("returns immediately on first success (no retries)", async () => {
    const fn = vi.fn(async () => "first-try");
    expect(await withD1Retry(fn, { sleep: noSleep })).toBe("first-try");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// Integration: the advance hot path (updateRenderFromView) must self-heal a transient D1 blip
// rather than throw it up to the sweep (which would abort the whole advance and re-fail every tick).
describe("updateRenderFromView under transient D1 error", () => {
  function fakeEnv(failTimes: number): { env: Env; runCalls: () => number } {
    let runCalls = 0;
    const env = {
      DB: {
        prepare() {
          const stmt = {
            bind() { return stmt; },
            async run() {
              runCalls += 1;
              if (runCalls <= failTimes) throw new Error("D1_ERROR: internal error");
              return { meta: { changes: 1 } };
            },
          };
          return stmt;
        },
      },
    } as unknown as Env;
    return { env, runCalls: () => runCalls };
  }

  const view: RunpodJobView = { jobId: "film-abc", status: "IN_PROGRESS", statusRaw: "clips" };

  it("completes after the D1 op fails twice then succeeds", async () => {
    const { env, runCalls } = fakeEnv(2);
    await expect(updateRenderFromView(env, view)).resolves.toBeUndefined();
    expect(runCalls()).toBe(3); // 2 transient failures + 1 success
  });
});
