// Scatter/gather render orchestrator: N parallel film jobs (clips_only shards) + one gather assemble.

import type { Env } from "./env";
import type { ScatterJob } from "./scatter-orchestrator-types";
import {
  advanceFilmJob,
  callVideoFinish,
  cancelFilmJob,
  classifyAssembleTransport,
  clipKeysFromFilmJob,
  filmJobDocKey,
  filmPhaseToShardStatus,
  orderFinalClips,
  startFilmJob,
  runFilmFinish,
  type FilmJob,
  type FilmScene,
} from "./film-orchestrator";
import { filmJobToPollView, filterScenesByShotIds, orderScenesByShotIds, mapRenderOverridesToModuleConfigs } from "./film-render-bridge";
import { presignR2Get, presignR2Put } from "./r2-presign";
import { resolveStagedAudioKey } from "./audio-stage";
import { discoverModules, servingForHook } from "./modules/registry";
import { readBundleScenes } from "./bundle-storyboard";
import { getProjectById } from "./storyboard-projects-db";
import { buildDialogueLines } from "./dialogue-lines";
import type { DialogueLine } from "./modules/types";
import {
  gatherDecision,
  isScatterParentJobId,
  scatterParentJobId,
  scatterShards,
  type ShardStatus,
} from "./scatter";
import type { RunpodJobView, RunpodStatus } from "./runpod-submit";
import {
  claimFinish,
  getFinishState,
  getRenderIdByJobId,
  insertRender,
  buildInsertRenderStmt,
  markFinishDone,
  markFinishFailed,
  markRenderFailedByJobId,
  updateRenderFromView,
} from "./renders-db";
import { resolveCastLoras } from "./cast-loras";
import { fireNotifyForScatter } from "./scatter-notify";
import { isTransientD1Error, withD1Retry, d1ErrorCode } from "./d1-retry";

export type { ScatterJob } from "./scatter-orchestrator-types";
export { isScatterParentJobId as isScatterJobId };

const MAX_ASSEMBLE_ATTEMPTS = 6;
const scatterDocKey = (id: string) => `renders/${id}/scatter-job.json`;
const scatterOutKey = (id: string) => `renders/${id}/film.mp4`;

async function loadScatterJob(env: Env, scatterId: string): Promise<ScatterJob | null> {
  const obj = await env.R2_RENDERS.get(scatterDocKey(scatterId));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as ScatterJob;
}

