import { describe, it, expect } from "vitest";
import { checkManifest, checkInvokeResponse, checkCancelResponse, checkHookOutput, hookOutputViolation, allPass, failures } from "../src/modules/conformance";

const goodManifest = {
  name: "demo",
  version: "1.0.0",
  api: "vivijure-module/2",
  hooks: ["finish"],
  provides: [{ id: "x", label: "X" }],
  config_schema: {
    n: { type: "int", default: 2, min: 1, max: 4 },
    flag: { type: "bool", default: true },
    mode: { type: "enum", values: ["a", "b"], default: "a" },
  },
};

describe("conformance: manifest", () => {
  it("passes a well-formed manifest", () => {
    const checks = checkManifest(goodManifest);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });

  it("fails an unknown api version", () => {
    const checks = checkManifest({ ...goodManifest, api: "vivijure-module/9" });
    expect(allPass(checks)).toBe(false);
  });

  it("fails an unknown hook", () => {
    const checks = checkManifest({ ...goodManifest, hooks: ["finish", "bogus"] });
    expect(allPass(checks)).toBe(false);
  });

  it("fails a config field whose default does not match its type", () => {
    const checks = checkManifest({ ...goodManifest, config_schema: { n: { type: "int", default: "two" } } });
    expect(allPass(checks)).toBe(false);
  });

  it("fails an enum default outside its values", () => {
    const checks = checkManifest({ ...goodManifest, config_schema: { mode: { type: "enum", values: ["a", "b"], default: "c" } } });
    expect(allPass(checks)).toBe(false);
  });

  it("accepts a config field marked scope:install (operator-set-once)", () => {
    const checks = checkManifest({
      ...goodManifest,
      config_schema: { recipient: { type: "string", default: "", scope: "install" } },
    });
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });

  it("fails a config field with an unknown scope", () => {
    const checks = checkManifest({
      ...goodManifest,
      config_schema: { recipient: { type: "string", default: "", scope: "bogus" } },
    });
    expect(allPass(checks)).toBe(false);
  });

  it("fails a provides entry missing a label", () => {
    const checks = checkManifest({ ...goodManifest, provides: [{ id: "x" }] });
    expect(allPass(checks)).toBe(false);
  });
});

describe("conformance: invoke response", () => {
  it("accepts ok:true with output", () => {
    expect(checkInvokeResponse({ ok: true, output: { storyboard: {} } }).pass).toBe(true);
  });
  it("accepts ok:false with an error string", () => {
    expect(checkInvokeResponse({ ok: false, error: "nope" }).pass).toBe(true);
  });
  it("rejects ok:true with no output", () => {
    expect(checkInvokeResponse({ ok: true }).pass).toBe(false);
  });
  it("rejects ok:false with no error string", () => {
    expect(checkInvokeResponse({ ok: false }).pass).toBe(false);
  });
  it("rejects a body with no boolean ok", () => {
    expect(checkInvokeResponse({ output: {} }).pass).toBe(false);
    expect(checkInvokeResponse(null).pass).toBe(false);
  });
});

describe("conformance: cancel response", () => {
  it("accepts ok:true (cancelled / idempotent success)", () => {
    expect(checkCancelResponse({ ok: true }).pass).toBe(true);
  });
  it("accepts ok:false with an error string (could not cancel -> core degrade-logs)", () => {
    expect(checkCancelResponse({ ok: false, error: "job not found" }).pass).toBe(true);
  });
  it("rejects ok:false with no error string", () => {
    expect(checkCancelResponse({ ok: false }).pass).toBe(false);
  });
  it("rejects a body with no boolean ok", () => {
    expect(checkCancelResponse({}).pass).toBe(false);
    expect(checkCancelResponse(null).pass).toBe(false);
  });
});

