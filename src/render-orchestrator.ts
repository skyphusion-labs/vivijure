// Render-execution orchestrator: drive the motion.backend module per shot, ASYNC (invoke -> poll)
// and ACROSS REQUESTS, so a Worker never holds a multi-minute generation. POST starts the job
// (resolves the chosen motion.backend module, submits each shot, persists the poll tokens to an R2
// job doc). GET advances it (polls the shots still pending; the module's /poll finalizes a clip to
// R2 on completion). The caller polls GET until `complete`. Keyframes arrive as URLs -- the GPU
// keyframe stage feeds them later; for now the clip stage stands alone.
//
// State is an R2 json per job. GET only polls shots still pending (done ones are not re-polled, so
// no re-download). For concurrency-safe progress a Durable Object is the upgrade; this MVP assumes
// the caller polls sequentially.

import type { Env } from "./env";
import { discoverModules, invokeModule, pollModule, servingForHook, validateConfig } from "./modules/registry";
import type { MotionBackendInput, MotionBackendOutput, PollResponse } from "./modules/types";

export interface ClipShotInput {
  shot_id: string;
  keyframe_url: string;
  prompt: string;
  seconds: number;
}
export interface ClipShot extends ClipShotInput {
  status: "pending" | "done" | "failed";
  poll?: string;
  clip_key?: string;
  error?: string;
}
export interface ClipJob {
  job_id: string;
  project: string;
  motion_backend: string | null;
  binding: string | null;
  shots: ClipShot[];
  created_at: number;
}

interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
const asFetcher = (v: unknown): FetcherLike | null =>
  v && typeof (v as { fetch?: unknown }).fetch === "function" ? (v as FetcherLike) : null;

const jobKey = (jobId: string) => `renders/${jobId}/clips-job.json`;

export interface JobSummary {
  total: number;
  done: number;
  failed: number;
  pending: number;
  complete: boolean;
}
export function summarizeJob(job: ClipJob): JobSummary {
  const total = job.shots.length;
  const done = job.shots.filter((s) => s.status === "done").length;
  const failed = job.shots.filter((s) => s.status === "failed").length;
  return { total, done, failed, pending: total - done - failed, complete: done + failed === total };
}

/** Apply a /poll outcome to a shot (pure): failure -> failed; still pending -> unchanged; output ->
 *  done with the clip key. */
export function applyPoll(shot: ClipShot, r: PollResponse<MotionBackendOutput>): void {
  if (!r.ok) {
    shot.status = "failed";
    shot.error = r.error;
    return;
  }
  if ((r as { pending?: boolean }).pending) return; // still running
  shot.status = "done";
  shot.clip_key = (r as { output: MotionBackendOutput }).output.clip_key;
}

/** Start a clip job: resolve the motion.backend module, submit every shot, persist poll tokens. */
export async function startClipJob(
  env: Env,
  args: { project: string; shots: ClipShotInput[]; motion_backend?: string; config?: Record<string, unknown> },
): Promise<ClipJob> {
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const serving = servingForHook(modules, "motion.backend"); // ui.order sorted (matches the resolver)
  const mb = args.motion_backend ? serving.find((m) => m.name === args.motion_backend) ?? null : serving[0] ?? null;
  const config = mb ? validateConfig(mb.config_schema, args.config) : {};
  const binding = mb ? mb.binding : null;

  const job_id = "clips-" + crypto.randomUUID();
  const shots: ClipShot[] = [];
  for (const sh of args.shots) {
    const shot: ClipShot = { ...sh, status: "pending" };
    const fetcher = binding ? asFetcher(envRec[binding]) : null;
    if (!mb || !fetcher) {
      shot.status = "failed";
      shot.error = mb ? `module ${mb.name} (${binding}) is not bound` : "no motion.backend module installed";
      shots.push(shot);
      continue;
    }
    const r = await invokeModule<MotionBackendInput, MotionBackendOutput>(fetcher, {
      hook: "motion.backend",
      input: { shot_id: sh.shot_id, keyframe_url: sh.keyframe_url, prompt: sh.prompt, seconds: sh.seconds },
      config,
      context: { project: args.project, job_id },
    });
    if (!r.ok) {
      shot.status = "failed";
      shot.error = r.error;
    } else if ((r as { pending?: boolean }).pending) {
      shot.poll = (r as { poll: string }).poll; // stays pending; GET advances it
    } else if ("output" in r) {
      shot.status = "done";
      shot.clip_key = (r.output as MotionBackendOutput).clip_key; // a synchronous module
    } else {
      shot.status = "failed";
      shot.error = "module returned neither output nor a poll token";
    }
    shots.push(shot);
  }

  const job: ClipJob = {
    job_id,
    project: args.project,
    motion_backend: mb ? mb.name : null,
    binding,
    shots,
    created_at: Date.now(),
  };
  await env.R2_RENDERS.put(jobKey(job_id), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  return job;
}

/** Advance a clip job: poll the shots still pending; the module finalizes a clip to R2 on done. */
export async function advanceClipJob(env: Env, jobId: string): Promise<ClipJob | null> {
  const obj = await env.R2_RENDERS.get(jobKey(jobId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as ClipJob;
  const envRec = env as unknown as Record<string, unknown>;
  const fetcher = job.binding ? asFetcher(envRec[job.binding]) : null;
  for (const shot of job.shots) {
    if (shot.status !== "pending" || !shot.poll) continue;
    if (!fetcher) {
      shot.status = "failed";
      shot.error = "module binding no longer bound";
      continue;
    }
    const p = await pollModule<MotionBackendOutput>(fetcher, { poll: shot.poll });
    applyPoll(shot, p);
  }
  await env.R2_RENDERS.put(jobKey(jobId), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  return job;
}
