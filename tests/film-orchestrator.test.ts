import { describe, it, expect } from "vitest";
import { joinKeyframesToScenes, applyFinishOutput, orderFinalClips, resolveFinishConfigs, coerceSceneIds, callVideoFinish, classifyAssembleTransport, advanceFilmJob, filmJobDocKey, phaseAgeSeconds, listProjectKeyframes, KEYFRAME_STALL_SECONDS, PHASE_HARD_DEADLINE_SECONDS, type FilmScene, type FinishShot, type FilmJob } from "../src/film-orchestrator";
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

// Issue #122: an assemble that already PUT its film.mp4 (but whose response was lost, so the job
// is still phase "assemble") must self-heal from R2 presence on the next poll/sweep -- finalize from
// the existing object instead of re-running the concat. Fakes for R2 + a VPC double that records
// any call; the test fails if the container is invoked despite the output already being in R2.
function assembleEnv(opts: { jobInR2: object; filmOutputExists: boolean }) {
  const vpcCalls: string[] = [];
  const puts: string[] = [];
  const env = {
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
    R2_RENDERS: {
      get: async (key: string) =>
        key === filmJobDocKey((opts.jobInR2 as { film_id: string }).film_id)
          ? { text: async () => JSON.stringify(opts.jobInR2) }
          : null,
      head: async (key: string) =>
        opts.filmOutputExists && key === `renders/${(opts.jobInR2 as { film_id: string }).film_id}/film.mp4` ? {} : null,
      put: async (key: string) => { puts.push(key); },
    },
    VIDEO_FINISH_VPC: { fetch: async (input: Request | string) => { vpcCalls.push(typeof input === "string" ? input : input.url); return new Response(JSON.stringify({ ok: true, key: "renders/film-selfheal-1/film.mp4" }), { status: 200, headers: { "content-type": "application/json" } }); } },
    // presign creds: only the fall-through path reaches presignR2Get/Put (the short-circuit
    // returns before them), but they must be present so that path does not throw.
    R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
    R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
  } as unknown as Env;
  return { env, vpcCalls, puts };
}

describe("advanceFilmJob assemble self-heal from R2 presence (issue #122)", () => {
  const baseJob = {
    film_id: "film-selfheal-1",
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
    phase: "assemble" as const,
    finish_shots: [{ shot_id: "shot_01", clip_key: "renders/film-selfheal-1/clips/shot_01_finished.mp4", chain: ["M"], idx: 1, status: "done" as const, applied: [] }],
  };

  it("finalizes to done from the existing film.mp4 without invoking video-finish", async () => {
    const { env, vpcCalls } = assembleEnv({ jobInR2: baseJob, filmOutputExists: true });
    const r = await advanceFilmJob(env, "film-selfheal-1");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_key).toBe("renders/film-selfheal-1/film.mp4");
    expect(vpcCalls).toEqual([]); // the concat was NOT re-run -- derived from R2 presence
  });

  it("falls through to the container when the film.mp4 is not yet in R2", async () => {
    const { env, vpcCalls } = assembleEnv({ jobInR2: baseJob, filmOutputExists: false });
    await advanceFilmJob(env, "film-selfheal-1");
    expect(vpcCalls.length).toBe(1); // no short-circuit -> normal assemble path ran
  });
});

// Issue #129: a keyframe / finish module poll returns pending for any non-COMPLETED RunPod status, so a
// GC'd-but-finished job pins the film IN_PROGRESS forever. The driver must recover (adopt the keyframes
// already in R2) or fail loudly at an absolute ceiling -- never hang. Fakes for R2 (list + get + put).

describe("phaseAgeSeconds (#129)", () => {
  const base = { phase: "keyframe", created_at: 0 } as unknown as FilmJob;
  it("measures against phase_started_at when present", () => {
    expect(phaseAgeSeconds({ ...base, phase_started_at: 1000 } as FilmJob, 61_000)).toBe(60);
  });
  it("falls back to created_at on a pre-#129 job (no phase_started_at)", () => {
    expect(phaseAgeSeconds({ ...base, created_at: 1000 } as FilmJob, 61_000)).toBe(60);
  });
  it("never returns negative for a future stamp", () => {
    expect(phaseAgeSeconds({ ...base, phase_started_at: 10_000 } as FilmJob, 0)).toBe(0);
  });
});

// R2 list double: serves objects whose keys start with the queried prefix, supporting a single page.
function r2ListEnv(keys: string[]) {
  return {
    R2_RENDERS: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: keys.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
        truncated: false,
      }),
    },
  } as unknown as Env;
}

describe("listProjectKeyframes (#129 R2 adoption)", () => {
  const sc: FilmScene[] = [
    { shot_id: "shot_01", prompt: "a", seconds: 4 },
    { shot_id: "shot_02", prompt: "b", seconds: 4 },
  ];
  it("returns only keyframes for shots in the storyboard, keyed by R2 path", async () => {
    const env = r2ListEnv([
      "renders/neon/keyframes/shot_01.png",
      "renders/neon/keyframes/shot_02.png",
      "renders/neon/keyframes/shot_99.png", // stale from an older render -- must be dropped
    ]);
    const out = await listProjectKeyframes(env, "neon", sc);
    expect(out).toEqual([
      { shot_id: "shot_01", keyframe_key: "renders/neon/keyframes/shot_01.png" },
      { shot_id: "shot_02", keyframe_key: "renders/neon/keyframes/shot_02.png" },
    ]);
  });
  it("returns empty when no keyframes are in R2 yet", async () => {
    expect(await listProjectKeyframes(r2ListEnv([]), "neon", sc)).toEqual([]);
  });
});

