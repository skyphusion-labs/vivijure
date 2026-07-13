import { describe, it, expect, vi } from "vitest";
import { joinKeyframesToScenes, applyFinishOutput, applySpeechOutput, orderFinalClips, summarizeFilm, filmProgressMarker, resolveFinishConfigs, coerceSceneIds, coerceDialogueLineIds, callVideoFinish, classifyAssembleTransport, advanceFilmJob, clipKeysFromFilmJob, filmJobDocKey, clipJobDocKey, phaseAgeSeconds, ceilingAgeSeconds, listProjectKeyframes, keyframeSetCompleteInR2, listProjectClips, clipFileMatchesShot, finishShotAdoptableFromR2, reclaimFinishShotsFromR2, adoptFinishStepOutput, finishShotLedgerReconciles, classifyFinishFailure, classifyFinishRetry, FINISH_STEP_MAX_ATTEMPTS, FILM_FINISH_INFLIGHT_WINDOW_SECONDS, finishStepOutputKey, finishStepAppliedTag, KEYFRAME_STALL_SECONDS, PHASE_HARD_DEADLINE_SECONDS, applyMasterOutput, degradeMasterStep, masterChainDone, filmSeconds, masteredBedKey, MASTER_STEP_MAX_ATTEMPTS, MASTER_STALL_SECONDS, type FilmScene, type FinishShot, type SpeechShot, type FilmJob, type MasterState } from "../src/film-orchestrator";
import type { ConfigSchema } from "../src/modules/types";
import type { Env } from "../src/env";
import { filmJobToPollView } from "../src/film-render-bridge";
import { _resetModuleDiscoveryCache } from "../src/modules/registry";
import { finishStepInputHash } from "../src/finish-hash";

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

