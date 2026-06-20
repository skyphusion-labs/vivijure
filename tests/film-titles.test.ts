import { describe, it, expect } from "vitest";
import {
  coerceConfig,
  hasCards,
  buildContainerSpec,
  passthroughOutput,
  type TitlesConfig,
} from "../modules/film-titles/src/film-titles";
import type { FilmFinishInput } from "../modules/film-titles/src/contract";
import worker from "../modules/film-titles/src/index";

const baseInput = (over: Partial<FilmFinishInput> = {}): FilmFinishInput => ({
  film_key: "renders/film-x/film.mp4",
  video_url: "https://r2/get",
  output_url: "https://r2/put",
  output_key: "renders/film-x/film_titled.mp4",
  width: 1920,
  height: 1080,
  fps: 24,
  ...over,
});

describe("film-titles pure logic", () => {
  it("coerceConfig clamps + defaults", () => {
    expect(coerceConfig({})).toEqual<TitlesConfig>({
      font: "DejaVu Sans", color: "white", bg: "black", title_seconds: 3, credit_seconds: 5,
    });
    expect(coerceConfig({ title_seconds: 99, credit_seconds: 0, font: "Impact" })).toMatchObject({
      font: "Impact", title_seconds: 15, credit_seconds: 1,
    });
  });

  it("hasCards is true only with a non-empty title or credits", () => {
    expect(hasCards(baseInput())).toBe(false);
    expect(hasCards(baseInput({ title: { text: "  " } }))).toBe(false);
    expect(hasCards(baseInput({ title: { text: "NEON HALFLIFE" } }))).toBe(true);
    expect(hasCards(baseInput({ credits: { lines: ["  ", ""] } }))).toBe(false);
    expect(hasCards(baseInput({ credits: { lines: ["directed by you"] } }))).toBe(true);
  });

  it("buildContainerSpec forwards presigned urls + only includes present cards", () => {
    const cfg = coerceConfig({});
    const noCards = buildContainerSpec(baseInput(), cfg);
    expect(noCards).toMatchObject({ videoUrl: "https://r2/get", outputUrl: "https://r2/put", width: 1920, height: 1080, fps: 24 });
    expect(noCards.title).toBeUndefined();
    expect(noCards.credits).toBeUndefined();

    const full = buildContainerSpec(
      baseInput({ title: { text: "NEON HALFLIFE", subtitle: "a film by you" }, credits: { lines: ["directed by you", "", "music: MiniMax"] } }),
      cfg,
    );
    expect(full.title).toEqual({ text: "NEON HALFLIFE", subtitle: "a film by you", seconds: 3 });
    // empty credit lines are dropped
    expect(full.credits).toEqual({ lines: ["directed by you", "music: MiniMax"], seconds: 5 });
  });

  it("passthroughOutput keeps the original film_key", () => {
    const out = passthroughOutput(baseInput(), "noop:no-cards");
    expect(out.film_key).toBe("renders/film-x/film.mp4");
    expect(out.applied).toEqual(["noop:no-cards"]);
    expect(out.degraded).toBeUndefined();
    expect(passthroughOutput(baseInput(), "passthrough:container-failed", { degraded: true }).degraded).toBe("passthrough:container-failed");
  });
});


// Module invoke path (default export). Guards the bug where a BARE "/film-titles" URL throws in the
// Workers runtime, gets masked as "container-unreachable", and ships the film UNCARDED at phase=done.
describe("film-titles module invoke (#207 regression)", () => {
  function vpcEnv(over: { status?: number; body?: unknown; throws?: boolean } = {}) {
    const calls: string[] = [];
    const env = {
      VIDEO_FINISH_VPC: {
        async fetch(input: Request | string) {
          calls.push(typeof input === "string" ? input : input.url);
          if (over.throws) throw new TypeError("Invalid URL");
          return new Response(JSON.stringify(over.body ?? { ok: true, key: "renders/film-x/film_titled.mp4" }), {
            status: over.status ?? 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    return { env, calls };
  }

  const invoke = (input: FilmFinishInput) =>
    new Request("https://module/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook: "film.finish", input, config: {}, context: {} }),
    });

  it("calls the container with an ABSOLUTE url and applies the cards (not degraded)", async () => {
    const { env, calls } = vpcEnv();
    const res = await worker.fetch(invoke(baseInput({ title: { text: "NEON HALFLIFE" } })), env);
    const json = (await res.json()) as { ok: boolean; output: { film_key: string; applied: string[]; degraded?: string } };
    // The whole bug: a bare path threw. Assert a parseable absolute URL with the right path.
    expect(calls).toHaveLength(1);
    expect(() => new URL(calls[0])).not.toThrow();
    expect(new URL(calls[0]).pathname).toBe("/film-titles");
    expect(json.ok).toBe(true);
    expect(json.output.film_key).toBe("renders/film-x/film_titled.mp4"); // the carded film, not the original
    expect(json.output.applied).toEqual(["film-titles"]);
    expect(json.output.degraded).toBeUndefined();
  });

  it("soft-degrades (fail-safe) when the container is unreachable, keeping the original film", async () => {
    const { env } = vpcEnv({ throws: true });
    const res = await worker.fetch(invoke(baseInput({ title: { text: "NEON HALFLIFE" } })), env);
    const json = (await res.json()) as { ok: boolean; output: { film_key: string; degraded?: string } };
    expect(json.ok).toBe(true); // never drops the film
    expect(json.output.film_key).toBe("renders/film-x/film.mp4"); // original (uncarded)
    expect(json.output.degraded).toBe("passthrough:container-unreachable");
  });

  it("no-ops without round-tripping the container when there are no cards", async () => {
    const { env, calls } = vpcEnv();
    const res = await worker.fetch(invoke(baseInput()), env);
    const json = (await res.json()) as { ok: boolean; output: { degraded?: string } };
    expect(calls).toHaveLength(0);
    expect(json.ok).toBe(true);
    expect(json.output.degraded).toBeUndefined();
  });
});
