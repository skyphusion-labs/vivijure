import { describe, it, expect } from "vitest";
import { joinKeyframesToScenes, applyFinishOutput, orderFinalClips, resolveFinishConfigs, coerceSceneIds, callVideoFinish, classifyAssembleTransport, type FilmScene, type FinishShot } from "../src/film-orchestrator";
import type { ConfigSchema } from "../src/modules/types";
import type { Env } from "../src/env";

const finishShot = (over: Partial<FinishShot> = {}): FinishShot => ({
  shot_id: "shot_01", clip_key: "clips/shot_01.mp4", chain: ["MODULE_FINISH_RIFE"], idx: 0,
  status: "pending", applied: [], ...over,
});

describe("applyFinishOutput (chain fold)", () => {
  it("single-module chain: folds the output and marks done", () => {
    const fs = finishShot();
    applyFinishOutput(fs, { shot_id: "shot_01", clip_key: "clips/shot_01_finished.mp4", out_fps: 32, frames: 160, applied: ["interpolate:2x"] });
    expect(fs.clip_key).toBe("clips/shot_01_finished.mp4");
    expect(fs.applied).toEqual(["interpolate:2x"]);
    expect(fs.idx).toBe(1);
    expect(fs.poll).toBeUndefined();
    expect(fs.status).toBe("done");
  });

  it("multi-module chain: stays pending until the chain is exhausted, accumulating applied + chaining clips", () => {
    const fs = finishShot({ chain: ["MODULE_A", "MODULE_B"] });
    applyFinishOutput(fs, { shot_id: "shot_01", clip_key: "clips/after_a.mp4", out_fps: 32, frames: 160, applied: ["interpolate:2x"] });
    expect(fs.idx).toBe(1);
    expect(fs.status).toBe("pending"); // module B still to run
    expect(fs.clip_key).toBe("clips/after_a.mp4"); // B will finish A's output
    applyFinishOutput(fs, { shot_id: "shot_01", clip_key: "clips/after_b.mp4", out_fps: 32, frames: 160, applied: ["face_restore:gfpgan"] });
    expect(fs.idx).toBe(2);
    expect(fs.status).toBe("done");
    expect(fs.applied).toEqual(["interpolate:2x", "face_restore:gfpgan"]);
    expect(fs.clip_key).toBe("clips/after_b.mp4");
  });
});

const scenes: FilmScene[] = [
  { shot_id: "shot_01", prompt: "a city at dawn", seconds: 5 },
  { shot_id: "shot_02", prompt: "a chase", seconds: 7 },
  { shot_id: "shot_03", prompt: "the reveal", seconds: 6 },
];

describe("joinKeyframesToScenes", () => {
  it("joins every scene to its keyframe by shot_id, carrying prompt + seconds", () => {
    const { matched, missing } = joinKeyframesToScenes(scenes, [
      { shot_id: "shot_01", keyframe_key: "k/shot_01.png" },
      { shot_id: "shot_02", keyframe_key: "k/shot_02.png" },
      { shot_id: "shot_03", keyframe_key: "k/shot_03.png" },
    ]);
    expect(missing).toEqual([]);
    expect(matched).toEqual([
      { shot_id: "shot_01", keyframe_key: "k/shot_01.png", prompt: "a city at dawn", seconds: 5 },
      { shot_id: "shot_02", keyframe_key: "k/shot_02.png", prompt: "a chase", seconds: 7 },
      { shot_id: "shot_03", keyframe_key: "k/shot_03.png", prompt: "the reveal", seconds: 6 },
    ]);
  });

  it("reports scenes with no keyframe in `missing` and keeps the rest", () => {
    const { matched, missing } = joinKeyframesToScenes(scenes, [
      { shot_id: "shot_01", keyframe_key: "k/shot_01.png" },
      { shot_id: "shot_03", keyframe_key: "k/shot_03.png" },
    ]);
    expect(matched.map((m) => m.shot_id)).toEqual(["shot_01", "shot_03"]);
    expect(missing).toEqual(["shot_02"]);
  });

  it("ignores keyframes for shots not in the storyboard, and preserves scene order", () => {
    const { matched, missing } = joinKeyframesToScenes(scenes, [
      { shot_id: "shot_99", keyframe_key: "k/orphan.png" },
      { shot_id: "shot_02", keyframe_key: "k/shot_02.png" },
    ]);
    expect(matched.map((m) => m.shot_id)).toEqual(["shot_02"]);
    expect(missing).toEqual(["shot_01", "shot_03"]);
  });

  it("returns all missing when no keyframes were produced", () => {
    const { matched, missing } = joinKeyframesToScenes(scenes, []);
    expect(matched).toEqual([]);
    expect(missing).toEqual(["shot_01", "shot_02", "shot_03"]);
  });
});