describe("applySpeechOutput (chain fold + honest soft-degrade)", () => {
  const speechShot = (over: Partial<SpeechShot> = {}): SpeechShot => ({
    shot_id: "shot_01", audio_key: "renders/p/dialogue/shot_01.wav", chain: ["MODULE_SPEECH_UPSCALE"], idx: 0, status: "pending", applied: [], ...over,
  });
  it("real enhance: threads the new audio_key forward, records applied, marks done", () => {
    const ss = speechShot();
    applySpeechOutput(ss, { shot_id: "shot_01", audio_key: "renders/p/dialogue/shot_01_enh.wav", applied: ["speech-upscale:resemble-enhance"] });
    expect(ss.audio_key).toBe("renders/p/dialogue/shot_01_enh.wav");
    expect(ss.applied).toEqual(["speech-upscale:resemble-enhance"]);
    expect(ss.idx).toBe(1);
    expect(ss.status).toBe("done");
    expect(ss.degraded).toBeUndefined();
  });
  it("HONEST soft-degrade: keeps the ORIGINAL audio_key (mouth never goes silent), records the reason, no fake applied tag", () => {
    const ss = speechShot();
    // even if a buggy module returns a junk key alongside `degraded`, the guard ignores it
    applySpeechOutput(ss, { shot_id: "shot_01", audio_key: "JUNK-should-be-ignored", applied: [], degraded: "backend down" });
    expect(ss.audio_key).toBe("renders/p/dialogue/shot_01.wav"); // the ORIGINAL dialogue audio survives
    expect(ss.degraded).toBe("backend down");
    expect(ss.applied).toEqual([]); // no fake applied tag
    expect(ss.status).toBe("done");
  });
  it("multi-module chain: stays pending until exhausted, threading enhanced audio between steps", () => {
    const ss = speechShot({ chain: ["MODULE_A", "MODULE_B"] });
    applySpeechOutput(ss, { shot_id: "shot_01", audio_key: "renders/p/dialogue/shot_01_a.wav", applied: ["denoise:a"] });
    expect(ss.idx).toBe(1);
    expect(ss.status).toBe("pending"); // module B still to run
    expect(ss.audio_key).toBe("renders/p/dialogue/shot_01_a.wav"); // B enhances A's output
    applySpeechOutput(ss, { shot_id: "shot_01", audio_key: "renders/p/dialogue/shot_01_b.wav", applied: ["upscale:b"] });
    expect(ss.idx).toBe(2);
    expect(ss.status).toBe("done");
    expect(ss.applied).toEqual(["denoise:a", "upscale:b"]);
    expect(ss.audio_key).toBe("renders/p/dialogue/shot_01_b.wav");
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

  it("does NOT adopt a FAILED shot mid-chain (the silent-render bug: a lip-sync fail at idx 1 of 4 must not adopt the RIFE intermediate)", () => {
    const midChainFailed = finishShot({
      status: "failed", idx: 1,
      chain: ["MODULE_FINISH_RIFE", "MODULE_FINISH_LIPSYNC", "MODULE_FINISH_UPSCALE", "MODULE_FINISH_STUB"],
    });
    expect(finishShotAdoptableFromR2(midChainFailed)).toBe(false);
  });

  it("reclaim does NOT touch a mid-chain FAILED shot even when an intermediate clip is present in R2", () => {
    const failed = finishShot({
      shot_id: "shot_02", status: "failed", idx: 1, // failed at lip-sync (idx 1), 2 more steps to go
      chain: ["MODULE_FINISH_RIFE", "MODULE_FINISH_LIPSYNC", "MODULE_FINISH_UPSCALE", "MODULE_FINISH_STUB"],
    });
    const present = new Map([["shot_02", "renders/p/clips/shot_02_finished.mp4"]]); // the RIFE intermediate
    const adopted = reclaimFinishShotsFromR2([failed], present);
    expect(adopted).toBe(0);
    expect(failed.status).toBe("failed"); // NOT silently flipped to done on an intermediate
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
    expect(stuck.applied).toEqual([]);                 // #583: reused from R2, never a fake applied-run tag
    expect(stuck.adopted).toEqual(["interpolate:2x"]); // the reuse is disclosed in `adopted` (RIFE default 2x)
    expect(shots.every((s) => s.status !== "pending")).toBe(true); // phase can now advance to assemble
  });

  it("leaves a stuck PENDING shot pending when its clip is genuinely absent from R2 (no false adoption)", () => {
    const stuck = finishShot({ shot_id: "shot_02", status: "pending", poll: "frozen", idx: 0, chain: ["MODULE_FINISH_RIFE"] });
    const adopted = reclaimFinishShotsFromR2([stuck], new Map());
    expect(adopted).toBe(0);
    expect(stuck.status).toBe("pending");
  });
});

// #662: an ADOPTED finish step's tag lives in `adopted`, not `applied` (the #583 disjoint honesty channel),
// so reading `applied` alone makes an adopted shot look like it dropped exactly one chain module's tag (the
// 3/3-films prod symptom). The VERDICT is a bookkeeping channel-split, NOT a skip: the step ran (its output
// is #583-provenance-gated in R2) and its transform is present. The `ledger` records one entry PER chain
// step (run OR reused) so the per-shot honesty ledger reconciles 1:1 to the chain -- the reused step is
// PRESENT (reused:true), never dropped.
describe("finish shot ledger reconciles 1:1 to its chain (#662, adopted-shot bookkeeping)", () => {
  const finishOut = (clip_key: string, applied: string[]) =>
    ({ shot_id: "s", clip_key, out_fps: 32, frames: 160, applied }) as unknown as Parameters<typeof applyFinishOutput>[1];

  it("no-dialogue chain, RIFE(idx0) reused mid-chain: applied MISSING rife, but the ledger reconciles + discloses it reused", () => {
    const fs = finishShot({
      shot_id: "shot_03",
      chain: ["MODULE_FINISH_RIFE", "MODULE_FINISH_LIPSYNC", "MODULE_FINISH_UPSCALE", "MODULE_FINISH_STUB"],
      configs: [{ interpolation_factor: 2 }, {}, { scale: 2 }, {}],
    });
    // idx0 RIFE: its RunPod job GC'd after writing _finished.mp4 -> adopted from R2 (tag reconstructed).
    adoptFinishStepOutput(fs, "clips/shot_03_finished.mp4", finishStepAppliedTag(fs));
    // idx1..3 run: no-dialogue lip-sync no-ops, upscale, no-overlays text.
    applyFinishOutput(fs, finishOut("clips/shot_03_finished.mp4", ["noop:no-dialogue"]));
    applyFinishOutput(fs, finishOut("clips/shot_03_finished_up.mp4", ["upscale:2x"]));
    applyFinishOutput(fs, finishOut("clips/shot_03_finished_up.mp4", ["noop:no-overlays"]));

    expect(fs.status).toBe("done");
    expect(fs.applied).toEqual(["noop:no-dialogue", "upscale:2x", "noop:no-overlays"]); // the exact prod symptom: applied has no rife tag
    expect(fs.adopted).toEqual(["interpolate:2x"]);                                      // ...because RIFE was REUSED, disclosed here (#583)
    expect(finishShotLedgerReconciles(fs)).toBe(true);                                   // #662: the LEDGER reconciles 1:1 to the chain
    expect(fs.ledger?.map((r) => r.binding)).toEqual(fs.chain);                          // one record per step, in chain order
    expect(fs.ledger?.[0]).toEqual({ binding: "MODULE_FINISH_RIFE", tags: ["interpolate:2x"], reused: true }); // RIFE PRESENT as reused, not dropped
    expect(fs.ledger?.filter((r) => r.reused).map((r) => r.binding)).toEqual(["MODULE_FINISH_RIFE"]);
  });

  it("dialogue chain, LIPSYNC(idx0) reused mid-chain: applied MISSING lipsync, but the ledger reconciles + discloses it reused", () => {
    const fs = finishShot({
      shot_id: "shot_02",
      chain: ["MODULE_FINISH_LIPSYNC", "MODULE_FINISH_RIFE", "MODULE_FINISH_UPSCALE", "MODULE_FINISH_STUB"],
      configs: [{ version: "v15" }, { interpolation_factor: 2 }, { scale: 2 }, {}],
    });
    // idx0 LIPSYNC: reused from R2 (its _ls artifact + matching #583 provenance sidecar) -> mouth IS synced.
    adoptFinishStepOutput(fs, "clips/shot_02_ls.mp4", finishStepAppliedTag(fs));
    applyFinishOutput(fs, finishOut("clips/shot_02_ls_rife.mp4", ["interpolate:2x"]));
    applyFinishOutput(fs, finishOut("clips/shot_02_ls_rife_up.mp4", ["upscale:2x"]));
    applyFinishOutput(fs, finishOut("clips/shot_02_ls_rife_up.mp4", ["noop:no-overlays"]));

    expect(fs.status).toBe("done");
    expect(fs.applied).toEqual(["interpolate:2x", "upscale:2x", "noop:no-overlays"]); // the prod symptom: no lipsync tag at all in applied
    expect(fs.adopted).toEqual(["lipsync:v15"]);                                       // ...reused, disclosed here (NOT unsynced)
    expect(finishShotLedgerReconciles(fs)).toBe(true);
    expect(fs.ledger?.map((r) => r.binding)).toEqual(fs.chain);
    expect(fs.ledger?.[0]).toEqual({ binding: "MODULE_FINISH_LIPSYNC", tags: ["lipsync:v15"], reused: true });
  });

  it("FINAL step reused via reclaimFinishShotsFromR2 (idx===last): the ledger still reconciles 1:1", () => {
    const fs = finishShot({
      shot_id: "shot_01",
      chain: ["MODULE_FINISH_RIFE", "MODULE_FINISH_LIPSYNC", "MODULE_FINISH_UPSCALE", "MODULE_FINISH_STUB"],
      configs: [{ interpolation_factor: 2 }, {}, { scale: 2 }, {}],
    });
    applyFinishOutput(fs, finishOut("clips/shot_01_finished.mp4", ["interpolate:2x"]));  // idx0
    applyFinishOutput(fs, finishOut("clips/shot_01_finished.mp4", ["noop:no-dialogue"])); // idx1
    applyFinishOutput(fs, finishOut("clips/shot_01_finished_up.mp4", ["upscale:2x"]));    // idx2 -> now at last step, still pending
    expect(fs.idx).toBe(3);
    expect(fs.status).toBe("pending");
    fs.poll = "frozen"; // last-chain pending with a poll token -> adoptable (RUN #29 frozen-envelope path)
    const n = reclaimFinishShotsFromR2([fs], new Map([[fs.shot_id, "clips/shot_01_finished_up.mp4"]]));
    expect(n).toBe(1);
    expect(fs.status).toBe("done");
    expect(finishShotLedgerReconciles(fs)).toBe(true);
    expect(fs.ledger?.length).toBe(4);
    expect(fs.ledger?.[3]).toEqual({ binding: "MODULE_FINISH_STUB", tags: ["MODULE_FINISH_STUB:r2-adopted"], reused: true });
  });

  it("guard catches a REAL drop: a DONE shot whose ledger is SHORTER than its chain does NOT reconcile", () => {
    const fs = finishShot({ chain: ["A", "B", "C"], status: "done", ledger: [
      { binding: "A", tags: ["x"], reused: false }, { binding: "B", tags: ["y"], reused: false },
    ] });
    expect(finishShotLedgerReconciles(fs)).toBe(false);
  });

  it("guard catches an OUT-OF-ORDER ledger: bindings must match the chain positionally", () => {
    const fs = finishShot({ chain: ["A", "B"], status: "done", ledger: [
      { binding: "B", tags: ["y"], reused: false }, { binding: "A", tags: ["x"], reused: false },
    ] });
    expect(finishShotLedgerReconciles(fs)).toBe(false);
  });

  it("a pre-#662 DONE shot with NO ledger is not asserted (back-compat: reconciles vacuously)", () => {
    expect(finishShotLedgerReconciles(finishShot({ chain: ["A", "B"], status: "done" }))).toBe(true);
  });

  it("a still-advancing (pending) shot is not asserted, even with a partial ledger", () => {
    const fs = finishShot({ chain: ["A", "B"], status: "pending", ledger: [{ binding: "A", tags: ["x"], reused: false }] });
    expect(finishShotLedgerReconciles(fs)).toBe(true);
  });
});

describe("finish-step transient retry (the silent-render trigger: a lip-sync invocation blip)", () => {
  it("classifyFinishFailure: transport blips are transient, module-logic rejects are deterministic", () => {
    expect(classifyFinishFailure("module /invoke -> 503")).toBe("transient");
    expect(classifyFinishFailure("module /poll -> 504")).toBe("transient");
    expect(classifyFinishFailure("module /invoke -> 429")).toBe("transient");
    expect(classifyFinishFailure("module unreachable: signal timed out")).toBe("transient");
    expect(classifyFinishFailure("module /invoke -> 400")).toBe("deterministic");
    expect(classifyFinishFailure("module /invoke -> 404")).toBe("deterministic");
    expect(classifyFinishFailure("finish-lipsync: input needs shot_id and clip_key")).toBe("deterministic");
    expect(classifyFinishFailure("finish-lipsync job failed: out of memory")).toBe("deterministic");
    expect(classifyFinishFailure(undefined)).toBe("deterministic");
  });

  it("classifyFinishRetry: transient retries under the cap, fails at the cap; deterministic fails at once", () => {
    expect(classifyFinishRetry("module /invoke -> 503", 0)).toEqual({ action: "retry", attempts: 1 });
    expect(classifyFinishRetry("module /invoke -> 503", 1)).toEqual({ action: "retry", attempts: 2 });
    expect(classifyFinishRetry("module /invoke -> 503", FINISH_STEP_MAX_ATTEMPTS - 1)).toEqual({ action: "fail" });
    expect(classifyFinishRetry("module /invoke -> 400", 0)).toEqual({ action: "fail" }); // deterministic, no spin
  });

  // Integration: a film at phase=finish whose lip-sync invocation transiently 503s, then succeeds.
  // The step must RE-DISPATCH (stay pending, bump attempts) -- not go failed + adopt an intermediate --
  // so the shot ends up voiced (applied includes the lip-sync tag).
  const lipsyncFilm = (): FilmJob => ({
    film_id: "film-finish-retry", project: "neon", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    motion_backend: "own-gpu", motion_config: {}, finish_config: {},
    keyframe_binding: null, phase: "finish", clips_only: true,
    finish_shots: [
      { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4", chain: ["MODULE_FINISH_LIPSYNC"], configs: [{}], idx: 0, status: "pending", applied: [], poll: undefined, error: undefined },
    ] as FinishShot[],
    created_at: Date.now(),
  });

  function retryEnv(job: FilmJob, lipsyncOutcomes: Array<number>) {
    const filmDoc = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    let call = 0;
    const env = {
      R2_RENDERS: {
        get: async (k: string) => (k === filmDoc ? { text: async () => stored } : null),
        put: async (k: string, b: string) => { if (k === filmDoc) stored = b; },
        list: async () => ({ objects: [], truncated: false }), // no _finished clip in R2 -> no reclaim interference
      },
      MODULE_FINISH_LIPSYNC: {
        fetch: async (url: string) => {
          if (!String(url).includes("/invoke")) return new Response("{}", { status: 404 });
          const status = lipsyncOutcomes[Math.min(call, lipsyncOutcomes.length - 1)];
          call += 1;
          if (status !== 200) return new Response("", { status });
          return new Response(JSON.stringify({ ok: true, output: { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_ls.mp4", out_fps: 24, frames: 96, applied: ["lipsync:v15"] } }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    } as unknown as Env;
    return { env, read: () => JSON.parse(stored) as FilmJob };
  }

  it("re-dispatches a transient lip-sync 503, then voices the shot on the retry", async () => {
    const { env, read } = retryEnv(lipsyncFilm(), [503, 200]); // fail once, then succeed
    await advanceFilmJob(env, "film-finish-retry");
    const after1 = read().finish_shots![0];
    expect(after1.status).toBe("pending");          // NOT failed -- re-dispatching
    expect(after1.attempts).toBe(1);
    expect(after1.applied).toEqual([]);             // lip-sync did not run yet
    await advanceFilmJob(env, "film-finish-retry"); // second tick: 200
    const after2 = read().finish_shots![0];
    expect(after2.status).toBe("done");
    expect(after2.applied).toEqual(["lipsync:v15"]); // shot_02-style fix: actually VOICED
    expect(after2.clip_key).toBe("renders/neon/clips/shot_01_ls.mp4");
  });

  it("fails LOUD after the cap on a persistent transient (no infinite spin)", async () => {
    const { env, read } = retryEnv(lipsyncFilm(), [503]); // 503 forever
    for (let i = 0; i < FINISH_STEP_MAX_ATTEMPTS; i++) await advanceFilmJob(env, "film-finish-retry");
    expect(read().finish_shots![0].status).toBe("failed");
  });

  it("fails LOUD at once on a deterministic 400 (no retry)", async () => {
    const { env, read } = retryEnv(lipsyncFilm(), [400]);
    await advanceFilmJob(env, "film-finish-retry");
    const fs = read().finish_shots![0];
    expect(fs.status).toBe("failed");
    expect(fs.attempts ?? 0).toBe(0); // deterministic -> never incremented
  });

  // #245/#246: a failed finish must fail the RENDER loud -- the film job goes phase=failed with the
  // real error, NOT phase=done shipping the raw i2v clip with applied=[] (the wan silent-degrade).
  it("a failed finish fails the render (phase=failed), never silently done with the raw clip", async () => {
    const { env, read } = retryEnv(lipsyncFilm(), [400]); // deterministic finish failure
    await advanceFilmJob(env, "film-finish-retry");
    const job = read();
    expect(job.finish_shots![0].status).toBe("failed");
    expect(job.phase).toBe("failed");        // was "done" before the fix (clips_only path)
    expect(job.phase).not.toBe("done");
    expect(job.error).toMatch(/finish failed/i);
    expect(job.error).toMatch(/shot_01/);
  });
});

describe("clipKeysFromFilmJob: no raw-clip substitution for a failed finish (#245/#246)", () => {
  it("finish set up + a shot failed -> finished clips only, never the raw i2v clip", async () => {
    const job = {
      film_id: "film-x", project: "neon", clip_job_id: "clips-x",
      finish_shots: [
        { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_ls.mp4", chain: ["MODULE_LIPSYNC"], configs: [{}], idx: 0, status: "done", applied: ["lipsync:v15"] },
        { shot_id: "shot_02", clip_key: "renders/neon/clips/shot_02_wan.mp4", chain: ["MODULE_FINISH_RIFE"], configs: [{}], idx: 0, status: "failed", applied: [], error: "RIFE crash" },
      ] as FinishShot[],
    } as unknown as FilmJob;
    let touchedRawClipJob = false;
    const env = { R2_RENDERS: { get: async () => { touchedRawClipJob = true; return null; } } } as unknown as Env;
    const keys = await clipKeysFromFilmJob(env, job);
    expect(touchedRawClipJob).toBe(false);                                  // never fell through to raw
    expect(keys.get("shot_01")).toBe("renders/neon/clips/shot_01_ls.mp4");  // the finished clip
    expect(keys.has("shot_02")).toBe(false);                               // failed shot NOT raw-substituted
  });

  it("no finish modules installed (finish_shots empty) -> assembles the raw i2v clips", async () => {
    const job = { film_id: "film-y", project: "neon", clip_job_id: "clips-y", finish_shots: [] } as unknown as FilmJob;
    const clipJob = { shots: [{ shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_wan.mp4", status: "done" }] };
    const env = { R2_RENDERS: { get: async () => ({ text: async () => JSON.stringify(clipJob) }) } } as unknown as Env;
    const keys = await clipKeysFromFilmJob(env, job);
    expect(keys.get("shot_01")).toBe("renders/neon/clips/shot_01_wan.mp4"); // raw clip used (no finish)
  });
});

describe("finish-step R2 advance (FIX C: a MID-chain step GC'd/frozen with its output already in R2)", () => {
  const fs = (over: Partial<FinishShot>): FinishShot => ({
    shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4",
    chain: [], configs: [], idx: 0, status: "pending", applied: [], ...over,
  } as FinishShot);

  it("finishStepOutputKey: predicts each finish module's output key; null for an unmodeled module", () => {
    // finish-rife names its output off the shot id (container convention), not by appending to the input.
    expect(finishStepOutputKey("neon", fs({ chain: ["MODULE_FINISH_RIFE"] }))).toBe("renders/neon/clips/shot_01_finished.mp4");
    // the append-convention modules insert their suffix before the extension of the INPUT clip key.
    expect(finishStepOutputKey("neon", fs({ clip_key: "renders/neon/clips/shot_01_finished.mp4", chain: ["MODULE_FINISH_LIPSYNC"] }))).toBe("renders/neon/clips/shot_01_finished_ls.mp4");
    expect(finishStepOutputKey("neon", fs({ clip_key: "renders/neon/clips/shot_01_finished_ls.mp4", chain: ["MODULE_FINISH_UPSCALE"] }))).toBe("renders/neon/clips/shot_01_finished_ls_up.mp4");
    // an unmodeled module -> null: NO R2 shortcut, so it can never advance off a sibling step's artifact.
    expect(finishStepOutputKey("neon", fs({ chain: ["MODULE_FINISH_STUB"] }))).toBeNull();
  });

  it("finishStepAppliedTag: reconstructs each module's applied marker from its validated config", () => {
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_FINISH_LIPSYNC"], configs: [{ version: "v15" }] }))).toBe("lipsync:v15");
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_FINISH_UPSCALE"], configs: [{ scale: 2 }] }))).toBe("upscale:2x");
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_FINISH_RIFE"], configs: [{ interpolation_factor: 2 }] }))).toBe("interpolate:2x");
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_FINISH_STUB"], configs: [{}] }))).toBe("MODULE_FINISH_STUB:r2-adopted");
  });

  // The live wedge: a 4-step chain stuck at idx 0 (RIFE) whose poll froze IN_PROGRESS / 404s while the
  // RIFE output already landed in R2 -- so lip-sync was never dispatched and the shot pended forever.
  const wedgeFilm = (): FilmJob => ({
    film_id: "film-fixc", project: "neon", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    motion_backend: "own-gpu", motion_config: {}, finish_config: {},
    keyframe_binding: null, phase: "finish", clips_only: true,
    finish_shots: [{
      shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4",
      chain: ["MODULE_FINISH_RIFE", "MODULE_FINISH_LIPSYNC", "MODULE_FINISH_UPSCALE", "MODULE_FINISH_STUB"],
      configs: [{ interpolation_factor: 2 }, { version: "v15" }, { scale: 2 }, {}],
      idx: 0, status: "pending", applied: [], poll: "frozen", error: undefined,
    }] as FinishShot[],
    created_at: Date.now(),
  });

  function wedgeEnv(job: FilmJob, opts: { rifePoll: "pending" | "404"; rifeOutputInR2: boolean }, sidecars: Record<string, string> = {}) {
    const filmDoc = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    const present = new Set<string>();
    if (opts.rifeOutputInR2) present.add("renders/neon/clips/shot_01_finished.mp4");
    let lipsyncInvoked = false;
    const env = {
      R2_RENDERS: {
        get: async (k: string) => (k === filmDoc ? { text: async () => stored } : (k in sidecars ? { text: async () => sidecars[k] } : null)),
        put: async (k: string, b: string) => { if (k === filmDoc) stored = b; },
        list: async () => ({ objects: [], truncated: false }),
        head: async (k: string) => (present.has(k) ? { key: k } : null),
      },
      MODULE_FINISH_RIFE: {
        fetch: async (url: string) => {
          if (!String(url).includes("/poll")) return new Response("{}", { status: 404 });
          if (opts.rifePoll === "404") return new Response("", { status: 404 }); // GC'd-after-complete
          return new Response(JSON.stringify({ ok: true, pending: true }), { status: 200, headers: { "content-type": "application/json" } }); // frozen IN_PROGRESS
        },
      },
      MODULE_FINISH_LIPSYNC: {
        fetch: async (url: string) => {
          if (String(url).includes("/invoke")) { lipsyncInvoked = true; return new Response(JSON.stringify({ ok: true, pending: true, poll: "ls-tok" }), { status: 200, headers: { "content-type": "application/json" } }); }
          return new Response(JSON.stringify({ ok: true, pending: true }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    } as unknown as Env;
    return { env, read: () => JSON.parse(stored) as FilmJob, lipsyncInvoked: () => lipsyncInvoked };
  }

  it("frozen-pending RIFE + its output in R2 -> adopts the step, advances idx, then dispatches lip-sync", async () => {
    const scHash = await finishStepInputHash(null, null, { interpolation_factor: 2 }); // #583 gate: matching sidecar
    const { env, read, lipsyncInvoked } = wedgeEnv(wedgeFilm(), { rifePoll: "pending", rifeOutputInR2: true },
      { "renders/neon/clips/shot_01_finished.mp4.hash": scHash });
    await advanceFilmJob(env, "film-fixc");
    const a = read().finish_shots![0];
    expect(a.idx).toBe(1);                                              // advanced off the RIFE step...
    expect(a.applied).toEqual([]);                                     // #583: adopted, NOT run -> never a fake applied-run tag
    expect(a.adopted).toEqual(["interpolate:2x"]);                     // ...the reuse is disclosed in the `adopted` channel
    expect(a.clip_key).toBe("renders/neon/clips/shot_01_finished.mp4"); // next step's input is the RIFE output
    expect(a.status).toBe("pending");                                  // 3 modules still to run
    expect(a.poll).toBeUndefined();
    expect(lipsyncInvoked()).toBe(false);                             // lip-sync dispatches on the NEXT tick
    await advanceFilmJob(env, "film-fixc");
    expect(lipsyncInvoked()).toBe(true);                              // the wedge is cleared: lip-sync now runs
    expect(read().finish_shots![0].poll).toBe("ls-tok");
  });

  it("404 job-not-found + NO R2 output -> fails loud (not silent-pending)", async () => {
    const { env, read } = wedgeEnv(wedgeFilm(), { rifePoll: "404", rifeOutputInR2: false });
    await advanceFilmJob(env, "film-fixc");
    expect(read().finish_shots![0].status).toBe("failed");
  });

  it("frozen-pending + NO R2 output yet -> stays pending (the job may still finish), never false-fails", async () => {
    const { env, read } = wedgeEnv(wedgeFilm(), { rifePoll: "pending", rifeOutputInR2: false });
    await advanceFilmJob(env, "film-fixc");
    const a = read().finish_shots![0];
    expect(a.status).toBe("pending");
    expect(a.idx).toBe(0);
    expect(a.applied).toEqual([]);
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

// Issue #563: dialogue_lines must ride the SAME id coercion as the scenes. startFilmJob coerced
// scene ids (s1 -> shot_01) but stored dialogue_lines verbatim, so the TTS map was keyed s1 while
// the lip-sync finish step and buildCaptionCues joined on shot_01: the film shipped silent and
// uncaptioned (noop:no-dialogue on every shot) even though the dialogue stage ran and paid.
describe("coerceDialogueLineIds (dialogue joins the coerced scene ids, issue #563)", () => {
  const scenes = [
    { shot_id: "s1", prompt: "a", seconds: 5 },
    { shot_id: "s2", prompt: "b", seconds: 5 },
  ];
  it("remaps caller ids positionally, exactly like coerceSceneIds", () => {
    const out = coerceDialogueLineIds(scenes, [
      { shot_id: "s1", text: "They said no one would come." },
      { shot_id: "s2", text: "But the light finds someone.", voice_id: "orion" },
    ]);
    expect(out).toEqual([
      { shot_id: "shot_01", text: "They said no one would come." },
      { shot_id: "shot_02", text: "But the light finds someone.", voice_id: "orion" },
    ]);
  });
  it("no-ops on already-canonical ids (planner UI / scatter path unchanged)", () => {
    const canonical = [
      { shot_id: "shot_01", prompt: "a", seconds: 5 },
      { shot_id: "shot_02", prompt: "b", seconds: 5 },
    ];
    const lines = [{ shot_id: "shot_02", text: "hi" }];
    expect(coerceDialogueLineIds(canonical, lines)).toEqual(lines);
  });
  it("passes a line matching no scene through unchanged (fail-soft, like the dialogue stage)", () => {
    const lines = [{ shot_id: "narrator", text: "meanwhile..." }];
    expect(coerceDialogueLineIds(scenes, lines)).toEqual(lines);
  });
  it("preserves undefined / empty lines", () => {
    expect(coerceDialogueLineIds(scenes, undefined)).toBeUndefined();
    expect(coerceDialogueLineIds(scenes, [])).toEqual([]);
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
function r2ListEnv(items: (string | { key: string; uploadedMs: number })[]) {
  // A plain-string entry defaults to uploaded epoch 0 (the pre-#661 tests pass a 0 floor, so age is moot);
  // an object entry carries an explicit uploadedMs for the #661 freshness-guard cases.
  const objs = items.map((it) => typeof it === "string"
    ? { key: it, uploaded: new Date(0) }
    : { key: it.key, uploaded: new Date(it.uploadedMs) });
  return {
    R2_RENDERS: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: objs.filter((o) => o.key.startsWith(prefix)),
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
    const out = await listProjectKeyframes(env, "neon", sc, 0);
    expect(out).toEqual([
      { shot_id: "shot_01", keyframe_key: "renders/neon/keyframes/shot_01.png" },
      { shot_id: "shot_02", keyframe_key: "renders/neon/keyframes/shot_02.png" },
    ]);
  });
  it("returns empty when no keyframes are in R2 yet", async () => {
    expect(await listProjectKeyframes(r2ListEnv([]), "neon", sc, 0)).toEqual([]);
  });
  it("ignores .hash param-hash sidecars (backend #112): the PNG wins, never the sidecar (#578)", async () => {
    // .hash sorts BEFORE .png lexicographically; pre-#578 the first-seen dedupe adopted the sidecar
    // and the motion backend was handed a 16-byte hash file as its start image.
    const env = r2ListEnv([
      "renders/neon/keyframes/shot_01.hash",
      "renders/neon/keyframes/shot_01.png",
      "renders/neon/keyframes/shot_02.hash",
      "renders/neon/keyframes/shot_02.png",
    ]);
    const out = await listProjectKeyframes(env, "neon", sc, 0);
    expect(out).toEqual([
      { shot_id: "shot_01", keyframe_key: "renders/neon/keyframes/shot_01.png" },
      { shot_id: "shot_02", keyframe_key: "renders/neon/keyframes/shot_02.png" },
    ]);
  });
  it("a shot with ONLY a sidecar (no image) is not adopted -- absent, not poisoned (#578)", async () => {
    const env = r2ListEnv([
      "renders/neon/keyframes/shot_01.hash",
      "renders/neon/keyframes/shot_02.png",
    ]);
    const out = await listProjectKeyframes(env, "neon", sc, 0);
    expect(out).toEqual([
      { shot_id: "shot_02", keyframe_key: "renders/neon/keyframes/shot_02.png" },
    ]);
  });
  it("accepts jpg/jpeg/webp keyframes, case-insensitive", async () => {
    const env = r2ListEnv([
      "renders/neon/keyframes/shot_01.JPG",
      "renders/neon/keyframes/shot_02.webp",
    ]);
    const out = await listProjectKeyframes(env, "neon", sc, 0);
    expect(out).toEqual([
      { shot_id: "shot_01", keyframe_key: "renders/neon/keyframes/shot_01.JPG" },
      { shot_id: "shot_02", keyframe_key: "renders/neon/keyframes/shot_02.webp" },
    ]);
  });
  it("#661: drops a stale FULL set uploaded BEFORE this run started (the live producer keeps running)", async () => {
    const RUN_START = 2_000_000;
    const env = r2ListEnv([
      { key: "renders/neon/keyframes/shot_01.png", uploadedMs: RUN_START - 4 * 86_400_000 }, // 4d-old leftover
      { key: "renders/neon/keyframes/shot_02.png", uploadedMs: RUN_START - 4 * 86_400_000 },
    ]);
    expect(await listProjectKeyframes(env, "neon", sc, RUN_START)).toEqual([]);
  });
  it("#661: adopts this run own orphans uploaded AFTER the job started (legit #129 recovery survives)", async () => {
    const RUN_START = 2_000_000;
    const env = r2ListEnv([
      { key: "renders/neon/keyframes/shot_01.png", uploadedMs: RUN_START + 5_000 },
      { key: "renders/neon/keyframes/shot_02.png", uploadedMs: RUN_START + 5_000 },
    ]);
    expect(await listProjectKeyframes(env, "neon", sc, RUN_START)).toEqual([
      { shot_id: "shot_01", keyframe_key: "renders/neon/keyframes/shot_01.png" },
      { shot_id: "shot_02", keyframe_key: "renders/neon/keyframes/shot_02.png" },
    ]);
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
  it("#661: a stale FULL set (uploaded before the run) does NOT count as complete", async () => {
    const RUN_START = 2_000_000;
    const staleJob = { project: "neon", scenes: sc, created_at: RUN_START } as unknown as FilmJob;
    const env = r2ListEnv([
      { key: "renders/neon/keyframes/shot_01.png", uploadedMs: RUN_START - 86_400_000 },
      { key: "renders/neon/keyframes/shot_02.png", uploadedMs: RUN_START - 86_400_000 },
      { key: "renders/neon/keyframes/shot_03.png", uploadedMs: RUN_START - 86_400_000 },
    ]);
    expect(await keyframeSetCompleteInR2(env, staleJob)).toBe(false);
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
        objects: keyframeKeys.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, uploaded: new Date() })),
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

// Env double for the #619 partial-keyframe recovery: round-trips the film doc, serves a GROWABLE keyframe
// listing (addKeys mutates the same array a later sweep re-lists), and binds MODULE_KEYFRAME to a /poll
// stub that stays pending -- so a HELD partial phase stays "keyframe" exactly as it does in prod (an
// unbound module would instead fail the Phase-1 leg, masking the hold).
function kfRecoveryEnv(job: FilmJob, keyframeKeys: string[]) {
  const filmDoc = filmJobDocKey(job.film_id);
  let stored = JSON.stringify(job);
  const env = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmDoc ? { text: async () => stored } : null),
      put: async (key: string, body: string) => { if (key === filmDoc) stored = body; },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: keyframeKeys.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, uploaded: new Date() })),
        truncated: false,
      }),
    },
    MODULE_KEYFRAME: { fetch: async () => new Response(JSON.stringify({ ok: true, pending: true }), { headers: { "content-type": "application/json" } }) },
  } as unknown as Env;
  return { env, read: () => JSON.parse(stored) as FilmJob, addKeys: (...k: string[]) => keyframeKeys.push(...k) };
}

describe("advanceFilmJob partial keyframe recovery (#619)", () => {
  const scenes4: FilmScene[] = [
    { shot_id: "shot_01", prompt: "a", seconds: 7 },
    { shot_id: "shot_02", prompt: "b", seconds: 7 },
    { shot_id: "shot_03", prompt: "c", seconds: 7 },
    { shot_id: "shot_04", prompt: "d", seconds: 7 },
  ];
  // keyframes_only so the adopted path completes WITHOUT touching motion modules / presign.
  const kfJob = (over: Partial<FilmJob> = {}): FilmJob => ({
    film_id: "film-619",
    project: "neon",
    bundle_key: "bundles/neon.json",
    scenes: scenes4,
    motion_backend: null,
    motion_config: {},
    finish_config: {},
    keyframe_binding: "MODULE_KEYFRAME",
    phase: "keyframe",
    keyframe_poll: "phantom-token",
    keyframes_only: true,
    created_at: Date.now() - (KEYFRAME_STALL_SECONDS + 60) * 1000, // stale, below the hard ceiling
    phase_started_at: Date.now() - (KEYFRAME_STALL_SECONDS + 60) * 1000,
    ...over,
  });

  it("HOLDS a partial set below the ceiling: does NOT advance, cancel, or degrade (#619)", async () => {
    // The exact prod bug: 2 of 4 keyframes in R2 on a stale poll. The old code adopted the 2, cancelled
    // the live job, and shipped a silent half-film. It must now HOLD in "keyframe" for the rest to land.
    const { env, read } = kfRecoveryEnv(kfJob(), [
      "renders/neon/keyframes/shot_01.png",
      "renders/neon/keyframes/shot_02.png",
    ]);
    const r = await advanceFilmJob(env, "film-619");
    expect(r?.job.phase).toBe("keyframe");            // did NOT advance to clips/done
    expect(r?.job.keyframe_recovered).toBeUndefined(); // no one-shot gate set on a partial pass
    expect(r?.job.keyframes_incomplete).toBeUndefined();
    expect(read().phase).toBe("keyframe");            // persisted, still holding
  });

  it("advances with ALL scenes once the full set lands on a later sweep (#619)", async () => {
    const { env, addKeys } = kfRecoveryEnv(kfJob(), [
      "renders/neon/keyframes/shot_01.png",
      "renders/neon/keyframes/shot_02.png",
    ]);
    const held = await advanceFilmJob(env, "film-619");
    expect(held?.job.phase).toBe("keyframe");         // partial: held, per the test above
    addKeys("renders/neon/keyframes/shot_03.png", "renders/neon/keyframes/shot_04.png");
    const done = await advanceFilmJob(env, "film-619");
    expect(done?.job.phase).toBe("done");             // full set: advances
    expect(done?.job.keyframe_recovered).toBe(true);
    expect(done?.job.keyframes?.map((k) => k.shot_id).sort()).toEqual(["shot_01", "shot_02", "shot_03", "shot_04"]);
    expect(done?.job.keyframes_incomplete).toBeUndefined(); // full set -> no degrade
  });

  it("at the ceiling with a partial set: delivers what rendered, records the drop, never a silent complete (#619)", async () => {
    const { env, read } = kfRecoveryEnv(
      kfJob({
        created_at: Date.now() - (PHASE_HARD_DEADLINE_SECONDS + 60) * 1000,
        phase_started_at: Date.now() - (PHASE_HARD_DEADLINE_SECONDS + 60) * 1000,
      }),
      ["renders/neon/keyframes/shot_01.png", "renders/neon/keyframes/shot_02.png"],
    );
    const r = await advanceFilmJob(env, "film-619");
    // advanced (delivered the 2 rendered scenes) rather than hanging or hard-failing the whole film...
    expect(r?.job.phase).toBe("done");
    expect(r?.job.keyframe_recovered).toBe(true);
    // ...but LOUDLY: the drop is recorded so the film never reports a clean complete over the rebased total.
    expect(r?.job.keyframes_incomplete).toEqual({ adopted: 2, expected: 4, dropped: ["shot_03", "shot_04"] });
    // and it is surfaced on the film summary the API returns.
    expect(summarizeFilm(read(), null).keyframes_incomplete).toEqual({ adopted: 2, expected: 4, dropped: ["shot_03", "shot_04"] });
  });
});

// #622 env double for the NORMAL keyframe-completion path (NOT a stall). The keyframe module /poll returns
// an OUTPUT (non-pending) carrying a PARTIAL keyframe set, so advanceToClips joins fewer keyframes than
// scenes -- the silent-half-film shape of #619 reached without any stall. A motion.backend module is bound
// returning a pending clip, so the film settles in "clips" without dragging in the finish/assemble
// machinery. Round-trips every doc by exact key; carries the fake R2 presign creds advanceToClips needs.
function kfCompletionEnv(job: FilmJob, keyframeOutput: { shot_id: string; keyframe_key: string }[]) {
  const store = new Map<string, string>();
  store.set(filmJobDocKey(job.film_id), JSON.stringify(job));
  const jr = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  const MOTION_MANIFEST = {
    name: "seedance", version: "0.1.0", api: "vivijure-module/2", hooks: ["motion.backend"],
    provides: [{ id: "seedance", label: "Seedance" }], config_schema: {}, ui: { section: "motion.backend", order: 10 },
  };
  const env = {
    R2_S3_ACCESS_KEY_ID: "k", R2_S3_SECRET_ACCESS_KEY: "s",
    R2_S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com", R2_S3_BUCKET: "renders",
    R2_RENDERS: {
      get: async (k: string) => (store.has(k) ? { text: async () => store.get(k) as string } : null),
      put: async (k: string, b: string) => { store.set(k, b); },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...store.keys()].filter((x) => x.startsWith(prefix)).map((x) => ({ key: x })),
        truncated: false,
      }),
    },
    // The keyframe module: /poll resolves to the (possibly partial) output; /module.json is invalid so it
    // is skipped from the registry (the poll path resolves the fetcher by binding, not via discovery).
    MODULE_KEYFRAME: {
      fetch: async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/poll")) return jr({ ok: true, output: { project: job.project, keyframes: keyframeOutput } });
        return jr({}); // /module.json -> invalid manifest -> skipped
      },
    },
    // A serving motion.backend so advanceToClips can start a clip job; the shot stays pending so the film
    // settles in "clips" (we assert the keyframe degrade, not the downstream clip/finish behavior).
    MODULE_SEEDANCE: {
      fetch: async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) return jr(MOTION_MANIFEST);
        if (url.endsWith("/invoke")) return jr({ ok: true, pending: true, poll: "mtok" });
        return jr({ ok: true, pending: true }); // /poll stays pending
      },
    },
  } as unknown as Env;
  return { env, read: () => JSON.parse(store.get(filmJobDocKey(job.film_id)) as string) as FilmJob };
}

describe("advanceToClips partial keyframe set on the NORMAL completion path (#622)", () => {
  const scenes4: FilmScene[] = [
    { shot_id: "shot_01", prompt: "a", seconds: 7 },
    { shot_id: "shot_02", prompt: "b", seconds: 7 },
    { shot_id: "shot_03", prompt: "c", seconds: 7 },
    { shot_id: "shot_04", prompt: "d", seconds: 7 },
  ];
  // A fresh keyframe phase awaiting its poll (created_at NOW, so the #129/#619 stall recovery does NOT
  // fire -- this is the module honestly reporting completion, not a GC orphan). NOT keyframes_only, so
  // afterKeyframeOutput takes the advanceToClips branch (a keyframes-only preview never rebases a film).
  const kfJob = (over: Partial<FilmJob> = {}): FilmJob => ({
    film_id: "film-622",
    project: "neon",
    bundle_key: "bundles/neon.json",
    scenes: scenes4,
    motion_backend: null, // let startClipJob pick the serving motion module (seedance)
    motion_config: {},
    finish_config: {},
    keyframe_binding: "MODULE_KEYFRAME",
    phase: "keyframe",
    keyframe_poll: "kfphantom",
    created_at: Date.now(),
    phase_started_at: Date.now(),
    ...over,
  });

  it("delivers-with-degrade when the module completes with a PARTIAL set: advances but records the drop LOUDLY (#622)", async () => {
    // The exact #622 shape: a keyframe module reports done with 2 of 4 keyframes. The old code built the
    // clip job from the 2 matched shots and dropped shot_03/shot_04 silently, so the film reported a clean
    // complete over a rebased total of 2. It must now advance delivering the 2 rendered scenes, but record
    // the drop so no counter is silently rebased.
    const { env, read } = kfCompletionEnv(kfJob(), [
      { shot_id: "shot_01", keyframe_key: "renders/neon/keyframes/shot_01.png" },
      { shot_id: "shot_02", keyframe_key: "renders/neon/keyframes/shot_02.png" },
    ]);
    const r = await advanceFilmJob(env, "film-622");
    expect(r?.job.phase).toBe("clips"); // advanced (delivered what rendered), did NOT hard-fail the whole film
    expect(r?.job.keyframes_incomplete).toEqual({ adopted: 2, expected: 4, dropped: ["shot_03", "shot_04"] });
    // surfaced on the film summary the API returns, and persisted (not just in-memory)
    expect(summarizeFilm(read(), null).keyframes_incomplete).toEqual({ adopted: 2, expected: 4, dropped: ["shot_03", "shot_04"] });
    expect(read().keyframes_incomplete).toEqual({ adopted: 2, expected: 4, dropped: ["shot_03", "shot_04"] });
  });

  it("does NOT flag a degrade when the module completes with the FULL set (#622)", async () => {
    const full = scenes4.map((s) => ({ shot_id: s.shot_id, keyframe_key: `renders/neon/keyframes/${s.shot_id}.png` }));
    const { env, read } = kfCompletionEnv(kfJob(), full);
    const r = await advanceFilmJob(env, "film-622");
    expect(r?.job.phase).toBe("clips");
    expect(r?.job.keyframes_incomplete).toBeUndefined(); // full coverage -> no degrade
    expect(read().keyframes_incomplete).toBeUndefined();
  });

  it("still HARD-FAILS when the module returns NONE of the requested shots (unchanged, no degrade record) (#622)", async () => {
    const { env, read } = kfCompletionEnv(kfJob(), []);
    const r = await advanceFilmJob(env, "film-622");
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/produced none of the requested shots/);
    expect(read().keyframes_incomplete).toBeUndefined(); // a hard fail is not a delivered-with-degrade
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
    const out = await listProjectClips(env, "neon", sc, 0);
    expect(out).toEqual([
      { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4" },
      { shot_id: "shot_10", clip_key: "renders/neon/clips/shot_10_i2v.mp4" },
    ]);
  });
  it("returns empty when no clips are in R2", async () => {
    expect(await listProjectClips(r2ListEnv([]), "neon", sc, 0)).toEqual([]);
  });
  it("#661: drops a stale clip uploaded BEFORE this run started, keeps a fresh one", async () => {
    const RUN_START = 2_000_000;
    const env = r2ListEnv([
      { key: "renders/neon/clips/shot_01_i2v.mp4", uploadedMs: RUN_START - 4 * 86_400_000 }, // stale leftover
      { key: "renders/neon/clips/shot_10_i2v.mp4", uploadedMs: RUN_START + 5_000 },          // this run own clip
    ]);
    const out = await listProjectClips(env, "neon", sc, RUN_START);
    expect(out).toEqual([
      { shot_id: "shot_10", clip_key: "renders/neon/clips/shot_10_i2v.mp4" },
    ]);
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
        objects: clipKeys.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, uploaded: new Date() })),
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

  // ------------------------------------------------------------------ the ceiling tracks progress (#704)
  // A slow local-gpu card lands one clip every few minutes: at minute 90 the phase is OLD but healthy.
  // The hard ceiling must measure the per-shot phases from last_progress_at, not phase_started_at, so a
  // film that keeps landing shots never hard-fails mid-progress -- while 90min since the LAST landed
  // shot still fails loudly, and the batch keyframe phase keeps its phase-age semantics.

  it("does NOT hard-fail an over-90min clips phase whose last shot landed recently (#704)", async () => {
    const old = (PHASE_HARD_DEADLINE_SECONDS + 600) * 1000;
    const job = stalledFilm({
      created_at: Date.now() - old,
      phase_started_at: Date.now() - old,
      last_progress_at: Date.now() - 10 * 60 * 1000, // a shot landed 10min ago -- healthy
    });
    // The stuck shots' clips are NOT in R2, so the same-phase adoption holds (partial) and the tick
    // reaches the ceiling check; the module poll stays pending.
    const { env } = clipsRecoveryEnv(job, clipsJob(), ["renders/neon/clips/shot_02_i2v.mp4"]);
    const r = await advanceFilmJob(env, "film-stall-clips");
    expect(r?.job.phase).toBe("clips"); // held, not failed
    expect(r?.job.error).toBeUndefined();
  });

  it("still hard-fails a clips phase with 90min since the LAST landed shot (#704)", async () => {
    const old = (PHASE_HARD_DEADLINE_SECONDS + 600) * 1000;
    const job = stalledFilm({
      created_at: Date.now() - old,
      phase_started_at: Date.now() - old,
      last_progress_at: Date.now() - (PHASE_HARD_DEADLINE_SECONDS + 60) * 1000, // stale progress too
    });
    const { env } = clipsRecoveryEnv(job, clipsJob(), ["renders/neon/clips/shot_02_i2v.mp4"]);
    const r = await advanceFilmJob(env, "film-stall-clips");
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toContain("stalled in phase \"clips\"");
  });

  it("a pre-#136 job with NO last_progress_at falls back to phase age at the ceiling (#704)", async () => {
    const old = (PHASE_HARD_DEADLINE_SECONDS + 600) * 1000;
    const job = stalledFilm({ created_at: Date.now() - old, phase_started_at: Date.now() - old });
    delete (job as Partial<FilmJob>).last_progress_at;
    const { env } = clipsRecoveryEnv(job, clipsJob(), ["renders/neon/clips/shot_02_i2v.mp4"]);
    const r = await advanceFilmJob(env, "film-stall-clips");
    expect(r?.job.phase).toBe("failed");
  });
});

describe("ceilingAgeSeconds (#704)", () => {
  const now = 1_800_000_000_000;
  const base = {
    film_id: "f", project: "p", bundle_key: "b", scenes: [], motion_backend: "m",
    motion_config: {}, finish_config: {}, keyframe_binding: null, clip_job_id: null,
    created_at: now - 100 * 60 * 1000, phase_started_at: now - 100 * 60 * 1000,
  } as unknown as FilmJob;

  it("per-shot phases measure from last_progress_at when it is newer", () => {
    for (const phase of ["clips", "speech", "finish"] as const) {
      const job = { ...base, phase, last_progress_at: now - 5 * 60 * 1000 } as FilmJob;
      expect(ceilingAgeSeconds(job, now)).toBe(5 * 60);
    }
  });

  it("per-shot phases fall back to phase_started_at with no progress stamp", () => {
    const job = { ...base, phase: "clips" } as FilmJob;
    expect(ceilingAgeSeconds(job, now)).toBe(100 * 60);
  });

  it("a stale last_progress_at OLDER than phase_started_at never rewinds the clock", () => {
    // e.g. the stamp was written in a PREVIOUS phase and the new phase just began
    const job = { ...base, phase: "clips", phase_started_at: now - 60 * 1000, last_progress_at: now - 100 * 60 * 1000 } as FilmJob;
    expect(ceilingAgeSeconds(job, now)).toBe(60);
  });

  it("the batch keyframe phase ignores last_progress_at (phase-age semantics unchanged)", () => {
    const job = { ...base, phase: "keyframe", last_progress_at: now - 60 * 1000 } as FilmJob;
    expect(ceilingAgeSeconds(job, now)).toBe(100 * 60);
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

  function finishEnv(job: FilmJob, r2Keys: string[], sidecars: Record<string, string> = {}) {
    const filmDoc = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    const env = {
      R2_RENDERS: {
        get: async (k: string) => (k === filmDoc ? { text: async () => stored } : (k in sidecars ? { text: async () => sidecars[k] } : null)),
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
    const scHash = await finishStepInputHash(null, null, {}); // #583 gate: matching sidecar for the reclaimed shot
    const { env, read } = finishEnv(finishFilm(), [
      "renders/neon/clips/shot_01_finished.mp4",
      "renders/neon/clips/shot_02_finished.mp4", // the failed shot's finish output IS present
    ], { "renders/neon/clips/shot_02_finished.mp4.hash": scHash });
    const r = await advanceFilmJob(env, "film-finish-reclaim");
    const fs2 = read().finish_shots?.find((f) => f.shot_id === "shot_02");
    expect(fs2?.status).toBe("done");
    expect(fs2?.clip_key).toBe("renders/neon/clips/shot_02_finished.mp4");
    expect(fs2?.error).toBeUndefined();
    expect(fs2?.applied).toEqual([]);                 // #583: reclaimed from R2, not run this pass
    expect(fs2?.adopted).toEqual(["interpolate:2x"]); // the reuse is disclosed in `adopted`, never faked into applied
    expect(r?.job.phase).not.toBe("finish"); // advanced (clips_only -> done)
  });

  it("#583 gate: does NOT reclaim a present artifact with NO sidecar (legacy) -- re-runs, never adopts blind", async () => {
    const { env, read } = finishEnv(finishFilm(), [
      "renders/neon/clips/shot_01_finished.mp4",
      "renders/neon/clips/shot_02_finished.mp4",
    ]); // no sidecars -> unstamped legacy artifact
    await advanceFilmJob(env, "film-finish-reclaim");
    expect(read().finish_shots?.find((f) => f.shot_id === "shot_02")?.status).toBe("failed"); // NOT adopted
  });

  it("#583 gate: does NOT reclaim when the sidecar MISMATCHES the current inputs (a changed-voice/param resubmit)", async () => {
    const { env, read } = finishEnv(finishFilm(), [
      "renders/neon/clips/shot_01_finished.mp4",
      "renders/neon/clips/shot_02_finished.mp4",
    ], { "renders/neon/clips/shot_02_finished.mp4.hash": "0".repeat(64) }); // a prior take's stale hash
    await advanceFilmJob(env, "film-finish-reclaim");
    expect(read().finish_shots?.find((f) => f.shot_id === "shot_02")?.status).toBe("failed"); // NOT adopted -> re-run/fail-loud, never ships stale
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
    api: "vivijure-module/2",
    hooks: ["film.finish"],
    provides: [{ id: "film-titles", label: "Title + credit cards" }],
    config_schema: {},
    ui: { section: "film.finish", order: 10 },
  };

  function filmFinishEnv(job: object, invokeResponse: unknown, opts: { withModule?: boolean; presentKeys?: string[] } = {}) {
    const filmId = (job as { film_id: string }).film_id;
    let stored = JSON.stringify(job);
    const jsonResp = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const env: Record<string, unknown> = {
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
        head: async (key: string) => (opts.presentKeys?.includes(key) ? ({ size: 1 } as unknown) : null),
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
    expect(r?.job.film_finish?.degraded).toBe("film-titles: passthrough:container-unreachable");
    expect(r?.job.film_finish?.steps).toEqual(["passthrough:container-unreachable"]);
    // film kept the muxed key (no cards applied)
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio.mp4");
    expect(read().film_finish?.degraded).toBe("film-titles: passthrough:container-unreachable"); // persisted
  });

  it("records applied + swaps to the DETERMINISTIC carded film when the module succeeds (#600)", async () => {
    const ok = { ok: true, output: { film_key: "renders/film-finish-obs/film-audio-titled-abc.mp4", applied: ["film-titles"] } };
    const { env } = filmFinishEnv(muxJob(), ok);
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish?.applied).toEqual(["film-titles"]);
    expect(r?.job.film_finish?.adopted).toEqual([]); // ran this attempt, not adopted
    expect(r?.job.film_finish?.degraded).toBeUndefined();
    // The film follows the module contract out.film_key (a real module writes to the presigned outKey and
    // echoes it; adoption HEADs the deterministic outKey, so real writes are what become adoptable).
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio-titled-abc.mp4");
  });

  it("#600: a completed step already in R2 is ADOPTED (not re-encoded), recorded as adopted not applied", async () => {
    // The deterministic step key is already present (a prior attempt finished it after its request timed
    // out). The chain must adopt it -- no re-dispatch -- so a big film stops re-burning the media stack.
    const ok = { ok: true, output: { film_key: "renders/film-finish-obs/film-audio-ff0.mp4", applied: ["film-titles"] } };
    const { env } = filmFinishEnv(muxJob(), ok, { presentKeys: ["renders/film-finish-obs/film-audio-ff0.mp4"] });
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish?.adopted).toEqual(["film-titles"]); // reused from R2
    expect(r?.job.film_finish?.applied).toEqual([]);              // NOT run this attempt (no fake applied, #583)
    expect(r?.job.film_finish?.degraded).toBeUndefined();
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio-ff0.mp4"); // threaded to the adopted artifact
  });

  const FF0_KEY = "renders/film-finish-obs/film-audio-ff0.mp4";

  it("#600 in-flight guard: a step dispatched within the window (key still absent) is NOT re-dispatched", async () => {
    // The deterministic key is absent (still encoding) but was dispatched moments ago. The guard must
    // stop the chain WITHOUT firing a duplicate encode: no finalize, film_key stays the assembled key.
    const ok = { ok: true, output: { film_key: FF0_KEY, applied: ["film-titles"] } };
    const { env } = filmFinishEnv(muxJob({ film_finish_dispatched: { [FF0_KEY]: Date.now() } }), ok);
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).not.toBe("done");                 // NOT finalized -- resumes next tick
    expect(r?.job.film_finish?.applied).toEqual([]);       // the module was NOT dispatched (no re-burn)
    expect(r?.job.film_finish?.adopted).toEqual([]);
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio.mp4"); // assembled key kept (stable base)
  });

  it("#600 in-flight guard: a STALE dispatch (past the window) IS re-dispatched", async () => {
    // Last dispatch is older than the window: the encode is presumed dead, so the step re-dispatches and
    // (in this stub) completes -> the film finalizes.
    const ok = { ok: true, output: { film_key: FF0_KEY, applied: ["film-titles"] } };
    const stale = Date.now() - (FILM_FINISH_INFLIGHT_WINDOW_SECONDS + 60) * 1000;
    const { env } = filmFinishEnv(muxJob({ film_finish_dispatched: { [FF0_KEY]: stale } }), ok);
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish?.applied).toEqual(["film-titles"]); // re-dispatched + completed
    expect(r?.job.film_key).toBe(FF0_KEY);
  });

  it("#600 a NOOP step passes the ORIGINAL film to the next step and does not poison adoption", async () => {
    // Chain [subtitle (noop, enabled=false), film-titles]. The noop returns ok WITHOUT writing its
    // deterministic key, echoing the INPUT key. titles must therefore read the ORIGINAL assembled film,
    // not the noop nonexistent -ff0 key, and the noop must not become an adoptable artifact.
    _resetModuleDiscoveryCache(); // this test installs its own 2-module set; drop any cached discovery
    const filmId = "film-noop-chain";
    const assembled = "renders/" + filmId + "/film-audio.mp4";
    const titledKey = "renders/" + filmId + "/film-audio-ff1.mp4";
    const manifest = (name: string, order: number) => ({
      name, version: "0.1.0", api: "vivijure-module/2", hooks: ["film.finish"],
      provides: [{ id: name, label: name }], config_schema: {}, ui: { section: "film.finish", order },
    });
    const job = {
      film_id: filmId, project: "p", scenes: [{ shot_id: "s1", prompt: "x", seconds: 3 }],
      phase: "mux" as const, silent_film_key: "renders/" + filmId + "/film-silent.mp4",
      audio_key: "renders/" + filmId + "/audio.mp4", mux_output_key: assembled,
      film_titles: { title: { text: "NEON" } }, created_at: 0,
    };
    let stored = JSON.stringify(job);
    const received: Record<string, string> = {};
    const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const moduleFetch = (m: { name: string }, response: unknown) => async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) return jsonResp(m.name === "subtitle" ? manifest("subtitle", 5) : manifest("film-titles", 10));
      const body = JSON.parse((init?.body as string) ?? "{}") as { input?: { film_key?: string } };
      if (body.input?.film_key) received[m.name] = body.input.film_key; // capture what each step read
      return jsonResp(response);
    };
    const env = {
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
        head: async () => null, // no pre-existing artifacts
        put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
      },
      VIDEO_FINISH_VPC: { fetch: async () => jsonResp({ ok: true, key: assembled }) },
      R2_S3_ACCESS_KEY_ID: "t", R2_S3_SECRET_ACCESS_KEY: "t",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
      MODULE_SUBTITLE: { fetch: moduleFetch({ name: "subtitle" }, { ok: true, output: { film_key: assembled, applied: ["noop:no-cards"] } }) },
      MODULE_FILM_TITLES: { fetch: moduleFetch({ name: "film-titles" }, { ok: true, output: { film_key: titledKey, applied: ["film-titles"] } }) },
    } as unknown as Env;
    const r = await advanceFilmJob(env, filmId);
    expect(r?.job.phase).toBe("done");
    expect(received["subtitle"]).toBe(assembled);   // noop read the assembled film
    expect(received["film-titles"]).toBe(assembled); // CRUX: titles read the ORIGINAL, not the noop -ff0
    expect(r?.job.film_key).toBe(titledKey);         // final film is the titles output
    expect(r?.job.film_finish?.applied).toContain("film-titles");
  });

  it("records a chain error (no film_finish drop) when the module invoke fails", async () => {
    const failed = { ok: false, error: "module /invoke -> 500" };
    const { env } = filmFinishEnv(muxJob(), failed);
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish?.errors?.some((e) => e.includes("film-titles"))).toBe(true);
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio.mp4"); // film survives
  });

  it("#663: re-times the .srt sidecar by the title-card prepend + surfaces the sidecar_key on the summary", async () => {
    // Chain [subtitle (order 5, burn+sidecar), film-titles (order 10, 3s title card)]. The subtitle
    // container wrote its sidecar to the deterministic per-step key `<base>-ff0.srt`, timed to the
    // pre-card 0-based film. film-titles then prepends a 3s title card, shifting the final film. The core
    // must re-time the sidecar by +3s, write it next to the FINAL film, and surface that key.
    _resetModuleDiscoveryCache();
    const filmId = "film-srt-663";
    const base = `renders/${filmId}/film-audio`;
    const assembled = `${base}.mp4`;
    const ff0 = `${base}-ff0.mp4`;
    const ff1 = `${base}-ff1.mp4`;
    const rawSidecar = `${base}-ff0.srt`;   // what the subtitle step wrote (pre-card timing)
    const finalSidecar = `${base}-ff1.srt`; // next to the final (carded) film
    const rawSrt = "1\n00:00:00,000 --> 00:00:03,000\nHello there\n\n2\n00:00:03,000 --> 00:00:05,000\nGoodbye\n";

    const manifest = (name: string, order: number) => ({
      name, version: "0.2.0", api: "vivijure-module/2", hooks: ["film.finish"],
      provides: [{ id: name, label: name }], config_schema: {}, ui: { section: "film.finish", order },
    });
    const job = {
      film_id: filmId, project: "p",
      scenes: [{ shot_id: "s1", prompt: "x", seconds: 3 }, { shot_id: "s2", prompt: "y", seconds: 2 }],
      dialogue_lines: [{ shot_id: "s1", text: "Hello there" }, { shot_id: "s2", text: "Goodbye" }],
      phase: "mux" as const, silent_film_key: `renders/${filmId}/film-silent.mp4`,
      audio_key: `renders/${filmId}/audio.mp4`, mux_output_key: assembled,
      film_titles: { title: { text: "NEON HALFLIFE" } }, created_at: 0,
    };
    let stored = JSON.stringify(job);
    const puts: Record<string, string> = {};
    const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const moduleFetch = (name: string, response: unknown) => async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) return jsonResp(manifest(name, name === "subtitle" ? 5 : 10));
      return jsonResp(response); // /invoke
    };
    const env = {
      R2_RENDERS: {
        get: async (key: string) => {
          if (key === filmJobDocKey(filmId)) return { text: async () => stored };
          if (key === rawSidecar) return { text: async () => rawSrt }; // subtitle wrote it (pre-card)
          if (key in puts) return { text: async () => puts[key] };
          return null;
        },
        head: async (key: string) => (key === rawSidecar ? ({ size: rawSrt.length } as unknown) : null),
        put: async (key: string, val: string) => { puts[key] = val; if (key === filmJobDocKey(filmId)) stored = val; },
      },
      VIDEO_FINISH_VPC: { fetch: async () => jsonResp({ ok: true, key: assembled }) },
      R2_S3_ACCESS_KEY_ID: "t", R2_S3_SECRET_ACCESS_KEY: "t",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
      // subtitle burns + writes a sidecar; film-titles applies a 3s title card and REPORTS prepend_seconds.
      MODULE_SUBTITLE: { fetch: moduleFetch("subtitle", { ok: true, output: { film_key: ff0, applied: ["subtitle", "subtitle:sidecar"] } }) },
      MODULE_FILM_TITLES: { fetch: moduleFetch("film-titles", { ok: true, output: { film_key: ff1, applied: ["film-titles"], prepend_seconds: 3 } }) },
    } as unknown as Env;

    const r = await advanceFilmJob(env, filmId);
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_key).toBe(ff1);
    // the sidecar was re-timed by +3s and written next to the final film
    expect(puts[finalSidecar]).toBeDefined();
    expect(puts[finalSidecar]).toContain("00:00:03,000 --> 00:00:06,000"); // cue 1 shifted +3
    expect(puts[finalSidecar]).toContain("00:00:06,000 --> 00:00:08,000"); // cue 2 shifted +3
    expect(puts[finalSidecar]).toContain("Hello there");
    // the raw pre-card sidecar is never mutated in place
    expect(puts[rawSidecar]).toBeUndefined();
    // the final sidecar key is surfaced on the job + the summary (not only discoverable by convention)
    expect(r?.job.film_finish?.sidecar_key).toBe(finalSidecar);
    const summary = summarizeFilm(r!.job, null);
    expect(summary.film_finish?.sidecar_key).toBe(finalSidecar);
  });

  it("#663: a credits-only finish (no title card) copies the sidecar unshifted next to the final film", async () => {
    _resetModuleDiscoveryCache();
    const filmId = "film-srt-663-credits";
    const base = `renders/${filmId}/film-audio`;
    const assembled = `${base}.mp4`;
    const ff0 = `${base}-ff0.mp4`;
    const ff1 = `${base}-ff1.mp4`;
    const rawSidecar = `${base}-ff0.srt`;
    const finalSidecar = `${base}-ff1.srt`;
    const rawSrt = "1\n00:00:00,000 --> 00:00:03,000\nHello there\n";
    const manifest = (name: string, order: number) => ({
      name, version: "0.2.0", api: "vivijure-module/2", hooks: ["film.finish"],
      provides: [{ id: name, label: name }], config_schema: {}, ui: { section: "film.finish", order },
    });
    const job = {
      film_id: filmId, project: "p",
      scenes: [{ shot_id: "s1", prompt: "x", seconds: 3 }],
      dialogue_lines: [{ shot_id: "s1", text: "Hello there" }],
      phase: "mux" as const, silent_film_key: `renders/${filmId}/film-silent.mp4`,
      audio_key: `renders/${filmId}/audio.mp4`, mux_output_key: assembled,
      film_titles: { credits: { lines: ["directed by you"] } }, created_at: 0,
    };
    let stored = JSON.stringify(job);
    const puts: Record<string, string> = {};
    const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const moduleFetch = (name: string, response: unknown) => async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) return jsonResp(manifest(name, name === "subtitle" ? 5 : 10));
      return jsonResp(response);
    };
    const env = {
      R2_RENDERS: {
        get: async (key: string) => {
          if (key === filmJobDocKey(filmId)) return { text: async () => stored };
          if (key === rawSidecar) return { text: async () => rawSrt };
          if (key in puts) return { text: async () => puts[key] };
          return null;
        },
        head: async (key: string) => (key === rawSidecar ? ({ size: rawSrt.length } as unknown) : null),
        put: async (key: string, val: string) => { puts[key] = val; if (key === filmJobDocKey(filmId)) stored = val; },
      },
      VIDEO_FINISH_VPC: { fetch: async () => jsonResp({ ok: true, key: assembled }) },
      R2_S3_ACCESS_KEY_ID: "t", R2_S3_SECRET_ACCESS_KEY: "t",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
      MODULE_SUBTITLE: { fetch: moduleFetch("subtitle", { ok: true, output: { film_key: ff0, applied: ["subtitle", "subtitle:sidecar"] } }) },
      // credits-only: film-titles applies a credit card (no title) -> NO prepend_seconds reported
      MODULE_FILM_TITLES: { fetch: moduleFetch("film-titles", { ok: true, output: { film_key: ff1, applied: ["film-titles"] } }) },
    } as unknown as Env;

    const r = await advanceFilmJob(env, filmId);
    expect(r?.job.phase).toBe("done");
    // unshifted copy next to the final film -- cue times unchanged (credits append at the end)
    expect(puts[finalSidecar]).toBe(rawSrt);
    expect(r?.job.film_finish?.sidecar_key).toBe(finalSidecar);
  });

  it("leaves film_finish unset when no film.finish module is installed (no-op)", async () => {
    const { env } = filmFinishEnv(muxJob(), {}, { withModule: false });
    const r = await advanceFilmJob(env, "film-finish-obs");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish).toBeUndefined();
    expect(r?.job.film_key).toBe("renders/film-finish-obs/film-audio.mp4");
  });
});

// --- dialogue phase (talking characters) ----------------------------------------------------------
// The crux: a clips-complete job with dialogue_lines runs the `dialogue` phase (per-shot TTS) and the
// resulting audio_key is injected into the shot's FinishInput, so the lip-sync finish module receives
// it. Drives advanceFilmJob through dialogue -> finish with fake MODULE_DIALOGUE + MODULE_LIPSYNC.
function moduleFetcher(
  manifest: object,
  handlers: { invoke?: (body: unknown) => object; poll?: (body: unknown) => object },
) {
  return {
    fetch: async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const j = (o: object) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/module.json")) return j(manifest);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (url.endsWith("/invoke") && handlers.invoke) return j(handlers.invoke(body));
      if (url.endsWith("/poll") && handlers.poll) return j(handlers.poll(body));
      return new Response("{}", { status: 404 });
    },
  };
}

// #602 async job+poll END-TO-END through advanceFilmJob: a film.finish module that returns
// { pending, poll } (its container encode outlasts a request budget) is SUBMITTED once and POLLED across
// ticks, never re-burning the encode each tick. The film finalizes only when the poll completes. This is
// the residual #600 did not cover: a SINGLE step that alone exceeds one request budget.
describe("applyFilmFinish async submit+poll across ticks (#602)", () => {
  const FILM_ID = "film-finish-async";
  const MUX_KEY = `renders/${FILM_ID}/film-audio.mp4`;
  const FF0_KEY = `renders/${FILM_ID}/film-audio-ff0.mp4`;
  const MANIFEST = {
    name: "film-titles", version: "0.2.0", api: "vivijure-module/2", hooks: ["film.finish"],
    provides: [{ id: "film-titles", label: "Title + credit cards" }], config_schema: {},
    ui: { section: "film.finish", order: 10 },
  };

  // A stateful film.finish module: /invoke -> pending+poll; /poll -> pending until `completeAfter`
  // polls, then the completed output at the deterministic FF0 key.
  function asyncEnv(completeAfter: number) {
    _resetModuleDiscoveryCache();
    const job = {
      film_id: FILM_ID, project: "p", scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
      phase: "mux" as const, silent_film_key: `renders/${FILM_ID}/film-silent.mp4`,
      audio_key: `renders/${FILM_ID}/audio.mp4`, mux_output_key: MUX_KEY,
      film_titles: { title: { text: "NEON HALFLIFE" } }, created_at: 0,
    };
    let stored = JSON.stringify(job);
    let polls = 0;
    const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const env: Record<string, unknown> = {
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey(FILM_ID) ? { text: async () => stored } : null),
        head: async () => null, // FF0 never appears in R2: completion is driven by the POLL, not adoption
        put: async (key: string, val: string) => { if (key === filmJobDocKey(FILM_ID)) stored = val; },
      },
      VIDEO_FINISH_VPC: { fetch: async () => j({ ok: true, key: MUX_KEY }) }, // mux container
      MODULE_FILM_TITLES: {
        fetch: async (input: Request | string) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.endsWith("/module.json")) return j(MANIFEST);
          if (url.endsWith("/poll")) {
            polls += 1;
            return polls >= completeAfter
              ? j({ ok: true, output: { film_key: FF0_KEY, applied: ["film-titles"] } })
              : j({ ok: true, pending: true });
          }
          return j({ ok: true, pending: true, poll: "tok-ff0" }); // /invoke -> accepted async
        },
      },
      R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
    };
    return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob, pollCount: () => polls };
  }

  it("submits on tick 1 (NOT finalized), persists the poll token, resumes next tick", async () => {
    const { env, read } = asyncEnv(99);
    const r = await advanceFilmJob(env, FILM_ID);
    expect(r?.job.phase).not.toBe("done");                 // still encoding -> not finalized
    expect(read().film_finish_polls?.[FF0_KEY]).toBe("tok-ff0"); // token persisted for the next tick
    expect(r?.job.film_finish?.applied ?? []).toEqual([]); // nothing folded yet
    expect(r?.job.film_key).toBe(MUX_KEY);                 // assembled key kept (stable deterministic base)
  });

  it("polls across ticks and finalizes to the carded film once the job COMPLETES", async () => {
    const { env, read } = asyncEnv(2); // completes on the 2nd poll
    await advanceFilmJob(env, FILM_ID);          // tick 1: submit -> pending
    let doc = read();
    expect(doc.phase).not.toBe("done");
    await advanceFilmJob(env, FILM_ID);          // tick 2: poll #1 -> still pending
    doc = read();
    expect(doc.phase).not.toBe("done");
    expect(doc.film_finish_polls?.[FF0_KEY]).toBe("tok-ff0"); // token retained while pending
    const r = await advanceFilmJob(env, FILM_ID); // tick 3: poll #2 -> completed
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_finish?.applied).toEqual(["film-titles"]);
    expect(r?.job.film_finish?.degraded).toBeUndefined();
    expect(r?.job.film_key).toBe(FF0_KEY);       // finalized to the carded film
    expect(read().film_finish_polls?.[FF0_KEY]).toBeUndefined(); // token cleared on completion
  });

  it("a container job FAILURE (poll ok:false) re-dispatches, then soft-degrades -- ships UNCARDED, never fails", async () => {
    _resetModuleDiscoveryCache();
    const job = {
      film_id: FILM_ID, project: "p", scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
      phase: "mux" as const, silent_film_key: `renders/${FILM_ID}/film-silent.mp4`,
      audio_key: `renders/${FILM_ID}/audio.mp4`, mux_output_key: MUX_KEY,
      film_titles: { title: { text: "NEON HALFLIFE" } }, created_at: 0,
    };
    let stored = JSON.stringify(job);
    const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const env = {
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey(FILM_ID) ? { text: async () => stored } : null),
        head: async () => null,
        put: async (key: string, val: string) => { if (key === filmJobDocKey(FILM_ID)) stored = val; },
      },
      VIDEO_FINISH_VPC: { fetch: async () => j({ ok: true, key: MUX_KEY }) },
      MODULE_FILM_TITLES: {
        fetch: async (input: Request | string) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.endsWith("/module.json")) return j(MANIFEST);
          if (url.endsWith("/poll")) return j({ ok: false, error: "container job failed: ffmpeg boom" });
          return j({ ok: true, pending: true, poll: "tok-ff0" });
        },
      },
      R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
    } as unknown as Env;
    // Drive enough ticks to exhaust the bounded re-dispatch (submit + poll-fail per attempt), then degrade.
    let last: Awaited<ReturnType<typeof advanceFilmJob>> = null;
    for (let i = 0; i < 12; i++) { last = await advanceFilmJob(env, FILM_ID); if (last?.job.phase === "done") break; }
    expect(last?.job.phase).toBe("done");                       // fail-safe: the film STILL ships (#190)
    expect(last?.job.film_key).toBe(MUX_KEY);                   // uncarded (the assembled film), never dropped
    expect(last?.job.film_finish?.degraded).toContain("ffmpeg boom"); // the miss is OBSERVABLE, not silent
  });
});

