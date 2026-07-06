import { describe, it, expect, vi } from "vitest";

// vivijure #577: a full render must judge the caller's RAW motion config against the chosen
// motion.backend's declared config_schema at the DOOR (400), before the keyframe phase spends GPU
// time. The invoke-path clamp (validateConfig) is deliberately forgiving -- a bad value silently
// degrades to the field default -- which is right mid-pipeline but hides the caller's mistake at
// the API boundary; and when the schema itself over-promised (the #577 trigger: seedance advertised
// 1080p, the provider rejects it), the value sailed through the clamp and failed EVERY shot ~17min
// of final-tier keyframes later. Pure helpers carry the judging; handler tests pin the wiring on
// all three keyframe-burning submit paths (hStartFilm, hSubmitRender, hScatterRender).

// ---- handler-wiring stubs (same pattern as motion-backend-preflight.test.ts) ---------------------
const h = vi.hoisted(() => ({ started: 0, scatterStarted: 0 }));
vi.mock("../src/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("../src/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: { scenes?: unknown }) => {
      h.started++;
      return { film_id: "film-577-test", project: "p", phase: "keyframe", scenes: args.scenes, created_at: 0 };
    }),
  };
});
vi.mock("../src/renders-db", async (orig) => {
  const actual = await orig<typeof import("../src/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => {}) };
});
vi.mock("../src/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("../src/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});
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
import { configPreflightViolations, motionConfigPreflightError } from "../src/modules/registry";
import { MODULE_API, type ConfigSchema, type RegisteredModule } from "../src/modules/types";
import type { Env } from "../src/env";

// ---- pure helpers --------------------------------------------------------------------------------
const SCHEMA: ConfigSchema = {
  resolution: { type: "enum", values: ["480p", "720p"], default: "720p", label: "resolution" },
  camera_fixed: { type: "bool", default: false, label: "lock camera" },
  seed: { type: "int", default: -1, min: -1, label: "seed" },
  fps: { type: "int", default: 24, min: 8, max: 60, label: "fps" },
  style: { type: "string", default: "", label: "style" },
};

describe("configPreflightViolations (#577 pure judge)", () => {
  it("a clean config -> [] (and an empty/absent config is always clean)", () => {
    expect(configPreflightViolations(SCHEMA, { resolution: "480p", camera_fixed: true, seed: 7 })).toEqual([]);
    expect(configPreflightViolations(SCHEMA, {})).toEqual([]);
    expect(configPreflightViolations(SCHEMA, undefined)).toEqual([]);
  });

  it("the #577 shape: an out-of-set enum names the value AND lists what IS allowed", () => {
    const v = configPreflightViolations(SCHEMA, { resolution: "1080p" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("1080p");
    expect(v[0]).toContain("480p, 720p");
  });

  it("an unknown key is named with the declared keys (typos surface, not silently drop)", () => {
    const v = configPreflightViolations(SCHEMA, { resolucion: "720p" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('"resolucion"');
    expect(v[0]).toContain("resolution");
  });

  it("out-of-range and non-numeric numbers are violations (the clamp would silently coerce)", () => {
    expect(configPreflightViolations(SCHEMA, { fps: 120 })[0]).toMatch(/out of range/);
    expect(configPreflightViolations(SCHEMA, { fps: "fast" })[0]).toMatch(/expected a number/);
    expect(configPreflightViolations(SCHEMA, { seed: -2 })[0]).toMatch(/out of range/);
  });

  it("wrong-typed bool/string are violations; several bad keys all surface at once", () => {
    const v = configPreflightViolations(SCHEMA, { camera_fixed: "yes", style: 3, resolution: "4k" });
    expect(v).toHaveLength(3);
  });

  it("a module with NO schema rejects any config keys honestly", () => {
    const v = configPreflightViolations(undefined, { resolution: "720p" });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/declares no config keys/);
  });
});

function mmod(name: string, schema?: ConfigSchema): RegisteredModule {
  return { name, hooks: ["motion.backend"], config_schema: schema, ui: { order: 10 } } as unknown as RegisteredModule;
}

describe("motionConfigPreflightError (#577 pure wrapper)", () => {
  const modules = [mmod("seedance", SCHEMA)];

  it("clean config or no config -> null", () => {
    expect(motionConfigPreflightError(modules, "seedance", { resolution: "720p" })).toBeNull();
    expect(motionConfigPreflightError(modules, "seedance", undefined)).toBeNull();
  });

  it("a violation -> a message naming the module and the allowed values", () => {
    const err = motionConfigPreflightError(modules, "seedance", { resolution: "1080p" });
    expect(err).toContain("seedance");
    expect(err).toContain("480p, 720p");
    expect(err).toMatch(/before any GPU spend/);
  });

  it("an unresolved backend name -> null (the #500/#504 backend preflight owns that error)", () => {
    expect(motionConfigPreflightError(modules, "ghost", { resolution: "1080p" })).toBeNull();
    expect(motionConfigPreflightError(modules, undefined, { resolution: "1080p" })).toBeNull();
  });
});

// ---- handler wiring ------------------------------------------------------------------------------
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
    MODULE_SEEDANCE: fakeModule({
      name: "seedance", version: "0.2.2", api: MODULE_API, hooks: ["motion.backend"],
      config_schema: { resolution: { type: "enum", values: ["480p", "720p"], default: "720p", label: "resolution" } },
      ui: { order: 10, locality: "cloud" },
    }),
  } as unknown as Env;
}

const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];

function post(path: string, body: unknown): Request {
  return new Request(`https://studio.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("hStartFilm motion_config preflight (#577 handler)", () => {
  it("the film-c9c44dcc repro shape (resolution the schema rejects) BOUNCES 400, zero jobs started", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post("/api/render/film", { bundle_key: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "seedance", motion_config: { resolution: "1080p" } }),
      env(), ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("1080p");
    expect(body.error).toContain("480p, 720p");
    expect(h.started).toBe(0); // bounced BEFORE any keyframe dispatch
  });

  it("an in-schema motion_config is ACCEPTED (201)", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post("/api/render/film", { bundle_key: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "seedance", motion_config: { resolution: "480p" } }),
      env(), ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
  });
});

describe("hSubmitRender motion override-config preflight (#577 handler)", () => {
  it("a bad per-module override config bounces 400 before any keyframe dispatch", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post("/api/storyboard/render", {
        bundleKey: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "seedance",
        renderOverrides: { config: { seedance: { resolution: "1080p" } } },
      }),
      env(), ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("480p, 720p");
    expect(h.started).toBe(0);
  });

  it("an in-schema override config is ACCEPTED (201)", async () => {
    h.started = 0;
    const res = await worker.fetch(
      post("/api/storyboard/render", {
        bundleKey: "bundles/verify.tar.gz", scenes: SCENES, motion_backend: "seedance",
        renderOverrides: { config: { seedance: { resolution: "720p" } } },
      }),
      env(), ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
  });
});

describe("hScatterRender motion override-config preflight (#577 handler)", () => {
  it("a bad per-module override config bounces 400 before any shard dispatch", async () => {
    h.scatterStarted = 0;
    const res = await worker.fetch(
      post("/api/storyboard/render/scatter", {
        bundleKey: "bundles/verify.tar.gz", shotIds: ["shot_01", "shot_02"], motion_backend: "seedance",
        renderOverrides: { config: { seedance: { resolution: "1080p" } } },
      }),
      env(), ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("480p, 720p");
    expect(h.scatterStarted).toBe(0);
  });
});
