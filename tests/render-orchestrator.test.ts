import { describe, it, expect } from "vitest";
import { summarizeJob, applyPoll } from "../src/render-orchestrator";
import type { ClipJob, ClipShot } from "../src/render-orchestrator";

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