describe("advanceFilmJob dialogue phase injects audio_key into finish (talking characters)", () => {
  const job = {
    film_id: "film-dlg-1",
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
    phase: "dialogue" as const,
    clips_only: true, // stop after finish -> done (skip assemble), so the tick ends cleanly
    dialogue_poll: "tok",
    dialogue_lines: [{ shot_id: "shot_01", text: "We're here.", voice_id: "orion" }],
    finish_shots: [{ shot_id: "shot_01", clip_key: "renders/p/clips/shot_01.mp4", chain: ["MODULE_LIPSYNC"], idx: 0, status: "pending" as const, applied: [] }],
  };

  function dialogueEnv() {
    const finishInputs: unknown[] = [];
    const env = {
      DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey("film-dlg-1") ? { text: async () => JSON.stringify(job) } : null),
        head: async () => null,
        put: async () => {},
        list: async () => ({ objects: [] }),
      },
      MODULE_DIALOGUE: moduleFetcher(
        { name: "dialogue-gen", version: "0.1.0", api: "vivijure-module/2", hooks: ["dialogue"], ui: { order: 10 } },
        { poll: () => ({ ok: true, output: { project: "p", audio: [{ shot_id: "shot_01", audio_key: "renders/p/dialogue/shot_01.wav", voice_id: "orion" }], applied: ["dialogue:@cf/deepgram/aura-1", "lines:1"] } }) },
      ),
      MODULE_LIPSYNC: moduleFetcher(
        { name: "finish-lipsync", version: "0.1.0", api: "vivijure-module/2", hooks: ["finish"], ui: { section: "finish", order: 15 } },
        { invoke: (body) => { finishInputs.push((body as { input: unknown }).input); return { ok: true, output: { shot_id: "shot_01", clip_key: "renders/p/clips/shot_01_ls.mp4", out_fps: 16, frames: 48, applied: ["lipsync:v15"] } }; } },
      ),
    } as unknown as Env;
    return { env, finishInputs };
  }

  it("polls dialogue -> records the audio map -> finish receives the shot's audio_key", async () => {
    const { env, finishInputs } = dialogueEnv();
    const r = await advanceFilmJob(env, "film-dlg-1");
    // dialogue audio recorded on the job
    expect(r?.job.dialogue_audio).toEqual({ shot_01: "renders/p/dialogue/shot_01.wav" });
    // the finish (lip-sync) module was invoked WITH that audio_key -- the whole point
    expect(finishInputs.length).toBe(1);
    expect((finishInputs[0] as { audio_key?: string }).audio_key).toBe("renders/p/dialogue/shot_01.wav");
    // #583: the core computed + forwarded the opaque provenance hash (finishStepInputHash) on the invoke
    // input. This env HEADs null, so the etags are null; the config is undefined (this shot has none).
    const oh = (finishInputs[0] as { output_hash?: string }).output_hash;
    expect(oh).toBe(await finishStepInputHash(null, null, undefined));
    // clips_only -> after finish the shard is done
    expect(r?.job.phase).toBe("done");
  });
});

