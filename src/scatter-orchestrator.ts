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
  type FilmJob,
  type FilmScene,
} from "./film-orchestrator";
import { filmJobToPollView, filterScenesByShotIds, mapRenderOverridesToModuleConfigs } from "./film-render-bridge";
import { presignR2Get, presignR2Put } from "./r2-presign";
import { resolveStagedAudioKey } from "./audio-stage";
import { discoverModules, servingForHook } from "./modules/registry";
import { readBundleScenes } from "./bundle-storyboard";
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
  markFinishDone,
  markFinishFailed,
  markRenderFailedByJobId,
  updateRenderFromView,
} from "./renders-db";
import { resolveCastLoras } from "./cast-loras";
import { fireNotifyForScatter } from "./scatter-notify";

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
  user_email: string;
  project_id?: number | null;
}

export async function startScatterRender(env: Env, args: StartScatterArgs): Promise<ScatterJob> {
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  if (servingForHook(modules, "keyframe").length === 0) {
    throw new Error("no keyframe module installed (bind MODULE_KEYFRAME)");
  }
  if (servingForHook(modules, "motion.backend").length === 0) {
    throw new Error("no motion.backend module installed");
  }

  const { pretrained, skipped } = await resolveCastLoras(env, args.user_email, args.cast_loras);
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
    user_email: args.user_email,
    phase: "shards",
    created_at: Date.now(),
  };

  await insertRender(env, {
    userEmail: args.user_email,
    jobId: scatterId,
    project: args.project,
    bundleKey: args.bundle_key,
    qualityTier: args.quality_tier,
    renderOverrides: args.render_overrides,
    status: "IN_QUEUE",
    mode: "full",
    projectId: args.project_id ?? null,
  });
  const parentId = await getRenderIdByJobId(env, scatterId);

  for (const shard of shards) {
    const shardScenes = filterScenesByShotIds(scenes, shard.shots);
    const film = await startFilmJob(env, {
      project: args.project,
      bundle_key: args.bundle_key,
      scenes: shardScenes,
      motion_backend: motionBackend,
      keyframe_config: mapped.keyframe_config,
      motion_config: mapped.motion_config,
      finish_config: mapped.finish_config,
      clips_only: true,
      pretrained_loras: shard.pretrainedLoras,
      user_email: args.user_email,
    });
    scatterJob.shard_film_ids.push(film.film_id);
    const view = filmJobToPollView(film, null);
    await insertRender(env, {
      userEmail: args.user_email,
      jobId: film.film_id,
      project: args.project,
      bundleKey: args.bundle_key,
      qualityTier: args.quality_tier,
      renderOverrides: args.render_overrides,
      status: view.status,
      mode: "full",
      projectId: args.project_id ?? null,
      parentId: parentId ?? undefined,
    });
  }

  await saveScatterJob(env, scatterJob);
  return scatterJob;
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
  let body: { ok?: boolean; error?: string };
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
  await finalizeScatterDone(env, job);
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
  const resp = await callVideoFinish(env, {
    clips: presigned,
    outputUrl: await presignR2Put(env, outputKey, 1800),
    outputKey,
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
  let body: { ok?: boolean; error?: string };
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

export async function advanceScatterJob(
  env: Env,
  scatterId: string,
  ctx?: ExecutionContext,
): Promise<RunpodJobView | null> {
  const job = await loadScatterJob(env, scatterId);
  if (!job) return null;
  if (job.cancelled) return scatterJobToPollView(job);
  if (job.phase === "done" || job.phase === "failed") return scatterJobToPollView(job);

  const shardStatuses: ShardStatus[] = [];
  const present = new Set<string>();

  for (let i = 0; i < job.shard_film_ids.length; i++) {
    const filmId = job.shard_film_ids[i];
    const shots = job.shard_shots[i] ?? [];
    const r = await advanceFilmJob(env, filmId);
    if (r) {
      const view = filmJobToPollView(r.job, r.clipJob);
      await updateRenderFromView(env, view, ctx);
      shardStatuses.push({ status: filmPhaseToShardStatus(r.job), shots });
      if (r.job.phase === "done") {
        for (const [shotId] of (await clipKeysFromFilmJob(env, r.job)).entries()) {
          present.add(shotId);
        }
      }
    } else {
      shardStatuses.push({ status: "FAILED", shots });
    }
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