describe("orderFinalClips", () => {
  it("orders clips by scene order regardless of completion order, for assemble", () => {
    // clips arrive out of order (shot_03 finished first, shot_01 last)
    const out = orderFinalClips(scenes, [
      { shot_id: "shot_03", clip_key: "c/shot_03.mp4" },
      { shot_id: "shot_01", clip_key: "c/shot_01.mp4" },
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
    ]);
    expect(out).toEqual([
      { shot_id: "shot_01", clip_key: "c/shot_01.mp4" },
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
      { shot_id: "shot_03", clip_key: "c/shot_03.mp4" },
    ]);
  });

  it("drops shots that produced no clip (never rendered), keeping the rest in scene order", () => {
    const out = orderFinalClips(scenes, [
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
      { shot_id: "shot_01", clip_key: "c/shot_01.mp4" },
    ]);
    expect(out.map((c) => c.shot_id)).toEqual(["shot_01", "shot_02"]);
  });

  it("ignores clips for shots not in the storyboard", () => {
    const out = orderFinalClips(scenes, [
      { shot_id: "shot_99", clip_key: "c/orphan.mp4" },
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
    ]);
    expect(out).toEqual([{ shot_id: "shot_02", clip_key: "c/shot_02.mp4" }]);
  });

  it("returns empty when nothing rendered", () => {
    expect(orderFinalClips(scenes, [])).toEqual([]);
  });
});

describe("resolveFinishConfigs (issue #75: finish modules must get their schema defaults)", () => {
  // a finish-rife-like schema: defaults turn interpolation on
  const rifeSchema: ConfigSchema = {
    interpolate: { type: "bool", default: true },
    interpolation_factor: { type: "int", default: 2, min: 1, max: 8 },
    face_restore: { type: "enum", values: ["none", "gfpgan", "codeformer"], default: "none" },
  };
  const serving = [{ name: "finish-rife", config_schema: rifeSchema }];

  it("applies schema defaults when the caller supplies no finish_config (the no-op bug fix)", () => {
    const [cfg] = resolveFinishConfigs(serving, undefined);
    // defaults present -> the module actually runs (interpolate true), not {} -> no-op
    expect(cfg).toEqual({ interpolate: true, interpolation_factor: 2, face_restore: "none" });
  });

  it("merges + clamps user overrides keyed by module name, keeping unspecified defaults", () => {
    const [cfg] = resolveFinishConfigs(serving, {
      "finish-rife": { interpolation_factor: 99, face_restore: "gfpgan" }, // 99 clamps to max 8
    });
    expect(cfg).toEqual({ interpolate: true, interpolation_factor: 8, face_restore: "gfpgan" });
  });

  it("returns configs in chain order, one per module", () => {
    const two = [
      { name: "a", config_schema: { x: { type: "int", default: 1 } } as ConfigSchema },
      { name: "b", config_schema: { y: { type: "bool", default: false } } as ConfigSchema },
    ];
    expect(resolveFinishConfigs(two, { b: { y: true } })).toEqual([{ x: 1 }, { y: true }]);
  });
});


describe("coerceSceneIds (scene-id seam: caller ids -> bundle's canonical shot_NN)", () => {
  it("renumbers non-canonical ids by declaration order", () => {
    const out = coerceSceneIds([
      { shot_id: "s1", prompt: "a", seconds: 5 },
      { shot_id: "s2", prompt: "b", seconds: 5 },
      { shot_id: "s3", prompt: "c", seconds: 5 },
    ]);
    expect(out.map((s) => s.shot_id)).toEqual(["shot_01", "shot_02", "shot_03"]);
  });
  it("keeps already-canonical shot_NN ids and preserves prompt/seconds", () => {
    expect(coerceSceneIds([{ shot_id: "shot_07", prompt: "x", seconds: 8 }]))
      .toEqual([{ shot_id: "shot_07", prompt: "x", seconds: 8 }]);
  });
  it("handles empty input", () => {
    expect(coerceSceneIds([])).toEqual([]);
  });
});

