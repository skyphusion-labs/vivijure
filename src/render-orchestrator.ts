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
import { discoverModules, invokeModule, pollModule, cancelModule, resolveFetcher, servingForHook, validateConfig } from "./modules/registry";
import type { MotionBackendInput, MotionBackendOutput, PollResponse, RegisteredModule } from "./modules/types";
import { hookOutputViolation } from "./modules/conformance";
import { validateClipArtifact } from "./clip-validate";

export interface ClipShotInput {
  shot_id: string;
  keyframe_url: string;
  keyframe_key?: string; // the underlying R2 key; an own-GPU backend that shares the bucket reads it
  prompt: string;
  seconds: number;
  motion_backend?: string; // per-shot module name; falls back to the job default
}
export interface ClipShot extends ClipShotInput {
  status: "pending" | "done" | "failed";
  poll?: string;
  clip_key?: string;
  error?: string;
  binding?: string | null; // resolved env binding for this shot's motion module
  // #536: the backend RunPod job id from the async-accept envelope (#318 jobId), retained so a cancel /
  // orphan log can NAME the job. Absent when the module omits the optional field.
  runpod_job_id?: string;
  // #536: set once a best-effort remote cancel has been ATTEMPTED for this shot (failed shot or teardown),
  // so the driver does not re-fire the cancel on every subsequent tick. Best-effort, whatever the outcome.
  cancel_sent?: boolean;
  // #523 Layer 1: structural output-validation verdict for this shot clip, set once (idempotent).
  // "fail" flips the shot to failed and is sticky so R2-presence reclaim never re-adopts a rejected clip.
  validated?: "pass" | "fail" | "skip";
  // #523 Layer 2: pixel-content verdict (video-finish container), set once at the film finish gate.
  content_validated?: "ok" | "suspect" | "corrupt" | "skip";
  content_degraded?: string; // set on a "suspect" warn/degrade; the film still completes
  // #707: what the motion backend actually DELIVERED (a fixed-grid backend honestly clamps, e.g.
  // CogVideoX pins 8fps with per-tier frame caps, so a 5s plan can land as a 3.1s clip). The module
  // output has always carried fps+frames; retaining them here lets the film summary surface
  // delivered-vs-planned per shot instead of staying silent about the clamp. Absent when the module
  // reported no usable numbers (frames=0 sentinel included) -- absence is honest, never fabricated.
  delivered_fps?: number;
  delivered_frames?: number;
}
export interface ClipJob {
  job_id: string;
  project: string;
  motion_backend: string | null;
  binding: string | null;
  module_configs?: Record<string, Record<string, unknown>>;
  shots: ClipShot[];
  created_at: number;
}


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
  const output = (r as { output: MotionBackendOutput }).output;
  const violation = hookOutputViolation(shot.motion_backend ?? "motion.backend", "motion.backend", output);
  if (violation) { shot.status = "failed"; shot.error = violation; return; } // envelope-ok but off-contract: fail loud, never advance garbage
  shot.status = "done";
  shot.clip_key = output.clip_key;
  // #707: retain what the backend delivered so the film summary can show delivered-vs-planned. The
  // contract has always carried fps+frames; modules with nothing to report send frames=0 (sentinel) --
  // treat that as absent rather than recording a fabricated 0-frame delivery.
  if (typeof output.fps === "number" && output.fps > 0 && typeof output.frames === "number" && output.frames > 0) {
    shot.delivered_fps = output.fps;
    shot.delivered_frames = output.frames;
  }
}

/** Pure: does an R2 clips-object filename belong to this shot? The backend writes a finished motion clip
 *  per shot under `renders/<project>/clips/`, named with the shot id followed by a NON-digit separator
 *  (e.g. `shot_09_i2v.mp4`, `shot_09_seedance.mp4`). Match the shot id only at a digit boundary so
 *  `shot_1` never swallows `shot_10`; exclude `_finished*` (finish-chain outputs, not motion clips);
 *  require a video extension. Matches by shot-id boundary, NOT the backend's exact slug, so it stays
 *  independent of the backend naming convention (the core never hardcodes where the backend wrote). */
