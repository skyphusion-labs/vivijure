import { describe, it, expect } from "vitest";
import {
  coerceConfig, defaultConfig, buildRunPodBody, masteredKey, encodePoll, decodePoll, parseBackendOutput,
  passthroughOutput, runpodJobGone, classifyGoneState, RUNPOD_NOTFOUND_GRACE_MS,
} from "../modules/audio-master/src/master";
import { checkManifest, checkInvokeResponse, checkHookOutput, allPass, failures } from "../src/modules/conformance";
import type { MasterInput } from "../modules/audio-master/src/contract";

const SAMPLE_INPUT: MasterInput = {
  film_id: "film_neon_01",
  audio_key: "renders/neon/audio/bed.wav",
  seconds: 42,
};

describe("audio-master: coerceConfig", () => {
  it("returns sane defaults for an empty config", () => {
    const c = coerceConfig({});
    expect(c).toEqual(defaultConfig());
    expect(c.target_lufs).toBe(-14);
    expect(c.upscale).toBe(true);
    expect(c.format).toBe("wav");
  });

  it("clamps target_lufs into the [-24, -9] range and falls back on non-numbers", () => {
    expect(coerceConfig({ target_lufs: -16 }).target_lufs).toBe(-16);
    expect(coerceConfig({ target_lufs: -30 }).target_lufs).toBe(-24);
    expect(coerceConfig({ target_lufs: 0 }).target_lufs).toBe(-9);
    expect(coerceConfig({ target_lufs: "loud" }).target_lufs).toBe(-14);
  });

  it("honors the upscale toggle and rejects unknown formats", () => {
    expect(coerceConfig({ upscale: false }).upscale).toBe(false);
    expect(coerceConfig({ upscale: true }).upscale).toBe(true);
    expect(coerceConfig({ format: "mp3" }).format).toBe("mp3");
    expect(coerceConfig({ format: "flac" }).format).toBe("wav");
  });
});

describe("audio-master: masteredKey", () => {
  it("inserts _mastered before the (format) extension, beside the source (original survives)", () => {
    expect(masteredKey("renders/neon/audio/bed.wav", "wav")).toBe("renders/neon/audio/bed_mastered.wav");
  });
  it("follows the requested output format even when re-encoding", () => {
    expect(masteredKey("renders/neon/audio/bed.wav", "mp3")).toBe("renders/neon/audio/bed_mastered.mp3");
  });
  it("appends when there is no extension, and ignores a dot in the path", () => {
    expect(masteredKey("renders/neon/audio/bed", "wav")).toBe("renders/neon/audio/bed_mastered.wav");
    expect(masteredKey("a.b/audio/bed", "wav")).toBe("a.b/audio/bed_mastered.wav");
  });
});

describe("audio-master: buildRunPodBody", () => {
  it("emits audio_key, the derived output_key, target_lufs, upscale, format (R2 mode -- no action field)", () => {
    const { input } = buildRunPodBody(SAMPLE_INPUT, coerceConfig({ target_lufs: -12, upscale: false, format: "mp3" }));
    expect(input.audio_key).toBe(SAMPLE_INPUT.audio_key);
    expect(input.output_key).toBe("renders/neon/audio/bed_mastered.mp3");
    expect(input.target_lufs).toBe(-12);
    expect(input.upscale).toBe(false);
    expect(input.format).toBe("mp3");
    expect(input.seconds).toBe(42);
    expect(input.action).toBeUndefined(); // dedicated endpoint, not a vivijure-backend action
  });
});

describe("audio-master: poll token", () => {
  it("encodePoll / decodePoll round-trips all fields incl submittedAt + the bed for passthrough", () => {
    const s = { jobId: "run-abc-123", filmId: "film_x", audioKey: "renders/x/audio/bed.wav", submittedAt: 1_700_000_000_000 };
    expect(decodePoll(encodePoll(s))).toEqual(s);
  });
  it("decodePoll returns null for garbage / empty / a token missing the bed key", () => {
    expect(decodePoll("not-base64-!!")).toBeNull();
    expect(decodePoll("")).toBeNull();
    expect(decodePoll(btoa(JSON.stringify({ jobId: "x" })))).toBeNull(); // missing audioKey
  });
  it("a legacy token (no submittedAt / filmId) decodes with safe defaults", () => {
    const r = decodePoll(btoa(JSON.stringify({ jobId: "j", audioKey: "renders/x/audio/bed.wav" })));
    expect(r?.filmId).toBe("");
    expect(r?.submittedAt).toBeUndefined();
  });
});

