import { describe, it, expect } from "vitest";
import { joinKeyframesToScenes, applyFinishOutput, orderFinalClips, resolveFinishConfigs, coerceSceneIds, callVideoFinish, classifyAssembleTransport, advanceFilmJob, filmJobDocKey, clipJobDocKey, phaseAgeSeconds, listProjectKeyframes, keyframeSetCompleteInR2, listProjectClips, clipFileMatchesShot, finishShotAdoptableFromR2, reclaimFinishShotsFromR2, KEYFRAME_STALL_SECONDS, PHASE_HARD_DEADLINE_SECONDS, type FilmScene, type FinishShot, type FilmJob } from "../src/film-orchestrator";
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

describe("finish-phase R2 adoption (RUN #29: envelope frozen IN_PROGRESS, artifact in R2)", () => {
  it("adopts a FAILED shot whose finished clip is in R2 (the GC'd-job path, #141)", () => {
    expect(finishShotAdoptableFromR2(finishShot({ status: "failed", error: "GC'd" }))).toBe(true);
  });

  it("adopts a PENDING last-chain shot with a poll token (the frozen-IN_PROGRESS envelope path)", () => {
    expect(finishShotAdoptableFromR2(finishShot({ status: "pending", poll: "tok", idx: 0, chain: ["MODULE_FINISH_RIFE"] }))).toBe(true);
  });

  it("does NOT adopt a PENDING shot mid-chain (its R2 key would be an intermediate module's output)", () => {
    expect(finishShotAdoptableFromR2(finishShot({ status: "pending", poll: "tok", idx: 0, chain: ["MODULE_A", "MODULE_B"] }))).toBe(false);
  });

  it("does NOT adopt a PENDING shot with no poll token (never submitted -- nothing produced it yet)", () => {
    expect(finishShotAdoptableFromR2(finishShot({ status: "pending", poll: undefined, idx: 0, chain: ["MODULE_FINISH_RIFE"] }))).toBe(false);
  });

  it("does NOT re-touch an already-done shot", () => {
    expect(finishShotAdoptableFromR2(finishShot({ status: "done" }))).toBe(false);
  });

  it("reclaims a stuck PENDING shot from R2 presence: marks done, sets the clip key, clears the poll", () => {
    const stuck = finishShot({ shot_id: "shot_02", status: "pending", poll: "frozen", idx: 0, chain: ["MODULE_FINISH_RIFE"] });
    const ok = finishShot({ shot_id: "shot_01", status: "done", clip_key: "renders/p/clips/shot_01_finished.mp4" });
    const shots = [ok, stuck];
    const present = new Map([["shot_02", "renders/p/clips/shot_02_finished.mp4"]]);
    const adopted = reclaimFinishShotsFromR2(shots, present);
    expect(adopted).toBe(1);
    expect(stuck.status).toBe("done");
    expect(stuck.clip_key).toBe("renders/p/clips/shot_02_finished.mp4");
    expect(stuck.poll).toBeUndefined();
    expect(shots.every((s) => s.status !== "pending")).toBe(true); // phase can now advance to assemble
  });

  it("leaves a stuck PENDING shot pending when its clip is genuinely absent from R2 (no false adoption)", () => {
    const stuck = finishShot({ shot_id: "shot_02", status: "pending", poll: "frozen", idx: 0, chain: ["MODULE_FINISH_RIFE"] });
    const adopted = reclaimFinishShotsFromR2([stuck], new Map());
    expect(adopted).toBe(0);
    expect(stuck.status).toBe("pending");
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

// keyframe phase: adopt on a *pending* poll only when the FULL set is in R2 (envelope-freeze, mirrors
// #154 for finish; the completeness guard prevents advancing on a partial mid-generation set).
describe("keyframeSetCompleteInR2 (pending-poll adoption guard)", () => {
  const job = (scenes: FilmScene[]) => ({ project: "neon", scenes } as unknown as FilmJob);
  const sc: FilmScene[] = [
    { shot_id: "shot_01", prompt: "a", seconds: 4 },
    { shot_id: "shot_02", prompt: "b", seconds: 4 },
    { shot_id: "shot_03", prompt: "c", seconds: 4 },
  ];
  it("true when every scene has a keyframe in R2 (full set -> adopt now, do not wait 20min)", async () => {
    const env = r2ListEnv([
      "renders/neon/keyframes/shot_01.png",
      "renders/neon/keyframes/shot_02.png",
      "renders/neon/keyframes/shot_03.png",
    ]);
    expect(await keyframeSetCompleteInR2(env, job(sc))).toBe(true);
  });
  it("false on a PARTIAL set (mid-generation -> must NOT advance early)", async () => {
    const env = r2ListEnv([
      "renders/neon/keyframes/shot_01.png",
      "renders/neon/keyframes/shot_02.png",
    ]);
    expect(await keyframeSetCompleteInR2(env, job(sc))).toBe(false);
  });
  it("false when none are in R2 and false for an empty storyboard", async () => {
    expect(await keyframeSetCompleteInR2(r2ListEnv([]), job(sc))).toBe(false);
    expect(await keyframeSetCompleteInR2(r2ListEnv([]), job([]))).toBe(false);
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

describe("clipFileMatchesShot (#139 clip-name matching)", () => {
  it("matches the shot's motion clip at a digit boundary", () => {
    expect(clipFileMatchesShot("shot_09_i2v.mp4", "shot_09")).toBe(true);
    expect(clipFileMatchesShot("shot_01.mp4", "shot_01")).toBe(true);
    expect(clipFileMatchesShot("shot_10_seedance.mov", "shot_10")).toBe(true);
  });
  it("does NOT let shot_1 swallow shot_10 (digit boundary)", () => {
    expect(clipFileMatchesShot("shot_10_i2v.mp4", "shot_1")).toBe(false);
  });
  it("excludes finish-chain outputs (they are not the raw motion clip)", () => {
    expect(clipFileMatchesShot("shot_06_finished.mp4", "shot_06")).toBe(false);
    expect(clipFileMatchesShot("shot_06_i2v_finished.mp4", "shot_06")).toBe(false);
  });
  it("requires a video extension", () => {
    expect(clipFileMatchesShot("shot_09_i2v.txt", "shot_09")).toBe(false);
    expect(clipFileMatchesShot("shot_09", "shot_09")).toBe(false);
  });
});

describe("listProjectClips (#139 R2 adoption)", () => {
  const sc: FilmScene[] = [
    { shot_id: "shot_01", prompt: "a", seconds: 4 },
    { shot_id: "shot_10", prompt: "b", seconds: 4 },
  ];
  it("returns the motion clip per in-storyboard shot, boundary-safe and excluding _finished", async () => {
    const env = r2ListEnv([
      "renders/neon/clips/shot_01_i2v.mp4",
      "renders/neon/clips/shot_01_finished.mp4", // finish output -- must NOT be chosen
      "renders/neon/clips/shot_10_i2v.mp4",
      "renders/neon/clips/shot_99_i2v.mp4",      // not in storyboard -- dropped
    ]);
    const out = await listProjectClips(env, "neon", sc);
    expect(out).toEqual([
      { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4" },
      { shot_id: "shot_10", clip_key: "renders/neon/clips/shot_10_i2v.mp4" },
    ]);
  });
  it("returns empty when no clips are in R2", async () => {
    expect(await listProjectClips(r2ListEnv([]), "neon", sc)).toEqual([]);
  });
});

// Env double that round-trips BOTH the film-job doc and the clip-job doc through R2, serves the clips
// listing, and has NO module bindings (so enterFinishPhase finds an empty finish chain -> clips_only
// shortcuts to done without touching any module). Lets the clips recovery be observed end-to-end.
function clipsRecoveryEnv(job: FilmJob, clipJob: ClipJobLike, clipKeys: string[], moduleResp: unknown = { ok: true, pending: true }) {
  const filmDoc = filmJobDocKey(job.film_id);
  const clipDoc = clipJobDocKey(clipJob.job_id);
  let filmStored = JSON.stringify(job);
  let clipStored = JSON.stringify(clipJob);
  const env = {
    R2_RENDERS: {
      get: async (key: string) =>
        key === filmDoc ? { text: async () => filmStored }
        : key === clipDoc ? { text: async () => clipStored }
        : null,
      put: async (key: string, body: string) => {
        if (key === filmDoc) filmStored = body;
        else if (key === clipDoc) clipStored = body;
      },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: clipKeys.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
        truncated: false,
      }),
    },
    // motion.backend stub: returns moduleResp on /poll. Default = pending (still rendering); pass a fail
    // envelope { ok:false, error } to simulate a #142 fast-fail of a GC'd job.
    MODULE_OWN_GPU: { fetch: async () => new Response(JSON.stringify(moduleResp), { headers: { "content-type": "application/json" } }) },
  } as unknown as Env;
  return { env, readFilm: () => JSON.parse(filmStored) as FilmJob, readClip: () => JSON.parse(clipStored) as ClipJobLike };
}

interface ClipJobLike {
  job_id: string;
  project: string;
  motion_backend: string | null;
  binding: string | null;
  shots: { shot_id: string; status: string; clip_key?: string; poll?: string; error?: string }[];
  created_at: number;
}

describe("advanceFilmJob clips stall recovery (#139)", () => {
  const scenes: FilmScene[] = [
    { shot_id: "shot_01", prompt: "a", seconds: 4 },
    { shot_id: "shot_02", prompt: "b", seconds: 4 },
    { shot_id: "shot_03", prompt: "c", seconds: 4 },
  ];
  const clipsJob = (): ClipJobLike => ({
    job_id: "clips-stall-1",
    project: "neon",
    motion_backend: "own-gpu",
    binding: "MODULE_OWN_GPU",
    // shot_02 already collected; shot_01 + shot_03 wedged pending on dead poll tokens
    shots: [
      { shot_id: "shot_01", status: "pending", poll: "phantom-1" },
      { shot_id: "shot_02", status: "done", clip_key: "renders/neon/clips/shot_02_i2v.mp4" },
      { shot_id: "shot_03", status: "pending", poll: "phantom-3" },
    ],
    created_at: Date.now(),
  });
  // clips_only so the recovered completion shortcuts to done (no finish modules bound in the test env).
  const stalledFilm = (over: Partial<FilmJob> = {}): FilmJob => ({
    film_id: "film-stall-clips",
    project: "neon",
    bundle_key: "b",
    scenes,
    motion_backend: "own-gpu",
    motion_config: {},
    finish_config: {},
    keyframe_binding: null,
    phase: "clips",
    clip_job_id: "clips-stall-1",
    clips_only: true,
    created_at: Date.now() - (KEYFRAME_STALL_SECONDS + 60) * 1000,
    phase_started_at: Date.now() - (KEYFRAME_STALL_SECONDS + 60) * 1000,
    ...over,
  });

  it("adopts the orphaned clips from R2, completes the clip job, and advances out of clips", async () => {
    const { env, readFilm, readClip } = clipsRecoveryEnv(stalledFilm(), clipsJob(), [
      "renders/neon/clips/shot_01_i2v.mp4",
      "renders/neon/clips/shot_02_i2v.mp4",
      "renders/neon/clips/shot_03_i2v.mp4",
    ]);
    const r = await advanceFilmJob(env, "film-stall-clips");
    expect(r?.job.clips_recovered).toBe(true);
    expect(r?.job.phase).not.toBe("clips"); // advanced (clips_only -> done)
    // the two stuck shots were filled from R2 in the persisted clip doc
    const cj = readClip();
    expect(cj.shots.find((s) => s.shot_id === "shot_01")?.clip_key).toBe("renders/neon/clips/shot_01_i2v.mp4");
    expect(cj.shots.find((s) => s.shot_id === "shot_03")?.clip_key).toBe("renders/neon/clips/shot_03_i2v.mp4");
    expect(cj.shots.every((s) => s.status === "done")).toBe(true);
    expect(readFilm().clips_recovered).toBe(true);
  });

  it("does not run the R2 adoption when the stuck shots' clips are absent from R2", async () => {
    const { env } = clipsRecoveryEnv(stalledFilm(), clipsJob(), [
      "renders/neon/clips/shot_02_i2v.mp4", // only the already-done shot; the 2 stuck shots have nothing
    ]);
    const r = await advanceFilmJob(env, "film-stall-clips");
    // The clips-from-R2 adoption did NOT fire (no pending shot had an R2 clip to adopt). What the
    // normal clips leg then does with the two unbound/phantom shots is orthogonal to this fix; the
    // invariant under test is that recovery does not fabricate a clip it cannot find in R2.
    expect(r?.job.clips_recovered).toBeUndefined();
  });

  it("does not fire before the stall deadline on a fresh clips phase", async () => {
    const fresh = stalledFilm({ created_at: Date.now(), phase_started_at: Date.now() });
    const { env } = clipsRecoveryEnv(fresh, clipsJob(), [
      "renders/neon/clips/shot_01_i2v.mp4",
      "renders/neon/clips/shot_03_i2v.mp4",
    ]);
    const r = await advanceFilmJob(env, "film-stall-clips");
    expect(r?.job.clips_recovered).toBeUndefined();
  });

  it("adopts a shot the module prematurely FAILED when its clip is in R2 (#141 interaction)", async () => {
    // After the module 404-grace fix, a GC'd shot comes back status=failed -- but the GPU wrote the clip
    // before the job aged out. The driver must reclaim it: artifact in R2 overrides the module's failure.
    const failedJob: ClipJobLike = {
      job_id: "clips-stall-1", project: "neon", motion_backend: "own-gpu", binding: "MODULE_OWN_GPU",
      shots: [
        { shot_id: "shot_01", status: "failed", error: "own-gpu job not found on RunPod (#141)" },
        { shot_id: "shot_02", status: "done", clip_key: "renders/neon/clips/shot_02_i2v.mp4" },
        { shot_id: "shot_03", status: "failed", error: "own-gpu job not found on RunPod (#141)" },
      ],
      created_at: Date.now(),
    };
    const { env, readClip } = clipsRecoveryEnv(stalledFilm(), failedJob, [
      "renders/neon/clips/shot_01_i2v.mp4",
      "renders/neon/clips/shot_02_i2v.mp4",
      "renders/neon/clips/shot_03_i2v.mp4",
    ]);
    const r = await advanceFilmJob(env, "film-stall-clips");
    expect(r?.job.clips_recovered).toBe(true);
    expect(r?.job.phase).not.toBe("clips");
    const cj = readClip();
    expect(cj.shots.every((s) => s.status === "done")).toBe(true);
    // the premature failure error was cleared on the reclaimed shots
    expect(cj.shots.find((s) => s.shot_id === "shot_01")?.error).toBeUndefined();
  });

  it("RE-FIRES across sweeps for STAGGERED stale clips (#143): adopts a subset, then the rest", async () => {
    // shot_02 already done; shot_01 + shot_03 still pending (their clips land at different times).
    const job = clipsJob();
    // Mutable R2 key set: only shot_01's clip has landed at first; shot_03's lands before the 2nd sweep.
    const r2 = ["renders/neon/clips/shot_01_i2v.mp4", "renders/neon/clips/shot_02_i2v.mp4"];
    const { env, readFilm, readClip } = clipsRecoveryEnv(stalledFilm(), job, r2);

    // Sweep 1: adopts shot_01 (in R2); shot_03 has no clip yet -> partial, stays in clips, NOT advanced,
    // and the one-shot gate is NOT consumed (so the next sweep can finish the job).
    const r1 = await advanceFilmJob(env, "film-stall-clips");
    expect(r1?.job.phase).toBe("clips");
    expect(r1?.job.clips_recovered).toBeUndefined();
    const cj1 = readClip();
    expect(cj1.shots.find((s) => s.shot_id === "shot_01")?.status).toBe("done");
    expect(cj1.shots.find((s) => s.shot_id === "shot_03")?.status).toBe("pending");

    // shot_03's clip lands in R2 between sweeps.
    r2.push("renders/neon/clips/shot_03_i2v.mp4");

    // Sweep 2: re-fires, adopts the now-present shot_03, job complete -> advances out of clips.
    const r2res = await advanceFilmJob(env, "film-stall-clips");
    expect(r2res?.job.clips_recovered).toBe(true);
    expect(r2res?.job.phase).not.toBe("clips");
    expect(readClip().shots.every((s) => s.status === "done")).toBe(true);
    expect(readFilm().clips_recovered).toBe(true);
  });

  it("FRESH render (<20min): module fast-fails 3 shots but their clips are in R2 -> finish gets all, not 7 (#141 regression)", async () => {
    // The lead's decisive case. A brand-new render at ~2.5min: the 20min stall-recovery must NOT run, so
    // only the clips-leg reclaim (before the complete-judgment) can save it. The module fast-fails all 3
    // pending shots (simulating #142 on GC'd jobs), but all 3 clips ARE in R2. Without the fix, summarizeJob
    // reads complete (0 done + 3 failed = 3) and the film advances DROPPING all 3.
    const fresh = stalledFilm({ created_at: Date.now(), phase_started_at: Date.now() }); // FRESH, not stale
    const allPending: ClipJobLike = {
      job_id: "clips-stall-1", project: "neon", motion_backend: "own-gpu", binding: "MODULE_OWN_GPU",
      shots: [
        { shot_id: "shot_01", status: "pending", poll: "phantom-1" },
        { shot_id: "shot_02", status: "pending", poll: "phantom-2" },
        { shot_id: "shot_03", status: "pending", poll: "phantom-3" },
      ],
      created_at: Date.now(),
    };
    // module FAST-FAILS every poll (#142), but every clip is in R2.
    const { env, readClip, readFilm } = clipsRecoveryEnv(fresh, allPending, [
      "renders/neon/clips/shot_01_i2v.mp4",
      "renders/neon/clips/shot_02_i2v.mp4",
      "renders/neon/clips/shot_03_i2v.mp4",
    ], { ok: false, error: "own-gpu job not found on RunPod (#141)" });
    const r = await advanceFilmJob(env, "film-stall-clips");
    // all 3 reclaimed from R2 in the clips leg, BEFORE the complete-judgment -> film advanced with ALL 3
    expect(readClip().shots.every((s) => s.status === "done")).toBe(true);
    expect(readClip().shots.filter((s) => s.status === "done").length).toBe(3); // not a 0/partial drop
    expect(r?.job.phase).not.toBe("clips"); // advanced (clips_only -> done)
  });
});

describe("advanceFinishPhase R2 reclaim (#141: finish output in R2 beats a finish-module fast-fail)", () => {
  // Film at phase=finish; one finish shot already FAILED (finish-rife fast-failed its GC'd job), but the
  // finished clip IS in R2. The reclaim must mark it done from R2 BEFORE the every-terminal -> advance
  // judgment, so the film does not advance to assemble dropping a shot whose _finished.mp4 exists.
  const finishFilm = (): FilmJob => ({
    film_id: "film-finish-reclaim",
    project: "neon",
    bundle_key: "b",
    scenes: [
      { shot_id: "shot_01", prompt: "a", seconds: 4 },
      { shot_id: "shot_02", prompt: "b", seconds: 4 },
    ],
    motion_backend: "own-gpu",
    motion_config: {},
    finish_config: {},
    keyframe_binding: null,
    phase: "finish",
    clips_only: true, // shortcut to done when finish is complete (no assemble container needed in test)
    finish_shots: [
      { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4", chain: ["MODULE_FINISH_RIFE"], configs: [{}], idx: 0, status: "done", applied: [], poll: undefined, error: undefined },
      { shot_id: "shot_02", clip_key: "renders/neon/clips/shot_02_i2v.mp4", chain: ["MODULE_FINISH_RIFE"], configs: [{}], idx: 0, status: "failed", applied: [], error: "finish-rife job not found on RunPod (#141)" },
    ] as FinishShot[],
    created_at: Date.now(),
  });

  function finishEnv(job: FilmJob, r2Keys: string[]) {
    const filmDoc = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    const env = {
      R2_RENDERS: {
        get: async (k: string) => (k === filmDoc ? { text: async () => stored } : null),
        put: async (k: string, b: string) => { if (k === filmDoc) stored = b; },
        list: async ({ prefix }: { prefix: string }) => ({
          objects: r2Keys.filter((x) => x.startsWith(prefix)).map((x) => ({ key: x })),
          truncated: false,
        }),
      },
    } as unknown as Env;
    return { env, read: () => JSON.parse(stored) as FilmJob };
  }

  it("reclaims a finish shot whose _finished output is in R2 -> done, then advances", async () => {
    const { env, read } = finishEnv(finishFilm(), [
      "renders/neon/clips/shot_01_finished.mp4",
      "renders/neon/clips/shot_02_finished.mp4", // the failed shot's finish output IS present
    ]);
    const r = await advanceFilmJob(env, "film-finish-reclaim");
    const fs2 = read().finish_shots?.find((f) => f.shot_id === "shot_02");
    expect(fs2?.status).toBe("done");
    expect(fs2?.clip_key).toBe("renders/neon/clips/shot_02_finished.mp4");
    expect(fs2?.error).toBeUndefined();
    expect(r?.job.phase).not.toBe("finish"); // advanced (clips_only -> done)
  });

  it("leaves the finish shot FAILED when its _finished output is NOT in R2", async () => {
    const { env, read } = finishEnv(finishFilm(), [
      "renders/neon/clips/shot_01_finished.mp4", // only the already-done shot's output
    ]);
    await advanceFilmJob(env, "film-finish-reclaim");
    expect(read().finish_shots?.find((f) => f.shot_id === "shot_02")?.status).toBe("failed");
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


// #207 follow-up: the film.finish chain is FAIL-SAFE -- the film always survives -- so a degraded run
// (e.g. the video-finish container unreachable) reaches phase="done" with NO cards. The orchestrator
// must RECORD that outcome on the job (film_finish) instead of shipping a silent green. Drives the real
// mux -> done transition through advanceFilmJob with a stubbed film.finish module.
describe("applyFilmFinish observability (#207: degraded film.finish must not ship silent green)", () => {
  const FILM_TITLES_MANIFEST = {
    name: "film-titles",
    version: "0.1.0",
    api: "vivijure-module/1",
    hooks: ["film.finish"],
    provides: [{ id: "film-titles", label: "Title + credit cards" }],
    config_schema: {},
    ui: { section: "film.finish", order: 10 },
  };

  function filmFinishEnv(job: object, invokeResponse: unknown, opts: { withModule?: boolean } = {}) {
    const filmId = (job as { film_id: string }).film_id;
    let stored = JSON.stringify(job);
    const jsonResp = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const env: Record<string, unknown> = {
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
        head: async () => null,
        put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
      },
      // mux container (callVideoFinish) -- returns the muxed film key
      VIDEO_FINISH_VPC: { fetch: async () => jsonResp({ ok: true, key: `renders/${filmId}/film-audio.mp4` }) },
      R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
    };
    if (opts.withModule !== false) {
      env.MODULE_FILM_TITLES = {
        fetch: async (input: Request | string) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.endsWith("/module.json")) return jsonResp(FILM_TITLES_MANIFEST);
          return jsonResp(invokeResponse); // /invoke
        },
      };
    }
    return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob };
  }

  const muxJob = (over: object = {}) => ({
    film_id: "film-finish-obs",
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
    phase: "mux" as const,
    silent_film_key: "renders/film-finish-obs/film-silent.mp4",
    audio_key: "renders/film-finish-obs/audio.mp4",
    mux_output_key: "renders/film-finish-obs/film-audio.mp4",
    film_titles: { title: { text: "NEON HALFLIFE" } },
    created_at: 0,
    ...over,
  });

  it("records degraded + keeps the muxed (uncarded) film when the module passes through", async () => {
    const degraded = { ok: true, output: { film_key: "renders/film-finish-obs/film-audio.mp4", applied: ["passthrough:container-unreachable"], degraded: "passthrough:container-unreachable" } };
    const { env, read } = filmFinishEnv(muxJob(), degraded);
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    // the degrade is OBSERVABLE, not a silent green
    expect(r?.job.film_finish?.degraded).toBe("passthrough:container-unreachable");
    expect(r?.job.film_finish?.steps).toEqual(["passthrough:container-unreachable"]);
    // film kept the muxed key (no cards applied)
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio.mp4");
    expect(read().film_finish?.degraded).toBe("passthrough:container-unreachable"); // persisted
  });

  it("records applied + swaps to the carded film when the module succeeds", async () => {
    const ok = { ok: true, output: { film_key: "renders/film-finish-obs/film-audio-titled-abc.mp4", applied: ["film-titles"] } };
    const { env } = filmFinishEnv(muxJob(), ok);
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish?.applied).toEqual(["film-titles"]);
    expect(r?.job.film_finish?.degraded).toBeUndefined();
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio-titled-abc.mp4");
  });

  it("records a chain error (no film_finish drop) when the module invoke fails", async () => {
    const failed = { ok: false, error: "module /invoke -> 500" };
    const { env } = filmFinishEnv(muxJob(), failed);
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish?.errors?.some((e) => e.includes("film-titles"))).toBe(true);
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio.mp4"); // film survives
  });

  it("leaves film_finish unset when no film.finish module is installed (no-op)", async () => {
    const { env } = filmFinishEnv(muxJob(), {}, { withModule: false });
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish).toBeUndefined();
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio.mp4");
  });
});
