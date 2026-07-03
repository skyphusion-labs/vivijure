// Cast-image orchestrator: drive the `cast.image` module to generate a cast member's LoRA TRAINING
// reference set, then register the generated images onto the member. Same async run/poll-across-
// requests pattern as the film + clip orchestrators: a 10-image set can't finish inside one Worker
// request, so the module renders a few images per /poll and this orchestrator advances it on each GET
// (the caller polls to `done`). No Worker ever holds a multi-minute image batch open.
//
//   POST /api/cast/:id/generate-refs  -> startCastRefsJob: presign the seed refs, invoke cast.image.
//   GET  /api/cast/:id/refs-job/:jobId -> advanceCastRefsJob: poll the module; on done, addRefs.
//
// cast.image is `pick_one`: one installed module answers (the module owns the model + prompt set).

import type { Env } from "./env";
import { discoverModules, invokeModule, pollModule, resolveFetcher, resolvePickOne, validateConfig } from "./modules/registry";
import type { CastImageInput, CastImageOutput } from "./modules/types";
import { hookOutputViolation } from "./modules/conformance";
import { presignR2Get } from "./r2-presign";
import { getCastById, addRefs, type CastRefImage } from "./cast-db";

/** A cast-refs generation job. The module keeps its OWN run state (an R2 doc) + poll token; this job
 *  doc only tracks the orchestrator's view: which module answers, the module's poll token, and the
 *  registered result. Stored in R2 (keyed by cast + job), advanced one GET at a time. */
export interface CastRefsJob {
  job_id: string;
  cast_id: number;
  // The cast member's opaque public id, exposed to the client in the summary (cast_id stays the
  // internal int: it keys the R2 job doc + is the cast.image module-contract field). S9 (F13).
  cast_public_id: string;
  module_name: string | null;
  binding: string | null;
  phase: "generating" | "done" | "failed";
  module_poll?: string;        // the cast.image module's own poll token (round-tripped unchanged)
  images: CastRefImage[];      // generated refs, registered onto the cast member on done
  applied: string[];           // what the module did (e.g. ["model:flux-2-klein-9b", "generated:10"])
  registered: number;          // how many refs were appended to the cast member
  error?: string;
  created_at: number;
}


const REF_TTL = 1800;  // 30min presign -- covers the whole multi-image run (a few polls of work)
const MAX_REFS = 4;    // FLUX 2 caps multi-reference inputs at 4 (nano-banana at 3); cap the seed set

export const castRefsJobKey = (castId: number, jobId: string) => `cast-gen/${castId}/${jobId}.refs-job.json`;

/** Pure: the reference seed set the module conditions on -- the portrait first (the identity seed),
 *  then the requested source photos (validated against the member's own sources), de-duped and capped
 *  at MAX_REFS. When the member has no portrait, the first valid source becomes the seed so a member
 *  with only uploaded sources can still generate (mirrors the cast-page gate: portrait OR sources). */
export function selectSeedKeys(
  portraitKey: string | null,
  sourceKeys: { key: string }[],
  wantKeys: string[] | undefined,
  max = MAX_REFS,
): string[] {
  const valid = new Set(sourceKeys.map((s) => s.key));
  const want = (wantKeys ?? []).filter((k) => valid.has(k));
  const out: string[] = [];
  if (portraitKey) out.push(portraitKey);
  for (const k of want) if (!out.includes(k)) out.push(k);
  return out.slice(0, max);
}

export interface CastRefsSummary {
  job_id: string;
  cast_id: string;  // the cast's opaque public id (never the internal integer PK)
  phase: CastRefsJob["phase"];
  module?: string;
  registered: number;
  images: CastRefImage[];
  error?: string;
}

/** Pure: the caller-facing view of a job (what the route returns). */
export function summarizeCastRefs(job: CastRefsJob): CastRefsSummary {
  return {
    job_id: job.job_id,
    cast_id: job.cast_public_id,
    phase: job.phase,
    module: job.module_name ?? undefined,
    registered: job.registered,
    images: job.images,
    error: job.error,
  };
}

const putJob = (env: Env, job: CastRefsJob) =>
  env.R2_RENDERS.put(castRefsJobKey(job.cast_id, job.job_id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
  });

/** Internal: a finished module run -> register the generated refs onto the cast member (one batch
 *  write), record what it applied, phase -> done. A run that produced nothing still completes (the
 *  caller sees registered=0, not an error -- the failure, if any, is in the module's error). */
async function finalize(env: Env, job: CastRefsJob, output: CastImageOutput): Promise<void> {
  const imgs = (output.images || []).filter((i) => i && i.key && i.mime);
  job.images = imgs;
  job.applied = output.applied || [];
  if (imgs.length) {
    const row = await addRefs(env, job.cast_id, imgs);
    job.registered = row ? imgs.length : 0;
  }
  job.phase = "done";
}

