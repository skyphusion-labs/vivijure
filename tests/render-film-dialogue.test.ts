import { describe, it, expect, vi } from "vitest";

// Issue #296: hStartFilm (POST /api/render/film) did not read or forward dialogue_lines, so a film
// submitted via the Slate path rendered silent (the dialogue/TTS + lip-sync stage and the subtitle
// module both read job.dialogue_lines). startFilmJob already accepts the arg; the regression was the
// handler dropping it. This locks the forward by spying startFilmJob and asserting it receives the
// body's dialogue_lines verbatim. The DB / row writes are stubbed: this is a handler-wiring lock.

type CapturedArgs = { dialogue_lines?: unknown; scenes?: unknown; pretrained_loras?: unknown; quality_tier?: unknown };
const h = vi.hoisted(() => ({ captured: null as CapturedArgs | null, bundleScenes: [] as Array<{ shot_id: string; prompt: string; seconds: number; dialogue?: { slot: string; text: string } }> }));

vi.mock("../src/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("../src/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: CapturedArgs) => {
      h.captured = args;
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
  return { ...actual, readBundleScenes: vi.fn(async () => h.bundleScenes) };
});

// #582: stub the cast resolve so a cast_loras arg yields voices without a D1 cast table. Wren's
// shape: slot A -> a cast member whose voice is asteria.
vi.mock("../src/cast-loras", async (orig) => {
  const actual = await orig<typeof import("../src/cast-loras")>();
  return {
    ...actual,
    resolveCastLoras: vi.fn(async (_env: unknown, castLoras: Record<string, unknown> | undefined) =>
      castLoras && Object.keys(castLoras).length
        ? { pretrained: {}, voices: { A: "asteria" }, castIds: { A: 4 }, skipped: [], skippedDetail: [] }
        : { pretrained: {}, voices: {}, castIds: {}, skipped: [], skippedDetail: [] },
    ),
  };
});

import worker from "../src/index";
import { startFilmJob } from "../src/film-orchestrator";
import { resolveCastLoras } from "../src/cast-loras";
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

function postFilm(body: unknown): Request {
  // #504: a full film now requires an explicit, serving motion.backend at the door. Default it here (a
  // body that sets its own still wins) so these tests exercise dialogue behavior, not the backend preflight.
  const withBackend = { motion_backend: "alibaba-wan", ...(body as Record<string, unknown>) };
  return new Request("https://studio.example/api/render/film", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withBackend),
  });
}

describe("POST /api/render/film forwards dialogue_lines (issue #296)", () => {
  it("hands the body's dialogue_lines to startFilmJob", async () => {
    h.captured = null;
    const dialogue_lines = [
      { shot_id: "shot_01", text: "We have to move.", voice_id: "aura-asteria-en" },
      { shot_id: "shot_02", text: "Right behind you.", voice_id: "aura-orion-en" },
    ];
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/talking.tar.gz",
        scenes: [
          { shot_id: "shot_01", prompt: "A speaks", seconds: 4 },
          { shot_id: "shot_02", prompt: "B answers", seconds: 4 },
        ],
        dialogue_lines,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(startFilmJob).toHaveBeenCalledTimes(1);
    const captured = h.captured as CapturedArgs | null;
    expect(captured).not.toBeNull();
    expect(captured?.dialogue_lines).toEqual(dialogue_lines);
  });

  it("a film with no dialogue_lines forwards undefined (silent film, unchanged behavior)", async () => {
    h.captured = null;
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/silent.tar.gz",
        scenes: [{ shot_id: "shot_01", prompt: "an empty room", seconds: 4 }],
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.dialogue_lines).toBeUndefined();
  });
});