describe("masteredBedKey (core presigns the PUT for this key)", () => {
  it("inserts _mastered.wav before the extension, beside the source (original survives)", () => {
    expect(masteredBedKey("renders/neon/audio/bed.wav")).toBe("renders/neon/audio/bed_mastered.wav");
  });
  it("defaults to .wav, and follows the requested format so the PUT key matches what the container writes", () => {
    expect(masteredBedKey("renders/neon/audio/bed.mp3")).toBe("renders/neon/audio/bed_mastered.wav");
    expect(masteredBedKey("renders/neon/audio/bed.wav", "mp3")).toBe("renders/neon/audio/bed_mastered.mp3");
    expect(masteredBedKey("renders/neon/audio/bed.wav", "wav")).toBe("renders/neon/audio/bed_mastered.wav");
  });
  it("appends when there is no extension, and ignores a dot in the path", () => {
    expect(masteredBedKey("renders/neon/audio/bed")).toBe("renders/neon/audio/bed_mastered.wav");
    expect(masteredBedKey("a.b/audio/bed")).toBe("a.b/audio/bed_mastered.wav");
  });
  it("is deterministic so a transient-retry re-PUT overwrites (never orphans a key)", () => {
    expect(masteredBedKey("renders/x/audio/bed.wav")).toBe(masteredBedKey("renders/x/audio/bed.wav"));
  });
});