/** Start a cast-refs job: resolve the cast.image module, presign the seed refs, invoke it, persist
 *  the poll token. Returns null when the cast member does not exist (the route 404s); a missing
 *  module / portrait is a failed job (phase "failed" + error), not null. */
export async function startCastRefsJob(
  env: Env,
  args: {
    castId: number;
    config?: Record<string, unknown>;
    artStyle?: string;
    sourceKeys?: string[];
    choice?: string;
  },
): Promise<CastRefsJob | null> {
  const cast = await getCastById(env, args.castId);
  if (!cast) return null;

  const job: CastRefsJob = {
    job_id: "refs-" + crypto.randomUUID(),
    cast_id: args.castId,
    cast_public_id: cast.public_id,
    module_name: null,
    binding: null,
    phase: "generating",
    images: [],
    applied: [],
    registered: 0,
    created_at: Date.now(),
  };

  const seedKeys = selectSeedKeys(cast.portrait_key, cast.source_keys, args.sourceKeys);
  if (!seedKeys.length) {
    job.phase = "failed";
    job.error = "cast member has no portrait or source photo to generate from";
    await putJob(env, job);
    return job;
  }

  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const module = resolvePickOne(modules, "cast.image", args.choice);
  if (!module) {
    job.phase = "failed";
    job.error = args.choice ? `no cast.image module named "${args.choice}"` : "no cast.image module installed";
    await putJob(env, job);
    return job;
  }
  job.module_name = module.name;
  job.binding = module.binding;
  const fetcher = resolveFetcher(envRec, module.binding);
  if (!fetcher) {
    job.phase = "failed";
    job.error = `cast.image module ${module.name} (${module.binding}) is not bound`;
    await putJob(env, job);
    return job;
  }

  // Presign the seed keys -- the module fetches them to condition the generation (the studio's R2 is
  // private, so a cloud image model needs a fetchable URL; mirrors how motion.backend gets keyframe_url).
  const urls = await Promise.all(seedKeys.map((k) => presignR2Get(env, k, REF_TTL)));
  const input: CastImageInput = {
    cast_id: args.castId,
    portrait_url: urls[0],
    portrait_key: seedKeys[0],
    source_urls: urls.slice(1),
    bible: cast.bible ?? undefined,
    art_style: args.artStyle,
  };
  const config = validateConfig(module.config_schema, args.config);
  const r = await invokeModule<CastImageInput, CastImageOutput>(fetcher, {
    hook: "cast.image",
    input,
    config,
    context: { project: `cast-${args.castId}`, job_id: job.job_id },
  });
  if (!r.ok) {
    job.phase = "failed";
    job.error = r.error;
  } else if ((r as { pending?: boolean }).pending) {
    job.module_poll = (r as { poll: string }).poll;
  } else if ("output" in r) {
    const out = (r as { output: CastImageOutput }).output;
    const violation = hookOutputViolation(module.name, "cast.image", out);
    if (violation) { job.phase = "failed"; job.error = violation; }
    else await finalize(env, job, out); // sync path
  } else {
    job.phase = "failed";
    job.error = "cast.image module returned neither output nor a poll token";
  }

  await putJob(env, job);
  return job;
}

/** Advance a cast-refs job: poll the module; on completion, register the refs and finish. Returns
 *  null when no such job exists (the route 404s). A terminal job (done/failed) is returned unchanged. */
export async function advanceCastRefsJob(env: Env, castId: number, jobId: string): Promise<CastRefsJob | null> {
  const obj = await env.R2_RENDERS.get(castRefsJobKey(castId, jobId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as CastRefsJob;
  if (job.phase !== "generating" || !job.module_poll || !job.binding) return job;

  const envRec = env as unknown as Record<string, unknown>;
  const fetcher = resolveFetcher(envRec, job.binding);
  if (!fetcher) {
    job.phase = "failed";
    job.error = "cast.image module no longer bound";
    await putJob(env, job);
    return job;
  }
  const p = await pollModule<CastImageOutput>(fetcher, { poll: job.module_poll });
  if (!p.ok) {
    job.phase = "failed";
    job.error = p.error;
  } else if (!(p as { pending?: boolean }).pending) {
    const out = (p as { output: CastImageOutput }).output;
    const violation = hookOutputViolation(job.module_name ?? "cast.image", "cast.image", out);
    if (violation) { job.phase = "failed"; job.error = violation; }
    else await finalize(env, job, out);
  }
  await putJob(env, job);
  return job;
}
