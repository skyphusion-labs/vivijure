import { describe, it, expect, vi } from "vitest";

// #695 + #696 honesty gates at the film/render submit boundary.
//
// #695: once startFilmJob returns, the film is LIVE and spending. A throw in the post-start bookkeeping
// (history-row insert, download-url enrichment) must NOT surface as a 5xx -- that lied about a running
// job and baited a retry-on-5xx client into a SECOND film. The started-film envelope returns 201; the
// insert failure is swallowed + logged, and hPollFilm insert-if-missing heals the row later.
//
// #696: a config map that is present but not a plain object bounces with 400 at the door, BEFORE any GPU
// spend -- never clamping to defaults silently (a STRING film_finish_config downgraded subtitle mode=both
// to burn with no error on film-941a4d3b).

const h = vi.hoisted(() => ({
  started: [] as Array<Record<string, unknown>>,
  insertThrows: false,
}));

vi.mock("../src/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("../src/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-honesty", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("../src/renders-db", async (orig) => {
  const actual = await orig<typeof import("../src/renders-db")>();
  return {
    ...actual,
    insertRender: vi.fn(async () => {
      if (h.insertThrows) throw new Error("D1_ERROR: D1 DB storage operation exceeded timeout");
    }),
  };
});
vi.mock("../src/film-render-bridge", async (orig) => {
  const actual = await orig<typeof import("../src/film-render-bridge")>();
  return { ...actual, filmRowFromJob: vi.fn(() => ({ jobId: "film-honesty", project: "p" })) };
});
vi.mock("../src/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("../src/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

import worker from "../src/index";
import { MODULE_API } from "../src/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function moduleBinding(name: string, hooks: string[], locality: string) {
  return {
    fetch: async () =>
      new Response(
        JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
}

const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  // Healthy spend gate (S9 F7) so these tests exercise the handlers, not the fail-closed gate.
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"], "cloud"),
  MODULE_ALIBABA_WAN: moduleBinding("alibaba-wan", ["motion.backend"], "cloud"),
} as unknown as Env;

function post(path: string, body: unknown): Request {
  return new Request(`https://studio.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];

describe("#696 hStartFilm rejects a non-object config map with 400 before any GPU spend", () => {
  const FIELDS = [
    "keyframe_config",
    "motion_config",
    "finish_config",
    "speech_config",
    "film_finish_config",
    "master_config",
  ];
  const BAD: Array<{ label: string; value: unknown }> = [
    { label: "string", value: "{\"subtitle\":{\"mode\":\"both\"}}" },
    { label: "array", value: [1, 2, 3] },
    { label: "number", value: 42 },
    { label: "null", value: null },
  ];
  for (const field of FIELDS) {
    for (const bad of BAD) {
      it(`${field} as ${bad.label} -> 400 naming the field, startFilmJob never called`, async () => {
        h.started = [];
        const body: Record<string, unknown> = {
          bundle_key: "bundles/good.tar.gz",
          scenes: SCENES,
          motion_backend: "alibaba-wan",
        };
        body[field] = bad.value;
        const res = await worker.fetch(post("/api/render/film", body), env, ctx);
        expect(res.status, `${field}=${bad.label}`).toBe(400);
        const parsed = (await res.json()) as { error?: string };
        expect(parsed.error ?? "").toContain(field);
        // B-F2 (#730): the type phrase is grammatical for every JSON type ("an array", not "a array").
        const article = /^[aeiou]/.test(bad.label) ? "an" : "a";
        expect(parsed.error ?? "", `${field}=${bad.label} grammar`).toContain(`not ${article} ${bad.label}`);
        expect(h.started.length, "must bounce before startFilmJob").toBe(0);
      });
    }
  }
});

describe("#696 hSubmitRender rejects a non-object render_overrides / config entry with 400", () => {
  it("renderOverrides as a string -> 400", async () => {
    h.started = [];
    const res = await worker.fetch(
      post("/api/storyboard/render", { bundleKey: "bundles/good.tar.gz", scenes: SCENES, renderOverrides: "nope" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toContain("renderOverrides");
    expect(h.started.length).toBe(0);
  });
  it("a per-module renderOverrides.config entry as a string -> 400 naming the module", async () => {
    h.started = [];
    const res = await worker.fetch(
      post("/api/storyboard/render", {
        bundleKey: "bundles/good.tar.gz",
        scenes: SCENES,
        renderOverrides: { config: { "alibaba-wan": "burn" } },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toContain("renderOverrides.config.alibaba-wan");
    expect(h.started.length).toBe(0);
  });
});

describe("#696 a valid config object passes through to startFilmJob verbatim", () => {
  it("film_finish_config object -> 201 and forwarded unchanged (mode=both survives, never clamps to burn)", async () => {
    h.started = [];
    h.insertThrows = false;
    const ffc = { subtitle: { mode: "both" } };
    const res = await worker.fetch(
      post("/api/render/film", {
        bundle_key: "bundles/good.tar.gz",
        scenes: SCENES,
        motion_backend: "alibaba-wan",
        film_finish_config: ffc,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started.length).toBe(1);
    expect(h.started[0].film_finish_config).toEqual(ffc);
  });
});

describe("#695 post-start bookkeeping failure still returns the started-film envelope, not a 5xx", () => {
  it("POST /api/render/film -> 201 even when insertRender throws (D1 timeout)", async () => {
    h.started = [];
    h.insertThrows = true;
    try {
      const res = await worker.fetch(
        post("/api/render/film", { bundle_key: "bundles/good.tar.gz", scenes: SCENES, motion_backend: "alibaba-wan" }),
        env,
        ctx,
      );
      expect(res.status).toBe(201);
      expect(h.started.length).toBe(1);
      const parsed = (await res.json()) as { ok?: boolean; film_id?: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.film_id).toBe("film-honesty");
    } finally {
      h.insertThrows = false;
    }
  });
  it("POST /api/storyboard/render -> 201 even when insertRender throws (D1 timeout)", async () => {
    h.started = [];
    h.insertThrows = true;
    try {
      const res = await worker.fetch(
        post("/api/storyboard/render", { bundleKey: "bundles/good.tar.gz", scenes: SCENES, motion_backend: "alibaba-wan" }),
        env,
        ctx,
      );
      expect(res.status).toBe(201);
      expect(h.started.length).toBe(1);
    } finally {
      h.insertThrows = false;
    }
  });
});

describe("#696 (deep) hStartFilm rejects a nested non-object per-module config entry with 400", () => {
  // The per-module maps are module -> { field: value }; a nested garbage entry (e.g.
  // film_finish_config = { subtitle: "garbage" }) must bounce at the door, not clamp silently
  // downstream. The flat knob maps (keyframe_config / motion_config) are top-level-only by design.
  const MODULE_MAPS = ["finish_config", "speech_config", "film_finish_config", "master_config"];
  const BAD: Array<{ label: string; value: unknown }> = [
    { label: "string", value: "garbage" },
    { label: "array", value: [1] },
    { label: "number", value: 7 },
    { label: "null", value: null },
  ];
  for (const map of MODULE_MAPS) {
    for (const bad of BAD) {
      it(`${map}.subtitle as ${bad.label} -> 400 naming the dotted path`, async () => {
        h.started = [];
        const body: Record<string, unknown> = {
          bundle_key: "bundles/good.tar.gz",
          scenes: SCENES,
          motion_backend: "alibaba-wan",
        };
        body[map] = { subtitle: bad.value };
        const res = await worker.fetch(post("/api/render/film", body), env, ctx);
        expect(res.status, `${map}.subtitle=${bad.label}`).toBe(400);
        const parsed = (await res.json()) as { error?: string };
        expect(parsed.error ?? "").toContain(`${map}.subtitle`);
        expect(h.started.length, "must bounce before startFilmJob").toBe(0);
      });
    }
  }

  it("control: a nested OBJECT per-module entry still passes and forwards verbatim", async () => {
    h.started = [];
    h.insertThrows = false;
    const ffc = { subtitle: { mode: "both" } };
    const res = await worker.fetch(
      post("/api/render/film", {
        bundle_key: "bundles/good.tar.gz",
        scenes: SCENES,
        motion_backend: "alibaba-wan",
        film_finish_config: ffc,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started[0].film_finish_config).toEqual(ffc);
  });
});
