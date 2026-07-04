import { describe, it, expect, vi } from "vitest";

// vivijure #500: hSubmitRender must bounce a FULL render at the door (400) when the effective
// motion_backend does not resolve to an explicit, serving motion.backend module -- instead of burning
// the keyframe phase and dying deep at assemble ("no clips rendered to assemble"). keyframesOnly is
// unaffected. The pure helper carries the message/list logic; the handler tests pin the wiring.

// ---- handler-wiring stubs (same pattern as bundle-key-validation.test.ts) -------------------------
const h = vi.hoisted(() => ({ started: 0, scatterStarted: 0 }));
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
// #504: hStartFilm derives dialogue from the bundle when the caller sends none; that read hits R2,
// which the fake env has no binding for. Stub it to [] so the derivation branch is a no-op (the
// preflight under test runs BEFORE it anyway).
vi.mock("../src/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("../src/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});
// #504: count scatter submits so the tests can assert ZERO jobs started on a bounced preflight, and
// return a minimal ScatterJob the (real) scatterJobToPollView can render.
vi.mock("../src/scatter-orchestrator", async (orig) => {
  const actual = await orig<typeof import("../src/scatter-orchestrator")>();
  return {
    ...actual,
    startScatterRender: vi.fn(async () => {
      h.scatterStarted++;
      return { cancelled: false, phase: "keyframe", project: "p", film_key: undefined, shard_film_ids: [], expected_shot_ids: [] };
    }),
  };
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
// ---- handler wiring (POST /api/render/film -> hStartFilm; #504) -----------------------------------
// hStartFilm has NO keyframes-only mode -- it always runs the full keyframe -> clips -> finish ->
// assemble chain -- so the motion.backend preflight is UNCONDITIONAL. The explicit choice is the
// top-level motion_backend (this endpoint carries no render_overrides bag), never the serving[0] default.
function postFilm(body: unknown): Request {
  return new Request("https://studio.example/api/render/film", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("hStartFilm motion-backend preflight (#504 handler)", () => {
  it("a full film with NO motion_backend BOUNCES 400 with the serving list, zero jobs started", async () => {
    h.started = 0;
    const res = await worker.fetch(postFilm({ bundle_key: "bundles/verify.tar.gz", scenes: SCENES }), env(), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/choose a motion backend/i);
    expect(body.error).toContain("local-gpu");
    expect(body.error).toContain("alibaba-wan");
    expect(h.started).toBe(0); // bounced BEFORE any keyframe dispatch
  });

  it("an explicit serving motion_backend (alibaba-wan) is ACCEPTED (201)", async () => {
    h.started = 0;
    const res = await worker.fetch(
      postFilm({ bundle_key: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "alibaba-wan" }),
      env(), ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
  });

  it("an explicit but NOT-serving motion_backend bounces 400 with the DISTINCT message, zero started", async () => {
    h.started = 0;
    const res = await worker.fetch(
      postFilm({ bundle_key: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "ghost-backend" }),
      env(), ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not an installed, serving module/i);
    expect(h.started).toBe(0);
  });
});

// ---- handler wiring (POST /api/storyboard/render/scatter -> hScatterRender; #504) -----------------
// Scatter always runs the full keyframe -> clips chain across shards (no keyframes-only mode); an
// omitted motion_backend used to default to defaultGpuDoorModule (an order-first door). The preflight
// requires an explicit, serving choice: top-level motion_backend ?? render_overrides.motion_backend.
function postScatter(body: unknown): Request {
  return new Request("https://studio.example/api/storyboard/render/scatter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SHOT_IDS = ["shot_01", "shot_02"];

describe("hScatterRender motion-backend preflight (#504 handler)", () => {
  it("a scatter render with NO motion_backend BOUNCES 400 with the serving list, zero jobs started", async () => {
    h.scatterStarted = 0;
    const res = await worker.fetch(postScatter({ bundleKey: "bundles/verify.tar.gz", shotIds: SHOT_IDS }), env(), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/choose a motion backend/i);
    expect(body.error).toContain("alibaba-wan");
    expect(h.scatterStarted).toBe(0); // bounced BEFORE any shard/keyframe dispatch
  });

  it("an explicit serving motion_backend via render_overrides is ACCEPTED (201)", async () => {
    h.scatterStarted = 0;
    const res = await worker.fetch(
      postScatter({ bundleKey: "bundles/verify.tar.gz", shotIds: SHOT_IDS, renderOverrides: { motion_backend: "alibaba-wan" } }),
      env(), ctx,
    );
    expect(res.status).toBe(201);
    expect(h.scatterStarted).toBe(1);
  });

  it("an explicit but NOT-serving motion_backend bounces 400 with the DISTINCT message, zero started", async () => {
    h.scatterStarted = 0;
    const res = await worker.fetch(
      postScatter({ bundleKey: "bundles/verify.tar.gz", shotIds: SHOT_IDS, motion_backend: "ghost-backend" }),
      env(), ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not an installed, serving module/i);
    expect(h.scatterStarted).toBe(0);
  });
});
