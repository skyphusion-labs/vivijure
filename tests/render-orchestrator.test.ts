import { describe, it, expect } from "vitest";
import { summarizeJob, describeClipFailures, applyPoll, classifyTransientFailure, clipFileMatchesShot, finishedClipFileMatchesShot, listClipsByShotId, reclaimClipsFromR2, advanceClipJob, startClipJob, cancelInFlightClips } from "../src/render-orchestrator";
import type { ClipJob, ClipShot } from "../src/render-orchestrator";
import type { RegisteredModule } from "../src/modules/types";
import type { Env } from "../src/env";

const job = (statuses: ClipShot["status"][]): ClipJob => ({
  job_id: "j", project: "p", motion_backend: "seedance", binding: "MODULE_SEEDANCE", created_at: 0,
  shots: statuses.map((status, i) => ({ shot_id: "s" + i, keyframe_url: "u", prompt: "x", seconds: 5, status })),
});

describe("summarizeJob", () => {
  it("counts states and is incomplete while any pending", () => {
    expect(summarizeJob(job(["done", "pending", "failed"]))).toEqual({ total: 3, done: 1, failed: 1, pending: 1, complete: false });
  });
  it("is complete when every shot is terminal", () => {
    expect(summarizeJob(job(["done", "failed", "done"])).complete).toBe(true);
  });
});

describe("describeClipFailures (#754: a zero-clip film names WHY)", () => {
  const withErrors = (errs: (string | undefined)[]): ClipJob => ({
    job_id: "j", project: "p", motion_backend: "local-gpu", binding: "MODULE_LOCAL_GPU", created_at: 0,
    shots: errs.map((error, i) => ({ shot_id: "shot_0" + i, keyframe_url: "u", prompt: "x", seconds: 5, status: "failed" as const, error })),
  });

  it("aggregates each failed shot's real reason (the door/backend error), not a bare generic", () => {
    const msg = describeClipFailures(withErrors(["clip upload failed: Unauthorized", "clip upload failed: Unauthorized"]));
    expect(msg).toBe("shot_00: clip upload failed: Unauthorized; shot_01: clip upload failed: Unauthorized");
  });

  it("falls back to 'unknown error' for a failed shot with no reason (never fabricates)", () => {
    expect(describeClipFailures(withErrors([undefined]))).toBe("shot_00: unknown error");
  });

  it("returns '' when nothing failed (caller keeps its own message)", () => {
    expect(describeClipFailures(job(["done", "done"]))).toBe("");
  });
});

