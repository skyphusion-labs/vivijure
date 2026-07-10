import { describe, it, expect } from "vitest";
import {
  coerceConfig,
  hasCards,
  hasTitleCard,
  buildContainerSpec,
  passthroughOutput,
  completedOutput,
  encodePoll,
  decodePoll,
  type TitlesConfig,
  type FinishPoll,
} from "../modules/film-titles/src/film-titles";
import type { FilmFinishInput } from "../modules/film-titles/src/contract";
import worker from "../modules/film-titles/src/index";
import { checkHookOutput } from "../src/modules/conformance";

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


// Module invoke path (default export). #602: the module is ASYNC-FIRST -- it submits to the container's
// /async/film-titles route and returns a poll token; the core drives submit+poll across ticks. It FALLS
// BACK to the synchronous /film-titles route on a pre-#602 container. Both use ABSOLUTE URLs (the #207
// bare-path bug: a bare "/film-titles" throws in the Workers runtime, masked as "container-unreachable").
describe("film-titles module invoke (#602 async + #207 regression)", () => {
  function vpcEnv(over: {
    asyncSupported?: boolean;
    statusResult?: { status: string; result?: unknown; error?: string };
    syncStatus?: number;
    syncBody?: unknown;
    throws?: boolean;
  } = {}) {
    const calls: string[] = [];
    const asyncSupported = over.asyncSupported ?? true;
    const j = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const env = {
      VIDEO_FINISH_VPC: {
        async fetch(input: Request | string) {
          const url = typeof input === "string" ? input : input.url;
          calls.push(url);
          if (over.throws) throw new TypeError("Invalid URL");
          const path = new URL(url).pathname;
          if (path.startsWith("/async/status/")) {
            const st = over.statusResult ?? { status: "completed", result: { ok: true, key: "renders/film-x/film_titled.mp4" } };
            return j(st, st.status === "not_found" ? 404 : 200);
          }
          if (path.startsWith("/async/")) {
            return asyncSupported ? j({ ok: true, jobId: "job-abc", status: "pending" }, 202) : j({ ok: false, error: "unknown async route" }, 404);
          }
          return j(over.syncBody ?? { ok: true, key: "renders/film-x/film_titled.mp4" }, over.syncStatus ?? 200);
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
  const pollReq = (token: string) =>
    new Request("https://module/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poll: token }),
    });

  it("submits async and returns a poll token (absolute /async URL, #207)", async () => {
    const { env, calls } = vpcEnv();
    const res = await worker.fetch(invoke(baseInput({ title: { text: "NEON HALFLIFE" } })), env);
    const json = (await res.json()) as { ok: boolean; pending?: boolean; poll?: string };
    expect(calls).toHaveLength(1);
    expect(() => new URL(calls[0])).not.toThrow();
    expect(new URL(calls[0]).pathname).toBe("/async/film-titles");
    expect(json.ok).toBe(true);
    expect(json.pending).toBe(true);
    expect(typeof json.poll).toBe("string");
  });

  it("polls to the DETERMINISTIC carded film on completion (not degraded)", async () => {
    const { env } = vpcEnv();
    const sub = (await (await worker.fetch(invoke(baseInput({ title: { text: "NEON HALFLIFE" } })), env)).json()) as { poll: string };
    const res = await worker.fetch(pollReq(sub.poll), env);
    const json = (await res.json()) as { ok: boolean; output: { film_key: string; applied: string[]; degraded?: string } };
    expect(json.ok).toBe(true);
    expect(json.output.film_key).toBe("renders/film-x/film_titled.mp4"); // the carded film, not the original
    expect(json.output.applied).toEqual(["film-titles"]);
    expect(json.output.degraded).toBeUndefined();
  });

  it("falls back to the SYNCHRONOUS route on a pre-#602 container (absolute URLs)", async () => {
    const { env, calls } = vpcEnv({ asyncSupported: false });
    const res = await worker.fetch(invoke(baseInput({ title: { text: "NEON HALFLIFE" } })), env);
    const json = (await res.json()) as { ok: boolean; output: { film_key: string; applied: string[] } };
    expect(calls.map((c) => new URL(c).pathname)).toEqual(["/async/film-titles", "/film-titles"]);
    expect(json.ok).toBe(true);
    expect(json.output.film_key).toBe("renders/film-x/film_titled.mp4");
    expect(json.output.applied).toEqual(["film-titles"]);
  });

  it("poll surfaces a container job FAILURE (ok:false -> the core soft-degrades, fail-safe)", async () => {
    const { env } = vpcEnv({ statusResult: { status: "failed", error: "ffmpeg boom" } });
    const sub = (await (await worker.fetch(invoke(baseInput({ title: { text: "X" } })), env)).json()) as { poll: string };
    const res = await worker.fetch(pollReq(sub.poll), env);
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("container job failed");
  });

  it("poll stays pending while the container job is still running", async () => {
    const { env } = vpcEnv({ statusResult: { status: "pending" } });
    const sub = (await (await worker.fetch(invoke(baseInput({ title: { text: "X" } })), env)).json()) as { poll: string };
    const json = (await (await worker.fetch(pollReq(sub.poll), env)).json()) as { ok: boolean; pending?: boolean };
    expect(json.ok).toBe(true);
    expect(json.pending).toBe(true);
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


// #663: film-titles PREPENDS an opening title card, shifting the FINAL film`s timeline. It reports the
// prepend duration as `prepend_seconds` so the core can re-time the subtitle .srt sidecar to match. Only a
// real TITLE card counts -- credits append at the END and never shift cues.
describe("film-titles prepend_seconds reporting (#663)", () => {
  function vpcEnv(over: { asyncSupported?: boolean } = {}) {
    const asyncSupported = over.asyncSupported ?? true;
    const j = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const env = {
      VIDEO_FINISH_VPC: {
        async fetch(input: Request | string) {
          const path = new URL(typeof input === "string" ? input : input.url).pathname;
          if (path.startsWith("/async/status/")) return j({ status: "completed", result: { ok: true, key: "renders/film-x/film_titled.mp4" } });
          if (path.startsWith("/async/")) return asyncSupported ? j({ ok: true, jobId: "job-abc" }, 202) : j({ ok: false }, 404);
          return j({ ok: true, key: "renders/film-x/film_titled.mp4" });
        },
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    return { env };
  }
  const invokeCfg = (input: FilmFinishInput, config: Record<string, unknown>) =>
    new Request("https://module/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook: "film.finish", input, config, context: {} }),
    });
  const pollReq = (token: string) =>
    new Request("https://module/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poll: token }),
    });
  const withTitle = (over: Partial<FilmFinishInput> = {}): FilmFinishInput => ({
    film_key: "renders/film-x/film.mp4",
    video_url: "https://r2/get",
    output_url: "https://r2/put",
    output_key: "renders/film-x/film_titled.mp4",
    width: 1920,
    height: 1080,
    fps: 24,
    title: { text: "NEON HALFLIFE" },
    ...over,
  });

  it("hasTitleCard is true ONLY for a non-empty opening title (credits do not count)", () => {
    expect(hasTitleCard(withTitle())).toBe(true);
    expect(hasTitleCard(withTitle({ title: { text: "   " } }))).toBe(false);
    expect(hasTitleCard(withTitle({ title: undefined, credits: { lines: ["directed by you"] } }))).toBe(false);
  });

  it("completedOutput reports prepend_seconds = the title card duration, omits it when there is no title", () => {
    const st: FinishPoll = { jobId: "j", filmKey: "renders/film-x/film.mp4", outputKey: "renders/film-x/film-ff1.mp4", submittedAt: 0, titleSeconds: 3 };
    const out = completedOutput({ key: "renders/film-x/film-ff1.mp4" }, st);
    expect(out.prepend_seconds).toBe(3);
    // credits-only / no title -> titleSeconds 0 -> field omitted (no prepend)
    const outNoTitle = completedOutput({ key: "renders/film-x/film-ff1.mp4" }, { ...st, titleSeconds: 0 });
    expect(outNoTitle.prepend_seconds).toBeUndefined();
  });

  it("the async poll token carries titleSeconds (survives encode/decode; legacy tokens default to 0)", () => {
    const token = encodePoll({ jobId: "j", filmKey: "f", outputKey: "o", submittedAt: 10, titleSeconds: 8 });
    expect(decodePoll(token)?.titleSeconds).toBe(8);
    // a pre-#663 token with no titleSeconds decodes to 0 (no prepend reported)
    const legacy = btoa(JSON.stringify({ jobId: "j", filmKey: "f", outputKey: "o", submittedAt: 10 }));
    expect(decodePoll(legacy)?.titleSeconds).toBe(0);
  });

  it("async invoke -> poll surfaces prepend_seconds = clamped title_seconds when a title card renders", async () => {
    const { env } = vpcEnv();
    const sub = (await (await worker.fetch(invokeCfg(withTitle(), { title_seconds: 8 }), env)).json()) as { poll: string };
    const out = (await (await worker.fetch(pollReq(sub.poll), env)).json()) as { output: { prepend_seconds?: number } };
    expect(out.output.prepend_seconds).toBe(8);
  });

  it("async credits-only invoke reports NO prepend_seconds (credits append at the end)", async () => {
    const { env } = vpcEnv();
    const creditsOnly = withTitle({ title: undefined, credits: { lines: ["directed by you"] } });
    const sub = (await (await worker.fetch(invokeCfg(creditsOnly, {}), env)).json()) as { poll: string };
    const out = (await (await worker.fetch(pollReq(sub.poll), env)).json()) as { output: { prepend_seconds?: number } };
    expect(out.output.prepend_seconds).toBeUndefined();
  });

  it("the SYNC fallback also reports prepend_seconds with a title card", async () => {
    const { env } = vpcEnv({ asyncSupported: false });
    const out = (await (await worker.fetch(invokeCfg(withTitle(), {}), env)).json()) as { output: { prepend_seconds?: number; applied: string[] } };
    expect(out.output.applied).toEqual(["film-titles"]);
    expect(out.output.prepend_seconds).toBe(3); // default title_seconds
  });

  it("prepend_seconds passes the film.finish conformance output check", () => {
    expect(checkHookOutput("film.finish", { film_key: "k", applied: ["film-titles"], prepend_seconds: 3 }).pass).toBe(true);
    expect(checkHookOutput("film.finish", { film_key: "k", applied: ["film-titles"], prepend_seconds: -1 }).pass).toBe(false);
    expect(checkHookOutput("film.finish", { film_key: "k", applied: ["film-titles"], prepend_seconds: Number.NaN }).pass).toBe(false);
  });
});
