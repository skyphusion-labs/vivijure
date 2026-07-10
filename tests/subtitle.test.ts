import { describe, it, expect } from "vitest";
import {
  coerceConfig,
  hasCaptions,
  cleanCues,
  formatTimestamp,
  buildSrt,
  buildContainerSpec,
  passthroughOutput,
  type SubtitleConfig,
} from "../modules/subtitle/src/subtitle";
import type { FilmFinishInput, CaptionCue } from "../modules/subtitle/src/contract";
import worker from "../modules/subtitle/src/index";
import { checkHookOutput } from "../src/modules/conformance";

const cues: CaptionCue[] = [
  { start: 0, end: 3, text: "Hello there" },
  { start: 7, end: 9.5, text: "Goodbye" },
];

const baseInput = (over: Partial<FilmFinishInput> = {}): FilmFinishInput => ({
  film_key: "renders/film-x/film.mp4",
  video_url: "https://r2/get",
  output_url: "https://r2/put",
  output_key: "renders/film-x/film_subbed.mp4",
  width: 1920,
  height: 1080,
  fps: 24,
  captions: cues,
  sidecar_url: "https://r2/put-srt",
  sidecar_key: "renders/film-x/film.srt",
  ...over,
});

describe("subtitle pure logic", () => {
  it("coerceConfig clamps + defaults", () => {
    expect(coerceConfig({})).toEqual<SubtitleConfig>({
      enabled: true, mode: "burn", font: "DejaVu Sans", font_size: 28, color: "white",
      position: "bottom", box_style: "outline", margin_v: 36,
    });
    expect(coerceConfig({ font_size: 999, margin_v: -5, mode: "both", position: "top", box_style: "box", enabled: false }))
      .toMatchObject({ font_size: 120, margin_v: 0, mode: "both", position: "top", box_style: "box", enabled: false });
    // unknown enum values fall back to the default, not through
    expect(coerceConfig({ mode: "nonsense", position: "diagonal" })).toMatchObject({ mode: "burn", position: "bottom" });
  });

  it("hasCaptions is true only with at least one renderable cue", () => {
    expect(hasCaptions(baseInput())).toBe(true);
    expect(hasCaptions(baseInput({ captions: [] }))).toBe(false);
    expect(hasCaptions(baseInput({ captions: undefined }))).toBe(false);
    expect(hasCaptions(baseInput({ captions: [{ start: 0, end: 1, text: "   " }] }))).toBe(false);
  });

  it("formatTimestamp renders SubRip HH:MM:SS,mmm", () => {
    expect(formatTimestamp(0)).toBe("00:00:00,000");
    expect(formatTimestamp(3.5)).toBe("00:00:03,500");
    expect(formatTimestamp(61.25)).toBe("00:01:01,250");
    expect(formatTimestamp(3661.007)).toBe("01:01:01,007");
    expect(formatTimestamp(-5)).toBe("00:00:00,000"); // clamped
  });

  it("cleanCues drops empties, clamps start, and guarantees end > start", () => {
    const out = cleanCues([
      { start: -1, end: 2, text: "  clamp start  " },
      { start: 5, end: 5, text: "zero length" }, // end gets bumped
      { start: 1, end: 2, text: "   " },          // dropped
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ start: 0, end: 2, text: "clamp start" });
    expect(out[1].end).toBeGreaterThan(out[1].start);
  });

  it("buildSrt renumbers cues from 1 with the right timing block", () => {
    expect(buildSrt(cues)).toBe(
      "1\n00:00:00,000 --> 00:00:03,000\nHello there\n\n2\n00:00:07,000 --> 00:00:09,500\nGoodbye\n",
    );
    expect(buildSrt([])).toBe("");
  });

  it("buildContainerSpec forwards urls + style and includes the sidecar only when wanted", () => {
    const burnSpec = buildContainerSpec(baseInput(), coerceConfig({}), "SRT");
    expect(burnSpec).toMatchObject({
      videoUrl: "https://r2/get", outputUrl: "https://r2/put", outputKey: "renders/film-x/film_subbed.mp4",
      srt: "SRT", mode: "burn", width: 1920, height: 1080, fps: 24,
    });
    expect(burnSpec.style).toEqual({ font: "DejaVu Sans", fontSize: 28, color: "white", position: "bottom", box: "outline", marginV: 36 });
    expect(burnSpec.sidecarUrl).toBeUndefined(); // burn-only -> no sidecar

    const bothSpec = buildContainerSpec(baseInput(), coerceConfig({ mode: "both" }), "SRT");
    expect(bothSpec.mode).toBe("both");
    expect(bothSpec.sidecarUrl).toBe("https://r2/put-srt");
    expect(bothSpec.sidecarKey).toBe("renders/film-x/film.srt");

    // sidecar requested but the core presigned no URL -> the spec degrades to burn-only
    const noUrl = buildContainerSpec(baseInput({ sidecar_url: undefined }), coerceConfig({ mode: "both" }), "SRT");
    expect(noUrl.mode).toBe("burn");
    expect(noUrl.sidecarUrl).toBeUndefined();
  });

  it("passthroughOutput keeps the original film_key and never fakes an applied tag", () => {
    const out = passthroughOutput(baseInput(), "noop:no-dialogue");
    expect(out.film_key).toBe("renders/film-x/film.mp4");
    expect(out.applied).toEqual(["noop:no-dialogue"]);
    expect(out.degraded).toBeUndefined();
    expect(passthroughOutput(baseInput(), "passthrough:container-failed", { degraded: true }).degraded)
      .toBe("passthrough:container-failed");
  });
});