describe("applyPoll", () => {
  const shot = (): ClipShot => ({ shot_id: "s", keyframe_url: "u", prompt: "x", seconds: 5, status: "pending", poll: "t" });
  it("marks done with the clip key on output", () => {
    const s = shot();
    applyPoll(s, { ok: true, output: { shot_id: "s", clip_key: "renders/p/clips/s.mp4", fps: 24, frames: 120 } });
    expect(s).toMatchObject({ status: "done", clip_key: "renders/p/clips/s.mp4" });
  });
  it("leaves pending while the job runs", () => {
    const s = shot();
    applyPoll(s, { ok: true, pending: true });
    expect(s.status).toBe("pending");
  });
  it("marks failed with the error", () => {
    const s = shot();
    applyPoll(s, { ok: false, error: "boom" });
    expect(s).toMatchObject({ status: "failed", error: "boom" });
  });
  it("retains the DELIVERED fps+frames on the shot (#707: delivered-vs-planned surfacing)", () => {
    const s = shot(); // planned 5s
    // a fixed-grid backend honestly clamped: 25 frames at a pinned 8fps = a 3.125s clip
    applyPoll(s, { ok: true, output: { shot_id: "s", clip_key: "renders/p/clips/s.mp4", fps: 8, frames: 25 } });
    expect(s).toMatchObject({ status: "done", delivered_fps: 8, delivered_frames: 25 });
  });
  it("retains the backend's distilled tier-honesty flag, and only when reported (#705)", () => {
    const s = shot();
    applyPoll(s, { ok: true, output: { shot_id: "s", clip_key: "renders/p/clips/s.mp4", fps: 24, frames: 120, distilled: true } });
    expect(s.distilled).toBe(true);

    const s2 = shot();
    applyPoll(s2, { ok: true, output: { shot_id: "s", clip_key: "renders/p/clips/s.mp4", fps: 24, frames: 120 } });
    expect(s2.distilled).toBeUndefined(); // absence stays absent, never a fabricated false
  });
  it("treats the frames=0 nothing-to-report sentinel as ABSENT delivery data, never a 0-frame record (#707)", () => {
    const s = shot();
    applyPoll(s, { ok: true, output: { shot_id: "s", clip_key: "renders/p/clips/s.mp4", fps: 24, frames: 0 } });
    expect(s.status).toBe("done");
    expect(s.delivered_fps).toBeUndefined();
    expect(s.delivered_frames).toBeUndefined();
  });
  // #719: the door /status can stall ~5s mid-sampler-step (GIL hold under model offload); a poll
  // landing in the stall propagates as a transport error and used to STICKILY fail the healthy
  // render on the FIRST blip (film-d9214549 died at ~2min with the GPU at 8/40 steps).
  it("tolerates transient poll errors up to the budget, then fails loud (#719)", () => {
    const s = shot();
    applyPoll(s, { ok: false, error: "module /poll -> 502" });
    expect(s.status).toBe("pending"); // blip 1: held, not failed
    expect(s.poll_attempts).toBe(1);
    applyPoll(s, { ok: false, error: "module unreachable: connection reset" });
    expect(s.status).toBe("pending"); // blip 2: still held
    expect(s.poll_attempts).toBe(2);
    applyPoll(s, { ok: false, error: "module /poll -> 504" });
    expect(s.status).toBe("failed");  // budget exhausted -> loud, with the real error
    expect(s.error).toContain("504");
    expect(s.error).toContain("#719");
  });

  it("a successful poll round-trip RESETS the transient budget (#719: consecutive, not cumulative)", () => {
    const s = shot();
    applyPoll(s, { ok: false, error: "module /poll -> 502" });
    applyPoll(s, { ok: false, error: "module /poll -> 502" });
    expect(s.poll_attempts).toBe(2);
    applyPoll(s, { ok: true, pending: true }); // healthy round-trip
    expect(s.poll_attempts).toBe(0);
    applyPoll(s, { ok: false, error: "module /poll -> 502" });
    expect(s.status).toBe("pending"); // fresh budget: a later isolated blip does not fail the shot
    expect(s.poll_attempts).toBe(1);
  });

  it("a DETERMINISTIC module-reported failure still fails immediately (#719 keeps honesty undelayed)", () => {
    const s = shot();
    applyPoll(s, { ok: false, error: "own-gpu job not found on RunPod (#141)" });
    expect(s.status).toBe("failed"); // no retry budget for a real reject
    expect(s.error).toContain("#141");
  });

  it("classifyTransientFailure: transport statuses + network strings are transient, module rejects are not", () => {
    expect(classifyTransientFailure("module /poll -> 502")).toBe("transient");
    expect(classifyTransientFailure("module /invoke -> 429")).toBe("transient");
    expect(classifyTransientFailure("module unreachable: fetch failed")).toBe("transient");
    expect(classifyTransientFailure("local-gpu /status -> 504")).toBe("transient");
    expect(classifyTransientFailure("module /poll -> 404")).toBe("deterministic");
    expect(classifyTransientFailure("CUDA out of memory")).toBe("deterministic");
    expect(classifyTransientFailure(undefined)).toBe("deterministic");
  });

  it("fails a shot whose output is envelope-ok but off-contract (#345), never advancing garbage", () => {
    const s = shot();
    s.motion_backend = "seedance";
    // ok:true + output, but missing clip_key/fps/frames -- the size cap would pass this; the contract must not.
    applyPoll(s, { ok: true, output: { shot_id: "s" } as never });
    expect(s.status).toBe("failed");
    expect(s.clip_key).toBeUndefined();       // no garbage clip key threaded downstream
    expect(s.error).toContain("seedance");    // traceable: names the module
    expect(s.error).toContain("motion.backend");
  });
});

describe("clipFileMatchesShot (#141/#143 shot-name matching)", () => {
  it("matches the motion clip at a digit boundary; excludes _finished; needs a video ext", () => {
    expect(clipFileMatchesShot("shot_09_i2v.mp4", "shot_09")).toBe(true);
    expect(clipFileMatchesShot("shot_10_seedance.mov", "shot_10")).toBe(true);
    expect(clipFileMatchesShot("shot_10_i2v.mp4", "shot_1")).toBe(false); // boundary: shot_1 != shot_10
    expect(clipFileMatchesShot("shot_06_finished.mp4", "shot_06")).toBe(false);
    expect(clipFileMatchesShot("shot_09_i2v.txt", "shot_09")).toBe(false);
    expect(clipFileMatchesShot("shot_09_i2v.mp4.hash", "shot_09")).toBe(false); // #583 param-hash sidecar, not a clip
  });
});