async function saveScatterJob(env: Env, job: ScatterJob): Promise<void> {
  await env.R2_RENDERS.put(scatterDocKey(job.scatter_id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function loadFilmJobDoc(env: Env, filmId: string): Promise<FilmJob | null> {
  const obj = await env.R2_RENDERS.get(filmJobDocKey(filmId));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as FilmJob;
}

export interface StartScatterArgs {
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  shot_ids: string[];
  shard_count: number;
  cast_loras: Record<string, unknown>;
  render_overrides?: Record<string, unknown>;
  motion_backend?: string;
  audio_key?: string;
  film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  user_email: string;
  project_id?: number | null;
}

/** Read the stored storyboard (D1 last_storyboard) and build the per-shot dialogue batch (authored
 *  line + cast-resolved voice). Returns [] when there's no project_id, no stored storyboard, or no
 *  dialogue -- a silent film. The bundle can't carry this (lossy), so D1 is the source of truth. */
async function resolveDialogueLines(
  env: Env,
  args: StartScatterArgs,
  voices: Record<string, string>,
  shotIds: string[],
): Promise<DialogueLine[]> {
  if (args.project_id == null) return [];
  const project = await getProjectById(env, args.project_id, args.user_email);
  if (!project?.last_storyboard) return [];
  return buildDialogueLines(project.last_storyboard, voices, shotIds);
}

export async function startScatterRender(env: Env, args: StartScatterArgs): Promise<ScatterJob> {
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  if (servingForHook(modules, "keyframe").length === 0) {
    throw new Error("no keyframe module installed (bind MODULE_KEYFRAME)");
  }
  if (servingForHook(modules, "motion.backend").length === 0) {
    throw new Error("no motion.backend module installed");
  }

  const { pretrained, voices, castIds, skipped } = await resolveCastLoras(env, args.cast_loras);
  if (!Object.keys(pretrained).length) {
    throw new Error(
      skipped.length
        ? "no ready cast LoRAs (train characters first)"
        : "castLoras required for scatter",
    );
  }

  const parsed = await readBundleScenes(env, args.bundle_key);
  const scenes: FilmScene[] = parsed.map((s) => ({
    shot_id: s.shot_id,
    prompt: s.prompt,
    seconds: s.seconds,
  }));
  const expected = args.shot_ids.filter((s) => typeof s === "string" && s.length > 0);
  if (expected.length < 2) throw new Error("scatter requires >= 2 shots");

  // Talking characters: the dialogue is dropped by the lossy bundle, so read the AUTHORITATIVE
  // storyboard from D1 (last_storyboard) and resolve each speaking shot's voice from the cast (voices,
  // off the same rows resolveCastLoras already read). Absent project_id / no dialogue -> a silent film.
  const dialogueLines = await resolveDialogueLines(env, args, voices, expected);

  const shards = scatterShards({
    shotIds: expected,
    shardCount: args.shard_count,
    pretrainedLoras: pretrained,
  });
  if (shards.length < 2) throw new Error("scatter requires >= 2 shards");

  const mapped = mapRenderOverridesToModuleConfigs(args.render_overrides, args.quality_tier, modules);
  const motionBackend = args.motion_backend ?? mapped.motion_backend ?? "own-gpu";
  const scatterId = scatterParentJobId(crypto.randomUUID());
  const stagedAudio = await resolveStagedAudioKey(env, args.audio_key);

  const scatterJob: ScatterJob = {
    scatter_id: scatterId,
    project: args.project,
    bundle_key: args.bundle_key,
    quality_tier: args.quality_tier,
    expected_shot_ids: expected,
    shard_film_ids: [],
    shard_shots: shards.map((s) => s.shots),
    motion_backend: motionBackend,
    audio_key: stagedAudio,
    has_dialogue: dialogueLines.length > 0,
    user_email: args.user_email,
    scenes,
    dialogue_lines: dialogueLines,
    film_titles: args.film_titles,
    film_finish_config: mapped.film_finish_config,
    project_id: args.project_id ?? null,
    render_overrides: args.render_overrides,
    phase: "shards",
    created_at: Date.now(),
  };

  // RUNNABILITY-FIRST (#289): build the shard FILM jobs (their docs live in R2), collecting the
  // render-row specs to persist to D1 afterwards. The D1 rows are a UI-list PROJECTION, not what
  // makes the render runnable -- so we never write them before the runnable R2 state.
  const shardRows: { jobId: string; status: string }[] = [];
  for (const shard of shards) {
    const shardScenes = filterScenesByShotIds(scenes, shard.shots);
    // Each shard runs its own finish chain (incl. lip-sync), so it carries only its shots' dialogue.
    const shardShotSet = new Set(shard.shots);
    const shardDialogue = dialogueLines.filter((l) => shardShotSet.has(l.shot_id));
    const film = await startFilmJob(env, {
      project: args.project,
      bundle_key: args.bundle_key,
      scenes: shardScenes,
      motion_backend: motionBackend,
      keyframe_backend: mapped.keyframe_backend,
      keyframe_config: mapped.keyframe_config,
      motion_config: mapped.motion_config,
      finish_config: mapped.finish_config,
      speech_config: mapped.speech_config,
      master_config: mapped.master_config,
      clips_only: true,
      pretrained_loras: shard.pretrainedLoras,
      cast_loras: castIds,
      user_email: args.user_email,
      dialogue_lines: shardDialogue,
    });
    scatterJob.shard_film_ids.push(film.film_id);
    shardRows.push({ jobId: film.film_id, status: filmJobToPollView(film, null).status });
  }

  await finalizeScatterSubmit(env, scatterJob, shardRows);
  return scatterJob;
}

/** Persist a scatter submit so it can NEVER orphan a render (#289).
 *
 *  The runnable R2 doc is written FIRST: the poll/advance path runs entirely off it
 *  (loadScatterJob), so once it lands the render is runnable and a later transient cannot strand
 *  it. The D1 render rows are a UI-list projection, written AFTER, best-effort: the parent (so the
 *  shards can FK it), then the shard rows as one all-or-nothing env.DB.batch, each wrapped in
 *  withD1Retry. A persistent D1 failure is logged as a structured d1.error and SWALLOWED -- the
 *  submit still succeeds (render is runnable) and the missing rows self-heal on the first poll
 *  (ensureScatterRenderRow). This is the cure for the orphan-row 422: a mid-submit blip can no
 *  longer leave a row with no job, nor fail the whole submit. The submit spans two stores (D1 rows
 *  + R2 docs), so a single DB.batch cannot make it truly atomic; runnability-first ordering plus
 *  self-heal makes the residual gap benign. */
export async function finalizeScatterSubmit(
  env: Env,
  scatterJob: ScatterJob,
  shardRows: { jobId: string; status: string }[],
): Promise<void> {
  await saveScatterJob(env, scatterJob); // <- render is RUNNABLE from here

  try {
    await withD1Retry(
      () =>
        insertRender(env, {
          jobId: scatterJob.scatter_id,
          project: scatterJob.project,
          bundleKey: scatterJob.bundle_key,
          qualityTier: scatterJob.quality_tier,
          renderOverrides: scatterJob.render_overrides,
          status: "IN_QUEUE",
          mode: "full",
          projectId: scatterJob.project_id ?? null,
        }),
      { label: "scatter.submit.parent" },
    );
    const parentId = await getRenderIdByJobId(env, scatterJob.scatter_id);
    if (shardRows.length) {
      const stmts = shardRows.map((r) =>
        buildInsertRenderStmt(env, {
          jobId: r.jobId,
          project: scatterJob.project,
          bundleKey: scatterJob.bundle_key,
          qualityTier: scatterJob.quality_tier,
          renderOverrides: scatterJob.render_overrides,
          status: r.status,
          mode: "full",
          projectId: scatterJob.project_id ?? null,
          parentId: parentId ?? undefined,
        }),
      );
      await withD1Retry(() => env.DB.batch(stmts), { label: "scatter.submit.shards" });
    }
  } catch (e) {
    // Render is already runnable off the R2 doc; the rows self-heal on first poll. Log, don't throw.
    console.log(JSON.stringify({
      ev: "d1.error", op: "scatter.submit.rows", scatter_id: scatterJob.scatter_id, code: d1ErrorCode(e),
    }));
  }
}

async function muxScatterAudio(env: Env, job: ScatterJob): Promise<void> {
  const silentKey = job.silent_film_key;
  const audioKey = job.audio_key;
  if (!silentKey || !audioKey) {
    job.film_key = silentKey;
    job.phase = "done";
    return;
  }
  if (!env.VIDEO_FINISH_VPC) {
    job.phase = "failed";
    job.error = "video-finish VPC binding not configured";
    return;
  }
  const outKey = job.mux_output_key ?? scatterOutKey(job.scatter_id);
  job.mux_output_key = outKey;
  const resp = await callVideoFinish(env, {
    clips: [{ url: await presignR2Get(env, silentKey, 1800) }],
    outputUrl: await presignR2Put(env, outKey, 1800),
    outputKey: outKey,
    audioUrl: await presignR2Get(env, audioKey, 1800),
    remuxAudioOnly: true,
  });
  if (!resp || !resp.ok) {
    job.phase = "failed";
    job.error = `scatter audio mux failed: HTTP ${resp?.status ?? "?"}`;
    return;
  }
  let body: { ok?: boolean; error?: string; durationSeconds?: number; shots?: number; clipsReceived?: number };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    job.phase = "failed";
    job.error = "scatter mux returned non-JSON";
    return;
  }
  if (!body.ok) {
    job.phase = "failed";
    job.error = `scatter mux failed: ${body.error || "unknown"}`;
    return;
  }
  job.film_key = outKey;
  job.phase = "done";
}

async function maybeFinalizeScatter(env: Env, job: ScatterJob): Promise<void> {
  if (job.phase !== "done" || !job.film_key) return;
  const st = await getFinishState(env, job.scatter_id);
  if (st?.finish_state === "done") return;
  await runScatterFilmFinish(env, job);
  await finalizeScatterDone(env, job);
}

/** Run the film.finish chain (subtitle / title / credit cards) on the assembled+muxed scatter film,
 *  mirroring the single-film path's inline film.finish (#284/#285). The assembled clip order ==
 *  expected_shot_ids order (orderFinalClips), so the FULL scenes + dialogue_lines give correctly aligned
 *  cumulative captions. FAIL-SAFE + idempotent: guarded by job.film_finish so a re-driven finalize never
 *  double-runs, and runFilmFinish soft-degrades (a card miss never drops the assembled film). */
async function runScatterFilmFinish(env: Env, job: ScatterJob): Promise<void> {
  if (job.film_finish || !job.film_key) return; // already run (or nothing to card)
  const r = await runFilmFinish(env, {
    film_key: job.film_key,
    // Caption scenes in the SAME order the gather assembles the clips (expected_shot_ids), NOT bundle
    // order, so buildCaptionCues' cumulative timeline matches the cut (the crux, #284/#285).
    scenes: orderScenesByShotIds(job.scenes ?? [], job.expected_shot_ids),
    dialogue_lines: job.dialogue_lines,
    film_titles: job.film_titles,
    film_finish_config: job.film_finish_config,
    bundle_key: job.bundle_key,
    project: job.project,
    job_id: job.scatter_id,
    user_email: job.user_email,
  });
  if (!r.ran) { job.film_finish = { applied: [], errors: [] }; return; } // no film.finish module -> mark + skip
  if (r.errors.length > 0) console.warn(`scatter film.finish errors for ${job.scatter_id}: ${r.errors.join("; ")}`);
  if (r.degraded) console.warn(`scatter film.finish degraded for ${job.scatter_id}: ${r.degraded} -- film shipped WITHOUT cards`);
  job.film_finish = { applied: r.applied, errors: r.errors, steps: r.steps, degraded: r.degraded };
  job.film_key = r.film_key;
  await saveScatterJob(env, job); // persist carded key + outcome before finalize records it
}

async function assembleScatterClips(
  env: Env,
  job: ScatterJob,
  clips: { shot_id: string; clip_key: string }[],
): Promise<void> {
  if (!env.VIDEO_FINISH_VPC) {
    job.phase = "failed";
    job.error = "video-finish VPC binding not configured";
    return;
  }
  const presigned: { url: string }[] = [];
  for (const c of clips) {
    presigned.push({ url: await presignR2Get(env, c.clip_key, 1800) });
  }
  const outputKey = scatterOutKey(job.scatter_id);
  // Talking film: the shards' lip-sync baked per-shot audio into each clip, so preserve it through the
  // concat (the container then silent-pads any audio-less clip to a uniform track). Without this the
  // gather strips ALL clip audio (-an) and the film comes out silent -- mirrors film-orchestrator's
  // single-film assemble (keepClipAudio on dialogue). Also keeps the audio of the clips that DID
  // lip-sync even when a sibling clip didn't, so one short finish chain can't silence the whole film.
  const resp = await callVideoFinish(env, {
    clips: presigned,
    outputUrl: await presignR2Put(env, outputKey, 1800),
    outputKey,
    keepClipAudio: !!job.has_dialogue,
  });
  const transport = classifyAssembleTransport(resp ? resp.status : null, job.assemble_attempts ?? 0, MAX_ASSEMBLE_ATTEMPTS);
  job.assemble_attempts = transport.attempts;
  if (transport.state === "retry") {
    job.phase = "gather";
    job.error = transport.error;
    return;
  }
  if (transport.state === "exhausted") {
    job.phase = "failed";
    job.error = transport.error;
    return;
  }
  if (!resp || !resp.ok) {
    job.phase = "failed";
    job.error = `video-finish gather returned ${resp?.status ?? "?"}`;
    return;
  }
  let body: { ok?: boolean; error?: string; durationSeconds?: number; shots?: number; clipsReceived?: number };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    job.phase = "failed";
    job.error = "video-finish gather returned non-JSON";
    return;
  }
  if (!body.ok) {
    job.phase = "failed";
    job.error = `video-finish gather failed: ${body.error || "unknown"}`;
    return;
  }
  // Fail loud: a scatter render must NEVER silently complete a PARTIAL film. If the assembled film
  // is materially shorter than the sum of the cut shots' durations, clips were dropped in the
  // assemble (a fetch miss or a concat truncation) -- error instead of shipping a 1-of-N film. This
  // closes the gap that let a 3-shot render COMPLETE with one shot; per-shot clips stay intact in R2
  // for a re-driven assemble. The 0.5 ratio catches a gross partial (v4 shipped 36%) while tolerating
  // legitimate per-clip tail/beat-trim (music films) without false alarms; the container-side guard
  // (output vs its actual normalized inputs) is the precise, false-positive-free backstop.
  const expectedSeconds = (job.scenes ?? [])
    .filter((s) => job.expected_shot_ids.includes(s.shot_id))
    .reduce((sum, s) => sum + (Number.isFinite(s.seconds) && s.seconds > 0 ? s.seconds : 0), 0);
  const assembledSeconds = typeof body.durationSeconds === "number" ? body.durationSeconds : 0;
  // [#287] instrumentation: clips we SENT vs the container received vs concatenated duration --
  // definitively locates a 3 -> 1 drop (worker-sent-fewer vs container-side) on the next run.
  console.log(JSON.stringify({
    ev: "scatter.assemble.result", scatter_id: job.scatter_id, sent: clips.length,
    clipsReceived: body.clipsReceived, shots: body.shots, durationSeconds: body.durationSeconds,
    expectedSeconds,
  }));
  if (expectedSeconds > 0 && assembledSeconds > 0 && assembledSeconds < expectedSeconds * 0.5) {
    job.phase = "failed";
    job.error = `assemble dropped clips: ${assembledSeconds.toFixed(1)}s assembled vs ~${expectedSeconds.toFixed(1)}s expected across ${job.expected_shot_ids.length} shots`;
    return;
  }
  job.silent_film_key = outputKey;
  if (job.audio_key) {
    job.phase = "mux";
    await muxScatterAudio(env, job);
  } else {
    job.film_key = outputKey;
    job.phase = "done";
  }
}

async function finalizeScatterDone(env: Env, job: ScatterJob): Promise<void> {
  if (!job.film_key) return;
  await markFinishDone(env, job.scatter_id, job.film_key, JSON.stringify({
    output_key: job.film_key,
    project: job.project,
    mode: "full",
  }));
  await fireNotifyForScatter(env, job);
}

async function advanceScatterGather(env: Env, job: ScatterJob): Promise<void> {
  const st = await getFinishState(env, job.scatter_id);
  const claimed = await claimFinish(env, job.scatter_id);
  if (!claimed && st?.finish_state !== "finishing") return;

  const clipMap = new Map<string, string>();
  for (const filmId of job.shard_film_ids) {
    const fj = await loadFilmJobDoc(env, filmId);
    if (!fj || fj.phase !== "done") continue;
    for (const [shotId, key] of (await clipKeysFromFilmJob(env, fj)).entries()) {
      clipMap.set(shotId, key);
    }
  }
  const clips = orderFinalClips(
    job.expected_shot_ids.map((shot_id) => ({ shot_id, prompt: "", seconds: 4 })),
    [...clipMap.entries()].map(([shot_id, clip_key]) => ({ shot_id, clip_key })),
  );
  // [#287] instrumentation: pin where 3 -> 1 happens. Logs shots_expected vs clips_gathered (and
  // the resolved shot ids) at the assemble decision; the container result is logged below.
  console.log(JSON.stringify({
    ev: "scatter.gather.assemble", scatter_id: job.scatter_id,
    shots_expected: job.expected_shot_ids.length, clips_gathered: clips.length,
    shot_ids: clips.map((c) => c.shot_id),
  }));
  if (clips.length !== job.expected_shot_ids.length) {
    const err = "gather: missing clips after finish decision";
    await markFinishFailed(env, job.scatter_id, err);
    job.phase = "failed";
    job.error = err;
    return;
  }

  await assembleScatterClips(env, job, clips);
  if (job.phase === "failed") {
    await markFinishFailed(env, job.scatter_id, job.error || "scatter gather failed");
  } else {
    await maybeFinalizeScatter(env, job);
  }
}

/** A shard's per-tick advance outcome. `ok` carries the loaded film job (use its phase); otherwise
 *  `doc_missing` = the film-job doc is gone from R2 (genuinely dead), `errored` = the advance threw
 *  (a transient blip or any mid-advance error -- UNDETERMINED this tick, NOT dead). */
export type ShardAdvanceOutcome =
  | { ok: true; job: FilmJob }
  | { ok: false; reason: "doc_missing" | "errored" };

/** Map a shard's advance outcome to its gather status. The key distinction (watchdog defense-in-
 *  depth): an `errored` shard is UNDETERMINED -> IN_PROGRESS (recoverable; the gather keeps waiting
 *  and retries), NOT a SHARD_DEAD status -- so a transient-D1-blocked shard is never declared
 *  "owning shard dead". Only a genuinely-failed phase or a vanished doc maps to FAILED. */
export function shardStatusForOutcome(outcome: ShardAdvanceOutcome): string {
  if (outcome.ok) return filmPhaseToShardStatus(outcome.job);
  return outcome.reason === "doc_missing" ? "FAILED" : "IN_PROGRESS";
}

/** Self-heal the D1 render row from the runnable R2 doc (#289). Cheap read first -- a no-op once
 *  the row exists (the normal path). Only when the row is MISSING (a submit whose best-effort D1
 *  write lost the flaky window) does it insert the row at the doc's current status and, when
 *  terminal, fill status/output via updateRenderFromView. Never aborts the advance: a transient is
 *  left for the next poll; a non-transient is logged. */
export async function ensureScatterRenderRow(
  env: Env,
  job: ScatterJob,
  ctx?: ExecutionContext,
): Promise<void> {
  try {
    if ((await getRenderIdByJobId(env, job.scatter_id)) != null) return;
    const view = scatterJobToPollView(job);
    await insertRender(env, {
      jobId: job.scatter_id,
      project: job.project,
      bundleKey: job.bundle_key,
      qualityTier: job.quality_tier,
      renderOverrides: job.render_overrides,
      status: view.status,
      mode: "full",
      projectId: job.project_id ?? null,
    });
    if (view.status !== "IN_PROGRESS") await updateRenderFromView(env, view, ctx);
    console.log(JSON.stringify({ ev: "scatter.selfheal.row", scatter_id: job.scatter_id, status: view.status }));
  } catch (e) {
    if (!isTransientD1Error(e)) {
      console.log(JSON.stringify({ ev: "d1.error", op: "scatter.selfheal.row", scatter_id: job.scatter_id, code: d1ErrorCode(e) }));
    }
    // never abort the advance for a projection-row write; a transient retries on the next poll.
  }
}

export async function advanceScatterJob(
  env: Env,
  scatterId: string,
  ctx?: ExecutionContext,
): Promise<RunpodJobView | null> {
  const job = await loadScatterJob(env, scatterId);
  if (!job) return null;
  // #289 self-heal: the submit writes the R2 doc before the D1 rows, so a mid-submit blip can
  // leave a runnable render whose UI-list row never got written. Insert it if missing (cheap read
  // first; no-op once it exists) so the render shows up and its terminal status/output get logged.
  await ensureScatterRenderRow(env, job, ctx);
  if (job.cancelled) return scatterJobToPollView(job);
  if (job.phase === "done" || job.phase === "failed") return scatterJobToPollView(job);

  const shardStatuses: ShardStatus[] = [];
  const present = new Set<string>();

  for (let i = 0; i < job.shard_film_ids.length; i++) {
    const filmId = job.shard_film_ids[i];
    const shots = job.shard_shots[i] ?? [];
    // Per-shard isolation (defense-in-depth, pairs with withD1Retry #229): a shard whose advance
    // ERRORS this tick (a transient D1/R2 blip outliving the in-tick retries, or any mid-advance
    // throw) is UNDETERMINED, not dead -- the catch keeps it IN_PROGRESS so the gather waits and
    // retries next tick instead of declaring its shots "owning shard dead", and one shard's error
    // no longer aborts the others' advance. Genuinely-dead still fails fast: a `failed` film phase
    // or a vanished film-job doc (null) both map to FAILED. A permanently-stuck shard is still
    // backstopped by the film job's own hard-deadline (it eventually reports phase=failed).
    let status: string;
    try {
      const r = await advanceFilmJob(env, filmId);
      if (r) {
        await updateRenderFromView(env, filmJobToPollView(r.job, r.clipJob), ctx);
        status = shardStatusForOutcome({ ok: true, job: r.job });
        if (r.job.phase === "done") {
          for (const [shotId] of (await clipKeysFromFilmJob(env, r.job)).entries()) {
            present.add(shotId);
          }
        }
      } else {
        status = shardStatusForOutcome({ ok: false, reason: "doc_missing" });
      }
    } catch (e) {
      const kind = isTransientD1Error(e) ? "transient D1" : "advance error";
      console.warn(
        `scatter ${scatterId} shard ${filmId} undetermined (${kind}); treating as in-progress, will retry: ${(e as Error).message}`,
      );
      status = shardStatusForOutcome({ ok: false, reason: "errored" });
    }
    shardStatuses.push({ status, shots });
  }

  if (job.phase === "shards") {
    const decision = gatherDecision([...present], job.expected_shot_ids, shardStatuses);
    if (decision.kind === "failed") {
      job.phase = "failed";
      job.error = decision.reason;
      await markRenderFailedByJobId(env, scatterId, decision.reason);
    } else if (decision.kind === "finish") {
      job.phase = "gather";
      await advanceScatterGather(env, job);
    }
  }
  if (job.phase === "gather") {
    await advanceScatterGather(env, job);
  }
  if (job.phase === "mux") {
    await muxScatterAudio(env, job);
    await maybeFinalizeScatter(env, job);
  }

  await saveScatterJob(env, job);
  const view = scatterJobToPollView(job);
  if (view.status !== "IN_PROGRESS") await updateRenderFromView(env, view, ctx);
  return view;
}

export function scatterJobToPollView(job: ScatterJob): RunpodJobView {
  let status: RunpodStatus;
  let output: Record<string, unknown> | undefined;

  if (job.cancelled) {
    status = "CANCELLED";
  } else if (job.phase === "done") {
    status = "COMPLETED";
    output = { output_key: job.film_key, project: job.project, mode: "full" };
  } else if (job.phase === "failed") {
    status = "FAILED";
  } else {
    status = "IN_PROGRESS";
    output = {
      phase: job.phase,
      project: job.project,
      shards: job.shard_film_ids.length,
      scene_total: job.expected_shot_ids.length,
    };
  }

  return {
    jobId: job.scatter_id,
    status,
    statusRaw: job.phase,
    output,
    error: job.error,
    executionTimeMs: Math.max(0, Date.now() - job.created_at),
  };
}

export async function cancelScatterJob(env: Env, scatterId: string): Promise<RunpodJobView | null> {
  const job = await loadScatterJob(env, scatterId);
  if (!job) return null;
  if (job.phase === "done" || job.phase === "failed") return scatterJobToPollView(job);
  job.cancelled = true;
  job.phase = "failed";
  job.error = "cancelled";
  for (const filmId of job.shard_film_ids) {
    await cancelFilmJob(env, filmId);
  }
  await saveScatterJob(env, job);
  return scatterJobToPollView(job);
}
