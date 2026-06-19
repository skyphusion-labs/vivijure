import { describe, it, expect } from "vitest";
import {
  MODEL,
  DEFAULT_VOICE,
  buildSpeechParams,
  parseAudioUrl,
  encodePoll,
  decodePoll,
  stateKey,
  audioKey,
  appliedTags,
  readOutput,
  normalizeConfig,
  mimeForFormat,
  textFromScoreInput,
} from "../modules/narration-gen/src/narration-gen";

describe("narration-gen pure logic", () => {
  it("buildSpeechParams includes required MiniMax fields with defaults", () => {
    expect(buildSpeechParams("Hello world.", {})).toEqual({
      text: "Hello world.",
      voice_id: DEFAULT_VOICE,
      speed: 1,
      volume: 1,
      pitch: 0,
      format: "mp3",
      sample_rate: 44100,
    });
  });

  it("buildSpeechParams forwards voice, emotion, and numeric knobs", () => {
    expect(
      buildSpeechParams("Line one.", {
        voice_id: "Custom_voice",
        emotion: "happy",
        format: "wav",
        pitch: 3,
        speed: 1.2,
        volume: 2,
        sample_rate: 24000,
      }),
    ).toEqual({
      text: "Line one.",
      voice_id: "Custom_voice",
      emotion: "happy",
      speed: 1.2,
      volume: 2,
      pitch: 3,
      format: "wav",
      sample_rate: 24000,
    });
  });

  it("buildSpeechParams clamps pitch, speed, and volume", () => {
    const p = buildSpeechParams("x", { pitch: 99, speed: 9, volume: 99 });
    expect(p.pitch).toBe(12);
    expect(p.speed).toBe(2);
    expect(p.volume).toBe(10);
  });

  it("textFromScoreInput prefers config.text, then scene narration/prompt", () => {
    expect(
      textFromScoreInput(
        {
          film_key: "films/x.mp4",
          seconds: 12,
          storyboard: { scenes: [{ prompt: "ignored", narration: "Voice line." }] },
        },
        { text: "Custom script." },
      ),
    ).toBe("Custom script.");
    expect(
      textFromScoreInput(
        {
          film_key: "films/x.mp4",
          seconds: 12,
          storyboard: {
            scenes: [
              { prompt: "visual only" },
              { prompt: "second", narration: " Narration wins. " },
            ],
          },
        },
        {},
      ),
    ).toBe("visual only\n\nNarration wins.");
  });

  it("textFromScoreInput rejects empty context", () => {
    expect(() => textFromScoreInput({ film_key: "x", seconds: 1 }, {})).toThrow(/text required/);
  });

  it("parseAudioUrl reads flat and nested audio URLs", () => {
    expect(parseAudioUrl({ audio: "https://cdn/a.mp3" })).toBe("https://cdn/a.mp3");
    expect(parseAudioUrl({ result: { audio: "https://cdn/b.mp3" } })).toBe("https://cdn/b.mp3");
  });

  it("poll token + R2 keys round-trip", () => {
    expect(decodePoll(encodePoll({ job_id: "job-1" }))).toEqual({ job_id: "job-1" });
    expect(stateKey("job-1")).toBe("narration-gen/job-1.state.json");
    expect(audioKey("job-1", "flac")).toBe("out/narr-job-1.flac");
  });

  it("readOutput returns ScoreOutput with film_key + applied", () => {
    const applied = appliedTags("mp3", { voice_id: "English_expressive_narrator", emotion: "calm" });
    const out = readOutput({
      status: "done",
      film_key: "films/silent.mp4",
      audio_key: "out/narr-x.mp3",
      mime: "audio/mpeg",
      applied: [...applied, "audio:out/narr-x.mp3"],
    });
    expect(out.film_key).toBe("films/silent.mp4");
    expect(out.applied).toContain(`narration:${MODEL}`);
    expect(out.applied).toContain("audio:out/narr-x.mp3");
  });

  it("normalizeConfig clamps invalid sample rate to default", () => {
    expect(normalizeConfig({ sample_rate: 999, pitch: 1.7, speed: "bad" })).toMatchObject({
      pitch: 2,
      speed: 1,
      sample_rate: 44100,
    });
  });

  it("mimeForFormat maps mp3/flac/wav", () => {
    expect(mimeForFormat("mp3")).toBe("audio/mpeg");
    expect(mimeForFormat("flac")).toBe("audio/flac");
    expect(mimeForFormat("wav")).toBe("audio/wav");
  });
});
