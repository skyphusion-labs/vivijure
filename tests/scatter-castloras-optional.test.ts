import { describe, it, expect, vi } from "vitest";

// #739: castLoras is OPTIONAL on scatter. The old startScatterRender guard hard-required a trained cast
// LoRA ("castLoras required for scatter"), unintended coupling baked in at the v0.2.0 bulk ship. The
// relax: absent/empty castLoras renders generic shards (like the film/render siblings); a PRESENT-but-
// untrained binding still fails hard (the #738-symmetric untrained-cast message), turned into a 400 at
// the hScatter door. These tests pin BOTH halves and are red on main.

const h = vi.hoisted(() => ({ scatterStarted: 0 }));

// Control cast resolution: {A:"untrained"} -> a skipped (not-ready) binding; anything else -> empty.
vi.mock("../src/cast-loras", async (orig) => {
  const actual = await orig<typeof import("../src/cast-loras")>();
  return {
    ...actual, // keep the REAL untrainedCastMessage so the assertions see the real text
    resolveCastLoras: vi.fn(async (_env: unknown, castLoras: Record<string, unknown> | undefined) =>
      castLoras && castLoras.A === "untrained"
        ? { pretrained: {}, voices: {}, castIds: { A: 7 }, skipped: ["A"], skippedDetail: [{ slot: "A", name: "Wren", reason: "no trained LoRA" as const }] }
        : { pretrained: {}, voices: {}, castIds: {}, skipped: [], skippedDetail: [] }),
  };
});
// Distinctive throw so the orchestrator test can prove it got PAST the cast guard (to readBundleScenes)
// on the fix, vs stopping at the guard on main.
vi.mock("../src/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("../src/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => { throw new Error("BUNDLE_STUB_REACHED"); }) };
});
vi.mock("../src/renders-db", async (orig) => {
  const actual = await orig<typeof import("../src/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => {}) };
});

import worker from "../src/index";
import { startScatterRender } from "../src/scatter-orchestrator";
import { MODULE_API } from "../src/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
function fakeModule(manifest: unknown) {
  return { fetch: async () => new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } }) };
}
function env(): Env {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET") },
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MODULE_KEYFRAME: fakeModule({ name: "cloud-keyframe", version: "0.1.0", api: MODULE_API, hooks: ["keyframe"] }),
    MODULE_ALIBABA_WAN: fakeModule({ name: "alibaba-wan", version: "0.1.0", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 10, locality: "cloud" } }),
  } as unknown as Env;
}
function postScatter(body: unknown): Request {
  return new Request("https://studio.example/api/storyboard/render/scatter", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const BASE = { bundleKey: "bundles/x.tar.gz", shotIds: ["shot_01", "shot_02"], motion_backend: "alibaba-wan" };
const ORCH_ARGS = { project: "p", bundle_key: "bundles/x.tar.gz", quality_tier: "draft" as const, shot_ids: ["shot_01", "shot_02"], shard_count: 2, render_overrides: undefined, motion_backend: "alibaba-wan", audio_key: undefined, film_titles: undefined, project_id: null };

describe("#739 hScatter cast door: PRESENT-but-untrained castLoras -> 400 (never a silent drop)", () => {
  it("400s with the untrained-cast message, symmetric with hSubmitRender/hStartFilm", async () => {
    h.scatterStarted = 0;
    const res = await worker.fetch(postScatter({ ...BASE, castLoras: { A: "untrained" } }), env(), ctx);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toContain("no trained LoRA");
    expect(parsed.error ?? "").toContain("Wren");
  });
});

describe("#739 startScatterRender: castLoras is OPTIONAL (empty/absent allowed)", () => {
  it("does NOT reject with the old 'castLoras required for scatter' -- it proceeds past the cast guard", async () => {
    // Empty cast: on main this throws 'castLoras required for scatter' at the guard; on the fix it passes
    // the guard and reaches readBundleScenes (the stubbed BUNDLE_STUB_REACHED throw).
    await expect(startScatterRender(env(), { ...ORCH_ARGS, cast_loras: {} }))
      .rejects.toThrow("BUNDLE_STUB_REACHED");
  });
  it("a PRESENT-but-untrained binding still throws the untrained-cast message (the split)", async () => {
    await expect(startScatterRender(env(), { ...ORCH_ARGS, cast_loras: { A: "untrained" } }))
      .rejects.toThrow(/no trained LoRA/);
  });
});