describe("conformance: hook output payload", () => {
  it("accepts a well-formed finish output", () => {
    const out = { shot_id: "s1", clip_key: "k.mp4", out_fps: 24, frames: 48, applied: ["interpolate:2x"] };
    expect(checkHookOutput("finish", out).pass).toBe(true);
  });
  it("rejects a finish output missing applied (envelope-ok but contract-broken)", () => {
    const out = { shot_id: "s1", clip_key: "k.mp4", out_fps: 24, frames: 48 };
    expect(checkHookOutput("finish", out).pass).toBe(false);
  });
  it("accepts a well-formed speech output", () => {
    const out = { shot_id: "s1", audio_key: "renders/neon/dialogue/s1_enh.wav", applied: ["speech-upscale:resemble-enhance"] };
    expect(checkHookOutput("speech", out).pass).toBe(true);
  });
  it("accepts a soft-degraded speech output (passthrough audio_key, empty applied, degraded reason)", () => {
    const out = { shot_id: "s1", audio_key: "renders/neon/dialogue/s1.wav", applied: [], degraded: "backend down" };
    expect(checkHookOutput("speech", out).pass).toBe(true);
  });
  it("rejects a speech output missing audio_key (envelope-ok but contract-broken)", () => {
    const out = { shot_id: "s1", applied: [] };
    expect(checkHookOutput("speech", out).pass).toBe(false);
  });
  it("accepts a well-formed plan.enhance output", () => {
    const out = { storyboard: { scenes: [{ prompt: "x" }] }, notes: ["did a thing"] };
    expect(checkHookOutput("plan.enhance", out).pass).toBe(true);
  });
  it("rejects a plan.enhance output whose storyboard has no scenes[]", () => {
    expect(checkHookOutput("plan.enhance", { storyboard: {} }).pass).toBe(false);
  });
  it("accepts a well-formed keyframe output", () => {
    const out = { project: "neon", keyframes: [{ shot_id: "s1", keyframe_key: "kf.png" }] };
    expect(checkHookOutput("keyframe", out).pass).toBe(true);
  });
  it("accepts a well-formed motion.backend output", () => {
    const out = { shot_id: "s1", clip_key: "c.mp4", fps: 24, frames: 96 };
    expect(checkHookOutput("motion.backend", out).pass).toBe(true);
  });
  it("accepts a well-formed cast.image output", () => {
    const out = { cast_id: 7, images: [{ key: "r.png", mime: "image/png" }], applied: ["generated:1"] };
    expect(checkHookOutput("cast.image", out).pass).toBe(true);
  });
  it("accepts a well-formed notify output (including an empty delivered)", () => {
    expect(checkHookOutput("notify", { delivered: [] }).pass).toBe(true);
  });
  it("accepts a well-formed master output", () => {
    const out = { audio_key: "audio/bed.wav", applied: ["music-upscale:soxr48k", "loudnorm:-14LUFS"] };
    expect(checkHookOutput("master", out).pass).toBe(true);
  });
  it("accepts a master soft-degrade (passthrough bed + degraded reason)", () => {
    const out = { audio_key: "audio/bed.wav", applied: ["passthrough:no-runpod-secrets"], degraded: "no-runpod-secrets" };
    expect(checkHookOutput("master", out).pass).toBe(true);
  });
  it("rejects a master output missing audio_key (envelope-ok but contract-broken)", () => {
    expect(checkHookOutput("master", { applied: [] }).pass).toBe(false);
  });
  it("rejects a master output missing applied", () => {
    expect(checkHookOutput("master", { audio_key: "audio/bed.wav" }).pass).toBe(false);
  });
  it("accepts a well-formed score output, with and without the (S4) degraded field", () => {
    expect(checkHookOutput("score", { film_key: "f.mp4", applied: ["music:minimax"] }).pass).toBe(true);
    expect(checkHookOutput("score", { film_key: "f.mp4", applied: [], degraded: "tts down, bed only" }).pass).toBe(true);
  });
  it("rejects a score output whose degraded is present but not a string", () => {
    expect(checkHookOutput("score", { film_key: "f.mp4", applied: [], degraded: 7 }).pass).toBe(false);
  });
  it("accepts a film.finish output with only film_key (applied/degraded stay optional by decision)", () => {
    expect(checkHookOutput("film.finish", { film_key: "f.mp4" }).pass).toBe(true);
    expect(checkHookOutput("film.finish", { film_key: "f.mp4", applied: ["film-titles"], degraded: "" }).pass).toBe(true);
  });
  it("rejects a film.finish output whose PRESENT applied/degraded break their types (S4: no unchecked flow into job state)", () => {
    expect(checkHookOutput("film.finish", { film_key: "f.mp4", applied: "film-titles" }).pass).toBe(false);
    expect(checkHookOutput("film.finish", { film_key: "f.mp4", applied: [42] }).pass).toBe(false);
    expect(checkHookOutput("film.finish", { film_key: "f.mp4", degraded: { reason: "x" } }).pass).toBe(false);
  });
  it("rejects a non-object output", () => {
    expect(checkHookOutput("finish", null).pass).toBe(false);
  });
  it("rejects an unknown hook name", () => {
    expect(checkHookOutput("not.a.hook", { anything: true }).pass).toBe(false);
  });
});

describe("hookOutputViolation (terminal-seam guard, #345)", () => {
  it("returns null for a contract-valid output", () => {
    const out = { shot_id: "s", clip_key: "renders/p/clips/s.mp4", out_fps: 24, frames: 120, applied: ["upscale:2x"] };
    expect(hookOutputViolation("finish-upscale", "finish", out)).toBeNull();
  });
  it("returns a traceable reason (module id + hook + detail) for a malformed output", () => {
    const reason = hookOutputViolation("finish-upscale", "finish", { shot_id: "s" });
    expect(reason).toContain("finish-upscale"); // the module id, for the event channel
    expect(reason).toContain("finish");         // the hook
    expect(reason).toContain("clip_key");        // the specific field that broke
  });
  it("catches an envelope-correct but empty payload", () => {
    expect(hookOutputViolation("m", "master", {})).not.toBeNull();
  });
  it("does not flag a legitimate soft-degrade (passthrough carries the required fields)", () => {
    // an honest master degrade: ok:true, audio_key passed through, applied:[], plus a degraded reason
    const degraded = { audio_key: "renders/p/audio/bed.wav", applied: [], degraded: "container unreachable" };
    expect(hookOutputViolation("audio-master", "master", degraded)).toBeNull();
  });
});