export function clipFileMatchesShot(file: string, shotId: string): boolean {
  if (!file.startsWith(shotId)) return false;
  const rest = file.slice(shotId.length);
  if (rest.length === 0) return false; // need a separator + extension
  if (/^\d/.test(rest)) return false; // digit boundary: shot_1 must not match shot_10...
  if (/(^|[._-])finished([._-]|$)/i.test(rest)) return false; // finish-chain output, not a motion clip
  return /\.(mp4|mov|webm|mkv)$/i.test(file); // a video file
}

/** Pure: does an R2 clips-object filename belong to this shot's FINISH-chain output? The finish modules
 *  write `renders/<project>/clips/<shot_id>_finished.mp4`. Same shot-id digit boundary as the motion-clip
 *  matcher, but here the `_finished` marker is REQUIRED (it is the finish output, not the raw motion clip)
 *  and a video extension is required. Matches by boundary + the `finished` marker, not a hardcoded full
 *  slug, so it stays independent of the backend convention. */
export function finishedClipFileMatchesShot(file: string, shotId: string): boolean {
  if (!file.startsWith(shotId)) return false;
  const rest = file.slice(shotId.length);
  if (/^\d/.test(rest)) return false; // digit boundary: shot_1 must not match shot_10...
  if (!/(^|[._-])finished([._-]|$)/i.test(rest)) return false; // MUST be a finish-chain output
  return /\.(mp4|mov|webm|mkv)$/i.test(file);
}

/** Map shot_id -> R2 key for the objects under `renders/<project>/clips/` that match `matches` (by shot-id
 *  boundary). Makes R2 PRESENCE the authority on completion: an artifact in R2 beats a module's poll
 *  verdict (the backend wrote it even if its RunPod job was later GC'd and the module fast-failed the
 *  poll; issue #141). `matches` selects the raw motion clip (default) or the finish output. Only the
 *  requested shot ids are returned. */
