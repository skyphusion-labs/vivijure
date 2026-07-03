import { describe, it, expect, beforeEach } from "vitest";
import {
  isSpendRoute,
  enforceSpendLimit,
  __resetRateLimitWarnForTest,
  SPEND_RETRY_AFTER_SECONDS,
  type RateLimitBinding,
} from "../src/rate-limit";

function req(ip = "1.2.3.4"): Request {
  return new Request("https://studio/api/render/film", { method: "POST", headers: { "cf-connecting-ip": ip } });
}

describe("isSpendRoute -- the GPU/spend surface", () => {
  it("matches every spend route (POST only)", () => {
    const spend = [
      "/api/storyboard/render",
      "/api/render/clips",
      "/api/render/film",
      "/api/storyboard/render/scatter",
      "/api/storyboard/render-from-keyframes",
      "/api/storyboard/renders/abc-123/animate-cloud",
      "/api/storyboard/renders/abc-123/animate-hybrid",
      "/api/cast/7/train-lora",
      "/api/cast/7/generate-refs",
      "/api/storyboard/score-bed",
      "/api/storyboard/music-generate",
    ];
    for (const p of spend) expect(isSpendRoute("POST", p)).toBe(true);
  });

  it("does NOT match the same paths under GET (reads are free)", () => {
    expect(isSpendRoute("GET", "/api/render/film")).toBe(false);
    expect(isSpendRoute("GET", "/api/cast/7/train-lora")).toBe(false);
  });

  it("does NOT match non-spend routes", () => {
    expect(isSpendRoute("POST", "/api/cast")).toBe(false);
    expect(isSpendRoute("POST", "/api/upload")).toBe(false);
    expect(isSpendRoute("GET", "/api/render/film/abc")).toBe(false);
    expect(isSpendRoute("POST", "/api/storyboard/render-plan")).toBe(false); // dry-run, no GPU
    expect(isSpendRoute("POST", "/api/storyboard/renders/7/add-audio")).toBe(false);
  });
});