describe("POST /api/render/film derives dialogue_lines from the bundle when none given (issue #313)", () => {
  it("a dialogue-bearing bundle with NO explicit dialogue_lines renders voiced (derived + default voice)", async () => {
    h.captured = null;
    h.bundleScenes = [
      { shot_id: "shot_01", prompt: "A speaks", seconds: 4, dialogue: { slot: "A", text: "We move now." } },
      { shot_id: "shot_02", prompt: "silent", seconds: 4 },
    ];
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/talking.tar.gz",
        scenes: [
          { shot_id: "shot_01", prompt: "A speaks", seconds: 4 },
          { shot_id: "shot_02", prompt: "silent", seconds: 4 },
        ],
        // no dialogue_lines, no cast_loras -> derive from bundle, default voice
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.dialogue_lines).toEqual([
      { shot_id: "shot_01", text: "We move now.", voice_id: "angus" },
    ]);
  });

  it("an explicit dialogue_lines arg WINS over the bundle (no derive)", async () => {
    h.captured = null;
    h.bundleScenes = [{ shot_id: "shot_01", prompt: "x", seconds: 4, dialogue: { slot: "A", text: "from bundle" } }];
    const explicit = [{ shot_id: "shot_01", text: "from arg", voice_id: "orion" }];
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/talking.tar.gz",
        scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
        dialogue_lines: explicit,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.dialogue_lines).toEqual(explicit);
  });

  it("a bundle with NO dialogue stays silent (derived lines empty -> undefined on the job)", async () => {
    h.captured = null;
    h.bundleScenes = [{ shot_id: "shot_01", prompt: "an empty room", seconds: 4 }];
    const res = await worker.fetch(
      postFilm({ bundle_key: "bundles/silent.tar.gz", scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }] }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.dialogue_lines).toBeUndefined();
  });
});

// vivijure #582: explicit dialogue_lines WITHOUT a voice_id must resolve the shot's speaking slot to
// its cast voice via cast_loras -- not fall to the default while the record and the operator's mental
// model say the cast member "has a voice" (Wren, asteria, spoke as angus in film-08dd5777).
describe("POST /api/render/film resolves cast voices for explicit dialogue_lines (#582)", () => {
  const SCENES = [{ shot_id: "shot_01", prompt: "Wren speaks", seconds: 4 }];
  const BUNDLE = [{ shot_id: "shot_01", prompt: "x", seconds: 4, dialogue: { slot: "A", text: "storyboard line" } }];

  it("the film-08dd5777 shape: voiceless explicit line + cast_loras -> the CAST voice", async () => {
    h.captured = null;
    h.bundleScenes = BUNDLE;
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/wren.tar.gz", scenes: SCENES,
        cast_loras: { A: "cast-pub-id" },
        dialogue_lines: [{ shot_id: "shot_01", text: "We move now." }],
      }),
      env, ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.dialogue_lines).toEqual([
      { shot_id: "shot_01", text: "We move now.", voice_id: "asteria" },
    ]);
  });

  it("an explicit line voice_id still wins over the cast voice", async () => {
    h.captured = null;
    h.bundleScenes = BUNDLE;
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/wren.tar.gz", scenes: SCENES,
        cast_loras: { A: "cast-pub-id" },
        dialogue_lines: [{ shot_id: "shot_01", text: "x", voice_id: "orion" }],
      }),
      env, ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.dialogue_lines).toEqual([
      { shot_id: "shot_01", text: "x", voice_id: "orion" },
    ]);
  });

  it("without cast_loras a voiceless explicit line is forwarded untouched (downstream default)", async () => {
    h.captured = null;
    h.bundleScenes = BUNDLE;
    const explicit = [{ shot_id: "shot_01", text: "no cast bound" }];
    const res = await worker.fetch(
      postFilm({ bundle_key: "bundles/wren.tar.gz", scenes: SCENES, dialogue_lines: explicit }),
      env, ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.dialogue_lines).toEqual(explicit);
  });
});