export async function listClipsByShotId(
  env: Env,
  project: string,
  shotIds: string[],
  matches: (file: string, shotId: string) => boolean = clipFileMatchesShot,
  minUploadedMs = 0,
): Promise<Map<string, string>> {
  const prefix = `renders/${project}/clips/`;
  const found = new Map<string, string>(); // shot_id -> key (first match wins)
  let cursor: string | undefined;
  do {
    const listed = await env.R2_RENDERS.list({ prefix, cursor, limit: 1000 });
    for (const o of listed.objects) {
      // Freshness guard (#661): when a floor is set, skip any clip written BEFORE this run started. A prior
      // render of the same project name leaves clips at the identical renders/<project>/clips/<shot>_<backend>
      // path; without this the stall/fail reclaim adopts a 4-day-old clip and ships wrong content silently
      // (the #245/#249 class). This run own clips always upload AFTER the job created_at, so the legit #141
      // reclaim survives. R2Object.uploaded is a Date; job stamps are epoch ms -- normalize explicitly.
      if (minUploadedMs && o.uploaded.getTime() < minUploadedMs) continue;
      const file = o.key.slice(prefix.length);
      for (const shotId of shotIds) {
        if (!found.has(shotId) && matches(file, shotId)) found.set(shotId, o.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return found;
}

/** Start a clip job: resolve the motion.backend module per shot, submit, persist poll tokens. */
export async function startClipJob(
  env: Env,
  args: {
    project: string;
    shots: ClipShotInput[];
    motion_backend?: string;
    config?: Record<string, unknown>;
    module_configs?: Record<string, Record<string, unknown>>;
  },
  preModules?: RegisteredModule[],
): Promise<ClipJob> {
  const envRec = env as unknown as Record<string, unknown>;
  const modules = preModules ?? await discoverModules(envRec);
  const serving = servingForHook(modules, "motion.backend");
  const defaultMb = args.motion_backend
    ? serving.find((m) => m.name === args.motion_backend) ?? null
    : serving[0] ?? null;
  const moduleConfigs = args.module_configs ?? {};
  const defaultConfig = defaultMb
    ? validateConfig(defaultMb.config_schema, args.config ?? moduleConfigs[defaultMb.name])
    : {};

  const job_id = "clips-" + crypto.randomUUID();
  const shots: ClipShot[] = [];
  for (const sh of args.shots) {
    const shot: ClipShot = { ...sh, status: "pending" };
    const mbName = sh.motion_backend ?? args.motion_backend ?? defaultMb?.name;
    const mb = mbName ? serving.find((m) => m.name === mbName) ?? null : defaultMb;
    const binding = mb ? mb.binding : null;
    shot.binding = binding;
    shot.motion_backend = mb?.name ?? undefined;
    const fetcher = binding ? resolveFetcher(envRec, binding) : null;
    const config = mb
      ? validateConfig(mb.config_schema, moduleConfigs[mb.name] ?? (mb.name === defaultMb?.name ? args.config : undefined) ?? args.config)
      : defaultConfig;
    if (!mb || !fetcher) {
      shot.status = "failed";
      shot.error = mb ? `module ${mb.name} (${binding}) is not bound` : "no motion.backend module installed";
      shots.push(shot);
      continue;
    }
    const r = await invokeModule<MotionBackendInput, MotionBackendOutput>(fetcher, {
      hook: "motion.backend",
      input: { shot_id: sh.shot_id, keyframe_url: sh.keyframe_url, keyframe_key: sh.keyframe_key, prompt: sh.prompt, seconds: sh.seconds },
      config,
      context: { project: args.project, job_id },
    });
    if (!r.ok) {
      shot.status = "failed";
      shot.error = r.error;
    } else if ((r as { pending?: boolean }).pending) {
      shot.poll = (r as { poll: string }).poll;
      shot.runpod_job_id = (r as { jobId?: string }).jobId; // #536: retain the backend job id for cancel/accounting
    } else if ("output" in r) {
      const output = r.output as MotionBackendOutput;
      const violation = hookOutputViolation(mb.name, "motion.backend", output);
      if (violation) { shot.status = "failed"; shot.error = violation; }
      else { shot.status = "done"; shot.clip_key = output.clip_key; }
    } else {
      shot.status = "failed";
      shot.error = "module returned neither output nor a poll token";
    }
    shots.push(shot);
  }

  const job: ClipJob = {
    job_id,
    project: args.project,
    motion_backend: defaultMb ? defaultMb.name : null,
    binding: defaultMb ? defaultMb.binding : null,
    module_configs: Object.keys(moduleConfigs).length ? moduleConfigs : undefined,
    shots,
    created_at: Date.now(),
  };
  await env.R2_RENDERS.put(jobKey(job_id), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  return job;
}

/** Advance a clip job: poll the shots still pending; the module finalizes a clip to R2 on done. */
export async function advanceClipJob(env: Env, jobId: string, preModules?: RegisteredModule[]): Promise<ClipJob | null> {
  const obj = await env.R2_RENDERS.get(jobKey(jobId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as ClipJob;
  const envRec = env as unknown as Record<string, unknown>;
  for (const shot of job.shots) {
    if (shot.status !== "pending" || !shot.poll) continue;
    const binding = shot.binding ?? job.binding;
    const fetcher = binding ? resolveFetcher(envRec, binding) : null;
    if (!fetcher) {
      shot.status = "failed";
      shot.error = "module binding no longer bound";
      continue;
    }
    const p = await pollModule<MotionBackendOutput>(fetcher, { poll: shot.poll });
    applyPoll(shot, p);
  }
  // R2 PRESENCE IS AUTHORITATIVE (issue #141): reclaim any FAILED shot whose clip is in R2 -- whether it
  // failed this pass or a prior one -- so a #142 fast-fail can never drop a shot whose clip actually
  // landed. Runs BEFORE the caller's summarizeJob() complete/advance judgment. (The caller also calls
  // reclaimClipsFromR2 again right before its complete-check; both are idempotent + cheap.)
  await reclaimClipsFromR2(env, job);
  // #536: a shot still FAILED that had started a remote job (it held a poll token) may have left the RunPod
  // job running -- fire a best-effort cancel so the backend does not keep burning GPU after the studio gave
  // up (the 307s-of-H200 zombie observed on the S18 gate). reclaimClipsFromR2 ran first, so a shot whose
  // clip actually landed is already done and skipped. A module without /cancel logs an honest orphan.
  await cancelFailedShots(env, job, preModules);
  await validateDoneClips(env, job); // #523 Layer 1: structural gate before the caller advances to finish/upscale spend
  await env.R2_RENDERS.put(jobKey(jobId), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  return job;
}

/** #536: fire a best-effort remote cancel for every shot that is FAILED, held a poll token (so a remote
 *  job was started), and has not been cancelled yet. Discovers the registry only when there IS an orphan to
 *  cancel (the happy path pays nothing); the film tick threads its once-discovered registry in. */
async function cancelFailedShots(env: Env, job: ClipJob, preModules?: RegisteredModule[]): Promise<void> {
  const orphans = job.shots.filter((s) => s.status === "failed" && s.poll && !s.cancel_sent);
  if (!orphans.length) return;
  const envRec = env as unknown as Record<string, unknown>;
  const modules = preModules ?? await discoverModules(envRec);
  for (const shot of orphans) await cancelShotRemote(envRec, job, shot, modules);
}

/** #536: cancel ONE shot in-flight RunPod job via its motion module (cancelModule, keyed by the poll
 *  token, exactly as cancelInFlightKeyframe does for the keyframe phase). Records cancel_sent so it fires
 *  at most once, and NAMES the RunPod job in every orphan log so a left-running job is actionable. Mirrors
 *  the honest-orphan discipline: an unbound module or a module with no cancel primitive logs loudly, it
 *  never hides the leak. */
async function cancelShotRemote(envRec: Record<string, unknown>, job: ClipJob, shot: ClipShot, modules: RegisteredModule[]): Promise<void> {
  const jobId = shot.runpod_job_id ?? "(job id unknown)";
  const binding = shot.binding ?? job.binding;
  const mb = binding ? (modules.find((m) => m.binding === binding) ?? null) : null;
  const fetcher = binding ? resolveFetcher(envRec, binding) : null;
  shot.cancel_sent = true; // best-effort ONCE, whatever the outcome -- never re-fire every tick
  if (!mb || !fetcher) {
    console.warn(`clip job ${job.job_id}: cannot cancel failed shot ${shot.shot_id} -- module ${binding ?? "?"} not bound; RunPod job ${jobId} left running (ORPHAN) (#536)`);
    return;
  }
  if (!mb.cancelable) {
    console.warn(`clip job ${job.job_id}: motion module ${mb.name} has no cancel primitive (cancelable=false); RunPod job ${jobId} for shot ${shot.shot_id} left running (ORPHAN) (#536)`);
    return;
  }
  const r = await cancelModule(fetcher, { poll: shot.poll as string });
  if (r.ok) console.warn(`clip job ${job.job_id}: cancelled in-flight RunPod job ${jobId} for failed shot ${shot.shot_id} via ${mb.name} (#536)`);
  else console.warn(`clip job ${job.job_id}: cancel FAILED (${r.error}) for shot ${shot.shot_id} -- RunPod job ${jobId} left running (ORPHAN) (#536)`);
}

/** #536: teardown cancel -- STOP every in-flight (pending, poll-token-bearing) shot RunPod job when a clip
 *  job is cancelled/torn down, so a user-cancelled render does not leave the GPU running (the motion-phase
 *  sibling of cancelInFlightKeyframe; cancelFilmJob calls this off the clips phase). Persists cancel_sent.
 *  No-op when nothing is in flight. */
export async function cancelInFlightClips(env: Env, jobId: string, preModules?: RegisteredModule[]): Promise<void> {
  const obj = await env.R2_RENDERS.get(jobKey(jobId));
  if (!obj) return;
  const job = JSON.parse(await obj.text()) as ClipJob;
  const inflight = job.shots.filter((s) => s.status === "pending" && s.poll && !s.cancel_sent);
  if (!inflight.length) return;
  const envRec = env as unknown as Record<string, unknown>;
  const modules = preModules ?? await discoverModules(envRec);
  for (const shot of inflight) await cancelShotRemote(envRec, job, shot, modules);
  await env.R2_RENDERS.put(jobKey(jobId), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
}

/** R2 PRESENCE IS THE SOURCE OF TRUTH for clip completion. Mutates the clip job in place: any shot that
 *  is NOT done but whose motion clip is present in R2 (matched by shot-id boundary) is marked done with
 *  that key (pending OR failed -- the artifact overrides a module's premature fast-fail; issue #141). A
 *  shot with no R2 clip is left as-is (a genuine non-render). Only lists R2 when there is at least one
 *  not-done shot to reclaim (the all-done happy path pays nothing). Returns the number adopted. This is
 *  the single reclaim used both inside advanceClipJob AND by the film orchestrator before it judges the
 *  clip job complete, so a fast-fail at 150s can never advance the film with a clip dropped. */
export async function reclaimClipsFromR2(env: Env, job: ClipJob): Promise<number> {
  const notDone = job.shots.filter((s) => s.status !== "done" && s.validated !== "fail");
  if (!notDone.length) return 0;
  const present = await listClipsByShotId(env, job.project, notDone.map((s) => s.shot_id), clipFileMatchesShot, job.created_at);
  let adopted = 0;
  for (const shot of notDone) {
    if (present.has(shot.shot_id)) {
      shot.status = "done";
      shot.clip_key = present.get(shot.shot_id);
      shot.poll = undefined;
      shot.error = undefined; // clear a premature failure; the artifact is the source of truth
      shot.validated = undefined; // #523: re-validate the freshly-adopted artifact
      adopted += 1;
    }
  }
  return adopted;
}

/** #523 Layer 1: validate each newly-done clip's STRUCTURE (mp4 box tree) before the finish / dialogue /
 *  upscale chain spends anything. Engine-agnostic: every motion.backend clip (cloud backend, both local
 *  doors, any future module) funnels through this one chokepoint. Idempotent per shot via `validated`, so
 *  it runs at most once and can be called from more than one seam. A structural FAILURE flips the shot to
 *  failed with the real reason (honest-failure #245/#249: never a silent advance, never applied=[]) and
 *  clears its poll token so the orphan-cancel pass ignores a clip that already landed. A "skip" (artifact
 *  unreadable / validation disabled) leaves the shot untouched -- an I/O blip must never false-reject a
 *  real render. Emits one `clip.validate` structured event per shot (docs/observability.md) so smoke tests
 *  assert on the event, not prose. Returns true iff it changed any shot; the CALLER owns the job-doc write.
 *
 *  HONEST SCOPE: this catches the STRUCTURAL-corruption class (truncated / empty / zero-frame /
 *  zero-duration / non-mp4). It does NOT catch the local-16gb#35 pure-noise clip, which is a structurally
 *  valid mp4 -- that needs a pixel decode (Layer 2, a video-finish-container pre-gate, filed separately). */
export async function validateDoneClips(env: Env, job: ClipJob): Promise<boolean> {
  let changed = false;
  for (const shot of job.shots) {
    if (shot.status !== "done" || !shot.clip_key || shot.validated) continue;
    const res = await validateClipArtifact(env, shot.clip_key, shot.seconds);
    shot.validated = res.verdict;
    console.log(JSON.stringify({
      ev: "clip.validate",
      job_id: job.job_id,
      shot_id: shot.shot_id,
      verdict: res.verdict,
      checks: res.checks,
      ...(res.reason ? { reason: res.reason } : {}),
    }));
    if (res.verdict === "fail") {
      shot.status = "failed";
      shot.error = `clip failed output validation: ${res.reason}`;
      shot.poll = undefined; // it already produced a (bad) artifact; do not fire an orphan cancel
      changed = true;
    }
  }
  return changed;
}
