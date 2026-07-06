import { describe, it, expect } from "vitest";
import {
  coerceConfig, encodePoll, decodePoll, passthroughOutput, softDegradeInFailedEnvelope, buildRunPodBody,
} from "../modules/finish-lipsync/src/lipsync";
import { MANIFEST } from "../modules/finish-lipsync/src/index";
import { checkManifest, checkInvokeResponse, allPass, failures } from "../src/modules/conformance";
import type { FinishInput } from "../modules/finish-lipsync/src/contract";

const SAMPLE_INPUT: FinishInput = {
  shot_id: "shot_01",
  clip_key: "renders/lighthouse/clips/shot_01_seedance.mp4",
  audio_key: "renders/lighthouse/dialogue/shot_01.wav",
  src_fps: 16,
  frames: 80,
  width: 1280,
  height: 720,
};

describe("finish-lipsync: softDegradeInFailedEnvelope (#565)", () => {
  it("recognizes the exact musetalk#24 envelope: RunPod-lifted error, ok:false kept in output", () => {
    // Verbatim shape from the failed The_Lighthouse render (job 02ffed52-...-u1).
    const s = { status: "FAILED", error: "musetalk produced no output mp4", output: { ok: false } };
    expect(softDegradeInFailedEnvelope(s)).toBe("musetalk produced no output mp4");
  });

  it("prefers a detail the handler kept nested in output.error over the lifted envelope error", () => {
    const s = { status: "FAILED", error: "lifted", output: { ok: false, error: "no face detected in clip" } };
    expect(softDegradeInFailedEnvelope(s)).toBe("no face detected in clip");
  });

  it("prefers the musetalk#25 `detail` key over both error fields", () => {
    const s = { status: "FAILED", error: "lifted", output: { ok: false, error: "legacy", detail: "no usable face region in clip" } };
    expect(softDegradeInFailedEnvelope(s)).toBe("no usable face region in clip");
  });

  it("returns '' (match, no detail) when the envelope kept ok:false but no error string anywhere", () => {
    expect(softDegradeInFailedEnvelope({ status: "FAILED", output: { ok: false } })).toBe("");
    expect(softDegradeInFailedEnvelope({ status: "FAILED", error: 42, output: { ok: false } })).toBe("");
  });

  it("caps a runaway detail string at 120 chars", () => {
    const s = { status: "FAILED", error: "x".repeat(500), output: { ok: false } };
    expect(softDegradeInFailedEnvelope(s)?.length).toBe(120);
  });

  it("returns null for a genuine crash: a raise leaves no structured output in the envelope", () => {
    expect(softDegradeInFailedEnvelope({ status: "FAILED", error: "Traceback ..." })).toBeNull();
    expect(softDegradeInFailedEnvelope({ status: "FAILED", error: "boom", output: null })).toBeNull();
    expect(softDegradeInFailedEnvelope({ status: "FAILED", error: "boom", output: "text" })).toBeNull();
  });

  it("returns null when output exists but does not carry the handler's ok:false", () => {
    expect(softDegradeInFailedEnvelope({ status: "FAILED", output: {} })).toBeNull();
    expect(softDegradeInFailedEnvelope({ status: "FAILED", output: { ok: true } })).toBeNull();
    expect(softDegradeInFailedEnvelope({ status: "FAILED", output: { ok: "false" } })).toBeNull();
  });

  it("returns null for any non-FAILED status (COMPLETED ok:false stays with the existing branch)", () => {
    expect(softDegradeInFailedEnvelope({ status: "COMPLETED", output: { ok: false } })).toBeNull();
    expect(softDegradeInFailedEnvelope({ status: "IN_PROGRESS", output: { ok: false } })).toBeNull();
    expect(softDegradeInFailedEnvelope({ output: { ok: false } })).toBeNull();
  });
});

describe("finish-lipsync: buildRunPodBody (#583 sidecar stamp)", () => {
  it("forwards output_hash verbatim when present, omits it when absent", () => {
    const withHash = buildRunPodBody({ ...SAMPLE_INPUT, audio_key: "renders/neon/dialogue/shot_01.wav", output_hash: "abc123" }, coerceConfig({}));
    expect(withHash.input.output_hash).toBe("abc123");
    const without = buildRunPodBody({ ...SAMPLE_INPUT, audio_key: "renders/neon/dialogue/shot_01.wav" }, coerceConfig({}));
    expect("output_hash" in without.input).toBe(false);
  });
});

describe("finish-lipsync: coerceConfig", () => {
  it("returns sane defaults for an empty config", () => {
    const c = coerceConfig({});
    expect(c.version).toBe("v15");
    expect(c.bbox_shift).toBe(0);
  });
  it("rejects an unknown version; truncates bbox_shift (range clamping is the core's job)", () => {
    expect(coerceConfig({ version: "v99" }).version).toBe("v15");
    expect(coerceConfig({ version: "v1" }).version).toBe("v1");
    expect(coerceConfig({ bbox_shift: 3.7 }).bbox_shift).toBe(3);
    expect(coerceConfig({ bbox_shift: "nope" }).bbox_shift).toBe(0);
  });
});

describe("finish-lipsync: poll token", () => {
  it("encodePoll / decodePoll round-trips all fields incl clipKey (the passthrough source)", () => {
    const s = { jobId: "run-abc", shotId: "shot_02", clipKey: "renders/p/clips/shot_02.mp4", srcFps: 24, frames: 96, submittedAt: 1_700_000_000_000 };
    expect(decodePoll(encodePoll(s))).toEqual(s);
  });
  it("decodePoll returns null for garbage; a legacy token without clipKey defaults it to ''", () => {
    expect(decodePoll("not-base64-!!")).toBeNull();
    expect(decodePoll(btoa(JSON.stringify({ jobId: "x" })))).toBeNull(); // missing shotId
    expect(decodePoll(btoa(JSON.stringify({ jobId: "x", shotId: "s" })))?.clipKey).toBe("");
  });
});

describe("finish-lipsync: passthroughOutput (degrade observability #77)", () => {
  it("a backend soft-degrade carries the ORIGINAL clip through, tagged and recorded", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "backend-soft-degrade", { detail: "musetalk produced no output mp4" });
    expect(o.clip_key).toBe(SAMPLE_INPUT.clip_key);
    expect(o.applied).toEqual(["passthrough:backend-soft-degrade"]);
    expect(o.degraded).toBe("backend-soft-degrade: musetalk produced no output mp4");
  });
  it("the no-dialogue case is a bare noop, never a degrade", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "no-dialogue", { degraded: false });
    expect(o.applied).toEqual(["noop:no-dialogue"]);
    expect(o.degraded).toBeUndefined();
  });
});

describe("finish-lipsync: manifest conformance", () => {
  it("passes the conformance manifest checker", () => {
    const checks = checkManifest(MANIFEST);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });
  it("invoke success / error / degraded responses all pass the response checker", () => {
    expect(checkInvokeResponse({ ok: true, output: { shot_id: "s", clip_key: "k_ls.mp4", out_fps: 16, frames: 80, applied: ["lipsync:v15"] } }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: false, error: "finish-lipsync: input needs shot_id and clip_key" }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: true, output: passthroughOutput(SAMPLE_INPUT, "backend-soft-degrade") }).pass).toBe(true);
  });
});