const masterState = (over: Partial<MasterState> = {}): MasterState => ({
  chain: ["MODULE_AUDIO_MASTER"], idx: 0, applied: [], degraded: [], ...over,
});

describe("master chain fold (applyMasterOutput / degradeMasterStep)", () => {
  it("single-step chain: folds the mastered bed, accumulates applied, advances to done", () => {
    const m = masterState();
    const next = applyMasterOutput(m, "audio/bed.wav", {
      audio_key: "audio/bed_mastered.wav", applied: ["music-upscale:soxr48k", "loudnorm:-14LUFS"],
    });
    expect(next).toBe("audio/bed_mastered.wav");
    expect(m.applied).toEqual(["music-upscale:soxr48k", "loudnorm:-14LUFS"]);
    expect(m.idx).toBe(1);
    expect(m.poll).toBeUndefined();
    expect(m.attempts).toBe(0);
    expect(masterChainDone(m)).toBe(true);
  });

  it("multi-step chain: each step chains the previous bed and stays not-done until exhausted", () => {
    const m = masterState({ chain: ["MODULE_A", "MODULE_B"] });
    const afterA = applyMasterOutput(m, "audio/bed.wav", { audio_key: "audio/bed_a.wav", applied: ["a:1"] });
    expect(afterA).toBe("audio/bed_a.wav");
    expect(m.idx).toBe(1);
    expect(masterChainDone(m)).toBe(false);
    const afterB = applyMasterOutput(m, afterA, { audio_key: "audio/bed_b.wav", applied: ["b:1"] });
    expect(afterB).toBe("audio/bed_b.wav");
    expect(m.idx).toBe(2);
    expect(m.applied).toEqual(["a:1", "b:1"]);
    expect(masterChainDone(m)).toBe(true);
  });

  it("a module soft-degrade (ok:true + output.degraded) carries the bed through and is recorded, never silent", () => {
    const m = masterState();
    const next = applyMasterOutput(m, "audio/bed.wav", {
      audio_key: "audio/bed.wav", applied: ["passthrough:no-runpod-secrets"], degraded: "no-runpod-secrets",
    });
    expect(next).toBe("audio/bed.wav"); // unchanged bed
    expect(m.degraded).toEqual(["MODULE_AUDIO_MASTER: no-runpod-secrets"]);
    expect(m.applied).toEqual(["passthrough:no-runpod-secrets"]);
  });

  it("an empty audio_key from a module keeps the prior bed (never drops it)", () => {
    const m = masterState();
    const next = applyMasterOutput(m, "audio/bed.wav", { audio_key: "", applied: [] });
    expect(next).toBe("audio/bed.wav");
    expect(m.idx).toBe(1);
  });

  it("degradeMasterStep passes the bed through, records the reason against the step, advances", () => {
    const m = masterState({ chain: ["MODULE_A", "MODULE_B"], idx: 1, poll: "tok", attempts: 2 });
    degradeMasterStep(m, "module not bound");
    expect(m.degraded).toEqual(["MODULE_B: module not bound"]);
    expect(m.idx).toBe(2);
    expect(m.poll).toBeUndefined();
    expect(m.attempts).toBe(0);
    expect(masterChainDone(m)).toBe(true);
  });
});