// Env double that round-trips one film job through R2 (get -> mutate -> put) and serves the keyframe
// listing, so advanceFilmJob's recovery can be observed end-to-end on the persisted job.
function recoveryEnv(job: FilmJob, keyframeKeys: string[]) {
  let stored = JSON.stringify(job);
  const env = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmJobDocKey(job.film_id) ? { text: async () => stored } : null),
      put: async (key: string, body: string) => { if (key === filmJobDocKey(job.film_id)) stored = body; },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: keyframeKeys.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
        truncated: false,
      }),
    },
  } as unknown as Env;
  return { env, read: () => JSON.parse(stored) as FilmJob };
}

describe("advanceFilmJob keyframe stall recovery (#129)", () => {
  const scenes: FilmScene[] = [
    { shot_id: "shot_01", prompt: "a", seconds: 4 },
    { shot_id: "shot_02", prompt: "b", seconds: 4 },
  ];
  // keyframes_only so the adopted path completes WITHOUT touching motion modules / presign.
  const stuckJob = (over: Partial<FilmJob> = {}): FilmJob => ({
    film_id: "film-stall-kf",
    project: "neon",
    bundle_key: "bundles/neon.json",
    scenes,
    motion_backend: null,
    motion_config: {},
    finish_config: {},
    keyframe_binding: "MODULE_KEYFRAME",
    phase: "keyframe",
    keyframe_poll: "phantom-token",
    keyframes_only: true,
    created_at: Date.now() - (KEYFRAME_STALL_SECONDS + 60) * 1000, // stale
    phase_started_at: Date.now() - (KEYFRAME_STALL_SECONDS + 60) * 1000,
    ...over,
  });

  it("adopts the orphaned keyframes from R2 and advances (keyframes_only -> done)", async () => {
    const { env, read } = recoveryEnv(stuckJob(), [
      "renders/neon/keyframes/shot_01.png",
      "renders/neon/keyframes/shot_02.png",
    ]);
    const r = await advanceFilmJob(env, "film-stall-kf");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.keyframe_recovered).toBe(true);
    expect(r?.job.keyframes?.map((k) => k.shot_id)).toEqual(["shot_01", "shot_02"]);
    // persisted, not just in-memory
    expect(read().phase).toBe("done");
  });

  it("does NOT escalate a fresh keyframe phase that has not gone stale yet", async () => {
    const fresh = stuckJob({
      created_at: Date.now(),
      phase_started_at: Date.now(),
    });
    const { env } = recoveryEnv(fresh, ["renders/neon/keyframes/shot_01.png"]);
    // The phantom poll token routes through the keyframe module, which is not bound in this env, so the
    // normal leg fails it; the point is recovery did NOT fire (no adoption from R2) before the deadline.
    const r = await advanceFilmJob(env, "film-stall-kf");
    expect(r?.job.keyframe_recovered).toBeUndefined();
  });

  it("does not adopt when no keyframes are in R2 (not actually complete)", async () => {
    // Stale but nothing in R2 to adopt, and not yet past the hard ceiling -> stays in keyframe.
    const { env } = recoveryEnv(stuckJob({ keyframe_binding: null }), []);
    const r = await advanceFilmJob(env, "film-stall-kf");
    expect(r?.job.keyframe_recovered).toBeUndefined();
    expect(r?.job.phase).not.toBe("done");
  });
});

describe("advanceFilmJob hard-deadline loud fail (#129)", () => {
  const scenes: FilmScene[] = [{ shot_id: "shot_01", prompt: "a", seconds: 4 }];
  const wedged = (phase: FilmJob["phase"]): FilmJob => ({
    film_id: "film-wedged",
    project: "neon",
    bundle_key: "b",
    scenes,
    motion_backend: null,
    motion_config: {},
    finish_config: {},
    keyframe_binding: null,
    phase,
    created_at: Date.now() - (PHASE_HARD_DEADLINE_SECONDS + 60) * 1000,
    phase_started_at: Date.now() - (PHASE_HARD_DEADLINE_SECONDS + 60) * 1000,
  });

  it("fails a clips phase wedged past the ceiling, with a diagnostic, and persists it", async () => {
    const { env, read } = recoveryEnv(wedged("clips"), []);
    const r = await advanceFilmJob(env, "film-wedged");
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/stalled in phase "clips"/);
    expect(read().phase).toBe("failed");
  });

  it("fails a finish phase wedged past the ceiling", async () => {
    const { env } = recoveryEnv(wedged("finish"), []);
    const r = await advanceFilmJob(env, "film-wedged");
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/stalled in phase "finish"/);
  });

  it("leaves a terminal phase untouched (no false ceiling fail)", async () => {
    const done = wedged("done");
    const { env } = recoveryEnv(done, []);
    const r = await advanceFilmJob(env, "film-wedged");
    expect(r?.job.phase).toBe("done");
  });
});