describe("finishedClipFileMatchesShot (#141 finish-output matching)", () => {
  it("matches ONLY the _finished output at a digit boundary, with a video ext", () => {
    expect(finishedClipFileMatchesShot("shot_06_finished.mp4", "shot_06")).toBe(true);
    expect(finishedClipFileMatchesShot("shot_06_i2v.mp4", "shot_06")).toBe(false); // raw motion clip, not finish
    expect(finishedClipFileMatchesShot("shot_10_finished.mp4", "shot_1")).toBe(false); // boundary
    expect(finishedClipFileMatchesShot("shot_06_finished.txt", "shot_06")).toBe(false); // not a video
    expect(finishedClipFileMatchesShot("shot_06_finished.mp4.hash", "shot_06")).toBe(false); // #583 param-hash sidecar
    expect(finishedClipFileMatchesShot("shot_06_finished_ls.mp4.hash", "shot_06")).toBe(false); // suffixed-output sidecar
  });
});

describe("listClipsByShotId ignores .hash param-hash sidecars (#583, mirror of the #578 keyframe filter)", () => {
  const listEnv = (keys: string[]) => ({
    R2_RENDERS: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: keys.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
        truncated: false,
      }),
    },
  } as unknown as Env);

  it("adopts the finished clip, never its sidecar, when both are present", async () => {
    const env = listEnv([
      "renders/p/clips/shot_01_finished.mp4.hash", // the param-hash sidecar must never be adopted as the clip
      "renders/p/clips/shot_01_finished.mp4",
    ]);
    const found = await listClipsByShotId(env, "p", ["shot_01"], finishedClipFileMatchesShot);
    expect(found.get("shot_01")).toBe("renders/p/clips/shot_01_finished.mp4");
  });

  it("a shot with ONLY a sidecar (no clip) is absent, never poisoned", async () => {
    const env = listEnv(["renders/p/clips/shot_01_finished.mp4.hash"]);
    const found = await listClipsByShotId(env, "p", ["shot_01"], finishedClipFileMatchesShot);
    expect(found.has("shot_01")).toBe(false);
  });
});

// R2 list/get/put double for advanceClipJob; serves the clip-job doc + a clips listing.
function clipEnv(clipJob: ClipJob, clipKeys: string[], moduleResp: unknown) {
  const docKey = `renders/${clipJob.job_id}/clips-job.json`;
  let stored = JSON.stringify(clipJob);
  const env = {
    R2_RENDERS: {
      get: async (k: string) => (k === docKey ? { text: async () => stored } : null),
      put: async (k: string, b: string) => { if (k === docKey) stored = b; },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: clipKeys.filter((x) => x.startsWith(prefix)).map((x) => ({ key: x })),
        truncated: false,
      }),
    },
    // the motion module: returns moduleResp on /poll (e.g. a fail envelope to simulate a 404-grace fail)
    MODULE_SEEDANCE: { fetch: async () => new Response(JSON.stringify(moduleResp), { headers: { "content-type": "application/json" } }) },
  } as unknown as Env;
  return { env, read: () => JSON.parse(stored) as ClipJob };
}

describe("listClipsByShotId (#141 R2 presence lookup)", () => {
  it("maps requested shot ids to their R2 clip keys, boundary-safe, excluding _finished", async () => {
    const env = {
      R2_RENDERS: {
        list: async ({ prefix }: { prefix: string }) => ({
          objects: [
            "renders/neon/clips/shot_01_i2v.mp4",
            "renders/neon/clips/shot_01_finished.mp4",
            "renders/neon/clips/shot_10_i2v.mp4",
          ].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
          truncated: false,
        }),
      },
    } as unknown as Env;
    const m = await listClipsByShotId(env, "neon", ["shot_01", "shot_10", "shot_99"]);
    expect(m.get("shot_01")).toBe("renders/neon/clips/shot_01_i2v.mp4"); // not the _finished one
    expect(m.get("shot_10")).toBe("renders/neon/clips/shot_10_i2v.mp4");
    expect(m.has("shot_99")).toBe(false);
  });
});