describe("filmSeconds (master length hint)", () => {
  it("sums scene durations", () => {
    expect(filmSeconds({ scenes: [{ shot_id: "s1", prompt: "", seconds: 3 }, { shot_id: "s2", prompt: "", seconds: 4 }] })).toBe(7);
  });
  it("is undefined when there are no durations", () => {
    expect(filmSeconds({ scenes: [] })).toBeUndefined();
    expect(filmSeconds({ scenes: [{ shot_id: "s1", prompt: "", seconds: 0 }] })).toBeUndefined();
  });
});

describe("master constants", () => {
  it("bounds step retries and the stall ceiling", () => {
    expect(MASTER_STEP_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MASTER_STALL_SECONDS).toBeGreaterThan(0);
  });
});

// End-to-end master phase: advanceFilmJob drives a `master` module over the audio bed (after assemble,
// before mux), folds the mastered bed back into job.audio_key, then muxes. FAIL-SAFE: a master miss
// passes the bed through and STILL muxes -- the render never fails on a polish step (#249 / #77).
function masterEnv(
  job: FilmJob,
  invokeResponses: Array<{ status?: number; body?: object }>,
  pollResponses: Array<{ status?: number; body?: object }> = [],
) {
  const filmDoc = filmJobDocKey(job.film_id);
  let stored = JSON.stringify(job);
  let invokeCall = 0, pollCall = 0;
  const vpcCalls: string[] = [];
  const env = {
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
    R2_RENDERS: {
      get: async (k: string) => (k === filmDoc ? { text: async () => stored } : null),
      put: async (k: string, b: string) => { if (k === filmDoc) stored = b; },
      head: async () => null,
      list: async () => ({ objects: [], truncated: false }),
    },
    // The master module: 404 on /module.json (so the film.finish/notify discovery in transitionToDone
    // skips it -- it is not those hooks), and a scripted /invoke + /poll for the master chain.
    MODULE_AUDIO_MASTER: {
      fetch: async (url: string) => {
        const u = String(url);
        if (u.includes("/module.json")) return new Response("not found", { status: 404 });
        if (u.includes("/invoke")) {
          const r = invokeResponses[Math.min(invokeCall, invokeResponses.length - 1)]; invokeCall += 1;
          return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
        }
        if (u.includes("/poll")) {
          const r = pollResponses[Math.min(pollCall, pollResponses.length - 1)]; pollCall += 1;
          return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 404 });
      },
    },
    VIDEO_FINISH_VPC: { fetch: async (input: Request | string) => { vpcCalls.push(typeof input === "string" ? input : input.url); return new Response(JSON.stringify({ ok: true, key: "renders/film-master/muxed.mp4" }), { status: 200, headers: { "content-type": "application/json" } }); } },
    R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
    R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
  } as unknown as Env;
  return { env, vpcCalls, read: () => JSON.parse(stored) as FilmJob };
}

const masterJob = (): FilmJob => ({
  film_id: "film-master", project: "neon", bundle_key: "b",
  scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
  motion_backend: "own-gpu", motion_config: {}, finish_config: {},
  keyframe_binding: null, phase: "master",
  silent_film_key: "renders/film-master/film.mp4",
  audio_key: "renders/neon/audio/bed.wav",
  master: { chain: ["MODULE_AUDIO_MASTER"], idx: 0, applied: [], degraded: [] },
  created_at: Date.now(),
});

describe("advanceFilmJob master phase (pre-mux audio mastering)", () => {
  it("a synchronous master folds the mastered bed, records applied, then muxes -> done", async () => {
    const { env, vpcCalls, read } = masterEnv(masterJob(), [
      { body: { ok: true, output: { audio_key: "renders/neon/audio/bed_mastered.wav", applied: ["music-upscale:soxr48k", "loudnorm:-14LUFS"] } } },
    ]);
    const r = await advanceFilmJob(env, "film-master");
    const job = read();
    expect(job.audio_key).toBe("renders/neon/audio/bed_mastered.wav"); // the MASTERED bed is what gets muxed
    expect(job.master?.applied).toEqual(["music-upscale:soxr48k", "loudnorm:-14LUFS"]);
    expect(job.master?.degraded).toEqual([]);
    expect(vpcCalls.length).toBe(1);     // the mux ran (with the mastered bed)
    expect(r?.job.phase).toBe("done");
  });

  it("an async master parks on its poll token (tick 1), then folds + muxes on completion (tick 2)", async () => {
    const { env, vpcCalls, read } = masterEnv(
      masterJob(),
      [{ body: { ok: true, pending: true, poll: "tok-1" } }],
      [{ body: { ok: true, output: { audio_key: "renders/neon/audio/bed_mastered.wav", applied: ["loudnorm:-14LUFS"] } } }],
    );
    await advanceFilmJob(env, "film-master");
    const mid = read();
    expect(mid.phase).toBe("master");                 // still mastering
    expect(mid.master?.poll).toBe("tok-1");
    expect(mid.audio_key).toBe("renders/neon/audio/bed.wav"); // bed not yet rewritten
    expect(vpcCalls.length).toBe(0);                  // mux not reached yet
    const r2 = await advanceFilmJob(env, "film-master");
    const done = read();
    expect(done.audio_key).toBe("renders/neon/audio/bed_mastered.wav");
    expect(vpcCalls.length).toBe(1);
    expect(r2?.job.phase).toBe("done");
  });

  it("a module soft-degrade (ok:true + passthrough) muxes the ORIGINAL bed, records the reason, never fails", async () => {
    const { env, vpcCalls, read } = masterEnv(masterJob(), [
      { body: { ok: true, output: { audio_key: "renders/neon/audio/bed.wav", applied: ["passthrough:no-runpod-secrets"], degraded: "no-runpod-secrets" } } },
    ]);
    const r = await advanceFilmJob(env, "film-master");
    const job = read();
    expect(job.audio_key).toBe("renders/neon/audio/bed.wav");          // UNCHANGED original bed
    expect(job.master?.degraded).toEqual(["MODULE_AUDIO_MASTER: no-runpod-secrets"]);
    expect(vpcCalls.length).toBe(1);                                   // STILL muxed (never dropped)
    expect(r?.job.phase).toBe("done");                                 // NOT failed
  });

  it("a terminal master failure (HTTP 400) degrades to passthrough and STILL muxes -> done (never fails the render)", async () => {
    const { env, vpcCalls, read } = masterEnv(masterJob(), [
      { status: 400, body: { ok: false, error: "bad request" } },
    ]);
    const r = await advanceFilmJob(env, "film-master");
    const job = read();
    expect(job.audio_key).toBe("renders/neon/audio/bed.wav");          // original bed muxed
    expect(job.master?.degraded?.[0]).toMatch(/invoke failed/);
    expect(vpcCalls.length).toBe(1);
    expect(r?.job.phase).toBe("done");
    expect(r?.job.phase).not.toBe("failed");
  });
});

describe("advanceFilmJob speech phase: dialogue -> speech (clean audio) -> finish lip-syncs the CLEANED audio", () => {
  const job = {
    film_id: "film-speech-1",
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
    phase: "dialogue" as const,
    clips_only: true, // stop after finish -> done (skip assemble), so the tick ends cleanly
    dialogue_poll: "tok",
    dialogue_lines: [{ shot_id: "shot_01", text: "We're here.", voice_id: "orion" }],
    finish_shots: [{ shot_id: "shot_01", clip_key: "renders/p/clips/shot_01.mp4", chain: ["MODULE_LIPSYNC"], idx: 0, status: "pending" as const, applied: [] }],
  };

  function speechEnv() {
    const finishInputs: unknown[] = [];
    const speechInputs: unknown[] = [];
    const env = {
      DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey("film-speech-1") ? { text: async () => JSON.stringify(job) } : null),
        head: async () => null,
        put: async () => {},
        list: async () => ({ objects: [] }),
      },
      MODULE_DIALOGUE: moduleFetcher(
        { name: "dialogue-gen", version: "0.1.0", api: "vivijure-module/2", hooks: ["dialogue"], ui: { order: 10 } },
        { poll: () => ({ ok: true, output: { project: "p", audio: [{ shot_id: "shot_01", audio_key: "renders/p/dialogue/shot_01.wav", voice_id: "orion" }], applied: ["dialogue:aura-1"] } }) },
      ),
      MODULE_SPEECH_UPSCALE: moduleFetcher(
        { name: "speech-upscale", version: "0.1.0", api: "vivijure-module/2", hooks: ["speech"], config_schema: { enable: { type: "bool", default: false } }, ui: { section: "speech", order: 10 } },
        { invoke: (body) => { speechInputs.push((body as { input: unknown }).input); return { ok: true, output: { shot_id: "shot_01", audio_key: "renders/p/dialogue/shot_01_enh.wav", applied: ["speech-upscale:resemble-enhance"] } }; } },
      ),
      MODULE_LIPSYNC: moduleFetcher(
        { name: "finish-lipsync", version: "0.1.0", api: "vivijure-module/2", hooks: ["finish"], ui: { section: "finish", order: 15 } },
        { invoke: (body) => { finishInputs.push((body as { input: unknown }).input); return { ok: true, output: { shot_id: "shot_01", clip_key: "renders/p/clips/shot_01_ls.mp4", out_fps: 16, frames: 48, applied: ["lipsync:v15"] } }; } },
      ),
    } as unknown as Env;
    return { env, finishInputs, speechInputs };
  }

  it("speech module enhances the dialogue audio; lip-sync then drives off the CLEANED key", async () => {
    const { env, finishInputs, speechInputs } = speechEnv();
    const r = await advanceFilmJob(env, "film-speech-1");
    // the speech module received the ORIGINAL dialogue audio to enhance
    expect(speechInputs.length).toBe(1);
    expect((speechInputs[0] as { audio_key?: string }).audio_key).toBe("renders/p/dialogue/shot_01.wav");
    // dialogue_audio was rewritten to the ENHANCED key
    expect(r?.job.dialogue_audio).toEqual({ shot_01: "renders/p/dialogue/shot_01_enh.wav" });
    // lip-sync (finish) received the ENHANCED audio_key -- the whole point of inserting the speech phase
    expect(finishInputs.length).toBe(1);
    expect((finishInputs[0] as { audio_key?: string }).audio_key).toBe("renders/p/dialogue/shot_01_enh.wav");
    expect(r?.job.phase).toBe("done");
  });
});

