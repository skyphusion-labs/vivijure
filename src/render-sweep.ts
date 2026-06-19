// Background cron sweep: advance film / scatter jobs that have no client polling.

import type { Env } from "./env";
import { advanceFilmJob } from "./film-orchestrator";
import { filmJobToPollView, isFilmJobId } from "./film-render-bridge";
import { advanceScatterJob, isScatterJobId } from "./scatter-orchestrator";
import { listUnresolvedNotifiableJobs, updateRenderFromView } from "./renders-db";

/** Max age for jobs the sweep still tries to resolve (24h, matches RunPod job TTL). */
export const SWEEP_MAX_AGE_SECONDS = 24 * 3600;

export async function sweepUnresolvedJobs(env: Env, ctx?: ExecutionContext): Promise<number> {
  const jobIds = await listUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS);
  let n = 0;
  for (const jobId of jobIds) {
    try {
      const handled = await resolveOneJob(env, jobId, ctx);
      if (handled) n += 1;
    } catch (e) {
      console.warn(`render sweep failed for ${jobId}: ${(e as Error).message}`);
    }
  }
  return n;
}

async function resolveOneJob(env: Env, jobId: string, ctx?: ExecutionContext): Promise<boolean> {
  if (isScatterJobId(jobId)) {
    const view = await advanceScatterJob(env, jobId, ctx);
    return view !== null;
  }
  if (isFilmJobId(jobId)) {
    const r = await advanceFilmJob(env, jobId);
    if (!r) return false;
    await updateRenderFromView(env, filmJobToPollView(r.job, r.clipJob), ctx);
    return true;
  }
  return false;
}