describe("enforceSpendLimit -- denial-of-wallet guard", () => {
  beforeEach(() => __resetRateLimitWarnForTest());

  it("ALLOWS when the limiter says success", async () => {
    const limiter: RateLimitBinding = { limit: async () => ({ success: true }) };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: limiter });
    expect(r.ok).toBe(true);
  });

  it("DENIES 429 (with Retry-After) when the limiter says over-limit", async () => {
    const limiter: RateLimitBinding = { limit: async () => ({ success: false }) };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: limiter });
    expect(r).toMatchObject({ ok: false, status: 429, retryAfter: SPEND_RETRY_AFTER_SECONDS });
  });

  it("keys the limiter by client IP", async () => {
    const seen: string[] = [];
    const limiter: RateLimitBinding = {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: true };
      },
    };
    await enforceSpendLimit(req("9.9.9.9"), { SPEND_RATE_LIMITER: limiter });
    expect(seen).toEqual(["9.9.9.9"]);
  });

  it("falls back to a 'global' key when no client IP is present", async () => {
    const seen: string[] = [];
    const limiter: RateLimitBinding = {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: true };
      },
    };
    const noIp = new Request("https://studio/api/render/film", { method: "POST" });
    await enforceSpendLimit(noIp, { SPEND_RATE_LIMITER: limiter });
    expect(seen).toEqual(["global"]);
  });

  it("FAILS CLOSED by default (denies 503) when the limiter binding is unbound", async () => {
    // S9 F7: no SPEND_LIMIT_FAIL_CLOSED flag set -> the default is fail-closed.
    const r = await enforceSpendLimit(req(), {});
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it("FAILS CLOSED by default (denies 503, does not throw) when the limiter errors", async () => {
    const limiter: RateLimitBinding = {
      limit: async () => {
        throw new Error("limiter down");
      },
    };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: limiter });
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it("a HEALTHY limiter still allows under the fail-closed default (only a BROKEN check denies)", async () => {
    const limiter: RateLimitBinding = { limit: async () => ({ success: true }) };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: limiter });
    expect(r.ok).toBe(true);
  });

  it("SPEND_LIMIT_FAIL_CLOSED=\"false\" opts back to fail-open (a broken limiter ALLOWS)", async () => {
    const unbound = await enforceSpendLimit(req(), { SPEND_LIMIT_FAIL_CLOSED: "false" });
    expect(unbound.ok).toBe(true);
    const throwing: RateLimitBinding = { limit: async () => { throw new Error("limiter down"); } };
    const errored = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: throwing, SPEND_LIMIT_FAIL_CLOSED: "false" });
    expect(errored.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- S4: fail-closed posture

describe("enforceSpendLimit -- SPEND_LIMIT_FAIL_CLOSED", () => {
  beforeEach(() => __resetRateLimitWarnForTest());

  it("an unbound limiter DENIES 503 under fail-closed", async () => {
    const r = await enforceSpendLimit(req(), { SPEND_LIMIT_FAIL_CLOSED: "true" });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect((r as { message: string }).message).toContain("fail-closed");
  });

  it("a throwing limiter DENIES 503 under fail-closed", async () => {
    const limiter: RateLimitBinding = { limit: async () => { throw new Error("limiter down"); } };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: limiter, SPEND_LIMIT_FAIL_CLOSED: "true" });
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it("a WORKING limiter still allows under fail-closed (the flag changes failure handling, not verdicts)", async () => {
    const limiter: RateLimitBinding = { limit: async () => ({ success: true }) };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: limiter, SPEND_LIMIT_FAIL_CLOSED: "true" });
    expect(r.ok).toBe(true);
  });

  it("only the literal \"false\" opts out; anything else keeps the fail-closed default", async () => {
    // An unbound limiter is a BROKEN check, so the fail-closed default denies it 503.
    for (const v of ["true", "TRUE", "1", "yes", ""]) {
      const r = await enforceSpendLimit(req(), { SPEND_LIMIT_FAIL_CLOSED: v });
      expect(r).toMatchObject({ ok: false, status: 503 });
    }
    // Only the exact string "false" flips back to fail-open.
    const open = await enforceSpendLimit(req(), { SPEND_LIMIT_FAIL_CLOSED: "false" });
    expect(open.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- S4: daily budget ceiling

import { dailyCeiling, utcDay, type SpendCounterDb } from "../src/rate-limit";

/** In-memory D1 fake honoring the one UPSERT..RETURNING the ceiling uses. */
function fakeCounterDb(opts: { failWith?: Error } = {}) {
  const counts = new Map<string, number>();
  const db: SpendCounterDb = {
    prepare: (_sql: string) => ({
      bind: (...values: unknown[]) => ({
        async first<T>(): Promise<T | null> {
          if (opts.failWith) throw opts.failWith;
          const day = String(values[0]);
          const next = (counts.get(day) ?? 0) + 1;
          counts.set(day, next);
          return { count: next } as T;
        },
      }),
    }),
  };
  return { db, counts };
}

const okLimiter: RateLimitBinding = { limit: async () => ({ success: true }) };

describe("dailyCeiling / utcDay (pure)", () => {
  it("parses a positive integer; off for unset / 0 / negative / garbage", () => {
    expect(dailyCeiling({ SPEND_DAILY_CEILING: "25" })).toBe(25);
    expect(dailyCeiling({})).toBeNull();
    expect(dailyCeiling({ SPEND_DAILY_CEILING: "" })).toBeNull();
    expect(dailyCeiling({ SPEND_DAILY_CEILING: "0" })).toBeNull();
    expect(dailyCeiling({ SPEND_DAILY_CEILING: "-3" })).toBeNull();
    expect(dailyCeiling({ SPEND_DAILY_CEILING: "lots" })).toBeNull();
    expect(dailyCeiling({ SPEND_DAILY_CEILING: "2.5" })).toBeNull();
  });

  it("utcDay yields the UTC date and seconds to UTC midnight", () => {
    // 2026-07-02T23:59:00Z -> 60s to reset
    const t = Date.UTC(2026, 6, 2, 23, 59, 0);
    expect(utcDay(t)).toEqual({ day: "2026-07-02", secondsToReset: 60 });
    // midnight boundary belongs to the NEW day, full day to reset
    const m = Date.UTC(2026, 6, 3, 0, 0, 0);
    expect(utcDay(m)).toEqual({ day: "2026-07-03", secondsToReset: 86400 });
  });
});

describe("enforceSpendLimit -- SPEND_DAILY_CEILING", () => {
  beforeEach(() => __resetRateLimitWarnForTest());
  const NOW = Date.UTC(2026, 6, 2, 12, 0, 0);

  it("allows up to the ceiling, then DENIES 429 with Retry-After = seconds to UTC midnight", async () => {
    const { db } = fakeCounterDb();
    const env = { SPEND_RATE_LIMITER: okLimiter, SPEND_DAILY_CEILING: "2", DB: db };
    expect((await enforceSpendLimit(req(), env, NOW)).ok).toBe(true);
    expect((await enforceSpendLimit(req(), env, NOW)).ok).toBe(true);
    const third = await enforceSpendLimit(req(), env, NOW);
    expect(third).toMatchObject({ ok: false, status: 429, retryAfter: 12 * 3600 });
    expect((third as { message: string }).message).toContain("daily spend ceiling");
  });

  it("the counter is per-UTC-day: a new day starts fresh", async () => {
    const { db } = fakeCounterDb();
    const env = { SPEND_RATE_LIMITER: okLimiter, SPEND_DAILY_CEILING: "1", DB: db };
    expect((await enforceSpendLimit(req(), env, NOW)).ok).toBe(true);
    expect((await enforceSpendLimit(req(), env, NOW)).ok).toBe(false);
    const nextDay = NOW + 24 * 3600 * 1000;
    expect((await enforceSpendLimit(req(), env, nextDay)).ok).toBe(true);
  });

  it("no ceiling set -> D1 never touched", async () => {
    let touched = false;
    const db: SpendCounterDb = { prepare: () => { touched = true; return { bind: () => ({ first: async () => null }) }; } };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: okLimiter, DB: db }, NOW);
    expect(r.ok).toBe(true);
    expect(touched).toBe(false);
  });

  it("ceiling set but DB unbound: fail-closed (default) denies 503; explicit \"false\" allows", async () => {
    const closed = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: okLimiter, SPEND_DAILY_CEILING: "5" }, NOW);
    expect(closed).toMatchObject({ ok: false, status: 503 });
    const open = await enforceSpendLimit(
      req(),
      { SPEND_RATE_LIMITER: okLimiter, SPEND_DAILY_CEILING: "5", SPEND_LIMIT_FAIL_CLOSED: "false" },
      NOW,
    );
    expect(open.ok).toBe(true);
  });

  it("a throwing D1: fail-closed (default) denies 503; explicit \"false\" allows", async () => {
    const { db } = fakeCounterDb({ failWith: new Error("d1 down") });
    const closed = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: okLimiter, SPEND_DAILY_CEILING: "5", DB: db }, NOW);
    expect(closed).toMatchObject({ ok: false, status: 503 });
    const open = await enforceSpendLimit(
      req(),
      { SPEND_RATE_LIMITER: okLimiter, SPEND_DAILY_CEILING: "5", SPEND_LIMIT_FAIL_CLOSED: "false", DB: db },
      NOW,
    );
    expect(open.ok).toBe(true);
  });

  it("an over-LIMIT verdict short-circuits before the ceiling counter (denied requests do not spend a slot before 429)", async () => {
    const { db, counts } = fakeCounterDb();
    const overLimiter: RateLimitBinding = { limit: async () => ({ success: false }) };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: overLimiter, SPEND_DAILY_CEILING: "5", DB: db }, NOW);
    expect(r).toMatchObject({ ok: false, status: 429 });
    expect(counts.size).toBe(0);
  });
});