// #14: with TWO film.finish modules chained (subtitle ui.order=5, then film-titles ui.order=10), the
// shared dispatchChain used to reuse ONE presigned GET/PUT pair for the whole chain, so step 2 re-read
// the ORIGINAL film and overwrote step 1's output (captions lost). The fix presigns a FRESH GET (of the
// PRIOR step's output) + PUT per serving step, so step 2 reads what step 1 wrote.
describe("advanceFilmJob film.finish chain: step 2 reads step 1's OUTPUT, not the original (#14)", () => {
  type FFInput = { film_key?: string; video_url?: string; output_key?: string; output_url?: string };
  const filmFinishJob = (): FilmJob => ({
    film_id: "film-ff", project: "neon", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    motion_backend: "own-gpu", motion_config: {}, finish_config: {},
    keyframe_binding: null, phase: "mux",
    silent_film_key: "renders/neon/film.mp4",
    // audio_key UNDEFINED: enterMuxPhase short-circuits (film_key = silent_film_key) straight to
    // transitionToDone -> applyFilmFinish, so the film.finish chain runs without the mux VPC.
    created_at: Date.now(),
  });

  function filmFinishEnv(job: FilmJob) {
    const filmDoc = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    const subtitleInputs: FFInput[] = [];
    const titlesInputs: FFInput[] = [];
    // Each fake film.finish module returns the key it was told to write to (its `output_key`), exactly
    // as a real module does after writing the carded film there.
    const ffModule = (name: string, order: number, sink: FFInput[], tag: string) => moduleFetcher(
      { name, version: "0.1.0", api: "vivijure-module/2", hooks: ["film.finish"], ui: { section: "film.finish", order } },
      { invoke: (body) => { const inp = (body as { input: FFInput }).input; sink.push(inp); return { ok: true, output: { film_key: inp.output_key, applied: [tag] } }; } },
    );
    const env = {
      DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
      R2_RENDERS: {
        get: async (k: string) => (k === filmDoc ? { text: async () => stored } : null),
        put: async (k: string, b: string) => { if (k === filmDoc) stored = b; },
        head: async () => null,
        list: async () => ({ objects: [], truncated: false }),
      },
      MODULE_SUBTITLE: ffModule("subtitle", 5, subtitleInputs, "subtitle:burned"),
      MODULE_FILM_TITLES: ffModule("film-titles", 10, titlesInputs, "titles:cards"),
      R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
    } as unknown as Env;
    return { env, subtitleInputs, titlesInputs, read: () => JSON.parse(stored) as FilmJob };
  }

  it("step 1 reads the original film; step 2 reads step 1's output (captions survive the title cards)", async () => {
    const { env, subtitleInputs, titlesInputs, read } = filmFinishEnv(filmFinishJob());
    const r = await advanceFilmJob(env, "film-ff");

    expect(subtitleInputs.length).toBe(1);
    expect(titlesInputs.length).toBe(1);

    // Step 1 (subtitle) reads the ORIGINAL muxed film.
    expect(subtitleInputs[0].video_url).toContain("/renders/neon/film.mp4?");
    const step1Out = subtitleInputs[0].output_key!; // the key step 1 wrote (and returned as film_key)

    // Step 2 (film-titles) MUST read step 1's OUTPUT, not the original (the #14 regression).
    expect(titlesInputs[0].film_key).toBe(step1Out);
    expect(titlesInputs[0].video_url).toContain(step1Out);
    expect(titlesInputs[0].video_url).not.toContain("/renders/neon/film.mp4?");
    // And step 2 writes to a FRESH key (its own presigned PUT), distinct from step 1's.
    expect(titlesInputs[0].output_key).not.toBe(step1Out);

    // The film ends on the LAST step's output, and the chain recorded both modules.
    const done = read();
    expect(done.film_key).toBe(titlesInputs[0].output_key);
    expect(done.film_finish?.applied).toEqual(["subtitle", "film-titles"]);
    expect(r?.job.phase).toBe("done");
  });
});

describe("filmProgressMarker (#136 progress fingerprint)", () => {
  const base: FilmJob = {
    film_id: "f", project: "p", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }, { shot_id: "shot_02", prompt: "b", seconds: 4 }],
    motion_backend: "own-gpu", motion_config: {}, finish_config: {}, keyframe_binding: null,
    phase: "clips", created_at: 0,
  };

  it("clips: counts done clip shots in the marker", () => {
    const clipJob = { shots: [{ status: "done" }, { status: "pending" }] } as unknown as Parameters<typeof filmProgressMarker>[1];
    expect(filmProgressMarker({ ...base, phase: "clips" }, clipJob)).toBe("clips:1");
  });

  it("clips: marker advances as more shots finish (monotonic forward progress)", () => {
    const one = { shots: [{ status: "done" }, { status: "pending" }] } as unknown as Parameters<typeof filmProgressMarker>[1];
    const two = { shots: [{ status: "done" }, { status: "done" }] } as unknown as Parameters<typeof filmProgressMarker>[1];
    expect(filmProgressMarker({ ...base }, one)).not.toBe(filmProgressMarker({ ...base }, two));
    expect(filmProgressMarker({ ...base }, two)).toBe("clips:2");
  });

  it("finish: counts done finish shots", () => {
    const job: FilmJob = {
      ...base, phase: "finish",
      finish_shots: [
        { shot_id: "shot_01", clip_key: "k1", chain: ["M"], idx: 0, status: "done", applied: [] },
        { shot_id: "shot_02", clip_key: "k2", chain: ["M"], idx: 0, status: "pending", applied: [] },
      ] as FinishShot[],
    };
    expect(filmProgressMarker(job, null)).toBe("finish:1");
  });

  it("a phase with no per-shot fan-out reports :0 (stall window runs from phase start, as before)", () => {
    expect(filmProgressMarker({ ...base, phase: "keyframe" }, null)).toBe("keyframe:0");
    expect(filmProgressMarker({ ...base, phase: "assemble" }, null)).toBe("assemble:0");
  });
});

describe("advanceFilmJob re-stamps last_progress_at on a tick (#136)", () => {
  const film = (): FilmJob => ({
    film_id: "film-136-stamp", project: "neon", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    motion_backend: "own-gpu", motion_config: {}, finish_config: {}, keyframe_binding: null,
    phase: "finish", clips_only: true,
    finish_shots: [
      { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4", chain: ["MODULE_FINISH_RIFE"], configs: [{}], idx: 0, status: "done", applied: [] },
    ] as FinishShot[],
    created_at: Date.now() - 60_000,
  });

  it("sets last_progress_at + progress_marker after advancing", async () => {
    const job = film();
    const filmDoc = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    const env = {
      R2_RENDERS: {
        get: async (k: string) => (k === filmDoc ? { text: async () => stored } : null),
        put: async (k: string, b: string) => { if (k === filmDoc) stored = b; },
        list: async () => ({ objects: [], truncated: false }),
      },
    } as unknown as Env;
    await advanceFilmJob(env, job.film_id);
    const after = JSON.parse(stored) as FilmJob;
    expect(typeof after.last_progress_at).toBe("number");
    expect(typeof after.progress_marker).toBe("string");
    expect(after.last_progress_at as number).toBeGreaterThan(job.created_at);
  });
});

describe("advanceFinishPhase: mid-chain R2 adoption (#209 -- the FAC shot_03 incident)", () => {
  // The exact #209 reliability gap: a finish shot stuck PENDING at a NON-LAST chain module (RIFE at
  // idx 0 of [RIFE, FINISH_STUB]) whose RunPod envelope froze at IN_PROGRESS, but whose RIFE output
  // IS in R2. The orchestrator must adopt the intermediate from R2 (advance idx, set clip_key, clear
  // poll) so the chain proceeds to the finish stub -- not hang to the 90min ceiling and false-fail.
  const midChainFilm = (): FilmJob => ({
    film_id: "film-209", project: "fac", bundle_key: "b",
    scenes: [{ shot_id: "shot_03", prompt: "a", seconds: 4 }],
    motion_backend: "own-gpu", motion_config: {}, finish_config: {},
    keyframe_binding: null, phase: "finish", clips_only: true,
    finish_shots: [
      { shot_id: "shot_03", clip_key: "renders/fac/clips/shot_03_i2v.mp4",
        chain: ["MODULE_FINISH_RIFE", "MODULE_FINISH_STUB"], configs: [{}, {}], idx: 0,
        status: "pending", applied: [], poll: "tok-frozen", error: undefined },
    ] as FinishShot[],
    created_at: Date.now(),
  });

  function env209(job: FilmJob, headPresent: Set<string>, sidecars: Record<string, string> = {}) {
    const filmDoc = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    const env = {
      R2_RENDERS: {
        get: async (k: string) => (k === filmDoc ? { text: async () => stored } : (k in sidecars ? { text: async () => sidecars[k] } : null)),
        put: async (k: string, b: string) => { if (k === filmDoc) stored = b; },
        head: async (k: string) => (headPresent.has(k) ? { key: k } : null),
        list: async () => ({ objects: [], truncated: false }),
      },
      // RIFE module's RunPod envelope is frozen: every poll pends forever.
      MODULE_FINISH_RIFE: {
        fetch: async (url: string) =>
          String(url).includes("/poll")
            ? new Response(JSON.stringify({ ok: true, pending: true }), { status: 200, headers: { "content-type": "application/json" } })
            : new Response("{}", { status: 404 }),
      },
    } as unknown as Env;
    return { env, read: () => JSON.parse(stored) as FilmJob };
  }

  it("adopts the RIFE intermediate from R2 and advances idx (does NOT hang on a frozen envelope)", async () => {
    const scHash = await finishStepInputHash(null, null, {}); // #583 gate: matching sidecar
    const { env, read } = env209(midChainFilm(), new Set(["renders/fac/clips/shot_03_finished.mp4"]),
      { "renders/fac/clips/shot_03_finished.mp4.hash": scHash });
    await advanceFilmJob(env, "film-209");
    const fs = read().finish_shots?.find((f) => f.shot_id === "shot_03");
    expect(fs?.idx).toBe(1); // advanced off RIFE -> the finish stub
    expect(fs?.clip_key).toBe("renders/fac/clips/shot_03_finished.mp4"); // now feeding the finish stub
    expect(fs?.poll).toBeUndefined(); // frozen poll cleared
    expect(fs?.applied ?? []).not.toContain("interpolate:2x"); // #583: adopted, NOT run -> never a fake applied-run tag
    expect(fs?.adopted).toContain("interpolate:2x"); // RIFE's reconstructed tag, disclosed in the `adopted` channel
    expect(fs?.status).toBe("pending"); // still pending: the finish stub (idx 1) has yet to run
  });

  it("#583 gate: does NOT adopt the mid-chain artifact with NO sidecar -- stays pending, never advances on a legacy artifact", async () => {
    const { env, read } = env209(midChainFilm(), new Set(["renders/fac/clips/shot_03_finished.mp4"])); // no sidecar
    await advanceFilmJob(env, "film-209");
    const fs = read().finish_shots?.find((f) => f.shot_id === "shot_03");
    expect(fs?.idx).toBe(0);            // NOT advanced off RIFE
    expect(fs?.status).toBe("pending"); // stays pending (frozen poll), never adopts an unstamped artifact
  });

  it("#583 gate: does NOT adopt the mid-chain artifact when the sidecar MISMATCHES the current inputs", async () => {
    const { env, read } = env209(midChainFilm(), new Set(["renders/fac/clips/shot_03_finished.mp4"]),
      { "renders/fac/clips/shot_03_finished.mp4.hash": "0".repeat(64) }); // stale hash
    await advanceFilmJob(env, "film-209");
    const fs = read().finish_shots?.find((f) => f.shot_id === "shot_03");
    expect(fs?.idx).toBe(0);
    expect(fs?.status).toBe("pending");
  });

  it("stays pending (does NOT adopt) when the RIFE intermediate is NOT in R2 -- no phantom advance", async () => {
    const { env, read } = env209(midChainFilm(), new Set()); // nothing in R2
    await advanceFilmJob(env, "film-209");
    const fs = read().finish_shots?.find((f) => f.shot_id === "shot_03");
    expect(fs?.idx).toBe(0); // not advanced
    expect(fs?.status).toBe("pending");
  });
});

// #211 follow-up: the film.finish outcome is canonical user-affecting state, so it must ride the
// structured API channel (summarizeFilm), not just the persisted job -- the frontend shows honest
// degrade state from it.
describe("summarizeFilm surfaces film_finish (#211 follow-up)", () => {
  const base = {
    film_id: "film-sum", project: "p", scenes: [], phase: "done" as const,
    film_key: "renders/film-sum/film-titled.mp4", created_at: 0,
  };
  it("includes film_finish when present (applied, degraded unset)", () => {
    const job = { ...base, film_finish: { applied: ["film-titles"], errors: [], steps: ["film-titles"] } } as unknown as FilmJob;
    const sum = summarizeFilm(job, null);
    expect(sum.film_finish).toEqual({ applied: ["film-titles"], errors: [], steps: ["film-titles"] });
    expect(sum.film_finish?.degraded).toBeUndefined();
  });
  it("carries the degraded reason so a card-less ship is visible", () => {
    const job = { ...base, film_finish: { applied: ["film-titles"], errors: [], degraded: "film-titles: passthrough:container-unreachable" } } as unknown as FilmJob;
    expect(summarizeFilm(job, null).film_finish?.degraded).toBe("film-titles: passthrough:container-unreachable");
  });
  it("omits film_finish when the chain never ran", () => {
    expect(summarizeFilm(base as unknown as FilmJob, null).film_finish).toBeUndefined();
  });
});

describe("summarizeFilm surfaces delivered-vs-planned clip durations (#707)", () => {
  const base = {
    film_id: "film-707", project: "p", scenes: [], phase: "clips" as const, created_at: 0,
  };
  const cj = (shots: object[]): ClipJobLike => ({
    job_id: "j707", project: "p", motion_backend: "local-gpu", binding: "B", shots, created_at: 0,
  } as ClipJobLike);

  it("carries the distilled tier-honesty flag on a delivery entry when the shot has one (#705)", () => {
    const clipJob = cj([
      { shot_id: "shot_01", seconds: 5, status: "done", clip_key: "k1", delivered_fps: 24, delivered_frames: 120, distilled: true },
      { shot_id: "shot_02", seconds: 5, status: "done", clip_key: "k2", delivered_fps: 24, delivered_frames: 120 },
    ]);
    const sum = summarizeFilm(base as unknown as FilmJob, clipJob as never);
    expect(sum.clip_deliveries?.[0].distilled).toBe(true);
    expect(sum.clip_deliveries?.[1]).not.toHaveProperty("distilled"); // absence stays absent
  });

  it("reports planned vs delivered per done shot with backend-reported fps+frames", () => {
    const clipJob = cj([
      // a 5s plan clamped by a fixed-grid backend: 25f @ 8fps = 3.125s
      { shot_id: "shot_01", seconds: 5, status: "done", clip_key: "k1", delivered_fps: 8, delivered_frames: 25 },
      // a shot still pending contributes nothing
      { shot_id: "shot_02", seconds: 5, status: "pending" },
      // a done shot whose backend reported no numbers contributes nothing (absence over fabrication)
      { shot_id: "shot_03", seconds: 5, status: "done", clip_key: "k3" },
    ]);
    const sum = summarizeFilm(base as unknown as FilmJob, clipJob as never);
    expect(sum.clip_deliveries).toEqual([
      { shot_id: "shot_01", planned_seconds: 5, delivered_seconds: 3.125, fps: 8, frames: 25 },
    ]);
  });

  it("omits clip_deliveries entirely when no shot reported durations", () => {
    const clipJob = cj([{ shot_id: "shot_01", seconds: 5, status: "done", clip_key: "k1" }]);
    expect(summarizeFilm(base as unknown as FilmJob, clipJob as never).clip_deliveries).toBeUndefined();
  });

  it("omits clip_deliveries with no clip job at all", () => {
    expect(summarizeFilm(base as unknown as FilmJob, null).clip_deliveries).toBeUndefined();
  });
});

describe("finish_artifacts: contract-carried conventions beat the legacy name-derived fallback (S6)", () => {
  const fs = (over: Partial<FinishShot>): FinishShot => ({
    shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4",
    chain: [], configs: [], idx: 0, status: "pending", applied: [], ...over,
  } as FinishShot);
  const mod = (binding: string, finish_artifacts: unknown) =>
    ({ name: binding.toLowerCase(), binding, hooks: ["finish"], finish_artifacts }) as any;

  it("shot_named declaration predicts renders/<project>/clips/<shot><filename>", () => {
    const modules = [mod("MODULE_X_SMOOTH", { output_key: { kind: "shot_named", filename: "_smooth.mp4" } })];
    expect(finishStepOutputKey("neon", fs({ chain: ["MODULE_X_SMOOTH"] }), modules))
      .toBe("renders/neon/clips/shot_01_smooth.mp4");
  });

  it("append_suffix declaration inserts before the input key's extension", () => {
    const modules = [mod("MODULE_X_DENOISE", { output_key: { kind: "append_suffix", suffix: "_dn" } })];
    expect(finishStepOutputKey("neon", fs({ chain: ["MODULE_X_DENOISE"] }), modules))
      .toBe("renders/neon/clips/shot_01_i2v_dn.mp4");
  });

  it("the declaration WINS over the name fallback (an UPSCALE-named module can declare shot_named)", () => {
    const modules = [mod("MODULE_FINISH_UPSCALE", { output_key: { kind: "shot_named", filename: "_hires.mp4" } })];
    expect(finishStepOutputKey("neon", fs({ chain: ["MODULE_FINISH_UPSCALE"] }), modules))
      .toBe("renders/neon/clips/shot_01_hires.mp4");
  });

  it("no declaration + unmodeled name -> null (no R2 shortcut), and the legacy names still resolve", () => {
    const modules = [mod("MODULE_FINISH_STUB", undefined)];
    expect(finishStepOutputKey("neon", fs({ chain: ["MODULE_FINISH_STUB"] }), modules)).toBeNull();
    expect(finishStepOutputKey("neon", fs({ chain: ["MODULE_FINISH_RIFE"] }), modules))
      .toBe("renders/neon/clips/shot_01_finished.mp4");
  });

  it("applied rules: template {knob|default} + first-match-wins `when` gating", () => {
    const decl = {
      output_key: { kind: "shot_named", filename: "_finished.mp4" },
      applied: [
        { when: { knob: "interpolate", equals: false }, tag: "noop:interpolate-off" },
        { tag: "interpolate:{interpolation_factor|2}x" },
      ],
    };
    const modules = [mod("MODULE_X_RIFE", decl)];
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_X_RIFE"], configs: [{ interpolation_factor: 4 }] }), modules)).toBe("interpolate:4x");
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_X_RIFE"], configs: [{}] }), modules)).toBe("interpolate:2x");
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_X_RIFE"], configs: [{ interpolate: false }] }), modules)).toBe("noop:interpolate-off");
  });

  it("declared rules with NO match mark r2-adopted (never silent), and no-decl falls back to name rules", () => {
    const modules = [mod("MODULE_X_ODD", { output_key: { kind: "append_suffix", suffix: "_o" }, applied: [{ when: { knob: "on", equals: true }, tag: "on" }] })];
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_X_ODD"], configs: [{}] }), modules)).toBe("MODULE_X_ODD:r2-adopted");
    expect(finishStepAppliedTag(fs({ chain: ["MODULE_FINISH_LIPSYNC"], configs: [{ version: "v1" }] }), modules)).toBe("lipsync:v1");
  });
});

// --- #519: video-finish tier UNAVAILABLE degrades to a COMPLETED film with clips (never hard-fail) ---
// When VIDEO_FINISH_VPC is unbound, OR the finish container is unreachable at assemble/mux AFTER the
// bounded retry, the film must COMPLETE delivering what was rendered (per-shot clips at assemble, the
// silent film at mux) with a loud, structured status + a `film.finish_unavailable` event -- never a hard
// fail after the GPU spend. A GENUINE per-shot / container ERROR (the container ran and reported a real
// failure) still fails loud (#245/#249). Drives the real assemble/mux legs through advanceFilmJob.
describe("#519 video-finish UNAVAILABLE -> complete-with-clips degrade (vs #245/#249 hard-fail on a real error)", () => {
  // Env double parameterized on the VPC: absent (unbound), or bound with a chosen status/body. head()
  // returns null so the #122 R2-presence short-circuit never fires (there is no assembled film yet).
  function degradeEnv(job: object, opts: { vpc?: { status?: number; body?: unknown } } = {}) {
    const filmId = (job as { film_id: string }).film_id;
    let stored = JSON.stringify(job);
    const env: Record<string, unknown> = {
      DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
        head: async () => null,
        put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
      },
      R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
    };
    if (opts.vpc) {
      const { status = 200, body = { ok: true } } = opts.vpc;
      env.VIDEO_FINISH_VPC = { fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) };
    }
    return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob };
  }

  const asmJob = (over: object = {}) => ({
    film_id: "film-519-asm",
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }, { shot_id: "shot_02", prompt: "y", seconds: 3 }],
    phase: "assemble" as const,
    finish_shots: [
      { shot_id: "shot_01", clip_key: "renders/p/clips/shot_01_finished.mp4", chain: ["M"], idx: 1, status: "done" as const, applied: [] },
      { shot_id: "shot_02", clip_key: "renders/p/clips/shot_02_finished.mp4", chain: ["M"], idx: 1, status: "done" as const, applied: [] },
    ],
    created_at: 0,
    ...over,
  });

  const muxJob = (over: object = {}) => ({
    film_id: "film-519-mux",
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
    phase: "mux" as const,
    silent_film_key: "renders/film-519-mux/film-silent.mp4",
    audio_key: "renders/film-519-mux/audio.mp4",
    created_at: 0,
    ...over,
  });

  // Capture the structured film.finish_unavailable event off console.log.
  function captureEvent<T>(fn: () => Promise<T>): Promise<{ result: T; event: Record<string, unknown> | undefined }> {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    return fn().then((result) => {
      let event: Record<string, unknown> | undefined;
      for (const call of spy.mock.calls) {
        const line = call[0];
        if (typeof line !== "string") continue;
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          if (o.ev === "film.finish_unavailable") event = o;
        } catch { /* not a JSON event line */ }
      }
      spy.mockRestore();
      return { result, event };
    }).catch((e) => { spy.mockRestore(); throw e; });
  }

  it("assemble + VIDEO_FINISH_VPC UNBOUND -> COMPLETED delivering the per-shot clips, loud status + event", async () => {
    const { env, read } = degradeEnv(asmJob()); // no VIDEO_FINISH_VPC
    const { result: r, event } = await captureEvent(() => advanceFilmJob(env, "film-519-asm"));
    expect(r?.job.phase).toBe("done"); // NOT failed -- the clips are delivered
    expect(r?.job.finish_unavailable?.at).toBe("assemble");
    expect(r?.job.finish_unavailable?.delivered).toBe("clips");
    expect(r?.job.finish_unavailable?.clips?.map((c) => c.shot_id)).toEqual(["shot_01", "shot_02"]);
    expect(r?.job.film_key).toBeUndefined(); // there is no single assembled film
    // the degrade is a persisted, observable state (not a silent green)
    expect(read().finish_unavailable?.at).toBe("assemble");
    // and a loud structured event on the observability channel
    expect(event?.at).toBe("assemble");
    expect(event?.delivered).toBe("clips");
    expect(event?.clips).toBe(2);
  });

  it("assemble + container UNREACHABLE after the bounded retry -> same complete-with-clips degrade", async () => {
    // assemble_attempts at the cap-1 so this tick exhausts (502 is a transient gateway status, no backoff).
    const { env } = degradeEnv(asmJob({ assemble_attempts: 5 }), { vpc: { status: 502 } });
    const r = await advanceFilmJob(env, "film-519-asm");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable?.at).toBe("assemble");
    expect(r?.job.finish_unavailable?.delivered).toBe("clips");
    expect(r?.job.finish_unavailable?.clips?.length).toBe(2);
  });

  it("assemble + the container RAN and returned a real error (500) -> STILL FAILS LOUD (#245/#249)", async () => {
    const { env } = degradeEnv(asmJob(), { vpc: { status: 500, body: { ok: false, error: "ffmpeg concat boom" } } });
    const r = await advanceFilmJob(env, "film-519-asm");
    expect(r?.job.phase).toBe("failed"); // a genuine failure is NOT degraded
    expect(r?.job.error).toContain("500");
    expect(r?.job.finish_unavailable).toBeUndefined();
  });

  it("mux + VIDEO_FINISH_VPC UNBOUND -> COMPLETED shipping the SILENT film, loud status + event", async () => {
    const { env, read } = degradeEnv(muxJob()); // no VIDEO_FINISH_VPC, no film.finish/notify modules
    const { result: r, event } = await captureEvent(() => advanceFilmJob(env, "film-519-mux"));
    expect(r?.job.phase).toBe("done"); // NOT failed -- the silent film ships
    expect(r?.job.finish_unavailable?.at).toBe("mux");
    expect(r?.job.finish_unavailable?.delivered).toBe("silent_film");
    expect(r?.job.film_key).toBe("renders/film-519-mux/film-silent.mp4"); // the delivered (silent) film
    expect(read().finish_unavailable?.at).toBe("mux");
    expect(event?.at).toBe("mux");
    expect(event?.delivered).toBe("silent_film");
  });

  it("mux + the container RAN and returned a real error (500) -> STILL FAILS LOUD (#245/#249)", async () => {
    const { env } = degradeEnv(muxJob(), { vpc: { status: 500, body: { ok: false, error: "remux boom" } } });
    const r = await advanceFilmJob(env, "film-519-mux");
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toContain("500");
    expect(r?.job.finish_unavailable).toBeUndefined();
  });

  it("summarizeFilm + filmJobToPollView surface the degrade + clip keys for the UI", () => {
    const job = {
      ...asmJob(),
      phase: "done" as const,
      finish_unavailable: {
        at: "assemble" as const,
        reason: "video-finish tier not installed (VIDEO_FINISH_VPC unbound); delivered per-shot clips",
        delivered: "clips" as const,
        clips: [{ shot_id: "shot_01", clip_key: "renders/p/clips/shot_01_finished.mp4" }],
      },
    } as unknown as FilmJob;
    const summary = summarizeFilm(job, null);
    expect(summary.finish_unavailable?.at).toBe("assemble");
    expect(summary.finish_unavailable?.clips?.[0].shot_id).toBe("shot_01");
    const view = filmJobToPollView(job, null);
    expect(view.status).toBe("COMPLETED");
    const out = view.output as Record<string, unknown>;
    expect((out.finish_unavailable as { at: string }).at).toBe("assemble");
    expect((out.clips as { shot_id: string; key: string }[])[0]).toEqual({ shot_id: "shot_01", key: "renders/p/clips/shot_01_finished.mp4" });
  });
});

