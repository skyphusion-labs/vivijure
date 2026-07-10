import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

// Issue #9: the index.ts fetch entrypoint -- /health, /api/modules method-gating, and the ASSETS
// fallthrough (an unmatched route, or a route hit with the wrong method, serves static assets and
// never reaches a handler).

function makeEnv() {
  const assetCalls: string[] = [];
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: {
      fetch: async (req: Request) => {
        assetCalls.push(new URL(req.url).pathname);
        return new Response("ASSET", { status: 200 });
      },
    },
  } as unknown as Env;
  return { env, assetCalls };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const req = (path: string, method = "GET") => new Request(`https://studio.example${path}`, { method });

describe("fetch entrypoint (issue #9)", () => {
  it("GET /health returns the service descriptor", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/health"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "vivijure-studio", phase: 1 });
  });

  it("GET /api/modules returns a modules response (empty when no MODULE_* bindings)", async () => {
    const { env, assetCalls } = makeEnv();
    const res = await worker.fetch(req("/api/modules"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modules?: unknown[] };
    expect(Array.isArray(body.modules)).toBe(true);
    expect(body.modules).toHaveLength(0);
    expect(assetCalls).toHaveLength(0); // handled, not an asset
  });

  it("an unknown path falls through to ASSETS", async () => {
    const { env, assetCalls } = makeEnv();
    const res = await worker.fetch(req("/totally/unknown"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ASSET");
    expect(assetCalls).toEqual(["/totally/unknown"]);
  });

  it("method-gates: a wrong method on a real route never reaches the handler (falls through to ASSETS)", async () => {
    const { env, assetCalls } = makeEnv();
    // /api/storyboard/renders is GET-only; a POST must not invoke the list handler (which would touch D1).
    const res = await worker.fetch(req("/api/storyboard/renders", "POST"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ASSET");
    expect(assetCalls).toEqual(["/api/storyboard/renders"]);
  });

  it("POST /api/modules (wrong method) does not run discovery -- falls through to ASSETS", async () => {
    const { env, assetCalls } = makeEnv();
    const res = await worker.fetch(req("/api/modules", "POST"), env, ctx);
    expect(assetCalls).toEqual(["/api/modules"]);
    expect(await res.text()).toBe("ASSET");
  });

  it("GET /modules serves the module-host page via ASSETS", async () => {
    const { env, assetCalls } = makeEnv();
    const res = await worker.fetch(req("/modules"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ASSET");
    expect(assetCalls).toEqual(["/modules.html"]);
  });

  it("GET /planner serves planner.html via ASSETS", async () => {
    const { env, assetCalls } = makeEnv();
    const res = await worker.fetch(req("/planner"), env, ctx);
    expect(res.status).toBe(200);
    expect(assetCalls).toEqual(["/planner.html"]);
  });
});

function makePrefsEnv() {
  const store = new Map<string, string>();
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first() {
            if (!sql.trimStart().toUpperCase().startsWith("SELECT")) return null;
            const prefs = store.get("1"); // global singleton
            return prefs ? { prefs_json: prefs } : null;
          },
          async run() {
            if (!sql.trimStart().toUpperCase().startsWith("INSERT")) return { meta: { changes: 0 } };
            const prefsJson = bound[0] as string; // INSERT ... VALUES (1, ?, ?)
            store.set("1", prefsJson);
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, store };
}

const reqWithAccess = (path: string, method = "GET", init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("cf-access-authenticated-user-email", "owner@example.com");
  return new Request(`https://studio.example${path}`, { ...init, method, headers });
};

describe("whoami + user prefs", () => {
  it("GET /api/whoami returns the studio identity, never the Access email (no identity leak)", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(reqWithAccess("/api/whoami"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "studio" });
  });

  it("GET /api/whoami returns the studio identity without an Access header too", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/api/whoami"), env, ctx);
    expect(await res.json()).toEqual({ user: "studio" });
  });

  it("GET /api/prefs returns defaults then PATCH persists", async () => {
    const { env, store } = makePrefsEnv();
    const getRes = await worker.fetch(reqWithAccess("/api/prefs"), env, ctx);
    expect(await getRes.json()).toEqual({ ok: true, prefs: { emailNotifications: false } });

    const patchRes = await worker.fetch(
      reqWithAccess("/api/prefs", "PATCH", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emailNotifications: true }),
      }),
      env,
      ctx,
    );
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toEqual({ ok: true, prefs: { emailNotifications: true } });
    expect([...store.keys()]).toEqual(["1"]); // global singleton row

    const getAgain = await worker.fetch(reqWithAccess("/api/prefs"), env, ctx);
    expect(await getAgain.json()).toEqual({ ok: true, prefs: { emailNotifications: true } });
  });

  it("PUT /api/prefs is not wired (falls through to ASSETS)", async () => {
    const { env, assetCalls } = makeEnv();
    const res = await worker.fetch(reqWithAccess("/api/prefs", "PUT"), env, ctx);
    expect(await res.text()).toBe("ASSET");
    expect(assetCalls).toEqual(["/api/prefs"]);
  });

  it("GET /api/storyboard/renders returns { renders: [...] }", async () => {
    const env = {
    ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
      DB: {
        prepare(sql: string) {
          let bound: unknown[] = [];
          const stmt = {
            bind(...args: unknown[]) { bound = args; return stmt; },
            async all() {
              if (sql.includes("FROM renders")) return { results: [] };
              return { results: [] };
            },
          };
          return stmt;
        },
      },
    } as unknown as Env;
    const res = await worker.fetch(req("/api/storyboard/renders"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renders: [] });
  });
});

// #670: GET /api/storyboard/renders with no `limit` returned exactly 1 row. Number(null)/Number("") are
// both 0 (finite), so coercing first slipped `limit=0` past the finite guard and the listRendersForUser
// clamp raised 0 to 1. These assert the LIMIT bound to the D1 query for the four cases the fix must cover.
describe("GET /api/storyboard/renders limit default (#670)", () => {
  // Capture the LIMIT bound to the (unfiltered) renders query; the last bound arg is the clamped cap.
  function renderLimitEnv() {
    const limitBinds: unknown[] = [];
    const env = {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
      DB: {
        prepare(sql: string) {
          let bound: unknown[] = [];
          const stmt = {
            bind(...args: unknown[]) { bound = args; if (/LIMIT \?/.test(sql)) limitBinds.push(args.at(-1)); return stmt; },
            async all() { return { results: [] }; },
          };
          return stmt;
        },
      },
    } as unknown as Env;
    return { env, lastLimit: () => limitBinds.at(-1) };
  }

  it("absent ?limit -> the default (50) rows, NOT 1", async () => {
    const { env, lastLimit } = renderLimitEnv();
    const res = await worker.fetch(req("/api/storyboard/renders"), env, ctx);
    expect(res.status).toBe(200);
    expect(lastLimit()).toBe(50);
  });

  it("?limit= (empty string) -> the default (50)", async () => {
    const { env, lastLimit } = renderLimitEnv();
    await worker.fetch(req("/api/storyboard/renders?limit="), env, ctx);
    expect(lastLimit()).toBe(50);
  });

  it("?limit=abc (garbage) -> the default (50) via the finite guard", async () => {
    const { env, lastLimit } = renderLimitEnv();
    await worker.fetch(req("/api/storyboard/renders?limit=abc"), env, ctx);
    expect(lastLimit()).toBe(50);
  });

  it("?limit=5 (explicit) -> 5", async () => {
    const { env, lastLimit } = renderLimitEnv();
    await worker.fetch(req("/api/storyboard/renders?limit=5"), env, ctx);
    expect(lastLimit()).toBe(5);
  });
});
