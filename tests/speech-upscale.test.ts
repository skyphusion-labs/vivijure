import { describe, it, expect } from "vitest";
import {
  coerceConfig, defaultConfig, buildRunPodBody, enhancedAudioKey, encodePoll, decodePoll,
  parseBackendOutput, passthroughOutput, successOutput, runpodJobGone, classifyGoneState,
  RUNPOD_NOTFOUND_GRACE_MS, type PollState,
} from "../modules/speech-upscale/src/speech";
import {
  checkManifest, checkInvokeResponse, checkHookOutput, allPass, failures,
} from "../src/modules/conformance";
import type { SpeechInput } from "../modules/speech-upscale/src/contract";

const SAMPLE_INPUT: SpeechInput = {
  shot_id: "shot_01",
  audio_key: "renders/neon/dialogue/shot_01.wav",
};

const SAMPLE_STATE: PollState = {
  jobId: "run-abc-123", shotId: "shot_01", audioKey: SAMPLE_INPUT.audio_key,
  submittedAt: 1_700_000_000_000,
};

describe("speech-upscale: coerceConfig (opt-in, default off)", () => {
  it("defaults enable + denoise to false", () => {
    expect(defaultConfig()).toEqual({ enable: false, denoise: false });
    const c = coerceConfig({});
    expect(c.enable).toBe(false);
    expect(c.denoise).toBe(false);
  });
  it("only the literal `true` enables (no truthy coercion of strings/1)", () => {
    expect(coerceConfig({ enable: true }).enable).toBe(true);
    expect(coerceConfig({ enable: "true" }).enable).toBe(false);
    expect(coerceConfig({ enable: 1 }).enable).toBe(false);
    expect(coerceConfig({ denoise: true }).denoise).toBe(true);
  });
});

describe("speech-upscale: enhancedAudioKey", () => {
  it("inserts _enh and forces .wav beside the source (original survives)", () => {
    expect(enhancedAudioKey("renders/neon/dialogue/shot_01.wav")).toBe("renders/neon/dialogue/shot_01_enh.wav");
    expect(enhancedAudioKey("renders/neon/dialogue/shot_01.m4a")).toBe("renders/neon/dialogue/shot_01_enh.wav");
  });
  it("appends _enh.wav when there is no extension; ignores a dot in the path", () => {
    expect(enhancedAudioKey("renders/neon/dialogue/shot_01")).toBe("renders/neon/dialogue/shot_01_enh.wav");
    expect(enhancedAudioKey("a.b/dialogue/shot")).toBe("a.b/dialogue/shot_enh.wav");
  });
});

describe("speech-upscale: buildRunPodBody (R2 mode on audio_key)", () => {
  it("emits audio_key, the derived output_key, and denoise", () => {
    const { input } = buildRunPodBody(SAMPLE_INPUT, coerceConfig({ enable: true, denoise: true }));
    expect(input.audio_key).toBe(SAMPLE_INPUT.audio_key);
    expect(input.output_key).toBe("renders/neon/dialogue/shot_01_enh.wav");
    expect(input.denoise).toBe(true);
  });
});

describe("speech-upscale: poll token (carries audio_key for the stateless /poll)", () => {
  it("encodePoll / decodePoll round-trips all fields incl audioKey + submittedAt", () => {
    expect(decodePoll(encodePoll(SAMPLE_STATE))).toEqual(SAMPLE_STATE);
  });
  it("decodePoll returns null without jobId / shotId / audioKey", () => {
    expect(decodePoll("not-base64-!!")).toBeNull();
    expect(decodePoll(btoa(JSON.stringify({ jobId: "x", shotId: "s" })))).toBeNull();  // missing audioKey
  });
});

describe("speech-upscale: parseBackendOutput", () => {
  it("extracts the enhanced output_key + applied from a well-formed result", () => {
    const o = parseBackendOutput({ ok: true, output_key: "renders/neon/dialogue/shot_01_enh.wav", sr: 44100, bytes: 88278, applied: ["speech-upscale:resemble-enhance"] });
    expect(o).toMatchObject({ output_key: "renders/neon/dialogue/shot_01_enh.wav", applied: ["speech-upscale:resemble-enhance"] });
  });
  it("returns null for null / non-objects; output_key undefined when absent", () => {
    expect(parseBackendOutput(null)).toBeNull();
    expect(parseBackendOutput("x")).toBeNull();
    expect(parseBackendOutput({ sr: 44100 })?.output_key).toBeUndefined();
  });
});