// --- #521: module discovery is threaded ONCE per tick (no per-leg fan-out) ---
// A single advanceFilmJob tick can chain several discovering legs (a mux tick runs enterMuxPhase ->
// transitionToDone -> film.finish chain + notify). Each used to re-run the N-module `/module.json`
// manifest scan, and on a 25-module install that blew the free-plan 50-subrequest cap (F9/#521). The
// tick now discovers once and threads the registry down, so each module manifest is read exactly once.
describe("#521 discovery threaded once per tick (no per-leg module.json fan-out)", () => {
  const MANIFEST = {
    name: "film-titles", version: "0.1.0", api: "vivijure-module/2",
    hooks: ["film.finish"], provides: [{ id: "film-titles", label: "Title cards" }],
    config_schema: {}, ui: { section: "film.finish", order: 10 },
  };
  function countingEnv(job: object) {
    const filmId = (job as { film_id: string }).film_id;
    let stored = JSON.stringify(job);
    let manifestHits = 0;
    const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const env = {
      R2_RENDERS: {
        get: async (k: string) => (k === filmJobDocKey(filmId) ? { text: async () => stored } : null),
        head: async () => null,
        put: async (k: string, v: string) => { if (k === filmJobDocKey(filmId)) stored = v; },
      },
      VIDEO_FINISH_VPC: { fetch: async () => jsonResp({ ok: true, key: `renders/${filmId}/film-audio.mp4` }) },
      MODULE_FILM_TITLES: {
        fetch: async (input: Request | string) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.endsWith("/module.json")) { manifestHits += 1; return jsonResp(MANIFEST); }
          return jsonResp({ ok: true, output: { film_key: `renders/${filmId}/film-audio.mp4`, applied: ["film-titles"] } });
        },
      },
      R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
      R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
    } as unknown as Env;
    return { env, hits: () => manifestHits };
  }

  it("a mux -> film.finish -> notify tick reads each module manifest exactly ONCE", async () => {
    const job = {
      film_id: "film-521-tick", project: "p",
      scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
      phase: "mux" as const,
      silent_film_key: "renders/film-521-tick/silent.mp4",
      audio_key: "renders/film-521-tick/audio.mp4",
      film_titles: { title: { text: "NEON" } },
      created_at: 0,
    };
    const { env, hits } = countingEnv(job);
    const r = await advanceFilmJob(env, "film-521-tick");
    expect(r?.job.phase).toBe("done"); // the mux + film.finish chain still completes
    expect(hits()).toBe(1); // discovered ONCE for the whole tick (was 2+: runFilmFinish + fireNotify each re-scanned)
  });
});


// #697/#698: the per-shot duration honesty gate at assemble. A talking shot delivered a truncated
// 0.085s clip TWICE during the S31 GPU proof and the film shipped GREEN -- the pixel gate (#558) checks
// content, not length. This drives the real advanceFilmJob assemble leg with a VPC double that returns
// per-clip durations, asserting the gate fails loud below the floor and passes at/above it.
function durationGateEnv(job: object, clipDurations: number[] | undefined) {
  const filmId = (job as { film_id: string }).film_id;
  const putCalls: string[] = [];
  const body: Record<string, unknown> = { ok: true, key: `renders/${filmId}/film.mp4`, durationSeconds: 4, shots: 2 };
  if (clipDurations !== undefined) body.clipDurations = clipDurations;
  const env = {
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
    R2_RENDERS: {
      // The job doc reads back; the bundle_key (and everything else) is absent, so
      // readShotDurationsFromBundle returns {} and the plan falls back to scene.seconds.
      get: async (key: string) => key === filmJobDocKey(filmId) ? { text: async () => JSON.stringify(job) } : null,
      head: async () => null, // film.mp4 not yet in R2 -> no self-heal short-circuit, real assemble runs
      put: async (key: string) => { putCalls.push(key); },
    },
    VIDEO_FINISH_VPC: {
      fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    },
    R2_S3_ACCESS_KEY_ID: "test", R2_S3_SECRET_ACCESS_KEY: "test",
    R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_S3_BUCKET: "vivijure",
  } as unknown as Env;
  return { env, putCalls };
}

describe("advanceFilmJob assemble duration honesty gate (#697/#698)", () => {
  const baseJob = {
    film_id: "film-durgate-1",
    project: "p",
    bundle_key: "renders/p/bundle.tar.gz", // absent in R2 -> plan falls back to scene.seconds
    scenes: [
      { shot_id: "shot_01", prompt: "x", seconds: 4 },
      { shot_id: "shot_02", prompt: "y", seconds: 4 },
    ],
    phase: "assemble" as const,
    finish_shots: [
      { shot_id: "shot_01", clip_key: "renders/film-durgate-1/clips/shot_01_finished.mp4", chain: ["M"], idx: 1, status: "done" as const, applied: [] },
      { shot_id: "shot_02", clip_key: "renders/film-durgate-1/clips/shot_02_finished.mp4", chain: ["M"], idx: 1, status: "done" as const, applied: [] },
    ],
  };

  it("FAILS LOUD when a shot is delivered below the floor (the 0.085s-for-4s case)", async () => {
    const { env } = durationGateEnv(baseJob, [0.085, 4.01]);
    const r = await advanceFilmJob(env, "film-durgate-1");
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toContain("duration gate");
    expect(r?.job.error).toContain("shot_01");
    expect(r?.job.error).toContain("planned 4.00s");
  });

  it("PASSES at/above the floor (both clips full length) -- no false failure", async () => {
    const { env } = durationGateEnv(baseJob, [3.96, 4.01]);
    const r = await advanceFilmJob(env, "film-durgate-1");
    expect(r?.job.phase).not.toBe("failed");
    expect(r?.job.actual_clip_durations).toEqual({ shot_01: 3.96, shot_02: 4.01 });
  });

  it("SKIPS the gate (no false failure) when an older container reports no per-clip durations", async () => {
    const { env } = durationGateEnv(baseJob, undefined);
    const r = await advanceFilmJob(env, "film-durgate-1");
    expect(r?.job.phase).not.toBe("failed");
    expect(r?.job.actual_clip_durations).toBeUndefined();
  });
});
