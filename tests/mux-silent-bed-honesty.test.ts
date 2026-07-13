import { describe, it, expect } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator";
import type { Env } from "../src/env";

// F2: audio-master (or any long/ballooned bed) can push the mux bed over the video-finish container audio
// cap, so the container "finishes silent" -- it returns ok:true but writes a track-less MP4 and reports
// hasAudio:false. The mux MUST NOT mark that a silent green (phase=done with the bed silently dropped and
// no signal in the poll). It must surface an OBSERVABLE mux degrade (finish_unavailable at mux) and ship
// the silent film honestly (#245 / #249 / #77). hasAudio:undefined (an older container that omits the
// field) is unknown, not false, so the prior success behavior must hold.

function muxEnv(job: object, containerBody: unknown) {
  const filmId = (job as { film_id: string }).film_id;
  let stored = JSON.stringify(job);
  const jsonResp = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
      head: async () => null,
      put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
    },
    VIDEO_FINISH_VPC: { fetch: async () => jsonResp(containerBody) },
    R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
    R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
  };
  return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob };
}

const SILENT = "renders/film-mux-honesty/film-silent.mp4";
const OUT = "renders/film-mux-honesty/film-audio.mp4";
const muxJob = (over: object = {}) => ({
  film_id: "film-mux-honesty",
  project: "p",
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
  phase: "mux" as const,
  silent_film_key: SILENT,
  audio_key: "renders/film-mux-honesty/bed_mastered.wav",
  mux_output_key: OUT,
  created_at: 0,
  ...over,
});

describe("mux honesty: a dropped bed is an OBSERVABLE degrade, never a silent green (F2)", () => {
  it("hasAudio:false -> finish_unavailable at mux, ships the silent film, phase done", async () => {
    const { env, read } = muxEnv(muxJob(), { ok: true, key: OUT, hasAudio: false });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable?.at).toBe("mux");
    expect(r?.job.finish_unavailable?.delivered).toBe("silent_film");
    expect(r?.job.finish_unavailable?.reason).toMatch(/could not attach the audio bed/i);
    // the honest silent film (the assembled silent key), NOT the track-less muxed key dressed up as done
    expect(r?.job.film_key).toBe(SILENT);
    expect(read().finish_unavailable?.at).toBe("mux"); // persisted
  });

  it("hasAudio:true -> normal green with the muxed film, no degrade", async () => {
    const { env } = muxEnv(muxJob(), { ok: true, key: OUT, hasAudio: true });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable).toBeUndefined();
    expect(r?.job.film_key).toBe(OUT);
  });

  it("hasAudio absent (older container build) -> back-compat: normal green, no false degrade", async () => {
    const { env } = muxEnv(muxJob(), { ok: true, key: OUT });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable).toBeUndefined();
    expect(r?.job.film_key).toBe(OUT);
  });
});
