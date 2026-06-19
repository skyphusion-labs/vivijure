// Background cron sweep: advance film / scatter jobs that have no client polling.

import type { Env } from "./env";
import { advanceFilmJob, filmJobDocKey } from "./film-orchestrator";
import { filmJobToPollView, isFilmJobId } from "./film-render-bridge";
import { advanceScatterJob, isScatterJobId } from "./scatter-orchestrator";
import { listStrandedPostClipsFilmJobs, listUnresolvedNotifiableJobs, updateRenderFromView } from "./renders-db";

/** Max age for jobs the sweep still tries to resolve (24h, matches RunPod job TTL). */
export const SWEEP_MAX_AGE_SECONDS = 24 * 3600;

export async function sweepUnresolvedJobs(env: Env, ctx?: ExecutionContext): Promise<number> {
  // Pass 1: jobs young enough to still be live on RunPod (keyframe / clips can still
  // be polled). This is the common path.
  const jobIds = await listUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS);
  // Pass 2: post-clips film jobs that aged out of pass 1 but stalled before "done"
  // with their clips already rendered to R2. The remaining work (the CPU-only concat)
  // never expires, so we keep re-driving them -- gated on the film-job doc still
  // existing in R2 so we never chase a swept/GC'd job. De-dup against pass 1.
  const seen = new Set(jobIds);
  const stranded: string[] = [];
  for (const id of await listStrandedPostClipsFilmJobs(env, SWEEP_MAX_AGE_SECONDS)) {
    if (!seen.has(id) && isFilmJobId(id) && (await filmJobDocExists(env, id))) {
      seen.add(id);
      stranded.push(id);
    }
  }
  let n = 0;
  for (const jobId of [...jobIds, ...stranded]) {
    try {
      const handled = await resolveOneJob(env, jobId, ctx);
      if (handled) n += 1;
    } catch (e) {
      console.warn(`render sweep failed for ${jobId}: ${(e as Error).message}`);
    }
  }
  return n;
}

/** Cheap presence check: a stranded film job is only worth re-driving if its job doc
 *  (which carries the finished clip keys) is still in R2. A swept doc means the clips
 *  are gone too -- nothing to assemble -- so we skip it. */
async function filmJobDocExists(env: Env, jobId: string): Promise<boolean> {
  try {
    return (await env.R2_RENDERS.head(filmJobDocKey(jobId))) !== null;
  } catch {
    return false;
  }
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
