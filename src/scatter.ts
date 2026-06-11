// Distributed scatter/gather render conductor (pure core).
//
// A normal render runs every shot in one RunPod job. A *scatter* render splits
// the storyboard across N jobs that run in parallel, then *gathers* their
// per-shot clips into one MP4. The win is wall-clock: a 10-shot film that takes
// ~T on one worker takes ~T/N across N, at the same GPU-second cost.
//
// Three things make this safe and cheap, and they already exist on the backend:
//   1. `process_shot_ids` lets a job render only its slice (orchestrator.plan
//      scopes scenes to it).
//   2. `pretrained_loras` lets every shard REUSE the character adapters trained
//      ONCE up front (handler._stage_pretrained_loras pulls them from R2), so a
//      shard never retrains, and every shot shares byte-identical identity.
//   3. `finish_offloaded` makes a shard emit per-shot clips + a manifest and
//      skip the merge, so the control plane owns the single final assembly.
//
// This module is the CONDUCTOR's pure logic: how to split the shots, how to
// shape each shard's submit args, and how to decide when the gather can finish.
// No I/O, no Worker runtime: trivially unit-testable. The orchestration that
// submits jobs, writes the parent/child `renders` rows, and drives the merge
// lives in index.ts and reuses these helpers plus the gather core already in
// video-finish.ts (gatherClipPresence / finishInputFromClipKeys / runVideoFinish).

import type { RenderSubmitArgs } from "./runpod-submit";

// Split an ordered shot list into `shardCount` CONTIGUOUS, balanced slices.
//
// Contiguous (not round-robin) so each shard is a coherent run of the
// storyboard: shots that chain from their predecessor (chain_from_previous)
// stay together in one job, and the gather just concatenates shards in
// storyboard order. Balanced with a front-loaded remainder, so 10 shots over 3
// shards => [4, 3, 3], never an empty trailing shard.
//
// `shardCount` is clamped to [1, shots.length]: asking for more shards than
// shots would mint empty jobs (GPU-seconds for nothing), and asking for <1 is
// just a normal single render. An empty shot list returns [].
export function splitShots(shotIds: string[], shardCount: number): string[][] {
  const shots = shotIds.filter((s) => typeof s === "string" && s.length > 0);
  if (shots.length === 0) return [];
  const n = Math.max(1, Math.min(Math.floor(shardCount) || 1, shots.length));
  const base = Math.floor(shots.length / n);
  const extra = shots.length % n; // the first `extra` shards carry one more
  const shards: string[][] = [];
  let i = 0;
  for (let s = 0; s < n; s++) {
    const size = base + (s < extra ? 1 : 0);
    shards.push(shots.slice(i, i + size));
    i += size;
  }
  return shards;
}

export interface ScatterArgs {
  project: string;
  bundleKey: string;
  qualityTier?: "draft" | "standard" | "final";
  // The character adapters trained ONCE before the scatter, slot -> R2 key.
  // Every shard reuses these; without them each shard would retrain (slow, and
  // risks per-shard identity drift). Required for a real scatter.
  pretrainedLoras: Record<string, string>;
  // Storyboard-ordered shot ids (the full film).
  shotIds: string[];
  shardCount: number;
  renderOverrides?: Record<string, unknown>;
  userEmail?: string;
  // Optional slot map per shot (storyboard character_slots). When present, each
  // shard only carries the LoRAs its own shots actually use, so an
  // environment-only shard does not stage adapters it never binds. Absent => the
  // full pretrainedLoras map is handed to every shard (correct, slightly wasteful).
  shotSlots?: Record<string, string[]>;
}

// Build one RenderSubmitArgs per shard. Each is a finish-offloaded subset render
// that reuses the pre-trained LoRAs, so it draws keyframes + i2v for ITS shots
// and writes per-shot clips to R2 without assembling anything.
export function buildShardJobs(args: ScatterArgs): RenderSubmitArgs[] {
  const shards = splitShots(args.shotIds, args.shardCount);
  return shards.map((shard) => {
    const pretrained = scopePretrainedToShard(args.pretrainedLoras, shard, args.shotSlots);
    const job: RenderSubmitArgs = {
      project: args.project,
      bundleKey: args.bundleKey,
      qualityTier: args.qualityTier,
      processShotIds: shard,
      // finish_offloaded is the one raw routing flag the backend reads off the
      // overrides dict (buildSubmitPayload._OVERRIDE_FLAGS). It makes the shard
      // emit clips + manifest and skip the merge.
      renderOverrides: { ...(args.renderOverrides ?? {}), finish_offloaded: true },
    };
    if (Object.keys(pretrained).length > 0) job.pretrainedLoras = pretrained;
    if (args.userEmail) job.userEmail = args.userEmail;
    return job;
  });
}

// Restrict the pretrained-LoRA map to the slots a shard's shots actually use.
// Falls back to the full map when we have no per-shot slot information (the safe
// default: staging a spare adapter is wasteful, dropping a needed one renders
// the wrong identity).
function scopePretrainedToShard(
  pretrainedLoras: Record<string, string>,
  shard: string[],
  shotSlots?: Record<string, string[]>,
): Record<string, string> {
  if (!shotSlots) return { ...pretrainedLoras };
  const used = new Set<string>();
  for (const shotId of shard) {
    for (const slot of shotSlots[shotId] ?? []) used.add(slot);
  }
  const scoped: Record<string, string> = {};
  for (const [slot, key] of Object.entries(pretrainedLoras)) {
    if (used.has(slot)) scoped[slot] = key;
  }
  return scoped;
}

// A shard's terminal RunPod statuses that mean "this slice will never produce
// its clips" (so if its shots are still missing, the gather is doomed, not just
// slow). Mirrors RunpodStatus.
const SHARD_DEAD_STATUSES = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);

export type GatherDecision =
  | { kind: "finish" }
  | { kind: "waiting"; remaining: number }
  | { kind: "failed"; reason: string };

// Decide what the gather watcher should do, from the clip-presence signal
// (video-finish.gatherClipPresence) and the shards' last RunPod statuses.
//
//   finish  -> every shot has a clip in R2: assemble the MP4.
//   failed  -> a shard reached a dead terminal state while shots are still
//              missing: those clips can never arrive, so stop waiting.
//   waiting -> clips still landing; keep polling.
//
// The presence signal leads (a shard can be COMPLETED yet have re-emitted clips,
// or a retried shard can fill holes), so we only call "failed" when shots are
// genuinely missing AND a shard that would have produced them is dead.
export function gatherDecision(
  present: string[],
  missing: string[],
  shardStatuses: Array<{ status: string }>,
): GatherDecision {
  if (missing.length === 0 && present.length > 0) return { kind: "finish" };
  const anyDead = shardStatuses.some((s) => SHARD_DEAD_STATUSES.has(s.status));
  if (missing.length > 0 && anyDead) {
    return { kind: "failed", reason: `${missing.length} shot(s) missing and a shard failed: ${missing.join(", ")}` };
  }
  return { kind: "waiting", remaining: missing.length };
}

// Synthetic job_id for the scatter PARENT renders row. The parent is not a
// RunPod job (it owns N child jobs), but renders.job_id is NOT NULL UNIQUE, so
// it needs a stable, collision-free id. The caller passes a unique token (e.g.
// the first child job id, or a timestamp+slug); kept pure so tests are
// deterministic and the Worker chooses the entropy.
export function scatterParentJobId(token: string): string {
  return `scatter-${token}`;
}

export function isScatterParentJobId(jobId: string | null | undefined): boolean {
  return typeof jobId === "string" && jobId.startsWith("scatter-");
}
