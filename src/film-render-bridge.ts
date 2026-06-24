// Bridge between the film orchestrator (module render path) and the planner's RunPod-shaped
// poll contract. POST /api/storyboard/render uses startFilmJob when keyframe (+ motion for full
// renders) modules are installed; GET /api/storyboard/render/:jobId routes film-* ids here.

import type { ClipJob } from "./render-orchestrator";
import type { FilmJob } from "./film-orchestrator";
import { summarizeFilm, KEYFRAME_STALL_SECONDS } from "./film-orchestrator";
import type { FilmScene } from "./film-orchestrator";
import type { RunpodJobView, RunpodStatus } from "./runpod-submit";
import { resolveModuleRenderConfigs } from "./render-module-config";
import type { RegisteredModule } from "./modules/types";
import type { NewRenderRow } from "./renders-db";

export function isFilmJobId(jobId: string): boolean {
  return typeof jobId === "string" && jobId.startsWith("film-");
}

/** Reconstruct a renders-table row from a FilmJob doc (#164). The `POST /api/render/film`
 *  endpoint, unlike `POST /api/storyboard/render`, carries no quality tier or renderOverrides,
 *  so those default ("final" tier, no overrides) -- everything else reads straight off the job.
 *  Used at film START (insert the row) and on POLL as an insert-if-missing (insertRender is
 *  ON CONFLICT(job_id) DO NOTHING) so a film already in flight before history unification
 *  self-surfaces on its next poll/sweep tick. Pure so the mapping is unit-testable. */
export function filmRowFromJob(job: FilmJob): NewRenderRow {
  // Same mode derivation filmJobToPollView uses, so the row + the poll view never disagree.
  const mode = job.derive_mode ?? (job.keyframes_only ? "keyframes-only" : "full");
  return {
    jobId: job.film_id,
    project: job.project,
    bundleKey: job.bundle_key,
    qualityTier: "final",
    status: filmJobToPollView(job, null).status,
    mode,
    parentId: job.parent_render_id ?? null,
  };
}

/** Map planner render_overrides + quality tier into module config_schema fields. */
export function mapRenderOverridesToModuleConfigs(
  overrides: unknown,
  qualityTier: "draft" | "standard" | "final",
  modules: RegisteredModule[],
): ReturnType<typeof resolveModuleRenderConfigs> {
  return resolveModuleRenderConfigs(overrides, qualityTier, modules);
}

/** Normalize planner/API scene intake into FilmScene[]. */
export function normalizeFilmScenes(raw: unknown): FilmScene[] {
  if (!Array.isArray(raw)) return [];
  const out: FilmScene[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const shot_id = typeof o.shot_id === "string" ? o.shot_id.trim() : "";
    const prompt = typeof o.prompt === "string" ? o.prompt : "";
    const seconds = typeof o.seconds === "number" && o.seconds > 0 ? o.seconds : 4;
    if (shot_id && prompt.trim()) out.push({ shot_id, prompt, seconds });
  }
  return out;
}

/** Filter scenes to a process_shot_ids subset (scatter shards). */
export function filterScenesByShotIds(scenes: FilmScene[], shotIds: string[] | undefined): FilmScene[] {
  if (!shotIds || shotIds.length === 0) return scenes;
  const allow = new Set(shotIds);
  return scenes.filter((s) => allow.has(s.shot_id));
}

/** Order (and filter) scenes to match an explicit shot-id sequence. The scatter gather assembles its
 *  clips in expected_shot_ids order (orderFinalClips), regardless of shard completion order, while
 *  filterScenesByShotIds keeps scenes in their own (bundle) order. The two can differ; feeding captions
 *  the bundle order would compute each line's cumulative window against the WRONG preceding shots and
 *  misalign the subtitles. Anchoring the caption scenes to the same shot order the film is assembled in
 *  keeps buildCaptionCues' cumulative timeline aligned with the cut (#284/#285). Unknown ids are skipped;
 *  scenes whose id is absent from the sequence are dropped. */
export function orderScenesByShotIds(scenes: FilmScene[], shotIds: string[]): FilmScene[] {
  const byId = new Map(scenes.map((s) => [s.shot_id, s]));
  const out: FilmScene[] = [];
  for (const id of shotIds) {
    const s = byId.get(id);
    if (s) out.push(s);
  }
  return out;
}

