import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

// Issue #9: the index.ts fetch entrypoint -- /health, /api/modules method-gating, and the ASSETS
// fallthrough (an unmatched route, or a route hit with the wrong method, serves static assets and
// never reaches a handler).

function makeEnv() {
  const assetCalls: string[] = [];
  const env = {
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
