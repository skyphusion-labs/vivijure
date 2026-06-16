import { describe, it, expect, beforeEach } from "vitest";
import { discoverModules, _resetModuleDiscoveryCache } from "../src/modules/registry";
import { MODULE_API } from "../src/modules/types";

// Issue #17 follow-up: /api/modules caches discovery for 60s per isolate (opt-in via cacheTtlMs) so a
// refresh storm stops re-fetching every module manifest each request. nowMs is injected for determinism.

const MANIFEST = { name: "finish-rife", version: "0.1.0", api: MODULE_API, hooks: ["finish"] };
const TTL = 60_000;

// One MODULE_* binding whose manifest fetch is counted, so cache hits are observable.
function countingEnv() {
  const counts = { fetches: 0 };
  const env: Record<string, unknown> = {
    MODULE_X: {
      fetch: async () => {
        counts.fetches++;
        return new Response(JSON.stringify(MANIFEST), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  };
  return { env, counts };
}

describe("discoverModules per-isolate cache (issue #17 follow-up)", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  it("re-uses the cached registry within the TTL (one fetch, not N)", async () => {
    const { env, counts } = countingEnv();
    const a = await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 });
    const b = await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 + TTL - 1 }); // still inside TTL
    expect(counts.fetches).toBe(1); // second call served from cache
    expect(b).toEqual(a);
    expect(a.map((m) => m.name)).toEqual(["finish-rife"]);
  });

  it("re-discovers once the TTL has elapsed", async () => {
    const { env, counts } = countingEnv();
    await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 });
    await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 + TTL }); // at expiry (now < expiresAt is false)
    expect(counts.fetches).toBe(2);
  });

  it("does NOT cache without a TTL (dispatch paths stay always-fresh)", async () => {
    const { env, counts } = countingEnv();
    await discoverModules(env);
    await discoverModules(env);
    expect(counts.fetches).toBe(2);
  });

  it("an uncached caller never reads the route's cache (no stale dispatch)", async () => {
    const { env, counts } = countingEnv();
    await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 }); // populate
    await discoverModules(env); // uncached -> fresh discovery, ignores the cache
    expect(counts.fetches).toBe(2);
  });
});
