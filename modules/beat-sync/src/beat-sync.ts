// Pure beat-sync logic (unit-testable without the Worker runtime).

import type { AudioBeatPlan } from "./contract";

export const MODES = ["beat", "duration"] as const;
export type AnalyzeMode = (typeof MODES)[number];

export interface AnalyzeConfig {
  clip_seconds?: number;
  mode?: AnalyzeMode;
  min_scene_s?: number;
  max_scene_s?: number;
  force_shots?: number;
}

/** Build the JSON body the audio-beat-sync container expects (camelCase). */
export function buildAnalyzeBody(
  config: AnalyzeConfig,
  audioUrl: string,
  audioKey: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    audioUrl,
    audioKey,
    clipSeconds: config.clip_seconds ?? 8,
    mode: config.mode ?? "beat",
    minSceneS: config.min_scene_s ?? 2.5,
    maxSceneS: config.max_scene_s ?? 12,
  };
  if (typeof config.force_shots === "number" && Number.isFinite(config.force_shots) && config.force_shots > 0) {
    body.forceShots = Math.round(config.force_shots);
  }
  return body;
}

export function normalizeConfig(raw: Record<string, unknown> | undefined): AnalyzeConfig & {
  clip_seconds: number;
  mode: AnalyzeMode;
  min_scene_s: number;
  max_scene_s: number;
} {
  const c = raw ?? {};
  const mode = c.mode === "duration" ? "duration" : "beat";
  let clip = typeof c.clip_seconds === "number" ? c.clip_seconds : Number(c.clip_seconds);
  if (!Number.isFinite(clip) || clip <= 0) clip = 8;
  let minS = typeof c.min_scene_s === "number" ? c.min_scene_s : Number(c.min_scene_s);
  if (!Number.isFinite(minS) || minS <= 0) minS = 2.5;
  let maxS = typeof c.max_scene_s === "number" ? c.max_scene_s : Number(c.max_scene_s);
  if (!Number.isFinite(maxS) || maxS <= 0) maxS = 12;
  let force: number | undefined;
  if (c.force_shots != null && c.force_shots !== "") {
    const n = typeof c.force_shots === "number" ? c.force_shots : Number(c.force_shots);
    if (Number.isFinite(n) && n > 0) force = Math.round(n);
  }
  return {
    clip_seconds: clip,
    mode,
    min_scene_s: minS,
    max_scene_s: maxS,
    force_shots: force,
  };
}

/** Normalize the container's snake_case plan to camelCase. Returns null on bad shape. */
export function parseAudioBeatPlan(raw: unknown): AudioBeatPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "beat" || r.mode === "duration" ? r.mode : null;
  if (!mode) return null;
  return {
    mode,
    audioKey: String(r.audio_key ?? ""),
    durationSeconds: Number(r.duration_seconds ?? 0),
    bpm: typeof r.bpm === "number" ? r.bpm : undefined,
    beatCount: typeof r.beat_count === "number" ? r.beat_count : undefined,
    suggestedShots: Number(r.suggested_shots ?? 0),
    clipSeconds: Number(r.clip_seconds ?? 0),
    filmSeconds: Number(r.film_seconds ?? 0),
    remainderSeconds: Number(r.remainder_seconds ?? 0),
    timedScenes: Array.isArray(r.timed_scenes)
      ? r.timed_scenes
          .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
          .map((s) => ({
            index: Number(s.index ?? 0),
            start: Number(s.start ?? 0),
            end: Number(s.end ?? 0),
            targetSeconds: Number(s.target_seconds ?? 0),
          }))
      : [],
    note: String(r.note ?? ""),
  };
}

/** Parse the container HTTP JSON: { ok, error?, ...plan fields }. */
export function parseContainerResponse(raw: unknown): { ok: true; plan: AudioBeatPlan } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "container returned non-object JSON" };
  const r = raw as Record<string, unknown>;
  if (r.ok === false) {
    return { ok: false, error: typeof r.error === "string" ? r.error : "beat analysis failed" };
  }
  const plan = parseAudioBeatPlan(raw);
  if (!plan) return { ok: false, error: "beat-sync container returned an unrecognized plan" };
  return { ok: true, plan };
}

export function appliedTags(mode: AnalyzeMode): string[] {
  return ["beat-sync:librosa-vpc", `mode:${mode}`];
}