describe("advanceClipJob fail-time R2 reclaim (#141: R2 presence beats a module fast-fail)", () => {
  it("reclaims a shot the module FAILED whose clip IS in R2 -> done, BEFORE the complete judgment", async () => {
    const cj = job(["pending"]);
    cj.job_id = "clips-reclaim"; cj.project = "neon";
    cj.shots[0].shot_id = "shot_01"; cj.shots[0].poll = "phantom";
    // The module fast-fails the poll (RunPod 404 past grace) -- but the clip is already in R2.
    const { env, read } = clipEnv(cj, ["renders/neon/clips/shot_01_i2v.mp4"], { ok: false, error: "own-gpu job not found on RunPod (#141)" });
    const out = await advanceClipJob(env, "clips-reclaim");
    expect(out?.shots[0].status).toBe("done"); // reclaimed, not failed
    expect(out?.shots[0].clip_key).toBe("renders/neon/clips/shot_01_i2v.mp4");
    expect(out?.shots[0].error).toBeUndefined(); // premature failure cleared
    expect(summarizeJob(out as ClipJob).complete).toBe(true); // and it judges complete WITH the clip
    expect(read().shots[0].status).toBe("done"); // persisted
  });

  it("leaves a shot FAILED when the module fails AND no clip is in R2 (genuine non-render)", async () => {
    const cj = job(["pending"]);
    cj.job_id = "clips-genuine-fail"; cj.project = "neon";
    cj.shots[0].shot_id = "shot_01"; cj.shots[0].poll = "phantom";
    const { env } = clipEnv(cj, [], { ok: false, error: "real failure" }); // nothing in R2
    const out = await advanceClipJob(env, "clips-genuine-fail");
    expect(out?.shots[0].status).toBe("failed");
    expect(out?.shots[0].error).toBe("real failure");
  });
});


// --- #535 / #536: request-scoped discovery through the clip tick + best-effort remote cancel on failure ---
// #536: when the clip orchestrator marks a shot FAILED (e.g. the poll threw "Too many subrequests"), the
// RunPod job it started may still be burning GPU (the S18 gate saw 307s of H200 after the studio gave up).
// advanceClipJob now fires a best-effort remote cancel (via the module, keyed by the poll token, gated on
// the module advertising `cancelable`) and records cancel_sent. #535: it accepts a threaded registry so
// the cancelable lookup does NOT re-fan-out the module.json discovery on the clip tick.
const SEEDANCE_MANIFEST = (cancelable: boolean) => ({
  name: "seedance", version: "0.1.0", api: "vivijure-module/2",
  hooks: ["motion.backend"], provides: [{ id: "seedance", label: "Seedance i2v" }],
  config_schema: {}, ui: { section: "motion.backend", order: 10 }, cancelable,
});
function jr(b: unknown) { return new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } }); }

function cancelClipEnv(clipJob: ClipJob, opts: { cancelable: boolean; pollResp: unknown; clipKeys?: string[]; invokeResp?: unknown }) {
  const docKey = `renders/${clipJob.job_id}/clips-job.json`;
  let stored = JSON.stringify(clipJob);
  const cancelCalls: string[] = [];
  let manifestHits = 0;
  const env = {
    R2_RENDERS: {
      get: async (k: string) => (k === docKey ? { text: async () => stored } : null),
      put: async (k: string, b: string) => { if (k === docKey) stored = b; },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: (opts.clipKeys ?? []).filter((x) => x.startsWith(prefix)).map((x) => ({ key: x })),
        truncated: false,
      }),
    },
    MODULE_SEEDANCE: {
      fetch: async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) { manifestHits += 1; return jr(SEEDANCE_MANIFEST(opts.cancelable)); }
        if (url.endsWith("/cancel")) { cancelCalls.push(url); return jr({ ok: true }); }
        if (url.endsWith("/invoke")) return jr(opts.invokeResp ?? { ok: true, pending: true, poll: "tok" });
        return jr(opts.pollResp); // /poll
      },
    },
  } as unknown as Env;
  return { env, read: () => JSON.parse(stored) as ClipJob, cancelCalls, manifestHits: () => manifestHits };
}

const failingShot = (jobId: string): ClipJob => ({
  job_id: jobId, project: "neon", motion_backend: "seedance", binding: "MODULE_SEEDANCE", created_at: 0,
  shots: [{ shot_id: "shot_01", keyframe_url: "u", prompt: "x", seconds: 5, status: "pending", poll: "tok", binding: "MODULE_SEEDANCE", runpod_job_id: "rp-123" }],
});

