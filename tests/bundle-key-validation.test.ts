import { describe, it, expect, vi } from "vitest";

// Boundary validation for the caller-supplied bundle key on every render submit route. The key
// becomes an R2 read downstream (readBundleScenes / stageBundleInjectedKeyframes), so each handler
// must reject anything that is not a plain relative key under the canonical bundles/ namespace at
// the request-parse point, with a 400, before the value is used. Mirrors the artifact serve
// route's prefix scoping (ARTIFACT_PREFIXES + isSafeRelKey). Also locks the adopt route, whose
// stored bundleKey can be read back as a storage key later (regen-shot).

// Handler-wiring stubs (same pattern as render-film-dialogue.test.ts) so the GOOD-key control
// case can run the /api/render/film handler without a real orchestrator/DB. The rejection cases
// never reach these: the 400 fires at the parse point.
const h = vi.hoisted(() => ({ started: 0 }));

vi.mock("../src/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("../src/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: { scenes?: unknown }) => {
      h.started++;
      return { film_id: "film-test", phase: "keyframe", scenes: args.scenes, created_at: 0 };
    }),
  };
});
vi.mock("../src/renders-db", async (orig) => {
  const actual = await orig<typeof import("../src/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => {}) };
});
vi.mock("../src/film-render-bridge", async (orig) => {
  const actual = await orig<typeof import("../src/film-render-bridge")>();
  return { ...actual, filmRowFromJob: vi.fn(() => ({})) };
});
vi.mock("../src/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("../src/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

import worker from "../src/index";
import { isSafeBundleKey, BUNDLE_KEY_PREFIX } from "../src/shared";
import { MODULE_API } from "../src/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  // A healthy default deploy binds SPEND_RATE_LIMITER (wrangler.toml.example); model it so the
  // fail-closed spend gate (S9 F7) passes and these tests exercise the render handlers, not the gate.
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_ALIBABA_WAN: { fetch: async () => new Response(JSON.stringify({ name: "alibaba-wan", version: "0.1.0", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 10, locality: "cloud" } }), { status: 200, headers: { "content-type": "application/json" } }) },
} as unknown as Env;

function post(path: string, body: unknown): Request {
  return new Request(`https://studio.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Key shapes that must never pass the boundary: a ".." segment, an absolute key, a key outside
// the bundles/ namespace, and a key with out-of-charset bytes.
const BAD_KEYS = [
  "bundles/../renders/other.tar.gz",
  "../bundles/p.tar.gz",
  "/bundles/p.tar.gz",
  "renders/p.tar.gz",
  "bundles/p name.tar.gz",
];

const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];

describe("isSafeBundleKey (shared helper)", () => {
  it("accepts the canonical assembler shape", () => {
    expect(isSafeBundleKey("bundles/my-project.tar.gz")).toBe(true);
    expect(isSafeBundleKey(`${BUNDLE_KEY_PREFIX}nested/ok.tar.gz`)).toBe(true);
  });
  it("rejects every unsafe / off-namespace shape", () => {
    for (const k of BAD_KEYS) expect(isSafeBundleKey(k), k).toBe(false);
    expect(isSafeBundleKey("")).toBe(false);
    expect(isSafeBundleKey(undefined)).toBe(false);
    expect(isSafeBundleKey("bundles")).toBe(false); // the prefix itself, no key under it
  });
});

describe("render submit routes reject a malformed bundleKey with 400", () => {
  const routes: Array<{ path: string; body: (key: string) => unknown }> = [
    { path: "/api/storyboard/render", body: (bundleKey) => ({ bundleKey, scenes: SCENES }) },
    { path: "/api/storyboard/render-from-keyframes", body: (bundleKey) => ({ bundleKey }) },
    { path: "/api/storyboard/render/scatter", body: (bundleKey) => ({ bundleKey, shotIds: ["shot_01", "shot_02"] }) },
    { path: "/api/render/film", body: (bundle_key) => ({ bundle_key, scenes: SCENES }) },
    { path: "/api/storyboard/renders/adopt", body: (bundleKey) => ({ jobId: "job-adopt-1", bundleKey }) },
  ];

  for (const { path, body } of routes) {
    it(`POST ${path}`, async () => {
      for (const key of BAD_KEYS) {
        const res = await worker.fetch(post(path, body(key)), env, ctx);
        expect(res.status, `${path} with ${key}`).toBe(400);
        const parsed = (await res.json()) as { error?: string };
        expect(parsed.error).toMatch(/bundle_?[kK]ey/);
      }
    });
  }

  it("control: a canonical bundles/ key still submits (POST /api/render/film -> 201)", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post("/api/render/film", { bundle_key: "bundles/good.tar.gz", scenes: SCENES, motion_backend: "alibaba-wan" }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
  });
});
