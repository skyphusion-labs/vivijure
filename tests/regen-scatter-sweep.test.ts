import { describe, it, expect } from "vitest";
import { resolveCastLoras } from "../src/cast-loras";
import { filmPhaseToShardStatus } from "../src/film-orchestrator";
import { scatterJobToPollView } from "../src/scatter-orchestrator";
import { scatterShards } from "../src/scatter";

describe("resolveCastLoras", () => {
  it("returns empty when castLoras is missing", async () => {
    const env = {} as import("../src/env").Env;
    const r = await resolveCastLoras(env, undefined);
    expect(r.pretrained).toEqual({});
    expect(r.skipped).toEqual([]);
  });
});

describe("scatterShards", () => {
  it("splits shots into non-empty shards with scoped loras", () => {
    const shards = scatterShards({
      shotIds: ["s1", "s2", "s3", "s4"],
      shardCount: 2,
      pretrainedLoras: { A: "loras/a.safetensors", B: "loras/b.safetensors" },
      shotSlots: { s1: ["A"], s2: ["A"], s3: ["B"], s4: ["B"] },
    });
    expect(shards).toHaveLength(2);
    expect(shards[0].shots).toEqual(["s1", "s2"]);
    expect(shards[0].pretrainedLoras).toEqual({ A: "loras/a.safetensors" });
    expect(shards[1].pretrainedLoras).toEqual({ B: "loras/b.safetensors" });
  });
});

describe("filmPhaseToShardStatus", () => {
  it("maps film phases to gather shard statuses", () => {
    expect(filmPhaseToShardStatus({ phase: "done" } as never)).toBe("COMPLETED");
    expect(filmPhaseToShardStatus({ phase: "failed" } as never)).toBe("FAILED");
    expect(filmPhaseToShardStatus({ phase: "clips", cancelled: true } as never)).toBe("CANCELLED");
    expect(filmPhaseToShardStatus({ phase: "keyframe" } as never)).toBe("IN_PROGRESS");
  });
});

describe("scatterJobToPollView", () => {
  it("returns COMPLETED with output_key when gather is done", () => {
    const view = scatterJobToPollView({
      scatter_id: "scatter-abc",
      project: "p",
      bundle_key: "b",
      quality_tier: "final",
      expected_shot_ids: ["s1", "s2"],
      shard_film_ids: ["film-1", "film-2"],
      shard_shots: [["s1"], ["s2"]],
      phase: "done",
      film_key: "renders/scatter-abc/film.mp4",
      created_at: Date.now() - 1000,
    });
    expect(view.status).toBe("COMPLETED");
    expect(view.output).toMatchObject({ output_key: "renders/scatter-abc/film.mp4" });
  });
});