describe("#738 hStartFilm rejects a bound-but-untrained cast_loras (symmetry with hSubmitRender)", () => {
  it("400s with the untrained-cast message and never starts the film (no silent generic render)", async () => {
    h.captured = null;
    // resolveCastLoras SKIPS an untrained cast (adds to skipped/skippedDetail) rather than throwing.
    // Before #738 hStartFilm ignored that and shipped a generic film; now it must 400 like hSubmitRender.
    vi.mocked(resolveCastLoras).mockResolvedValueOnce({
      pretrained: {},
      voices: {},
      castIds: { A: 4 },
      skipped: ["A"],
      skippedDetail: [{ slot: "A", name: "Wren", reason: "no trained LoRA" }],
    });
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/cast.tar.gz",
        scenes: [{ shot_id: "shot_01", prompt: "Wren stands in a field", seconds: 4 }],
        cast_loras: { A: "public-id-wren" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toContain("no trained LoRA");
    expect(parsed.error ?? "").toContain("Wren");
    // startFilmJob is the mock that records into h.captured; a 400 before it means h.captured stays null.
    expect(h.captured).toBeNull();
  });
});


// #762: hStartFilm resolved the ready cast adapters (resolvedLoras.pretrained) but the startFilmJob call
// forwarded ONLY dialogue_lines + cast_loras, DROPPING pretrained_loras -- so the keyframe worker got no
// banked adapter and RETRAINED every ready cast LoRA from scratch (~20 min, no signal). film-09d40b28 sat
// 23 min in keyframe retraining Wren + the Salvage Robot, both lora_status:ready. hSubmitRender (the render
// route) forwards it; the film route was never patched to match. These lock the forward the way the #296
// dialogue_lines test locks that one. quality_tier is the second forward (row-label honesty, see below).
describe("POST /api/render/film forwards pretrained_loras + qualityTier (#762)", () => {
  it("Bug 1: forwards the ready cast adapters as pretrained_loras (no retrain-from-scratch)", async () => {
    h.captured = null;
    vi.mocked(resolveCastLoras).mockResolvedValueOnce({
      pretrained: { A: "loras/wren.safetensors", B: "loras/salvage-robot.safetensors" },
      voices: {},
      castIds: { A: 4, B: 7 },
      skipped: [],
      skippedDetail: [],
    });
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/cast.tar.gz",
        scenes: [{ shot_id: "shot_01", prompt: "Wren and the salvage robot", seconds: 4 }],
        cast_loras: { A: "pub-wren", B: "pub-robot" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    // Fails on pre-#762 code: the handler dropped pretrained_loras, so captured.pretrained_loras was undefined.
    expect((h.captured as CapturedArgs | null)?.pretrained_loras).toEqual({
      A: "loras/wren.safetensors",
      B: "loras/salvage-robot.safetensors",
    });
  });

  it("a film with no ready adapters forwards pretrained_loras undefined (unchanged, no empty map on the wire)", async () => {
    h.captured = null;
    const res = await worker.fetch(
      postFilm({ bundle_key: "bundles/x.tar.gz", scenes: [{ shot_id: "shot_01", prompt: "an empty room", seconds: 4 }] }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.pretrained_loras).toBeUndefined();
  });

  it("Bug 2: forwards the requested qualityTier (draft stays draft, not hardcoded final)", async () => {
    h.captured = null;
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/x.tar.gz",
        scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
        qualityTier: "draft",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    // Fails on pre-#762 code: hStartFilm never read qualityTier, so captured.quality_tier was undefined.
    expect((h.captured as CapturedArgs | null)?.quality_tier).toBe("draft");
  });

  it("an absent qualityTier forwards undefined (filmRowFromJob then defaults final)", async () => {
    h.captured = null;
    const res = await worker.fetch(
      postFilm({ bundle_key: "bundles/x.tar.gz", scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }] }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.quality_tier).toBeUndefined();
  });

  it("an invalid qualityTier coerces to undefined (no bad tier leaks onto the job/row)", async () => {
    h.captured = null;
    const res = await worker.fetch(
      postFilm({
        bundle_key: "bundles/x.tar.gz",
        scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
        qualityTier: "ultra",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect((h.captured as CapturedArgs | null)?.quality_tier).toBeUndefined();
  });
});