describe("audio-master: parseBackendOutput", () => {
  it("extracts the mastered audio_key + applied from a well-formed result", () => {
    const o = parseBackendOutput({ audio_key: "renders/neon/audio/bed_mastered.wav", applied: ["music-upscale:soxr48k", "loudnorm:-14LUFS"] });
    expect(o).toMatchObject({ audio_key: "renders/neon/audio/bed_mastered.wav", applied: ["music-upscale:soxr48k", "loudnorm:-14LUFS"] });
  });
  it("returns null for null / non-objects; defaults applied to []", () => {
    expect(parseBackendOutput(null)).toBeNull();
    expect(parseBackendOutput("x")).toBeNull();
    expect(parseBackendOutput({ audio_key: "k" })?.applied).toEqual([]);
  });
});

describe("audio-master: manifest + output conformance", () => {
  const MANIFEST = {
    name: "audio-master",
    version: "0.1.0",
    api: "vivijure-module/1",
    hooks: ["master"],
    provides: [{ id: "master", label: "Master film audio (loudness + music upscale)" }],
    config_schema: {
      target_lufs: { type: "float", default: -14, min: -24, max: -9 },
      upscale: { type: "bool", default: true },
      format: { type: "enum", values: ["wav", "mp3"], default: "wav" },
    },
  };
  it("passes the conformance manifest checker", () => {
    const checks = checkManifest(MANIFEST);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });
  it("a real master output passes checkHookOutput('master')", () => {
    const output = { audio_key: "renders/neon/audio/bed_mastered.wav", applied: ["music-upscale:soxr48k", "loudnorm:-14LUFS"] };
    expect(checkHookOutput("master", output).pass).toBe(true);
  });
  it("invoke success / error / degraded responses all pass the response checker", () => {
    expect(checkInvokeResponse({ ok: true, output: { audio_key: "k_mastered.wav", applied: ["loudnorm:-14LUFS"] } }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: false, error: "audio-master: input needs film_id and audio_key" }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: true, output: passthroughOutput(SAMPLE_INPUT, "no-runpod-secrets") }).pass).toBe(true);
  });
  it("the passthrough output ALSO honors the master hook contract (degrade is contract-valid)", () => {
    expect(checkHookOutput("master", passthroughOutput(SAMPLE_INPUT, "no-runpod-secrets")).pass).toBe(true);
  });
});

describe("audio-master: passthroughOutput (degrade observability #77)", () => {
  it("carries the INPUT bed through unchanged -- never a new or dropped key", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "no-jobid");
    expect(o.audio_key).toBe(SAMPLE_INPUT.audio_key);
  });
  it("a real degrade tags applied with passthrough:<reason> AND sets degraded", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "no-runpod-secrets");
    expect(o.applied).toEqual(["passthrough:no-runpod-secrets"]);
    expect(o.degraded).toBe("no-runpod-secrets");
  });
  it("detail enriches the degraded note but not the terse applied tag", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "runpod-run-failed", { detail: "HTTP 500" });
    expect(o.applied).toEqual(["passthrough:runpod-run-failed"]);
    expect(o.degraded).toBe("runpod-run-failed: HTTP 500");
  });
  it("covers every degrade reason the worker emits", () => {
    for (const reason of ["no-runpod-secrets", "runpod-run-failed", "no-jobid", "exception", "runpod-job-gone", "runpod-job-failed", "no-audio-key"]) {
      const o = passthroughOutput(SAMPLE_INPUT, reason);
      expect(o.applied[0]).toBe(`passthrough:${reason}`);
      expect(o.degraded).toBeTruthy();
    }
  });
});

describe("audio-master: RunPod gone-detection + grace (#141)", () => {
  it("runpodJobGone detects 404 / numeric-404 / not-found-title, not a real run state", () => {
    expect(runpodJobGone(404, { status: 404 })).toBe(true);
    expect(runpodJobGone(200, { title: "Not Found" })).toBe(true);
    expect(runpodJobGone(200, { status: "COMPLETED" })).toBe(false);
  });
  it("classifyGoneState: grace window vs fail vs legacy", () => {
    const now = 2_000_000;
    expect(classifyGoneState(now - (RUNPOD_NOTFOUND_GRACE_MS - 1), now)).toBe("gone-grace");
    expect(classifyGoneState(now - (RUNPOD_NOTFOUND_GRACE_MS + 1), now)).toBe("gone-failed");
    expect(classifyGoneState(undefined, now)).toBe("gone-failed");
  });
});
