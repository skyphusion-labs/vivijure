import { describe, it, expect } from "vitest";
import {
  coerceConfig, buildRunPodBody, upscaledKey, encodePoll, decodePoll, parseBackendOutput,
  passthroughOutput, runpodJobGone, classifyGoneState, RUNPOD_NOTFOUND_GRACE_MS,
} from "../modules/finish-upscale/src/finish";
import { checkManifest, checkInvokeResponse, allPass, failures } from "../src/modules/conformance";
import type { FinishInput } from "../modules/finish-upscale/src/contract";

const SAMPLE_INPUT: FinishInput = {
  shot_id: "shot_01",
  clip_key: "renders/neon/clips/shot_01_seedance.mp4",
  src_fps: 16,
  frames: 80,
  width: 1280,
  height: 720,
};

describe("finish-upscale: coerceConfig", () => {
  it("returns sane defaults for an empty config (animevideov3: x4plus OOMs untiled, #585)", () => {
    const c = coerceConfig({});
    expect(c.scale).toBe(2);
    expect(c.model).toBe("realesr-animevideov3");
  });

  it("clamps scale to the integer factors 2 or 4 (>=4 -> 4, else 2)", () => {
    expect(coerceConfig({ scale: 2 }).scale).toBe(2);
    expect(coerceConfig({ scale: 3 }).scale).toBe(2);
    expect(coerceConfig({ scale: 4 }).scale).toBe(4);
    expect(coerceConfig({ scale: 5 }).scale).toBe(4);
    expect(coerceConfig({ scale: 1 }).scale).toBe(2);
  });

  it("rejects unknown models and falls back to the default", () => {
    expect(coerceConfig({ model: "nope" }).model).toBe("realesr-animevideov3");
    expect(coerceConfig({ model: "RealESRGAN_x4plus" }).model).toBe("RealESRGAN_x4plus");
    expect(coerceConfig({ model: "realesr-animevideov3" }).model).toBe("realesr-animevideov3");
  });
});

describe("finish-upscale: upscaledKey", () => {
  it("inserts _up before the extension, beside the source (original survives)", () => {
    expect(upscaledKey("renders/neon/clips/shot_01.mp4")).toBe("renders/neon/clips/shot_01_up.mp4");
  });
  it("appends _up when there is no extension", () => {
    expect(upscaledKey("renders/neon/clips/shot_01")).toBe("renders/neon/clips/shot_01_up");
  });
  it("only treats a dot in the FILENAME as the extension, not a dot in the path", () => {
    expect(upscaledKey("a.b/clips/shot")).toBe("a.b/clips/shot_up");
  });
});

describe("finish-upscale: buildRunPodBody", () => {
  it("emits clip_key, the derived output_key, scale and model (R2 mode -- no action field)", () => {
    const { input } = buildRunPodBody(SAMPLE_INPUT, coerceConfig({ scale: 4, model: "RealESRGAN_x4plus" }));
    expect(input.clip_key).toBe(SAMPLE_INPUT.clip_key);
    expect(input.output_key).toBe("renders/neon/clips/shot_01_seedance_up.mp4");
    expect(input.scale).toBe(4);
    expect(input.model).toBe("RealESRGAN_x4plus");
    expect(input.action).toBeUndefined();  // dedicated endpoint, not a vivijure-backend action
  });

  it("forwards output_hash verbatim when present, omits it when absent (#583 sidecar stamp)", () => {
    const withHash = buildRunPodBody({ ...SAMPLE_INPUT, output_hash: "abc123" }, coerceConfig({}));
    expect(withHash.input.output_hash).toBe("abc123");
    const without = buildRunPodBody(SAMPLE_INPUT, coerceConfig({}));
    expect("output_hash" in without.input).toBe(false);
  });
});

describe("finish-upscale: poll token", () => {
  it("encodePoll / decodePoll round-trips all fields incl submittedAt", () => {
    const s = { jobId: "run-abc-123", shotId: "shot_02", srcFps: 24, frames: 96, submittedAt: 1_700_000_000_000 };
    expect(decodePoll(encodePoll(s))).toEqual(s);
  });
  it("decodePoll returns null for garbage / empty / incomplete tokens", () => {
    expect(decodePoll("not-base64-!!")).toBeNull();
    expect(decodePoll("")).toBeNull();
    expect(decodePoll(btoa(JSON.stringify({ jobId: "x" })))).toBeNull(); // missing shotId
  });
  it("decodePoll fills defaults for missing numeric fields; legacy token has no submittedAt", () => {
    const r = decodePoll(btoa(JSON.stringify({ jobId: "j", shotId: "s" })));
    expect(r?.srcFps).toBe(16);
    expect(r?.frames).toBe(0);
    expect(r?.submittedAt).toBeUndefined();
  });
});

describe("finish-upscale: parseBackendOutput", () => {
  it("extracts the upscaled clip_key + fields from a well-formed result", () => {
    const o = parseBackendOutput({ shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_up.mp4", out_fps: 16, frames: 80, applied: ["upscale:2x"] });
    expect(o).toMatchObject({ shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_up.mp4", applied: ["upscale:2x"] });
  });
  it("returns null for null / undefined / non-objects; defaults applied to []", () => {
    expect(parseBackendOutput(null)).toBeNull();
    expect(parseBackendOutput("x")).toBeNull();
    expect(parseBackendOutput({ clip_key: "k" })?.applied).toEqual([]);
  });
});

describe("finish-upscale: manifest conformance", () => {
  const MANIFEST = {
    name: "finish-upscale",
    version: "0.1.0",
    api: "vivijure-module/2",
    hooks: ["finish"],
    provides: [{ id: "upscale", label: "Upscale resolution (Real-ESRGAN)" }],
    config_schema: {
      scale: { type: "int",  default: 2, min: 2, max: 4 },
      model: { type: "enum", values: ["realesr-animevideov3", "RealESRGAN_x4plus"], default: "realesr-animevideov3" },
    },
  };
  it("passes the conformance manifest checker", () => {
    const checks = checkManifest(MANIFEST);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });
  it("invoke success / error / degraded responses all pass the response checker", () => {
    expect(checkInvokeResponse({ ok: true, output: { shot_id: "s", clip_key: "k_up.mp4", out_fps: 16, frames: 80, applied: ["upscale:2x"] } }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: false, error: "finish-upscale: input needs shot_id and clip_key" }).pass).toBe(true);
    expect(checkInvokeResponse({ ok: true, output: passthroughOutput(SAMPLE_INPUT, "no-runpod-secrets") }).pass).toBe(true);
  });
});

describe("finish-upscale: passthroughOutput (degrade observability #77)", () => {
  it("carries the clip + source fps/frames through unchanged", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "no-jobid");
    expect(o.clip_key).toBe(SAMPLE_INPUT.clip_key);   // input passed through, not a new clip
    expect(o.out_fps).toBe(SAMPLE_INPUT.src_fps);
    expect(o.frames).toBe(SAMPLE_INPUT.frames);
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
    for (const reason of ["no-runpod-secrets", "runpod-run-failed", "no-jobid", "exception"]) {
      const o = passthroughOutput(SAMPLE_INPUT, reason);
      expect(o.applied[0]).toBe(`passthrough:${reason}`);
      expect(o.degraded).toBeTruthy();
    }
  });
});

describe("finish-upscale: RunPod gone-detection + grace (#141)", () => {
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
