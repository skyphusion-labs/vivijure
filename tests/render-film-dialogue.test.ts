import { describe, it, expect, vi } from "vitest";

// Issue #296: hStartFilm (POST /api/render/film) did not read or forward dialogue_lines, so a film
// submitted via the Slate path rendered silent (the dialogue/TTS + lip-sync stage and the subtitle
// module both read job.dialogue_lines). startFilmJob already accepts the arg; the regression was the
// handler dropping it. This locks the forward by spying startFilmJob and asserting it receives the
// body's dialogue_lines verbatim. The DB / row writes are stubbed: this is a handler-wiring lock.

type CapturedArgs = { dialogue_lines?: unknown; scenes?: unknown };
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

import worker from "../src/index";
import { startFilmJob } from "../src/film-orchestrator";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const env = { ASSETS: { fetch: async () => new Response("ASSET") } } as unknown as Env;

function postFilm(body: unknown): Request {
  return new Request("https://studio.example/api/render/film", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
