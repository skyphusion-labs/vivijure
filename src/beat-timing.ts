// Beat-synced storyboard timing (v0.119.0).
//
// Bridges /api/audio/analyze (the librosa beat plan) into /api/storyboard/plan.
// The planner LLM is good at distributing narrative content across a fixed
// number of shots; it is NOT reliable at emitting frame-accurate per-shot
// seconds. So the work is split:
//   - buildBeatTimingBlock() tells the planner EXACTLY how many shots to write
//     and roughly how long each runs, so the content is paced to the music.
//   - applyBeatTiming() runs AFTER validation and deterministically stamps the
//     exact start / end / target_seconds from the beat plan onto each scene, so
//     the cuts land on the beat regardless of what numbers the model emitted.
//
// Consumers: handleStoryboardPlan (index.ts) and the beat-timing unit tests.
// Pure: no Env, no fetch.

import type { StoryboardValidated } from "./storyboard-validate";
import { STORYBOARD_MAX_SCENES } from "./storyboard-validate";

// One beat-aligned shot. Mirrors the camelCase TimedScene emitted by
// /api/audio/analyze (parseAudioBeatPlan), so the client can forward the
// analyze response's timedScenes verbatim.
export interface BeatTimedScene {
  index: number;
  start: number;
  end: number;
  targetSeconds: number;
}

export interface BeatTimingInput {
  timedScenes: BeatTimedScene[];
  filmSeconds?: number;
  clipSeconds?: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// Validate the optional `beatPlan` field on a /api/storyboard/plan request.
// Accepts the subset of /api/audio/analyze's output we need: a non-empty
// timedScenes array plus optional filmSeconds / clipSeconds. Extra fields on
// the analyze response (bpm, note, suggestedShots, ...) are ignored so the
// client can forward the whole plan verbatim.
export function parseBeatTimingInput(
  raw: unknown,
): { ok: true; value: BeatTimingInput } | { ok: false; errors: string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["beatPlan must be an object"] };
  }
  const o = raw as { timedScenes?: unknown; filmSeconds?: unknown; clipSeconds?: unknown };
  if (!Array.isArray(o.timedScenes) || o.timedScenes.length === 0) {
    return { ok: false, errors: ["beatPlan.timedScenes must be a non-empty array"] };
  }
  if (o.timedScenes.length > STORYBOARD_MAX_SCENES) {
    return {
      ok: false,
      errors: [
        `beatPlan.timedScenes has ${o.timedScenes.length} entries, over the ${STORYBOARD_MAX_SCENES}-scene cap`,
      ],
    };
  }
  const timedScenes: BeatTimedScene[] = [];
  for (let i = 0; i < o.timedScenes.length; i++) {
    const t = o.timedScenes[i] as Partial<BeatTimedScene>;
    const start = t?.start;
    const end = t?.end;
    const target = t?.targetSeconds;
    if (!isFiniteNumber(start) || !isFiniteNumber(end) || !isFiniteNumber(target)) {
      return { ok: false, errors: [`beatPlan.timedScenes[${i}] needs finite start, end, targetSeconds`] };
    }
    if (start < 0 || end <= start || target <= 0) {
      return {
        ok: false,
        errors: [`beatPlan.timedScenes[${i}] requires 0 <= start < end and targetSeconds > 0`],
      };
    }
    timedScenes.push({ index: i, start, end, targetSeconds: target });
  }
  const value: BeatTimingInput = { timedScenes };
  if (isFiniteNumber(o.filmSeconds) && o.filmSeconds > 0) value.filmSeconds = o.filmSeconds;
  if (isFiniteNumber(o.clipSeconds) && o.clipSeconds > 0) value.clipSeconds = o.clipSeconds;
  return { ok: true, value };
}

// Median target shot length, used as clip_seconds when the plan carries no
// explicit clipSeconds. Median (not mean) so one long tail shot (the remainder
// absorber) does not skew the per-shot target the renderer reads.
function medianTarget(timedScenes: BeatTimedScene[]): number {
  const xs = timedScenes.map((t) => t.targetSeconds).sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Prompt block appended to the planning user message when a beat plan is
// supplied. Forces an exact shot count and gives the per-shot durations so the
// model paces its content to the cuts. The model does NOT emit the seconds
// (applyBeatTiming stamps them); it only writes content for exactly N shots.
export function buildBeatTimingBlock(beat: BeatTimingInput): string {
  const n = beat.timedScenes.length;
  const film = beat.filmSeconds ?? beat.timedScenes[n - 1].end;
  const lines = beat.timedScenes.map(
    (t, i) => `  shot ${i + 1}: ~${round3(t.targetSeconds)}s (cut ${round3(t.start)}s -> ${round3(t.end)}s)`,
  );
  return [
    "BEAT-SYNCED TIMING (the film is scored to an audio bed):",
    `- Produce EXACTLY ${n} scene${n === 1 ? "" : "s"}, one per shot below. Do not add or drop shots.`,
    `- Total film length is ${round3(film)}s. Pace each scene's action to roughly fill its shot duration:`,
    ...lines,
    "- The exact per-shot seconds are stamped by the pipeline after you respond,",
    `  so do not emit start / end / target_seconds; just write the content for`,
    `  all ${n} shots, in order.`,
  ].join("\n");
}

// Deterministically stamp beat timings onto a validated storyboard. The model
// owns scene COUNT + CONTENT; this owns the exact numbers, so cuts land on the
// beat even if the model fudged or omitted the seconds. Returns the stamped
// storyboard plus any non-fatal warnings (count drift between model and plan).
export function applyBeatTiming(
  storyboard: StoryboardValidated,
  beat: BeatTimingInput,
): { storyboard: StoryboardValidated; warnings: string[] } {
  const warnings: string[] = [];
  const want = beat.timedScenes.length;
  let scenes = storyboard.scenes;

  if (scenes.length > want) {
    warnings.push(
      `planner produced ${scenes.length} scenes but the beat plan has ${want}; dropped the last ${scenes.length - want}`,
    );
    scenes = scenes.slice(0, want);
  } else if (scenes.length < want) {
    warnings.push(
      `planner produced ${scenes.length} scenes but the beat plan has ${want}; timing applied to ${scenes.length}, film will not fill the audio`,
    );
  }

  const stamped = scenes.map((scene, i) => {
    const t = beat.timedScenes[i];
    return {
      ...scene,
      start: round3(t.start),
      end: round3(t.end),
      target_seconds: round3(t.targetSeconds),
    };
  });

  // Top-level duration/clip. When the count matched, trust the plan's
  // filmSeconds; on underflow, only claim the duration actually covered.
  const covered = stamped.length > 0 ? (stamped[stamped.length - 1].end as number) : 0;
  const filmSeconds = stamped.length === want ? (beat.filmSeconds ?? covered) : covered;
  const clipSeconds =
    beat.clipSeconds ?? medianTarget(beat.timedScenes.slice(0, stamped.length || 1));

  return {
    storyboard: {
      ...storyboard,
      scenes: stamped,
      duration_seconds: round3(filmSeconds),
      clip_seconds: round3(clipSeconds),
    },
    warnings,
  };
}
