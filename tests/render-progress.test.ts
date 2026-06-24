import { describe, it, expect } from "vitest";
import { readKeyframeDone, progressSnapshotKey, renderSlug } from "../src/render-progress";
import type { Env } from "../src/env";

// Issue #318: the GPU keyframe job writes a progress snapshot (renders/<slug>/progress/<jobId>.json)
// whose counts.keyframe_done ticks per shot in real time. readKeyframeDone folds it into the poll
// view so the keyframe band subdivides. Best-effort: any miss -> undefined (no sub-progress, no throw).

function envWith(key: string, body: unknown): Env {
  return {
    R2_RENDERS: { get: async (k: string) => (k === key ? { text: async () => JSON.stringify(body) } : null) },
  } as unknown as Env;
}

describe("readKeyframeDone (#318)", () => {
  it("returns counts.keyframe_done from the GPU job's snapshot", async () => {
    const key = progressSnapshotKey("neon", "job-123");
    const env = envWith(key, { project: "neon", job_id: "job-123", counts: { keyframe_done: 3, i2v_done: 1 } });
    expect(await readKeyframeDone(env, "neon", "job-123")).toBe(3);
  });

  it("returns undefined when the snapshot is absent (cloud-keyframe / not-yet-written)", async () => {
    const env = { R2_RENDERS: { get: async () => null } } as unknown as Env;
    expect(await readKeyframeDone(env, "neon", "job-x")).toBeUndefined();
  });

  it("returns undefined when counts.keyframe_done is missing (best-effort, no throw)", async () => {
    const key = progressSnapshotKey("neon", "job-1");
    expect(await readKeyframeDone(envWith(key, { counts: {} }), "neon", "job-1")).toBeUndefined();
  });

  it("returns undefined on a parse error (never throws)", async () => {
    const env = { R2_RENDERS: { get: async () => ({ text: async () => "not json" }) } } as unknown as Env;
    expect(await readKeyframeDone(env, "neon", "job-1")).toBeUndefined();
  });
});

describe("progressSnapshotKey slug parity with backend keys.py (#318)", () => {
  it("mirrors the backend _slug + layout", () => {
    expect(renderSlug("Neon Halflife")).toBe("Neon_Halflife");
    expect(progressSnapshotKey("Neon Halflife", "abc-123")).toBe("renders/Neon_Halflife/progress/abc-123.json");
  });
});
