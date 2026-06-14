import { describe, it, expect } from "vitest";
import {
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput,
} from "../modules/finish-rife/src/finish";
import { checkManifest, checkInvokeResponse, allPass, failures } from "../src/modules/conformance";
import type { FinishInput } from "../modules/finish-rife/src/contract";

const SAMPLE_INPUT: FinishInput = {
  shot_id: "shot_01",
  clip_key: "renders/neon/clips/shot_01_seedance.mp4",
  src_fps: 16,
  frames: 80,
  width: 1920,
  height: 1080,
};

describe("finish-rife: coerceConfig", () => {
  it("returns sane defaults for an empty config", () => {
    const c = coerceConfig({});
    expect(c.interpolate).toBe(true);
    expect(c.interpolation_factor).toBe(2);
    expect(c.face_restore).toBe("none");
    expect(c.face_fidelity).toBe(0.7);
    expect(c.only_faces).toBe(true);
  });

  it("snaps interpolation_factor DOWN to the next lower power-of-two (floor)", () => {
    expect(coerceConfig({ interpolation_factor: 3 }).interpolation_factor).toBe(2);
    expect(coerceConfig({ interpolation_factor: 5 }).interpolation_factor).toBe(4);
    expect(coerceConfig({ interpolation_factor: 7 }).interpolation_factor).toBe(4);
    expect(coerceConfig({ interpolation_factor: 8 }).interpolation_factor).toBe(8);
    expect(coerceConfig({ interpolation_factor: 1 }).interpolation_factor).toBe(1);
  });

  it("does not round UP at the boundary (7 -> 4, not 8)", () => {
    expect(coerceConfig({ interpolation_factor: 7 }).interpolation_factor).toBe(4);
  });

  it("clamps face_fidelity to [0, 1]", () => {
    expect(coerceConfig({ face_fidelity: 1.5 }).face_fidelity).toBe(1);
    expect(coerceConfig({ face_fidelity: -0.1 }).face_fidelity).toBe(0);
  });

  it("rejects unknown face_restore values and falls back to default", () => {
    expect(coerceConfig({ face_restore: "unknown" }).face_restore).toBe("none");
    expect(coerceConfig({ face_restore: "gfpgan" }).face_restore).toBe("gfpgan");
    expect(coerceConfig({ face_restore: "codeformer" }).face_restore).toBe("codeformer");
  });
});

describe("finish-rife: buildRunPodBody", () => {
  it("emits action=finish_clip with the correct project, shot_id, and clip_key", () => {
    const { input } = buildRunPodBody(SAMPLE_INPUT, coerceConfig({}), "neon_film");
    expect(input.action).toBe("finish_clip");
    expect(input.project).toBe("neon_film");
    expect(input.shot_id).toBe("shot_01");
    expect(input.clip_key).toBe(SAMPLE_INPUT.clip_key);
  });

  it("threads the caller project into the body, not a hardcoded placeholder", () => {
    const a = buildRunPodBody(SAMPLE_INPUT, coerceConfig({}), "project_a");
    const b = buildRunPodBody(SAMPLE_INPUT, coerceConfig({}), "project_b");
    expect(a.input.project).toBe("project_a");
    expect(b.input.project).toBe("project_b");
  });

  it("converts face_restore=none to false in the backend config", () => {
    const { input } = buildRunPodBody(SAMPLE_INPUT, coerceConfig({ face_restore: "none" }), "p");
    const cfg = input.config as Record<string, unknown>;
    expect(cfg.face_restore).toBe(false);
  });

  it("passes gfpgan/codeformer backend names through as strings", () => {
    const { input } = buildRunPodBody(SAMPLE_INPUT, coerceConfig({ face_restore: "gfpgan" }), "p");
    const cfg = input.config as Record<string, unknown>;
    expect(cfg.face_restore).toBe("gfpgan");
  });
});

describe("finish-rife: poll token", () => {
  it("encodePoll / decodePoll round-trips all fields", () => {
    const s = { jobId: "run-abc-123", shotId: "shot_02", srcFps: 24, frames: 96 };
    expect(decodePoll(encodePoll(s))).toEqual(s);
  });

  it("decodePoll returns null for garbage, empty string, and incomplete tokens", () => {
    expect(decodePoll("not-base64-!!")).toBeNull();
    expect(decodePoll("")).toBeNull();
    expect(decodePoll(btoa(JSON.stringify({ jobId: "x" })))).toBeNull(); // missing shotId
  });

  it("decodePoll fills in defaults for missing numeric fields", () => {
    const tok = btoa(JSON.stringify({ jobId: "j", shotId: "s" }));
    const r = decodePoll(tok);
    expect(r?.srcFps).toBe(16);
    expect(r?.frames).toBe(0);
  });
});

describe("finish-rife: parseBackendOutput", () => {
  it("extracts all fields from a well-formed backend result", () => {
    const o = parseBackendOutput({ shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_finished.mp4", out_fps: 32, frames: 160, applied: ["interpolate:2x"] });
    expect(o).toMatchObject({ shot_id: "shot_01", out_fps: 32, frames: 160, applied: ["interpolate:2x"] });
  });

  it("returns null for null, undefined, and non-objects", () => {
    expect(parseBackendOutput(null)).toBeNull();
    expect(parseBackendOutput(undefined)).toBeNull();
    expect(parseBackendOutput("string")).toBeNull();
  });

  it("defaults applied to [] when absent", () => {
    const o = parseBackendOutput({ shot_id: "s", clip_key: "k" });
    expect(o?.applied).toEqual([]);
  });
});

describe("finish-rife: manifest conformance", () => {
  const MANIFEST = {
    name: "finish-rife",
    version: "0.1.0",
    api: "vivijure-module/1",
    hooks: ["finish"],
    provides: [
      { id: "interpolate", label: "Smooth motion (RIFE frame interpolation)" },
      { id: "face_restore", label: "Relock faces (GFPGAN)" },
    ],
    config_schema: {
      interpolate:          { type: "bool",  default: true },
      interpolation_factor: { type: "int",   default: 2, min: 1, max: 8 },
      face_restore:         { type: "enum",  values: ["none", "gfpgan", "codeformer"], default: "none" },
      face_fidelity:        { type: "float", default: 0.7, min: 0, max: 1 },
      only_faces:           { type: "bool",  default: true },
    },
  };

  it("passes the conformance manifest checker", () => {
    const checks = checkManifest(MANIFEST);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });

  it("invoke passthrough response passes the conformance response checker", () => {
    const r = checkInvokeResponse({
      ok: true,
      output: { shot_id: "shot_01", clip_key: "renders/x.mp4", out_fps: 16, frames: 80, applied: [] },
    });
    expect(r.pass).toBe(true);
  });

  it("invoke error response passes the conformance response checker", () => {
    const r = checkInvokeResponse({ ok: false, error: "finish-rife: input needs shot_id and clip_key" });
    expect(r.pass).toBe(true);
  });
});
