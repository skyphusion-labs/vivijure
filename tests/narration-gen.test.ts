import { describe, it, expect } from "vitest";
import {
  MODEL,
  DEFAULT_VOICE,
  buildSpeechBody,
  extractAudioUrl,
  encodePoll,
  decodePoll,
  audioKey,
  appliedTags,
  normalizeConfig,
  mimeForFormat,
  textFromScoreInput,
  runpodJobGone,
  classifyGoneState,
  RUNPOD_NOTFOUND_GRACE_MS,
} from "../modules/narration-gen/src/narration-gen";

describe("narration-gen pure logic (RunPod transport)", () => {
  it("buildSpeechBody wraps input with RunPod's `prompt` field (not `text`) + defaults", () => {
    expect(buildSpeechBody("Hello world.", {})).toEqual({
      input: {
        prompt: "Hello world.",
        voice_id: DEFAULT_VOICE,
        speed: 1,
        volume: 1,
        pitch: 0,
        format: "mp3",
        sample_rate: 44100,
      },
    });
  });

  it("buildSpeechBody forwards voice, emotion, and numeric knobs", () => {
    expect(
      buildSpeechBody("Line one.", {
        voice_id: "Custom_voice",
        emotion: "happy",
        format: "wav",
        pitch: 3,
        speed: 1.2,
        volume: 2,
        sample_rate: 24000,
      }),
    ).toEqual({
      input: {
        prompt: "Line one.",
        voice_id: "Custom_voice",
        emotion: "happy",
        speed: 1.2,
        volume: 2,
        pitch: 3,
        format: "wav",
        sample_rate: 24000,
      },
    });
  });

  it("buildSpeechBody clamps pitch, speed, and volume", () => {
    const { input } = buildSpeechBody("x", { pitch: 99, speed: 9, volume: 99 });
    expect(input.pitch).toBe(12);
    expect(input.speed).toBe(2);
    expect(input.volume).toBe(10);
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

  it("extractAudioUrl reads RunPod output.result, plus audio/bare-string fallbacks", () => {
    expect(extractAudioUrl({ result: "https://cdn/a.mp3" })).toBe("https://cdn/a.mp3");
    expect(extractAudioUrl({ audio: "https://cdn/b.mp3" })).toBe("https://cdn/b.mp3");
    expect(extractAudioUrl("https://cdn/c.mp3")).toBe("https://cdn/c.mp3");
    expect(extractAudioUrl({})).toBeNull();
  });

  it("poll token round-trips the RunPod job id + score job id + film key + applied", () => {
    const tok = encodePoll({
      jobId: "rp-1", job_id: "job-1", film_key: "films/x.mp4", format: "flac",
      applied: [`narration:${MODEL}`], submittedAt: 123,
    });
    expect(decodePoll(tok)).toEqual({
      jobId: "rp-1", job_id: "job-1", film_key: "films/x.mp4", format: "flac",
      applied: [`narration:${MODEL}`], submittedAt: 123,
    });
    expect(audioKey("job-1", "flac")).toBe("out/narr-job-1.flac");
  });

  it("decodePoll rejects a malformed token", () => {
    expect(decodePoll("not-base64-json")).toBeNull();
  });

  it("runpodJobGone: 404 http OR numeric-404 status OR not-found title = gone; a run state = not gone", () => {
    expect(runpodJobGone(404, null)).toBe(true);
    expect(runpodJobGone(200, { status: 404 })).toBe(true);
    expect(runpodJobGone(200, { title: "Not Found" })).toBe(true);
    expect(runpodJobGone(200, { status: "IN_PROGRESS" })).toBe(false);
    expect(runpodJobGone(200, { status: "COMPLETED" })).toBe(false);
  });

  it("classifyGoneState: fail past grace (or legacy no-submittedAt), grace inside the window", () => {
    const now = 1_000_000;
    expect(classifyGoneState(undefined, now)).toBe("gone-failed");
    expect(classifyGoneState(now - RUNPOD_NOTFOUND_GRACE_MS - 1, now)).toBe("gone-failed");
    expect(classifyGoneState(now - 1000, now)).toBe("gone-grace");
  });

  it("appliedTags carries model + format + voice + a RunPod-valid emotion", () => {
    const tags = appliedTags("mp3", { voice_id: "Wise_Woman", emotion: "neutral" });
    expect(tags).toContain(`narration:${MODEL}`);
    expect(tags).toContain("voice:Wise_Woman");
    expect(tags).toContain("emotion:neutral");
  });

  it("buildSpeechBody drops an out-of-set emotion (e.g. the old Workers-AI `calm`) so RunPod does not 400", () => {
    const { input } = buildSpeechBody("x", { emotion: "calm" as unknown as "neutral" });
    expect(input.emotion).toBeUndefined();
    const ok = buildSpeechBody("x", { emotion: "happy" });
    expect(ok.input.emotion).toBe("happy");
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