// Module invoke path (default export). #602: the module is ASYNC-FIRST -- it submits to the container's
// /async/subtitle route and returns a poll token; the core drives submit+poll across ticks. It FALLS
// BACK to the synchronous /subtitle route on a pre-#602 container. Both use ABSOLUTE URLs (the #207
// bare-path bug). Also asserts the honest degrade/no-op behavior + film.finish conformance.
describe("subtitle module invoke (#602 async + honest degrade)", () => {
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
            const st = over.statusResult ?? { status: "completed", result: { ok: true, key: "renders/film-x/film_subbed.mp4", burned: true, sidecar: false } };
            return j(st, st.status === "not_found" ? 404 : 200);
          }
          if (path.startsWith("/async/")) {
            return asyncSupported ? j({ ok: true, jobId: "job-sub", status: "pending" }, 202) : j({ ok: false, error: "unknown async route" }, 404);
          }
          return j(over.syncBody ?? { ok: true, key: "renders/film-x/film_subbed.mp4", burned: true, sidecar: false }, over.syncStatus ?? 200);
        },
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    return { env, calls };
  }

  const invoke = (input: FilmFinishInput, config: Record<string, unknown> = {}) =>
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

  it("submits async and returns a poll token (absolute /async URL, #207)", async () => {
    const { env, calls } = vpcEnv();
    const res = await worker.fetch(invoke(baseInput()), env);
    const json = (await res.json()) as { ok: boolean; pending?: boolean; poll?: string };
    expect(calls).toHaveLength(1);
    expect(() => new URL(calls[0])).not.toThrow();
    expect(new URL(calls[0]).pathname).toBe("/async/subtitle");
    expect(json.ok).toBe(true);
    expect(json.pending).toBe(true);
    expect(typeof json.poll).toBe("string");
  });

  it("polls to the captioned film on completion, honoring the contract (not degraded)", async () => {
    const { env } = vpcEnv();
    const sub = (await (await worker.fetch(invoke(baseInput()), env)).json()) as { poll: string };
    const json = (await (await worker.fetch(pollReq(sub.poll), env)).json()) as { ok: boolean; output: { film_key: string; applied: string[]; degraded?: string } };
    expect(json.ok).toBe(true);
    expect(json.output.film_key).toBe("renders/film-x/film_subbed.mp4"); // the captioned film, not the original
    expect(json.output.applied).toEqual(["subtitle"]);
    expect(json.output.degraded).toBeUndefined();
    expect(checkHookOutput("film.finish", json.output).pass).toBe(true);
  });

  it("poll reports both burn and sidecar when the container wrote both", async () => {
    const { env } = vpcEnv({ statusResult: { status: "completed", result: { ok: true, key: "renders/film-x/film_subbed.mp4", burned: true, sidecar: true } } });
    const sub = (await (await worker.fetch(invoke(baseInput(), { mode: "both" }), env)).json()) as { poll: string };
    const json = (await (await worker.fetch(pollReq(sub.poll), env)).json()) as { ok: boolean; output: { film_key: string; applied: string[] } };
    expect(json.output.applied).toEqual(["subtitle", "subtitle:sidecar"]);
    expect(json.output.film_key).toBe("renders/film-x/film_subbed.mp4");
  });

  it("poll on a sidecar-only completion keeps the ORIGINAL film_key (no fake burn tag)", async () => {
    const { env } = vpcEnv({ statusResult: { status: "completed", result: { ok: true, key: "", burned: false, sidecar: true } } });
    const sub = (await (await worker.fetch(invoke(baseInput(), { mode: "both" }), env)).json()) as { poll: string };
    const json = (await (await worker.fetch(pollReq(sub.poll), env)).json()) as { ok: boolean; output: { film_key: string; applied: string[] } };
    expect(json.output.film_key).toBe("renders/film-x/film.mp4"); // unchanged
    expect(json.output.applied).toEqual(["subtitle:sidecar"]);
  });

  it("falls back to the SYNCHRONOUS route on a pre-#602 container", async () => {
    const { env, calls } = vpcEnv({ asyncSupported: false });
    const json = (await (await worker.fetch(invoke(baseInput()), env)).json()) as { ok: boolean; output: { film_key: string; applied: string[] } };
    expect(calls.map((c) => new URL(c).pathname)).toEqual(["/async/subtitle", "/subtitle"]);
    expect(json.output.film_key).toBe("renders/film-x/film_subbed.mp4");
    expect(json.output.applied).toEqual(["subtitle"]);
  });

  it("poll surfaces a container job FAILURE (ok:false -> the core soft-degrades, fail-safe)", async () => {
    const { env } = vpcEnv({ statusResult: { status: "failed", error: "libass boom" } });
    const sub = (await (await worker.fetch(invoke(baseInput()), env)).json()) as { poll: string };
    const json = (await (await worker.fetch(pollReq(sub.poll), env)).json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("container job failed");
  });

  it("soft-degrades (fail-safe) when the container is unreachable, keeping the original film", async () => {
    const { env } = vpcEnv({ throws: true });
    const res = await worker.fetch(invoke(baseInput()), env);
    const json = (await res.json()) as { ok: boolean; output: { film_key: string; degraded?: string } };
    expect(json.ok).toBe(true); // never drops the film
    expect(json.output.film_key).toBe("renders/film-x/film.mp4"); // original (uncaptioned)
    expect(json.output.degraded).toBe("passthrough:container-unreachable");
  });

  it("no-ops without round-tripping the container when there are no captions", async () => {
    const { env, calls } = vpcEnv();
    const res = await worker.fetch(invoke(baseInput({ captions: [] })), env);
    const json = (await res.json()) as { ok: boolean; output: { applied: string[]; degraded?: string } };
    expect(calls).toHaveLength(0);
    expect(json.ok).toBe(true);
    expect(json.output.applied).toEqual(["noop:no-dialogue"]);
    expect(json.output.degraded).toBeUndefined();
  });

  it("no-ops when disabled", async () => {
    const { env, calls } = vpcEnv();
    const res = await worker.fetch(invoke(baseInput(), { enabled: false }), env);
    const json = (await res.json()) as { ok: boolean; output: { applied: string[] } };
    expect(calls).toHaveLength(0);
    expect(json.output.applied).toEqual(["noop:disabled"]);
  });

  it("degrades a sidecar-only run with no presigned sidecar URL (never silent)", async () => {
    const { env, calls } = vpcEnv();
    const res = await worker.fetch(invoke(baseInput({ sidecar_url: undefined }), { mode: "sidecar" }), env);
    const json = (await res.json()) as { ok: boolean; output: { film_key: string; degraded?: string } };
    expect(calls).toHaveLength(0);
    expect(json.output.film_key).toBe("renders/film-x/film.mp4");
    expect(json.output.degraded).toBe("passthrough:sidecar-no-url");
  });

  it("rejects malformed input loudly (bad I/O fails, polish misses do not)", async () => {
    const { env } = vpcEnv();
    const res = await worker.fetch(invoke({ film_key: "", video_url: "", output_url: "", output_key: "" } as FilmFinishInput), env);
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("film.finish");
  });

  it("serves a conformant manifest at GET /module.json", async () => {
    const { env } = vpcEnv();
    const res = await worker.fetch(new Request("https://module/module.json"), env);
    const manifest = (await res.json()) as { name: string; api: string; hooks: string[]; ui?: { order?: number } };
    expect(manifest.name).toBe("subtitle");
    expect(manifest.api).toBe("vivijure-module/2");
    expect(manifest.hooks).toEqual(["film.finish"]);
    expect(manifest.ui?.order).toBe(5); // before film-titles (10)
  });
});