describe("#536 best-effort remote cancel when a clip shot is marked failed (zombie-GPU guard)", () => {
  it("fires a cancel via the module and records cancel_sent when the shot fails and the module is cancelable", async () => {
    const { env, read, cancelCalls } = cancelClipEnv(failingShot("clips-536a"), { cancelable: true, pollResp: { ok: false, error: "Too many subrequests" } });
    const out = await advanceClipJob(env, "clips-536a");
    expect(out?.shots[0].status).toBe("failed");
    expect(cancelCalls.length).toBe(1);           // the in-flight RunPod job was cancelled
    expect(out?.shots[0].cancel_sent).toBe(true);
    expect(read().shots[0].cancel_sent).toBe(true); // persisted
  });

  it("does NOT call cancel but still records cancel_sent (honest orphan) when the module is not cancelable", async () => {
    const { env, cancelCalls } = cancelClipEnv(failingShot("clips-536b"), { cancelable: false, pollResp: { ok: false, error: "boom" } });
    const out = await advanceClipJob(env, "clips-536b");
    expect(out?.shots[0].status).toBe("failed");
    expect(cancelCalls.length).toBe(0);           // no /cancel primitive -> logged orphan, not a crash
    expect(out?.shots[0].cancel_sent).toBe(true); // best-effort attempted once
  });

  it("does not re-fire the cancel on a later tick (cancel_sent gates it)", async () => {
    const { env, cancelCalls } = cancelClipEnv(failingShot("clips-536c"), { cancelable: true, pollResp: { ok: false, error: "boom" } });
    await advanceClipJob(env, "clips-536c");
    await advanceClipJob(env, "clips-536c"); // second tick: shot already failed + cancel_sent
    expect(cancelCalls.length).toBe(1);
  });

  it("does NOT cancel a shot whose clip actually landed in R2 (reclaim to done wins over cancel)", async () => {
    const { env, cancelCalls } = cancelClipEnv(failingShot("clips-536d"), { cancelable: true, pollResp: { ok: false, error: "poll blip" }, clipKeys: ["renders/neon/clips/shot_01_i2v.mp4"] });
    const out = await advanceClipJob(env, "clips-536d");
    expect(out?.shots[0].status).toBe("done"); // reclaimed
    expect(cancelCalls.length).toBe(0);        // nothing to cancel; the job completed
  });

  it("cancelInFlightClips cancels every in-flight (pending) shot on teardown", async () => {
    const cj = failingShot("clips-536e");
    cj.shots[0].status = "pending"; // still in flight
    const { env, read, cancelCalls } = cancelClipEnv(cj, { cancelable: true, pollResp: { ok: true, pending: true } });
    await cancelInFlightClips(env, "clips-536e");
    expect(cancelCalls.length).toBe(1);
    expect(read().shots[0].cancel_sent).toBe(true);
  });
});

describe("#535 clip tick reuses the threaded registry (no per-tick module.json fan-out)", () => {
  it("advanceClipJob with preModules does not re-discover, yet still cancels a failed shot", async () => {
    const { env, cancelCalls, manifestHits } = cancelClipEnv(failingShot("clips-535a"), { cancelable: true, pollResp: { ok: false, error: "boom" } });
    const modules = [{
      name: "seedance", version: "0.1.0", api: "vivijure-module/2", hooks: ["motion.backend"],
      provides: [{ id: "seedance", label: "Seedance" }], config_schema: {}, ui: { section: "motion.backend", order: 10 },
      cancelable: true, binding: "MODULE_SEEDANCE",
    }] as unknown as RegisteredModule[];
    const out = await advanceClipJob(env, "clips-535a", modules);
    expect(out?.shots[0].status).toBe("failed");
    expect(cancelCalls.length).toBe(1);   // cancel still fires, using the threaded registry
    expect(manifestHits()).toBe(0);       // NO discovery fan-out -- the module.json was never fetched
  });

  it("startClipJob captures the backend RunPod job id from the async envelope, and reuses a threaded registry", async () => {
    const modules = [{
      name: "seedance", version: "0.1.0", api: "vivijure-module/2", hooks: ["motion.backend"],
      provides: [{ id: "seedance", label: "Seedance" }], config_schema: {}, ui: { section: "motion.backend", order: 10 },
      cancelable: true, binding: "MODULE_SEEDANCE",
    }] as unknown as RegisteredModule[];
    const { env, manifestHits } = cancelClipEnv(failingShot("clips-535b"), { cancelable: true, pollResp: { ok: true, pending: true }, invokeResp: { ok: true, pending: true, poll: "tok9", jobId: "rp-xyz" } });
    const job = await startClipJob(env, { project: "neon", shots: [{ shot_id: "shot_01", keyframe_url: "u", prompt: "x", seconds: 5 }], motion_backend: "seedance" }, modules);
    expect(job.shots[0].poll).toBe("tok9");
    expect(job.shots[0].runpod_job_id).toBe("rp-xyz"); // #536: retained for cancel/accounting
    expect(manifestHits()).toBe(0);                    // #535: threaded registry, no discovery fan-out
  });
});