/** Stall signal for the UI (#129 / Joan's render-status UX). Surfaced on an IN_PROGRESS render's
 *  output_json so the history UI renders a real "needs attention" state instead of guessing from
 *  updated_at:
 *    last_progress_at -- epoch MILLIS the job entered its current phase (the true last-advanced time).
 *    stalled          -- true once the current phase has sat past the stall threshold with no progress.
 *    stall_seconds    -- how long it has been stalled (only when stalled), so the UI can say "stuck 34m".
 *  The driver (advanceFilmJob) recovers or loud-fails a stalled job; this is the in-flight signal in the
 *  window before it does. Pure + injectable `now` so it unit-tests without the wall clock. */
export function stallSignal(job: FilmJob, now: number = Date.now()): Record<string, unknown> {
  // Measure from the last REAL progress (#136): a clip/finish/speech shot completing re-stamps
  // job.last_progress_at (advanceFilmJob), so a healthy multi-shot phase that legitimately runs 30+
  // min advancing shot by shot no longer false-flags "stalled". Falls back to phase_started_at (then
  // created_at) for pre-#136 jobs, so an old in-flight job's signal is unchanged.
  const lastProgressAt = job.last_progress_at ?? job.phase_started_at ?? job.created_at;
  const ageSeconds = Math.max(0, Math.floor((now - lastProgressAt) / 1000));
  const stalled = ageSeconds >= KEYFRAME_STALL_SECONDS;
  const out: Record<string, unknown> = { last_progress_at: lastProgressAt };
  if (stalled) {
    out.stalled = true;
    out.stall_seconds = ageSeconds;
  }
  return out;
}

function phaseProgress(job: FilmJob, clipJob: ClipJob | null): Record<string, unknown> {
  const total = job.scenes.length;
  const summary = summarizeFilm(job, clipJob);
  const base = { scene_total: total, project: job.project, ...stallSignal(job) };

  switch (job.phase) {
    case "keyframe":
      return { ...base, phase: "keyframe", scene_index: 1 };
    case "clips": {
      const c = summary.clips;
      const done = c?.done ?? 0;
      const progress = c && c.total > 0 ? done / c.total : undefined;
      return {
        ...base,
        phase: "i2v",
        scene_index: Math.min(total, done + 1),
        progress,
      };
    }
    case "finish": {
      const f = summary.finish;
      const done = f?.done ?? 0;
      return { ...base, phase: "finish", scene_index: Math.min(total, done + 1) };
    }
    case "assemble":
      return { ...base, phase: "assemble" };
    case "mux":
      return { ...base, phase: "mux" };
    default:
      return base;
  }
}

/** Fold a film job into the RunPod-shaped view the planner poll loop already understands. */
export function filmJobToPollView(job: FilmJob, clipJob: ClipJob | null): RunpodJobView {
  let status: RunpodStatus;
  let output: Record<string, unknown> | undefined;

  if (job.cancelled) {
    status = "CANCELLED";
  } else if (job.phase === "done") {
    status = "COMPLETED";
    const mode = job.derive_mode
      ?? (job.keyframes_only ? "keyframes-only" : "full");
    output = {
      output_key: job.film_key,
      project: job.project,
      mode,
    };
    if (job.keyframes_only && job.keyframes?.length) {
      output.keyframes = job.keyframes.map((k) => ({ shot_id: k.shot_id, key: k.keyframe_key }));
      output.scenes = job.scenes;
    }
    if (job.derive_mode && clipJob) {
      const clips = clipJob.shots
        .filter((s) => s.status === "done" && s.clip_key)
        .map((s) => ({
          shot_id: s.shot_id,
          key: s.clip_key as string,
          model: s.motion_backend ?? clipJob.motion_backend ?? undefined,
        }));
      if (clips.length) output.clips = clips;
      const models = new Set(clips.map((c) => c.model).filter(Boolean));
      if (models.size === 1) output.model = [...models][0];
      else if (job.motion_backend) output.model = job.motion_backend;
    }
  } else if (job.phase === "failed") {
    status = "FAILED";
  } else {
    status = "IN_PROGRESS";
    output = phaseProgress(job, clipJob);
  }

  return {
    jobId: job.film_id,
    status,
    statusRaw: job.cancelled ? "CANCELLED" : job.phase,
    output,
    error: job.error,
    executionTimeMs: Math.max(0, Date.now() - job.created_at),
  };
}
