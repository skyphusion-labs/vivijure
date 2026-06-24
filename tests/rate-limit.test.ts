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

  it("DENIES (with Retry-After) when the limiter says over-limit", async () => {
    const limiter: RateLimitBinding = { limit: async () => ({ success: false }) };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: limiter });
    expect(r).toEqual({ ok: false, retryAfter: SPEND_RETRY_AFTER_SECONDS });
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

  it("FAILS OPEN (allows) when the limiter binding is unbound", async () => {
    const r = await enforceSpendLimit(req(), {});
    expect(r.ok).toBe(true);
  });

  it("FAILS OPEN (allows + does not throw) when the limiter errors", async () => {
    const limiter: RateLimitBinding = {
      limit: async () => {
        throw new Error("limiter down");
      },
    };
    const r = await enforceSpendLimit(req(), { SPEND_RATE_LIMITER: limiter });
    expect(r.ok).toBe(true);
  });
});