describe("speech-upscale: successOutput (the seam with the orchestrator)", () => {
  it("audio_key = the ENHANCED key, applied tag, never degraded", () => {
    const o = successOutput(SAMPLE_STATE, { output_key: "renders/neon/dialogue/shot_01_enh.wav", applied: ["speech-upscale:resemble-enhance"] });
    expect(o.shot_id).toBe(SAMPLE_INPUT.shot_id);
    expect(o.audio_key).toBe("renders/neon/dialogue/shot_01_enh.wav");   // enhanced key flows to lip-sync
    expect(o.applied).toEqual(["speech-upscale:resemble-enhance"]);
    expect(o.degraded).toBeUndefined();
  });
  it("falls back to the canonical applied tag if the endpoint omitted it", () => {
    const o = successOutput(SAMPLE_STATE, { output_key: "k_enh.wav" });
    expect(o.applied).toEqual(["speech-upscale:resemble-enhance"]);
  });
});

describe("speech-upscale: passthroughOutput (#249/#77 honest soft-degrade)", () => {
  it("INPUT audio passes through unchanged, NO fake applied tag, degraded set", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "disabled");
    expect(o.shot_id).toBe(SAMPLE_INPUT.shot_id);
    expect(o.audio_key).toBe(SAMPLE_INPUT.audio_key);   // original audio, lip-sync uses it unchanged
    expect(o.applied).toEqual([]);                      // never a fake speech-upscale tag
    expect(o.degraded).toBe("disabled");
  });
  it("detail enriches the degraded note", () => {
    expect(passthroughOutput(SAMPLE_INPUT, "endpoint-failed", "OOM").degraded).toBe("endpoint-failed: OOM");
  });
  it("covers every degrade reason the worker emits", () => {
    for (const reason of ["disabled", "no-runpod-secrets", "runpod-run-failed", "no-jobid", "exception", "not-configured", "endpoint-gone", "endpoint-failed", "no-output-key"]) {
      const o = passthroughOutput(SAMPLE_INPUT, reason);
      expect(o.audio_key).toBe(SAMPLE_INPUT.audio_key);
      expect(o.applied).toEqual([]);
      expect(o.degraded).toBeTruthy();
    }
  });
});

describe("speech-upscale: conformance (the live harness in src/modules/conformance.ts)", () => {
  const MANIFEST = {
    name: "speech-upscale",
    version: "0.1.0",
    api: "vivijure-module/2",
    hooks: ["speech"],
    provides: [{ id: "speech-upscale", label: "Clean dialogue audio (resemble-enhance)" }],
    config_schema: {
      enable:  { type: "bool", default: false },
      denoise: { type: "bool", default: false },
    },
  };
  it("passes the conformance manifest checker", () => {
    const checks = checkManifest(MANIFEST);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });
  it("invoke success / error / degraded / pending responses all pass the envelope checker", () => {
    expect(checkInvokeResponse({ ok: true, output: successOutput(SAMPLE_STATE, { output_key: "k_enh.wav", applied: ["speech-upscale:resemble-enhance"] }) }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: false, error: "speech-upscale: input needs shot_id and audio_key" }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: true, output: passthroughOutput(SAMPLE_INPUT, "endpoint-failed", "HTTP 500") }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: true, pending: true, poll: encodePoll(SAMPLE_STATE) }).pass).toBe(true);
  });
  it("BOTH the success and the soft-degrade output pass the `speech` hook-output contract", () => {
    const success = successOutput(SAMPLE_STATE, { output_key: "k_enh.wav", applied: ["speech-upscale:resemble-enhance"] });
    expect(checkHookOutput("speech", success).pass, checkHookOutput("speech", success).detail).toBe(true);
    const degraded = passthroughOutput(SAMPLE_INPUT, "endpoint-failed", "HTTP 500");
    expect(checkHookOutput("speech", degraded).pass, checkHookOutput("speech", degraded).detail).toBe(true);
  });
});

describe("speech-upscale: RunPod gone-detection + grace (#141)", () => {
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
