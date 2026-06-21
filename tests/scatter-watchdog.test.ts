import { describe, it, expect } from "vitest";

import { shardStatusForOutcome } from "../src/scatter-orchestrator";
import { gatherDecision, type ShardStatus } from "../src/scatter";
import type { FilmJob } from "../src/film-orchestrator";

// The watchdog refinement (#5, defense-in-depth on top of #229's withD1Retry): a shard whose advance
// merely ERRORS this tick is UNDETERMINED, not dead -- it must not be declared "owning shard dead".
// shardStatusForOutcome encodes that distinction; gatherDecision then keeps waiting for it.

const film = (phase: FilmJob["phase"], cancelled = false): FilmJob =>
  ({ phase, cancelled } as unknown as FilmJob);

describe("shardStatusForOutcome", () => {
  it("maps a determined film phase to its gather status", () => {
    expect(shardStatusForOutcome({ ok: true, job: film("done") })).toBe("COMPLETED");
    expect(shardStatusForOutcome({ ok: true, job: film("failed") })).toBe("FAILED");
    expect(shardStatusForOutcome({ ok: true, job: film("clips") })).toBe("IN_PROGRESS");
    expect(shardStatusForOutcome({ ok: true, job: film("keyframe") })).toBe("IN_PROGRESS");
    expect(shardStatusForOutcome({ ok: true, job: film("clips", true) })).toBe("CANCELLED");
  });

  it("treats a vanished film-job doc as genuinely dead (FAILED)", () => {
    expect(shardStatusForOutcome({ ok: false, reason: "doc_missing" })).toBe("FAILED");
  });

  it("treats an ERRORED advance as undetermined, NOT dead (IN_PROGRESS -> recoverable)", () => {
    expect(shardStatusForOutcome({ ok: false, reason: "errored" })).toBe("IN_PROGRESS");
  });
});

describe("gatherDecision honors the undetermined-shard distinction", () => {
  const expected = ["s1", "s2"];

  it("a transient-D1-blocked shard (errored -> IN_PROGRESS) keeps the gather WAITING, not failed", () => {
    const errored: ShardStatus = { status: shardStatusForOutcome({ ok: false, reason: "errored" }), shots: ["s2"] };
    const live: ShardStatus = { status: "IN_PROGRESS", shots: ["s1"] };
    // s2's owning shard merely errored this tick -> still recoverable -> wait, do not doom s2.
    expect(gatherDecision(["s1"], expected, [live, errored])).toEqual({ kind: "waiting", remaining: 1 });
  });

  it("a genuinely-dead shard (doc_missing -> FAILED) still dooms its missing shots", () => {
    const dead: ShardStatus = { status: shardStatusForOutcome({ ok: false, reason: "doc_missing" }), shots: ["s2"] };
    const live: ShardStatus = { status: "IN_PROGRESS", shots: ["s1"] };
    const d = gatherDecision(["s1"], expected, [live, dead]);
    expect(d.kind).toBe("failed");
  });
});
