import { describe, it, expect } from "vitest";
import {
  coerceConfig,
  hasCards,
  buildContainerSpec,
  passthroughOutput,
  type TitlesConfig,
} from "../modules/film-titles/src/film-titles";
import type { FilmFinishInput } from "../modules/film-titles/src/contract";

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
