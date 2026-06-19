import { describe, it, expect } from "vitest";
import { summarizeJob, applyPoll, clipFileMatchesShot, finishedClipFileMatchesShot, listClipsByShotId, advanceClipJob } from "../src/render-orchestrator";
import type { ClipJob, ClipShot } from "../src/render-orchestrator";
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
});

describe("clipFileMatchesShot (#141/#143 shot-name matching)", () => {
  it("matches the motion clip at a digit boundary; excludes _finished; needs a video ext", () => {
    expect(clipFileMatchesShot("shot_09_i2v.mp4", "shot_09")).toBe(true);
    expect(clipFileMatchesShot("shot_10_seedance.mov", "shot_10")).toBe(true);
    expect(clipFileMatchesShot("shot_10_i2v.mp4", "shot_1")).toBe(false); // boundary: shot_1 != shot_10
    expect(clipFileMatchesShot("shot_06_finished.mp4", "shot_06")).toBe(false);
    expect(clipFileMatchesShot("shot_09_i2v.txt", "shot_09")).toBe(false);
  });
});

describe("finishedClipFileMatchesShot (#141 finish-output matching)", () => {
  it("matches ONLY the _finished output at a digit boundary, with a video ext", () => {
    expect(finishedClipFileMatchesShot("shot_06_finished.mp4", "shot_06")).toBe(true);
    expect(finishedClipFileMatchesShot("shot_06_i2v.mp4", "shot_06")).toBe(false); // raw motion clip, not finish
    expect(finishedClipFileMatchesShot("shot_10_finished.mp4", "shot_1")).toBe(false); // boundary
    expect(finishedClipFileMatchesShot("shot_06_finished.txt", "shot_06")).toBe(false); // not a video
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