// Issue #82: the assemble cold-504 auto-recovery. callVideoFinish is driven by a MOCK VIDEO_FINISH_VPC
// binding (no real container) with backoffMs=0 so retries do not wait; the live endpoint is never hit.

// A VPC-binding double: returns each queued status in order (last repeats), recording every call.
function mockVpc(statuses: number[]) {
  const calls: string[] = [];
  let i = 0;
  const binding = {
    fetch: async (input: Request | string): Promise<Response> => {
      calls.push(typeof input === "string" ? input : input.url);
      const status = statuses[Math.min(i, statuses.length - 1)];
      i++;
      return new Response(JSON.stringify({ ok: status === 200 }), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const env = { VIDEO_FINISH_VPC: binding } as unknown as Env;
  return { env, calls };
}

const finishPayload = { clips: [{ url: "https://r2/clip.mp4" }], outputUrl: "https://r2/film.mp4", outputKey: "renders/f/film.mp4" };

describe("callVideoFinish transient retry (issue #82)", () => {
  it("returns a 200 on the first try with no retry", async () => {
    const { env, calls } = mockVpc([200]);
    const resp = await callVideoFinish(env, finishPayload, { backoffMs: 0 });
    expect(resp?.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it("retries a 504 (cold-boot + concat over the window) then succeeds", async () => {
    const { env, calls } = mockVpc([504, 200]);
    const resp = await callVideoFinish(env, finishPayload, { backoffMs: 0 });
    expect(resp?.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it("still retries a 503 (port binding) -- unchanged behavior", async () => {
    const { env, calls } = mockVpc([503, 200]);
    const resp = await callVideoFinish(env, finishPayload, { backoffMs: 0 });
    expect(resp?.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it("returns the last 504 after exhausting retries (orchestrator then auto-recovers)", async () => {
    const { env, calls } = mockVpc([504]);
    const resp = await callVideoFinish(env, finishPayload, { retries: 3, backoffMs: 0 });
    expect(resp?.status).toBe(504);
    expect(calls.length).toBe(3);
  });

  it("does NOT retry a terminal 500 (real ffmpeg error)", async () => {
    const { env, calls } = mockVpc([500, 200]);
    const resp = await callVideoFinish(env, finishPayload, { backoffMs: 0 });
    expect(resp?.status).toBe(500);
    expect(calls.length).toBe(1);
  });
});

describe("classifyAssembleTransport (issue #82 bounded auto-recover)", () => {
  const CAP = 6;

  it("a 504 under the cap stays in assemble (retry next poll)", () => {
    const d = classifyAssembleTransport(504, 0, CAP);
    expect(d.state).toBe("retry");
    if (d.state === "retry") {
      expect(d.attempts).toBe(1);
      expect(d.error).toContain("gateway 504");
      expect(d.error).toContain("clips intact");
    }
  });

  it("treats unreachable (null status) as transient", () => {
    const d = classifyAssembleTransport(null, 2, CAP);
    expect(d.state).toBe("retry");
    if (d.state === "retry") {
      expect(d.attempts).toBe(3);
      expect(d.error).toContain("container unreachable");
    }
  });

  it("treats 502 and 503 as transient too", () => {
    expect(classifyAssembleTransport(502, 0, CAP).state).toBe("retry");
    expect(classifyAssembleTransport(503, 0, CAP).state).toBe("retry");
  });

  it("goes terminal (exhausted) once the cap is reached", () => {
    const d = classifyAssembleTransport(504, CAP - 1, CAP);
    expect(d.state).toBe("exhausted");
    if (d.state === "exhausted") {
      expect(d.attempts).toBe(CAP);
      expect(d.error).toContain("reset phase");
    }
  });

  it("is 'ok' for a terminal container error (500) -- caller surfaces it, no loop", () => {
    expect(classifyAssembleTransport(500, 0, CAP).state).toBe("ok");
  });

  it("is 'ok' for a success (200)", () => {
    expect(classifyAssembleTransport(200, 0, CAP).state).toBe("ok");
  });

  it("resets the counter to 0 on a definitive answer, so a slow-but-successful finish never trips the cap", () => {
    // had 4 prior transient failures, then the (slow) container finally answers 200 -> streak broken.
    expect(classifyAssembleTransport(200, 4, CAP)).toEqual({ state: "ok", attempts: 0 });
    // a terminal container 500 likewise breaks the streak (a later manual re-run gets a full budget).
    expect(classifyAssembleTransport(500, 5, CAP)).toEqual({ state: "ok", attempts: 0 });
  });
});
