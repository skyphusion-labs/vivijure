import { describe, it, expect } from "vitest";
import {
  coerceConfig, defaultConfig, buildMasterBody, parseContainerResult, masterOutputFromResult,
  passthroughOutput,
} from "../modules/audio-master/src/master";
import { checkManifest, checkInvokeResponse, checkHookOutput, allPass, failures } from "../src/modules/conformance";
import type { MasterInput } from "../modules/audio-master/src/contract";

const SAMPLE_INPUT: MasterInput = {
  film_id: "film_neon_01",
  audio_key: "renders/neon/audio/bed.wav",
  audio_url: "https://acct.r2.cloudflarestorage.com/vivijure/renders/neon/audio/bed.wav?sig=get",
  output_url: "https://acct.r2.cloudflarestorage.com/vivijure/renders/neon/audio/bed_mastered.wav?sig=put",
  output_key: "renders/neon/audio/bed_mastered.wav",
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

describe("audio-master: buildMasterBody (CPU container POST /master)", () => {
  it("forwards the presigned URLs + the core-owned output_key with the clamped knobs", () => {
    const body = buildMasterBody(SAMPLE_INPUT, coerceConfig({ target_lufs: -12, upscale: false, format: "mp3" }));
    expect(body.audioUrl).toBe(SAMPLE_INPUT.audio_url);
    expect(body.outputUrl).toBe(SAMPLE_INPUT.output_url);
    expect(body.outputKey).toBe(SAMPLE_INPUT.output_key);
    expect(body.targetLufs).toBe(-12);
    expect(body.upscale).toBe(false);
    expect(body.format).toBe("mp3");
  });

  it("uses the master defaults for an empty config (wav, upscale on, -14 LUFS)", () => {
    const body = buildMasterBody(SAMPLE_INPUT, coerceConfig({}));
    expect(body).toMatchObject({ targetLufs: -14, upscale: true, format: "wav" });
  });
});

describe("audio-master: parseContainerResult", () => {
  it("extracts ok + the structured facts from a well-formed result", () => {
    const r = parseContainerResult({
      ok: true, key: "renders/neon/audio/bed_mastered.wav", bytes: 1234, format: "wav",
      durationSeconds: 42.0, lufs: -14.05, loudnessTargetLufs: -14, upscaled: true,
    });
    expect(r).toMatchObject({ ok: true, key: "renders/neon/audio/bed_mastered.wav", upscaled: true, loudnessTargetLufs: -14 });
  });

  it("returns null for null / non-objects; ok defaults to false on a missing flag", () => {
    expect(parseContainerResult(null)).toBeNull();
    expect(parseContainerResult("x")).toBeNull();
    expect(parseContainerResult({ key: "k" })?.ok).toBe(false);
  });
});

describe("audio-master: masterOutputFromResult (honest #77 applied record)", () => {
  it("tags music-upscale + loudnorm when the container upscaled", () => {
    const out = masterOutputFromResult(SAMPLE_INPUT, {
      ok: true, key: "renders/neon/audio/bed_mastered.wav", upscaled: true, loudnessTargetLufs: -14,
    });
    expect(out.audio_key).toBe("renders/neon/audio/bed_mastered.wav");
    expect(out.applied).toEqual(["music-upscale:soxr48k", "loudnorm:-14LUFS"]);
    expect(out.degraded).toBeUndefined();
  });

  it("omits the music-upscale tag when the container did NOT upscale (no fake tag)", () => {
    const out = masterOutputFromResult(SAMPLE_INPUT, { ok: true, key: "k_mastered.wav", upscaled: false, loudnessTargetLufs: -12 });
    expect(out.applied).toEqual(["loudnorm:-12LUFS"]);
  });

  it("falls back to the input output_key when the container echoes no key", () => {
    const out = masterOutputFromResult(SAMPLE_INPUT, { ok: true, upscaled: true, loudnessTargetLufs: -14 });
    expect(out.audio_key).toBe(SAMPLE_INPUT.output_key);
  });

  it("emits a bare loudnorm tag when no target was echoed", () => {
    const out = masterOutputFromResult(SAMPLE_INPUT, { ok: true, key: "k", upscaled: false });
    expect(out.applied).toEqual(["loudnorm"]);
  });
});

describe("audio-master: manifest + output conformance", () => {
  const MANIFEST = {
    name: "audio-master",
    version: "0.1.0",
    api: "vivijure-module/2",
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
    expect(checkInvokeResponse({ ok: false, error: "audio-master: input needs film_id, audio_key, audio_url, output_url, output_key" }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: true, output: passthroughOutput(SAMPLE_INPUT, "no-vpc-binding") }).pass).toBe(true);
  });
  it("the passthrough output ALSO honors the master hook contract (degrade is contract-valid)", () => {
    expect(checkHookOutput("master", passthroughOutput(SAMPLE_INPUT, "no-vpc-binding")).pass).toBe(true);
  });
});

describe("audio-master: passthroughOutput (degrade observability #77)", () => {
  it("carries the INPUT bed through unchanged -- never a new or dropped key", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "container-failed");
    expect(o.audio_key).toBe(SAMPLE_INPUT.audio_key);
  });
  it("a real degrade tags applied with passthrough:<reason> AND sets degraded", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "no-vpc-binding");
    expect(o.applied).toEqual(["passthrough:no-vpc-binding"]);
    expect(o.degraded).toBe("no-vpc-binding");
  });
  it("detail enriches the degraded note but not the terse applied tag", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "container-failed", { detail: "HTTP 500" });
    expect(o.applied).toEqual(["passthrough:container-failed"]);
    expect(o.degraded).toBe("container-failed: HTTP 500");
  });
  it("covers every degrade reason the worker emits", () => {
    for (const reason of ["no-vpc-binding", "container-unreachable", "container-failed", "container-bad-response", "no-output-key"]) {
      const o = passthroughOutput(SAMPLE_INPUT, reason);
      expect(o.applied[0]).toBe(`passthrough:${reason}`);
      expect(o.degraded).toBeTruthy();
    }
  });
});
