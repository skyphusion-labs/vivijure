import { describe, it, expect, vi } from "vitest";
import { callAudioMix, shouldMultiTrackMix, type FilmJob } from "../src/film-orchestrator";
import type { Env } from "../src/env";

// Issue #231: wire the audio-mix container (/mix: multi-track duck + loudnorm) into the mux phase.
// shouldMultiTrackMix gates it (dialogue + music bed + the VPC bound); callAudioMix is the VPC caller
// that degrades to null when the binding is absent so the mux falls back to the single-track remux.

const baseJob = (over: Partial<FilmJob> = {}): FilmJob => ({
  film_id: "f", project: "p", bundle_key: "b", scenes: [],
  motion_backend: null, motion_config: {}, finish_config: {}, keyframe_binding: null,
  phase: "mux", created_at: 0, ...over,
});

describe("shouldMultiTrackMix (#231 gate)", () => {
  const withVpc = { AUDIO_MIX_VPC: {} } as unknown as Env;
  const noVpc = {} as unknown as Env;

  it("true only when dialogue + music bed + VPC are all present", () => {
    const job = baseJob({ dialogue_audio: { shot_01: "a.wav" }, audio_key: "bed.m4a", silent_film_key: "film.mp4" });
    expect(shouldMultiTrackMix(job, withVpc)).toBe(true);
  });
  it("false with no dialogue (single-track bed remux is correct)", () => {
    const job = baseJob({ audio_key: "bed.m4a", silent_film_key: "film.mp4" });
    expect(shouldMultiTrackMix(job, withVpc)).toBe(false);
  });
  it("false with no music bed", () => {
    const job = baseJob({ dialogue_audio: { shot_01: "a.wav" }, silent_film_key: "film.mp4" });
    expect(shouldMultiTrackMix(job, withVpc)).toBe(false);
  });
  it("false when the audio-mix VPC is not bound (degrade to single-track)", () => {
    const job = baseJob({ dialogue_audio: { shot_01: "a.wav" }, audio_key: "bed.m4a", silent_film_key: "film.mp4" });
    expect(shouldMultiTrackMix(job, noVpc)).toBe(false);
  });
});

describe("callAudioMix (#231 VPC caller)", () => {
  it("returns null when AUDIO_MIX_VPC is not bound (caller degrades to single-track)", async () => {
    const r = await callAudioMix({} as unknown as Env, { tracks: [], outputUrl: "u", outputKey: "k" });
    expect(r).toBeNull();
  });

  it("POSTs the mix payload to /mix and returns the response", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({ ok: true, key: "mix.mp3", body: init.body }), { status: 200 }));
    const env = { AUDIO_MIX_VPC: { fetch } } as unknown as Env;
    const payload = {
      tracks: [{ url: "https://r2/video.mp4", role: "dialogue" as const, gainDb: 0 }, { url: "https://r2/bed.m4a", role: "music" as const, gainDb: 0 }],
      outputUrl: "https://r2/out", outputKey: "mix.mp3", format: "mp3", loudnessTargetLufs: -14,
    };
    const r = await callAudioMix(env, payload);
    expect(r?.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://audio-mix/mix");
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("retries a 503 (container still warming) then returns the eventual response", async () => {
    let n = 0;
    const fetch = vi.fn(async () => { n += 1; return new Response("", { status: n < 2 ? 503 : 200 }); });
    const env = { AUDIO_MIX_VPC: { fetch } } as unknown as Env;
    const r = await callAudioMix(env, { tracks: [], outputUrl: "u", outputKey: "k" }, { retries: 3, backoffMs: 0 });
    expect(r?.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
