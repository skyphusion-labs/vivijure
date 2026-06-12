import { describe, expect, it } from "vitest";

import {
  buildShardJobs,
  gatherDecision,
  splitShots,
  type ScatterArgs,
  type ShardStatus,
} from "../src/scatter";

// ----------------------------------------------------------------- splitShots

describe("splitShots", () => {
  it("splits into contiguous, front-loaded-remainder slices", () => {
    expect(splitShots(["a", "b", "c", "d", "e"], 3)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(splitShots(["a", "b", "c", "d"], 2)).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("clamps shardCount to [1, shots.length] (never mints empty shards)", () => {
    // more shards than shots -> one shot each, no empty trailing shard
    expect(splitShots(["a", "b"], 9)).toEqual([["a"], ["b"]]);
    // < 1 shard collapses to a single render
    expect(splitShots(["a", "b", "c"], 0)).toEqual([["a", "b", "c"]]);
  });
  it("drops blank ids and returns [] for an empty list", () => {
    expect(splitShots([], 3)).toEqual([]);
    expect(splitShots(["a", "", "b"], 2)).toEqual([["a"], ["b"]]);
  });
});

// ----------------------------------------------------------------- buildShardJobs

const baseArgs: ScatterArgs = {
  project: "demo",
  bundleKey: "bundles/demo.tar.gz",
  pretrainedLoras: {},
  shotIds: ["s1", "s2", "s3", "s4", "s5"],
  shardCount: 2,
};

describe("buildShardJobs", () => {
  it("emits one finish-offloaded job per non-empty shard", () => {
    const jobs = buildShardJobs(baseArgs);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].processShotIds).toEqual(["s1", "s2", "s3"]);
    expect(jobs[1].processShotIds).toEqual(["s4", "s5"]);
    for (const j of jobs) {
      expect(j.renderOverrides).toMatchObject({ finish_offloaded: true });
    }
  });

  it("NEVER emits a job with empty processShotIds (the empty == full-film guard)", () => {
    // No shot list -> no jobs at all (not one job that renders everything).
    expect(buildShardJobs({ ...baseArgs, shotIds: [] })).toEqual([]);
    // Every emitted job carries a non-empty slice, whatever the shardCount.
    for (const shardCount of [1, 2, 3, 5, 99]) {
      const jobs = buildShardJobs({ ...baseArgs, shardCount });
      expect(jobs.every((j) => (j.processShotIds?.length ?? 0) > 0)).toBe(true);
    }
  });

  it("scopes each shard's pretrained LoRAs to the slots its shots actually use", () => {
    const jobs = buildShardJobs({
      ...baseArgs,
      pretrainedLoras: { A: "loras/A.safetensors", B: "loras/B.safetensors" },
      shotSlots: { s1: ["A"], s2: ["A"], s3: ["A"], s4: ["B"], s5: ["B"] },
    });
    // shard 1 = s1..s3 (all slot A); shard 2 = s4..s5 (all slot B)
    expect(jobs[0].pretrainedLoras).toEqual({ A: "loras/A.safetensors" });
    expect(jobs[1].pretrainedLoras).toEqual({ B: "loras/B.safetensors" });
  });

  it("hands every shard the full LoRA map when no slot info is given", () => {
    const jobs = buildShardJobs({ ...baseArgs, pretrainedLoras: { A: "k" } });
    for (const j of jobs) expect(j.pretrainedLoras).toEqual({ A: "k" });
  });
});

// ----------------------------------------------------------------- gatherDecision

const live = (shots: string[]): ShardStatus => ({ status: "IN_PROGRESS", shots });
const done = (shots: string[]): ShardStatus => ({ status: "COMPLETED", shots });
const dead = (shots: string[]): ShardStatus => ({ status: "FAILED", shots });

describe("gatherDecision", () => {
  it("finishes only when present covers the full expected set", () => {
    expect(
      gatherDecision(["s1", "s2"], ["s1", "s2"], [done(["s1", "s2"])]),
    ).toEqual({ kind: "finish" });
  });

  it("finishes when present is a superset of expected (extra/re-emitted clips ignored)", () => {
    expect(
      gatherDecision(["s1", "s2", "s3", "spare"], ["s1", "s2", "s3"], [done(["s1", "s2", "s3"])]),
    ).toEqual({ kind: "finish" });
  });

  it("does NOT finish a partial film: missing-from-expected keeps waiting", () => {
    // The whole point of fix #1: expected is authoritative, so a clip set that
    // only covers 2 of 3 storyboard shots can never be reported as a success.
    expect(
      gatherDecision(["s1", "s2"], ["s1", "s2", "s3"], [live(["s1", "s2", "s3"])]),
    ).toEqual({ kind: "waiting", remaining: 1 });
  });

  it("fails when nothing is expected (never assembles an empty film)", () => {
    expect(gatherDecision([], [], []).kind).toBe("failed");
  });

  it("fails only the shots a DEAD shard owned", () => {
    const d = gatherDecision(
      ["s1", "s2"],
      ["s1", "s2", "s3"],
      [done(["s1", "s2"]), dead(["s3"])],
    );
    expect(d.kind).toBe("failed");
    if (d.kind === "failed") expect(d.reason).toContain("s3");
  });

  it("does NOT fail when a dead shard's shots already arrived and the missing shot is on a LIVE shard", () => {
    // fix #2: a single dead shard must not doom shots that a live shard still owns.
    // Shard A FAILED but its shots (s1,s2) are already present; s3 is still
    // pending on a live shard B -> keep waiting, do not fail the gather.
    expect(
      gatherDecision(["s1", "s2"], ["s1", "s2", "s3"], [dead(["s1", "s2"]), live(["s3"])]),
    ).toEqual({ kind: "waiting", remaining: 1 });
  });

  it("fails a missing shot that no shard owns (unassigned == unrecoverable)", () => {
    const d = gatherDecision(["s1"], ["s1", "s2"], [live(["s1"])]);
    expect(d.kind).toBe("failed");
    if (d.kind === "failed") expect(d.reason).toContain("s2");
  });

  it("waits while live shards could still fill every hole", () => {
    expect(
      gatherDecision([], ["s1", "s2"], [live(["s1"]), live(["s2"])]),
    ).toEqual({ kind: "waiting", remaining: 2 });
  });
});
