import { describe, it, expect, vi } from "vitest";

// vivijure #500: hSubmitRender must bounce a FULL render at the door (400) when the effective
// motion_backend does not resolve to an explicit, serving motion.backend module -- instead of burning
// the keyframe phase and dying deep at assemble ("no clips rendered to assemble"). keyframesOnly is
// unaffected. The pure helper carries the message/list logic; the handler tests pin the wiring.

// ---- handler-wiring stubs (same pattern as bundle-key-validation.test.ts) -------------------------
const h = vi.hoisted(() => ({ started: 0 }));
vi.mock("../src/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("../src/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: { scenes?: unknown }) => {
      h.started++;
      return { film_id: "film-500-test", project: "p", phase: "keyframe", scenes: args.scenes, created_at: 0 };
    }),
  };
});
vi.mock("../src/renders-db", async (orig) => {
  const actual = await orig<typeof import("../src/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => {}) };
});

import worker from "../src/index";
import { motionBackendPreflightError } from "../src/modules/registry";
import { MODULE_API, type RegisteredModule } from "../src/modules/types";
import type { Env } from "../src/env";

// ---- pure helper -------------------------------------------------------------------------------
function mmod(name: string, order = 100): RegisteredModule {
  return { name, hooks: ["motion.backend"], ui: { order } } as unknown as RegisteredModule;
}

describe("motionBackendPreflightError (#500 pure helper)", () => {
  const serving = [mmod("local-gpu", 0), mmod("alibaba-wan", 10)];

  it("an ABSENT choice -> a novice message that LISTS the serving module names", () => {
    const err = motionBackendPreflightError(serving, undefined);
    expect(err).toBeTruthy();
    expect(err).toMatch(/choose a motion backend/i);
    expect(err).toContain("local-gpu");
    expect(err).toContain("alibaba-wan");
  });

  it("an EXPLICIT serving choice (alibaba-wan) -> null (passes)", () => {
    expect(motionBackendPreflightError(serving, "alibaba-wan")).toBeNull();
    expect(motionBackendPreflightError(serving, "  alibaba-wan  ")).toBeNull(); // trimmed
  });

  it("an EXPLICIT but NOT-serving choice -> a DISTINCT not-installed message with the list", () => {
    const err = motionBackendPreflightError(serving, "ghost-backend");
    expect(err).toMatch(/not an installed, serving module/i);
    expect(err).toContain("ghost-backend");
    expect(err).toContain("alibaba-wan");
  });

  it("NO motion.backend installed at all -> install-or-keyframes message", () => {
    expect(motionBackendPreflightError([], undefined)).toMatch(/no motion\.backend module is installed/i);
  });
});

// ---- handler wiring (POST /api/storyboard/render -> hSubmitRender) --------------------------------
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function fakeModule(manifest: unknown) {
  return {
    fetch: async () =>
      new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } }),
  };
}

function env(): Env {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET") },
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MODULE_KEYFRAME: fakeModule({ name: "cloud-keyframe", version: "0.1.0", api: MODULE_API, hooks: ["keyframe"] }),
    MODULE_LOCAL_GPU: fakeModule({ name: "local-gpu", version: "0.1.0", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 0, locality: "local" } }),
    MODULE_ALIBABA_WAN: fakeModule({ name: "alibaba-wan", version: "0.1.0", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 10, locality: "cloud" } }),
  } as unknown as Env;
}

function post(body: unknown): Request {
  return new Request("https://studio.example/api/storyboard/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];

describe("hSubmitRender motion-backend preflight (#500 handler)", () => {
  it("the film-3cafd795 repro shape (full render, no motion_backend) BOUNCES 400 with the list", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post({ bundleKey: "bundles/verify.tar.gz", scenes: SCENES, renderOverrides: { keyframe_backend: "cloud-keyframe" } }),
      env(),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/choose a motion backend/i);
    expect(body.error).toContain("alibaba-wan");
    expect(h.started).toBe(0); // bounced BEFORE any keyframe dispatch
  });

  it("an explicit serving motion_backend (alibaba-wan) is ACCEPTED (201)", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post({ bundleKey: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "alibaba-wan" }),
      env(),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
  });

  it("an explicit but NOT-serving motion_backend bounces 400 with the DISTINCT message", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post({ bundleKey: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "ghost-backend" }),
      env(),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not an installed, serving module/i);
    expect(h.started).toBe(0);
  });

  it("a keyframes-only render with NO motion_backend is STILL accepted (no motion leg)", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post({ bundleKey: "bundles/verify.tar.gz", scenes: SCENES, keyframesOnly: true }),
      env(),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
  });
});