// --- #661 freshness floor: a prior render of the SAME project name leaves clips at identical
// renders/<project>/clips/<shot>_<backend> paths; without a floor the stall/fail reclaim would adopt a
// 4-day-old clip and ship wrong content silently. minUploadedMs (the ClipJob created_at) makes this run
// own clips (uploaded AFTER the job started) the only reclaim candidates; a leftover becomes invisible.
describe("listClipsByShotId freshness floor (#661)", () => {
  const RUN_START = 2_000_000;
  const listEnv = (items: { key: string; uploadedMs: number }[]) => ({
    R2_RENDERS: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: items.filter((o) => o.key.startsWith(prefix)).map((o) => ({ key: o.key, uploaded: new Date(o.uploadedMs) })),
        truncated: false,
      }),
    },
  } as unknown as Env);

  it("skips a clip uploaded BEFORE the floor, keeps one uploaded AFTER", async () => {
    const env = listEnv([
      { key: "renders/p/clips/shot_01_i2v.mp4", uploadedMs: RUN_START - 4 * 86_400_000 }, // stale leftover
      { key: "renders/p/clips/shot_02_i2v.mp4", uploadedMs: RUN_START + 5_000 },          // this run own clip
    ]);
    const m = await listClipsByShotId(env, "p", ["shot_01", "shot_02"], clipFileMatchesShot, RUN_START);
    expect(m.has("shot_01")).toBe(false);
    expect(m.get("shot_02")).toBe("renders/p/clips/shot_02_i2v.mp4");
  });

  it("floor 0 (default) keeps every clip regardless of age (back-compat)", async () => {
    const env = listEnv([{ key: "renders/p/clips/shot_01_i2v.mp4", uploadedMs: 1 }]);
    const m = await listClipsByShotId(env, "p", ["shot_01"]);
    expect(m.get("shot_01")).toBe("renders/p/clips/shot_01_i2v.mp4");
  });
});

describe("reclaimClipsFromR2 freshness (#661): a prior render clip is never silently adopted", () => {
  it("does NOT reclaim a pending shot whose only R2 clip predates the clip job", async () => {
    const cj = job(["pending"]);
    cj.project = "neon"; cj.created_at = 2_000_000; cj.shots[0].shot_id = "shot_01";
    const env = {
      R2_RENDERS: {
        list: async ({ prefix }: { prefix: string }) => ({
          objects: [{ key: "renders/neon/clips/shot_01_i2v.mp4", uploaded: new Date(cj.created_at - 86_400_000) }]
            .filter((o) => o.key.startsWith(prefix)),
          truncated: false,
        }),
      },
    } as unknown as Env;
    const adopted = await reclaimClipsFromR2(env, cj);
    expect(adopted).toBe(0);
    expect(cj.shots[0].status).toBe("pending"); // left for a genuine render, not silently stale-adopted
  });

  it("DOES reclaim a pending shot whose R2 clip was uploaded after the clip job started (#141 survives)", async () => {
    const cj = job(["pending"]);
    cj.project = "neon"; cj.created_at = 2_000_000; cj.shots[0].shot_id = "shot_01";
    const env = {
      R2_RENDERS: {
        list: async ({ prefix }: { prefix: string }) => ({
          objects: [{ key: "renders/neon/clips/shot_01_i2v.mp4", uploaded: new Date(cj.created_at + 5_000) }]
            .filter((o) => o.key.startsWith(prefix)),
          truncated: false,
        }),
      },
    } as unknown as Env;
    const adopted = await reclaimClipsFromR2(env, cj);
    expect(adopted).toBe(1);
    expect(cj.shots[0].status).toBe("done");
    expect(cj.shots[0].clip_key).toBe("renders/neon/clips/shot_01_i2v.mp4");
  });
});
