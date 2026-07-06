// Film orchestrator: the keyframe -> clip handoff. The connective tissue that turns a storyboard
// into moving clips by sequencing two async stages ACROSS REQUESTS, on the same R2-job-doc +
// caller-poll pattern the clip orchestrator uses (a Durable Object is the later upgrade for both):
//   phase "keyframe": run the keyframe module (project preview) -> keyframe keys (out-of-request).
//   phase "clips":    presign each keyframe key -> keyframe_url, feed {shot_id, keyframe_url, prompt,
//                     seconds} into the clip orchestrator (motion.backend, out-of-request).
// POST /api/render/film starts it; GET /api/render/film/:id advances it; the caller polls to `done`.
// No Worker ever holds a multi-minute GPU/cloud render.

import type { Env } from "./env";
import { discoverModules, invokeModule, pollModule, cancelModule, resolveFetcher, servingForHook, validateConfig, dispatchChain } from "./modules/registry";
import { loadInstallConfig } from "./operator-config";
import type { KeyframeInput, KeyframeOutput, FinishInput, FinishOutput, ConfigSchema, NotifyInput, NotifyOutput, DialogueLine, DialogueInput, DialogueOutput, SpeechInput, SpeechOutput, MasterInput, MasterOutput, FilmFinishInput, FilmFinishOutput, RegisteredModule } from "./modules/types";
import {
  startClipJob, advanceClipJob, cancelInFlightClips, summarizeJob, clipFileMatchesShot, finishedClipFileMatchesShot, listClipsByShotId, reclaimClipsFromR2, validateDoneClips,
  type ClipShotInput, type ClipJob, type JobSummary,
} from "./render-orchestrator";
import { hookOutputViolation } from "./modules/conformance";
import { presignR2Get, presignR2Put, FILM_DOWNLOAD_TTL_SECONDS } from "./r2-presign";
import { readShotDurationsFromBundle } from "./bundle-assembler";
import { contentValidateDoneClips } from "./clip-content-validate";
import { buildCaptionCues } from "./captions";
import { resolveStagedAudioKey } from "./audio-stage";
import { coerceShotId } from "./storyboard-validate";
import { getCastById, markLoraReady } from "./cast-db";
import { claimFilmAdvance, releaseFilmAdvance, type FilmAdvanceClaim } from "./renders-db";
import { withD1Retry } from "./d1-retry";
import { deriveLoraDestKey } from "./lora-bundle";

// The pure film model (S6 split): shapes + synchronous logic live in film-model.ts; this file owns
// the I/O. Re-exported below so every existing importer keeps its single entry point.
import {
  filmJobDocKey as filmKey, clipJobDocKey as clipDocKey,
  type FilmScene, type FinishShot, type SpeechShot, type FilmKeyframeRef, type FilmJob, type MasterState,
  summarizeFinish, summarizeFilm, orderFinalClips, joinKeyframesToScenes, filmPhaseToShardStatus,
  applyFinishOutput, applySpeechOutput,
  FINISH_STEP_MAX_ATTEMPTS, classifyFinishFailure, classifyFinishRetry, resolveFinishConfigs,
  finishShotAdoptableFromR2, reclaimFinishShotsFromR2, finishStepOutputKey, finishStepAppliedTag,
  classifyAssembleTransport,
  MASTER_STEP_MAX_ATTEMPTS, MASTER_STALL_SECONDS, filmSeconds, masteredBedKey, applyMasterOutput,
  degradeMasterStep, masterChainDone,
  coerceSceneIds, coerceDialogueLineIds,
  KEYFRAME_STALL_SECONDS, PHASE_HARD_DEADLINE_SECONDS, POLLABLE_PHASES, phaseAgeSeconds, filmProgressMarker,
} from "./film-model";

export * from "./film-model";


/** Cheap existence check for an R2 object (HEAD, no body). Used to derive assemble
 *  completion from R2 presence so a stalled-after-PUT concat self-heals (issue #122). */
async function r2ObjectExists(env: Env, key: string): Promise<boolean> {
  try {
    return (await env.R2_RENDERS.head(key)) !== null;
  } catch {
    return false;
  }
}

/** Collect finished clip keys from a terminal clips_only (or full) film job doc. */
export async function clipKeysFromFilmJob(
  env: Env,
  job: FilmJob,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (job.finish_shots?.length) {
    // Finish WAS set up for this job: the assembled clips are the FINISHED ones only. Never substitute
    // a raw i2v clip for a finish shot that did not reach "done" -- that silent-degrade (#245/#246)
    // shipped unfinished clips marked done with applied=[] (wan: RIFE crashed at idx 0 -> the shot
    // "failed" -> the job fell through to the raw _wan clip). A failed finish fails the render in
    // advanceFinishPhase; this is the defense-in-depth so assemble can never ship a raw clip.
    for (const fs of job.finish_shots) {
      if (fs.status === "done" && fs.clip_key) out.set(fs.shot_id, fs.clip_key);
    }
    return out;
  }
  // No finish modules installed (finish_shots empty) -> assemble the raw i2v clips (the clips_only path).
  if (!job.clip_job_id) return out;
  const cjObj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
  if (!cjObj) return out;
  const clipJob = JSON.parse(await cjObj.text()) as ClipJob;
  for (const sh of clipJob.shots) {
    if (sh.status === "done" && sh.clip_key) out.set(sh.shot_id, sh.clip_key);
  }
  return out;
}

/** Internal: keyframes-only path -- record keys and mark done (no i2v / assemble). */
function completeKeyframesOnly(job: FilmJob, kfOut: KeyframeOutput): void {
  const kfs = kfOut.keyframes || [];
  if (!kfs.length) {
    job.phase = "failed";
    job.error = "keyframe stage produced no keyframes";
    return;
  }
  job.keyframes = kfs.map((k) => ({ shot_id: k.shot_id, keyframe_key: k.keyframe_key }));
  job.phase = "done";
}

/** Bank any freshly-trained cast LoRA so a character is trained ONCE and reused across every project,
 *  instead of retrained on every render. THE long-standing bug: inline-trained adapters were saved to
 *  R2 but never written back to cast_members, so resolveCastLoras never saw them `ready` and the
 *  backend retrained the same LoRA every render (a silent ~20-min tax). For each slot the keyframe
 *  module reports under trained_loras, map slot -> cast id via job.cast_loras, copy the render-scoped
 *  adapter to a character-stable key (survives project deletion), and mark the cast member ready.
 *  Reused slots (backend reports the already-banked key) and unmapped slots are no-ops; a versioned
 *  stable key keyed on job.created_at makes a retry idempotent. Best-effort but LOUD on failure
 *  (unlike the silent state-tar restore it replaces). Keyed on cast id (PK) only. */
async function recordTrainedLorasToCast(env: Env, job: FilmJob, kfOut: KeyframeOutput): Promise<void> {
  const trained = kfOut.trained_loras;
  const castIds = job.cast_loras;
  if (!trained || !castIds) return;
  for (const [slot, srcKey] of Object.entries(trained)) {
    const castId = castIds[slot];
    if (!Number.isInteger(castId) || castId <= 0 || typeof srcKey !== "string" || !srcKey) continue;
    const stableKey = deriveLoraDestKey(castId, job.created_at);
    try {
      // Advance hot path: a transient D1 blip here would needlessly skip banking a freshly-trained
      // adapter (-> a wasteful retrain next render), so retry the cast read + readiness write.
      const cast = await withD1Retry(() => getCastById(env, castId));
      if (!cast) continue;
      // Reused this render (srcKey == current key) or already banked this render (retry): no-op.
      if (cast.lora_status === "ready" && (cast.lora_key === srcKey || cast.lora_key === stableKey)) continue;
      const obj = await env.R2_RENDERS.get(srcKey);
      if (!obj) { console.warn(`recordTrainedLoras: adapter missing in R2 (${srcKey}); cast ${castId} not banked`); continue; }
      await env.R2_RENDERS.put(stableKey, obj.body);
      await withD1Retry(() => markLoraReady(env, castId, stableKey));
      console.log(`recordTrainedLoras: cast ${castId} slot ${slot} banked ${srcKey} -> ${stableKey} (cross-project reuse)`);
    } catch (e) {
      console.warn(`recordTrainedLoras: cast ${castId} slot ${slot} failed: ${(e as Error).message}`);
    }
  }
}

/** Internal: after keyframes, either stop (preview) or hand off to the clip orchestrator. */
async function afterKeyframeOutput(env: Env, job: FilmJob, kfOut: KeyframeOutput, preModules?: RegisteredModule[]): Promise<void> {
  // Bank trained adapters before anything else, so a character LoRA is recorded even for a
  // keyframes-only preview / regen (which is exactly where the perpetual retrain hurt most).
  await recordTrainedLorasToCast(env, job, kfOut);
  if (job.keyframes_only) {
    completeKeyframesOnly(job, kfOut);
    return;
  }
  await advanceToClips(env, job, kfOut, preModules);
}

/** Internal: presign each matched keyframe -> start the clip job, advancing the film to phase=clips. */
async function advanceToClips(env: Env, job: FilmJob, kfOut: KeyframeOutput, preModules?: RegisteredModule[]): Promise<void> {
  const { matched, missing } = joinKeyframesToScenes(job.scenes, kfOut.keyframes || []);
  if (!matched.length) {
    job.phase = "failed";
    job.error = `keyframe stage produced none of the requested shots (missing: ${missing.join(", ")})`;
    return;
  }
  const shots: ClipShotInput[] = [];
  for (const m of matched) {
    const keyframe_url = await presignR2Get(env, m.keyframe_key, 1800); // 30min: covers a long cloud i2v job
    shots.push({ shot_id: m.shot_id, keyframe_url, prompt: m.prompt, seconds: m.seconds });
  }
  const clip = await startClipJob(env, {
    project: job.project, shots,
    motion_backend: job.motion_backend ?? undefined,
    config: job.motion_config,
  }, preModules);
  job.clip_job_id = clip.job_id;
  job.phase = "clips";
}

const putFilm = (env: Env, job: FilmJob) =>
  env.R2_RENDERS.put(filmKey(job.film_id), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });

/** Internal: clips done -> set up the finish chain (one FinishShot per done clip). No finish modules
 *  installed -> skip straight to assemble (the raw clips). No clips rendered at all -> fail (nothing
 *  to assemble). */
async function enterFinishPhase(env: Env, job: FilmJob, clipJob: ClipJob, preModules?: RegisteredModule[]): Promise<void> {
  // #523 Layer 1 defense-in-depth: validate any clip that reached done via a film-level R2 reclaim after
  // advanceClipJob's own pass, so finish/dialogue/upscale never spends on a structurally-corrupt clip. The
  // `validated` flag makes this idempotent (a no-op on the normal path). Persist if it dropped a shot so
  // the clip-job summary stays honest.
  if (job.clip_job_id && (await validateDoneClips(env, clipJob))) {
    await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
  }
  // #523 Layer 2: pixel-content gate (video-finish container) at the finish spend boundary. A "corrupt"
  // verdict fails the shot here, so finish/upscale never spends on a noise clip; "suspect" degrades. A
  // no-op when the tier is not installed (self-host) -- Layer 1 still stands. Persist if it changed a shot.
  if (job.clip_job_id && (await contentValidateDoneClips(env, clipJob))) {
    await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
  }
  const modules = preModules ?? await discoverModules(env as unknown as Record<string, unknown>);
  const serving = servingForHook(modules, "finish"); // ui.order; the full finish chain
  const chain = serving.map((m) => m.binding);
  const configs = resolveFinishConfigs(serving, job.finish_config);
  const doneClips = clipJob.shots.filter((s) => s.status === "done" && s.clip_key);
  if (!doneClips.length) { job.phase = "failed"; job.error = "no clips rendered to assemble"; return; }
  if (!chain.length) {
    job.phase = job.clips_only ? "done" : "assemble";
    return;
  }
  job.finish_shots = doneClips.map((s) => ({
    shot_id: s.shot_id, clip_key: s.clip_key as string, chain, configs, idx: 0, status: "pending" as const, applied: [],
  }));
  // finish_shots are built; interpose the dialogue phase (synthesize per-shot speech) before finish so
  // a lip-sync finish module has the audio to drive the mouth. No dialogue -> straight to finish.
  await enterDialogueOrFinish(env, job, preModules);
}

/** Fold a dialogue module's batch result into the per-shot audio map the finish stage reads. */
function applyDialogueOutput(job: FilmJob, out: DialogueOutput): void {
  const map: Record<string, string> = {};
  for (const a of out?.audio || []) {
    if (a && typeof a.shot_id === "string" && typeof a.audio_key === "string") map[a.shot_id] = a.audio_key;
  }
  job.dialogue_audio = map;
}

/** After finish_shots are built: if the film has dialogue lines AND a `dialogue` module is installed,
 *  submit the per-shot speech batch and enter the dialogue phase; otherwise go straight to finish. A
 *  submit failure (or no module) soft-degrades to a SILENT finish -- a dialogue glitch must never fail
 *  a fully-rendered film (lip-sync no-ops without an audio_key). */
async function enterDialogueOrFinish(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  const lines = job.dialogue_lines;
  if (!lines || !lines.length) { await enterSpeechOrFinish(env, job, preModules); return; }
  const envRec = env as unknown as Record<string, unknown>;
  const dialogueModule = servingForHook(preModules ?? await discoverModules(envRec), "dialogue")[0];
  const fetcher = dialogueModule ? resolveFetcher(envRec, dialogueModule.binding) : null;
  if (!fetcher) { await enterSpeechOrFinish(env, job, preModules); return; }  // no dialogue module bound: silent film
  const req = {
    hook: "dialogue" as const,
    input: { project: job.project, lines } as DialogueInput,
    config: {},
    context: { project: job.project, job_id: job.film_id },
  };
  const r = await invokeModule<DialogueInput, DialogueOutput>(fetcher, req);
  if (!r.ok) { console.warn(`film ${job.film_id}: dialogue submit failed (${r.error}); silent finish`); await enterSpeechOrFinish(env, job, preModules); return; }
  if ((r as { pending?: boolean }).pending) { job.dialogue_poll = (r as { poll: string }).poll; job.phase = "dialogue"; return; }
  if ("output" in r) {
    const v = hookOutputViolation(dialogueModule.name, "dialogue", r.output);
    if (v) { console.warn(`film ${job.film_id}: dialogue ${v}; silent finish`); await enterSpeechOrFinish(env, job, preModules); return; }
    applyDialogueOutput(job, r.output as DialogueOutput);
  }
  await enterSpeechOrFinish(env, job, preModules);
}

/** Poll the in-flight dialogue batch. On done, record the per-shot audio map and advance to finish; a
 *  failure soft-degrades to a silent finish (the rendered clips are fine, just unvoiced). */
async function advanceDialoguePhase(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  if (!job.dialogue_poll) { await enterSpeechOrFinish(env, job, preModules); return; }
  const envRec = env as unknown as Record<string, unknown>;
  const dialogueModule = servingForHook(preModules ?? await discoverModules(envRec), "dialogue")[0];
  const fetcher = dialogueModule ? resolveFetcher(envRec, dialogueModule.binding) : null;
  if (!fetcher) { job.dialogue_poll = undefined; await enterSpeechOrFinish(env, job, preModules); return; }
  const p = await pollModule<DialogueOutput>(fetcher, { poll: job.dialogue_poll });
  if (!p.ok) { console.warn(`film ${job.film_id}: dialogue failed (${p.error}); silent finish`); job.dialogue_poll = undefined; await enterSpeechOrFinish(env, job, preModules); return; }
  if ((p as { pending?: boolean }).pending) return;  // still synthesizing
  const out = (p as { output: DialogueOutput }).output;
  const v = hookOutputViolation(dialogueModule.name, "dialogue", out);
  if (v) { console.warn(`film ${job.film_id}: dialogue ${v}; silent finish`); job.dialogue_poll = undefined; await enterSpeechOrFinish(env, job, preModules); return; }
  applyDialogueOutput(job, out);
  job.dialogue_poll = undefined;
  await enterSpeechOrFinish(env, job, preModules);
}

/** After dialogue is resolved: if any `speech` module is installed AND there is dialogue audio to clean,
 *  build the per-shot speech chain and enter the speech phase; otherwise go straight to finish. No speech
 *  module, or no shot with dialogue audio -> straight to finish (an unvoiced film needs no speech pass). */
async function enterSpeechOrFinish(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  const audio = job.dialogue_audio ?? {};
  const shotIds = Object.keys(audio);
  if (!shotIds.length) { job.phase = "finish"; return; }  // unvoiced film: nothing to enhance
  const serving = servingForHook(preModules ?? await discoverModules(env as unknown as Record<string, unknown>), "speech"); // ui.order
  const chain = serving.map((m) => m.binding);
  if (!chain.length) { job.phase = "finish"; return; }  // no speech modules installed: passthrough to finish
  const configs = resolveFinishConfigs(serving, job.speech_config ?? {});
  job.speech_shots = shotIds.map((shot_id) => ({
    shot_id, audio_key: audio[shot_id], chain, configs, idx: 0, status: "pending" as const, applied: [],
  }));
  job.phase = "speech";
}

/** Advance the speech chain: per shot, submit its current speech module or poll the in-flight one,
 *  chaining the enhanced audio forward on completion. A transient invocation/poll blip re-dispatches the
 *  step up to the cap (classifyFinishRetry, shared with finish); a DETERMINISTIC failure does NOT fail the
 *  render -- speech is a POLISH step, so a hard step failure DEGRADES the shot (keep its current audio,
 *  record the reason, mark the chain done) rather than failing a fully-rendered film (#249/#77). When
 *  every shot is terminal, fold the cleaned (or, on a degrade, original) audio back into job.dialogue_audio
 *  -- so a lip-sync finish module drives the mouth from it -- and advance to finish. */
async function advanceSpeechPhase(env: Env, job: FilmJob): Promise<void> {
  const envRec = env as unknown as Record<string, unknown>;
  const degrade = (ss: SpeechShot, reason: string): void => {
    // A hard failure on a POLISH step: keep the current audio (original survives), record the reason
    // honestly (no fake applied tag), advance idx so the chain completes. The render never fails here.
    ss.degraded = reason;
    ss.idx += 1; ss.poll = undefined; ss.attempts = 0;
    if (ss.idx >= ss.chain.length) ss.status = "done";
  };
  const blipOrDegrade = (ss: SpeechShot, error: string | undefined, keepPoll: boolean): void => {
    const d = classifyFinishRetry(error, ss.attempts ?? 0); // reuse the shared transient classifier
    if (d.action === "retry") {
      ss.attempts = d.attempts;
      ss.error = `speech ${ss.chain[ss.idx]} transient (attempt ${d.attempts}/${FINISH_STEP_MAX_ATTEMPTS}), retrying: ${error ?? ""}`;
      if (!keepPoll) ss.poll = undefined;
    } else {
      degrade(ss, `${ss.chain[ss.idx]}: ${error ?? "speech step failed"}`);
    }
  };
  for (const ss of job.speech_shots || []) {
    if (ss.status !== "pending") continue;
    const fetcher = resolveFetcher(envRec, ss.chain[ss.idx]);
    if (!fetcher) { degrade(ss, `speech module ${ss.chain[ss.idx]} not bound`); continue; }
    const req = {
      hook: "speech" as const,
      input: { shot_id: ss.shot_id, audio_key: ss.audio_key } as SpeechInput,
      config: ss.configs?.[ss.idx] ?? {},
      context: { project: job.project, job_id: job.film_id },
    };
    if (!ss.poll) {
      const r = await invokeModule<SpeechInput, SpeechOutput>(fetcher, req);
      if (!r.ok) { blipOrDegrade(ss, r.error, false); }
      else if ((r as { pending?: boolean }).pending) { ss.poll = (r as { poll: string }).poll; }
      else if ("output" in r) { const v = hookOutputViolation(ss.chain[ss.idx], "speech", r.output); if (v) { degrade(ss, v); } else { applySpeechOutput(ss, r.output as SpeechOutput); } }
      else { degrade(ss, "speech module returned neither output nor a poll token"); }
    } else {
      const p = await pollModule<SpeechOutput>(fetcher, { poll: ss.poll });
      if (p.ok && !(p as { pending?: boolean }).pending) {
        const out = (p as { output: SpeechOutput }).output;
        const v = hookOutputViolation(ss.chain[ss.idx], "speech", out);
        if (v) { degrade(ss, v); } else { applySpeechOutput(ss, out); }
      } else if (!p.ok && classifyFinishFailure(p.error) === "transient") {
        blipOrDegrade(ss, p.error, true);
      } else if (!p.ok) {
        blipOrDegrade(ss, p.error, false);
      }
      // else: still pending -> leave it for the next tick
    }
  }
  const speechShots = job.speech_shots || [];
  if (speechShots.every((ss) => ss.status !== "pending")) {
    // Fold the cleaned (or, on a degrade, original) audio back into dialogue_audio so a lip-sync finish
    // module drives the mouth from it. This is the single point folding speech results into film state.
    for (const ss of speechShots) (job.dialogue_audio ??= {})[ss.shot_id] = ss.audio_key;
    job.phase = "finish";
  }
}

/** R2-authoritative recovery for a finish step whose RunPod job is GONE (poll 404s, GC'd-after-complete)
 *  or FROZEN (envelope stuck IN_PROGRESS so /poll pends forever, #166) MID-chain: if THIS step's expected
 *  output (finishStepOutputKey) is already in R2, fold it in and advance idx so the next module dispatches
 *  -- instead of pending to the hard-deadline. Distinct from finishShotAdoptableFromR2, which adopts only
 *  the chain's FINAL artifact: this advances ONE step on its OWN predicted output, so the remaining modules
 *  still run and it can never ship a half-finished clip (the mid-chain phantom-adopt the silent-render bug
 *  warned against). Returns true iff it advanced the step. */
async function adoptFinishStepFromR2(env: Env, job: FilmJob, fs: FinishShot, preModules?: RegisteredModule[]): Promise<boolean> {
  // The tick threads its once-discovered registry in (preModules); a direct caller discovers fresh.
  const modules = preModules ?? await discoverModules(env as unknown as Record<string, unknown>);
  const expected = finishStepOutputKey(job.project, fs, modules);
  if (!expected) return false;
  if ((await env.R2_RENDERS.head(expected)) === null) return false;
  applyFinishOutput(fs, { shot_id: fs.shot_id, clip_key: expected, out_fps: 0, frames: 0, applied: [finishStepAppliedTag(fs, modules)] });
  return true;
}

/** Advance the finish chain: per shot, submit its current finish module or poll the in-flight one,
 *  chaining to the next module on completion. Phase -> assemble when every shot is terminal. */
async function advanceFinishPhase(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  const envRec = env as unknown as Record<string, unknown>;
  // A transient invocation/poll blip re-dispatches the step (status stays `pending`) up to the cap
  // instead of failing it; a deterministic reject or the cap exhausted fails loud. `keepPoll` keeps a
  // poll token to re-poll (a lost poll) vs clearing it to re-submit (a failed invoke).
  const failOrRetry = (fs: FinishShot, error: string | undefined, keepPoll: boolean): void => {
    const d = classifyFinishRetry(error, fs.attempts ?? 0);
    if (d.action === "retry") {
      fs.attempts = d.attempts;
      fs.error = `finish ${fs.chain[fs.idx]} transient (attempt ${d.attempts}/${FINISH_STEP_MAX_ATTEMPTS}), retrying: ${error ?? ""}`;
      if (!keepPoll) fs.poll = undefined; // re-submit next tick; status stays "pending"
    } else {
      fs.status = "failed";
      fs.error = error;
    }
  };
  for (const fs of job.finish_shots || []) {
    if (fs.status !== "pending") continue;
    const fetcher = resolveFetcher(envRec, fs.chain[fs.idx]);
    if (!fetcher) { fs.status = "failed"; fs.error = `finish module ${fs.chain[fs.idx]} not bound`; continue; }
    const req = {
      hook: "finish" as const,
      input: { shot_id: fs.shot_id, clip_key: fs.clip_key, audio_key: job.dialogue_audio?.[fs.shot_id] } as FinishInput,
      config: fs.configs?.[fs.idx] ?? {}, // validated per-module config (issue #75); {} only for legacy jobs
      context: { project: job.project, job_id: job.film_id },
    };
    if (!fs.poll) {
      const r = await invokeModule<FinishInput, FinishOutput>(fetcher, req);
      if (!r.ok) { failOrRetry(fs, r.error, false); }
      else if ((r as { pending?: boolean }).pending) { fs.poll = (r as { poll: string }).poll; }
      else if ("output" in r) { const v = hookOutputViolation(fs.chain[fs.idx], "finish", r.output); if (v) { fs.status = "failed"; fs.error = v; } else { applyFinishOutput(fs, r.output as FinishOutput); } }
      else { fs.status = "failed"; fs.error = "finish module returned neither output nor a poll token"; }
    } else {
      const p = await pollModule<FinishOutput>(fetcher, { poll: fs.poll });
      if (p.ok && !(p as { pending?: boolean }).pending) {
        const out = (p as { output: FinishOutput }).output;
        const v = hookOutputViolation(fs.chain[fs.idx], "finish", out);
        if (v) { fs.status = "failed"; fs.error = v; } else { applyFinishOutput(fs, out); }
      } else if (!p.ok && classifyFinishFailure(p.error) === "transient") {
        failOrRetry(fs, p.error, true); // a transport blip: re-poll the same job under the cap
      } else if (!(await adoptFinishStepFromR2(env, job, fs, preModules))) {
        // The step's RunPod job is GONE (a deterministic poll failure -- 404 job-not-found, the
        // GC'd-after-complete path) or FROZEN (envelope stuck IN_PROGRESS so /poll pends forever, #166),
        // and this step's output is NOT in R2. A deterministic failure with no artifact fails loud; a
        // still-pending poll with no artifact stays pending (the job may yet finish, or its output land).
        // The whole point: a mid-chain finish step can no longer pend forever when its output is in R2 --
        // the wedge that stalled the showcase (RIFE done, idx never advanced, lip-sync never dispatched).
        if (!p.ok) failOrRetry(fs, p.error, true);
      }
      // else: adoptFinishStepFromR2 folded this step's R2 output in and advanced idx (R2 authoritative).
    }
  }
  // R2 PRESENCE IS AUTHORITATIVE (issue #141), symmetric to the clips reclaim: the finish output may
  // already be in R2 at renders/<project>/clips/<shot>_finished.mp4 even though the module verdict says
  // otherwise -- a shot it fast-failed on a GC'd job (#141), OR a last-chain shot stuck `pending` because
  // the RunPod envelope froze at IN_PROGRESS and the poll never sees COMPLETED (RUN #29). Reclaim any
  // adoptable shot whose finished clip is present BEFORE the every-terminal judgment, so the finish phase
  // never advances dropping a shot -- and never false-fails at the hard-deadline -- with the clip in R2.
  // Only one R2 list, only when there is an adoptable shot to reclaim (the all-done happy path pays nothing).
  const finishShots = job.finish_shots || [];
  if (finishShots.some(finishShotAdoptableFromR2)) {
    const present = await listClipsByShotId(env, job.project, finishShots.map((fs) => fs.shot_id), finishedClipFileMatchesShot);
    reclaimFinishShotsFromR2(finishShots, present);
  }
  if (finishShots.every((fs) => fs.status !== "pending")) {
    // Fail LOUD on a genuinely-failed finish step. After the bounded transient-retry (failOrRetry)
    // and the R2 reclaim above, a shot still "failed" has no path left and no finished artifact -- so
    // the render must NOT advance to done/assemble shipping the raw i2v clip with applied=[]. That
    // silent-degrade (#245/#246) shipped green-but-unfinished films (wan: RIFE crashed at idx 0, the
    // shot "failed", the job went done with the raw clip, error:None). Surface the real error instead.
    const failed = finishShots.filter((fs) => fs.status === "failed");
    if (failed.length) {
      job.phase = "failed";
      job.error = `finish failed for ${failed.length} shot(s): ` +
        failed.map((fs) => `${fs.shot_id} at ${fs.chain[fs.idx] ?? "?"} (${fs.error ?? "no error"})`).join("; ");
      return;
    }
    job.phase = job.clips_only ? "done" : "assemble";
  }
}

// --------------------------------------------------------------------------- assemble (phase 4)

/** The video-finish container's POST /finish response (containers/video-finish/app.py). */
interface FinishContainerResult {
  ok: boolean;
  key?: string;
  bytes?: number;
  durationSeconds?: number;
  shots?: number;
  error?: string;
}

/** Call the video-finish container's POST /finish, retrying on a transient gateway status -- 503 (a
 *  cold container can 503 while its port is still binding -- same shape as callImagePrep in
 *  bundle-assembler) or 504 (a cold-boot + ffmpeg concat that exceeds the request window; issue #82).
 *  backoffMs is injectable so tests do not actually wait. Returns the Response or null on a network
 *  error. The orchestrator (enterAssemblePhase) adds an outer, across-polls auto-recover on top of
 *  this in-request retry, since a single request window may not outlast a fully-cold container. */
export async function callVideoFinish(
  env: Env,
  payload: {
    clips: { url: string }[];
    outputUrl: string;
    outputKey: string;
    width?: number;
    height?: number;
    fps?: number;
    audioUrl?: string;
    remuxAudioOnly?: boolean;
    keepClipAudio?: boolean;
  },
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<Response | null> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  // video-finish runs always-on on the fleet, reached over a Workers VPC binding (private, no cold
  // start) -- so the old Container-DO singleton + warm-/health dance is gone (issue #83).
  let resp: Response | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await env.VIDEO_FINISH_VPC.fetch("http://video-finish/finish", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503 && resp.status !== 504) return resp;
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, backoffMs)); // container still binding / warming
  }
  return resp;
}

/** What the audio-mix container's /mix returns (containers/audio-mix/app.py). */
interface AudioMixResult {
  ok: boolean;
  key?: string;
  durationSeconds?: number;
  lufs?: number;
  ducked?: boolean;
  error?: string;
}

/** POST to the always-on fleet audio-mix container (/mix), mirroring callVideoFinish: a private
 *  Workers VPC binding, retry the transient gateway statuses. Returns null when the binding is not
 *  provisioned (#231 is additive -- the caller then degrades to the single-track remux). */
export async function callAudioMix(
  env: Env,
  payload: {
    tracks: { url: string; role: "dialogue" | "music" | "sfx"; gainDb?: number }[];
    outputUrl: string;
    outputKey: string;
    format?: string;
    loudnessTargetLufs?: number;
  },
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<Response | null> {
  if (!env.AUDIO_MIX_VPC) return null; // not provisioned -> caller degrades to single-track mux
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  let resp: Response | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await env.AUDIO_MIX_VPC.fetch("http://audio-mix/mix", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503 && resp.status !== 504) return resp;
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, backoffMs));
  }
  return resp;
}

/** Pure: should the mux phase run the multi-track mix (#231)? Only when the film has BOTH dialogue
 *  (baked into the assembled video by lip-sync) AND a music bed, and the audio-mix VPC is bound.
 *  Otherwise the single-track remux is correct (and unchanged). */
export function shouldMultiTrackMix(job: FilmJob, env: Env): boolean {
  const hasDialogue = !!job.dialogue_audio && Object.keys(job.dialogue_audio).length > 0;
  return hasDialogue && !!job.audio_key && !!job.silent_film_key && !!env.AUDIO_MIX_VPC;
}

/** #231: mix the film's dialogue (in the assembled video) under-ducked with the music bed + loudnorm via
 *  /mix, returning the mixed audio R2 key to remux -- or null to DEGRADE to the single-track bed mux. The
 *  mix is a POLISH step: any failure soft-degrades (keep the bed), never fails a fully-rendered film
 *  (#249/#77). /mix runs ffmpeg -i per track, so the assembled video's URL works as the dialogue track
 *  (its audio stream is extracted); the bed is the music track. */
async function mixFilmAudio(env: Env, job: FilmJob, videoKey: string, bedKey: string): Promise<string | null> {
  const mixKey = job.mix_audio_key
    ?? videoKey.replace(/\.mp4$/i, "") + "-mix-" + crypto.randomUUID().slice(0, 8) + ".mp3";
  job.mix_audio_key = mixKey;
  const [dialogueUrl, musicUrl, outputUrl] = await Promise.all([
    presignR2Get(env, videoKey, 1800),
    presignR2Get(env, bedKey, 1800),
    presignR2Put(env, mixKey, 1800),
  ]);
  const resp = await callAudioMix(env, {
    tracks: [
      { url: dialogueUrl, role: "dialogue", gainDb: 0 },
      { url: musicUrl, role: "music", gainDb: 0 },
    ],
    outputUrl,
    outputKey: mixKey,
    format: "mp3",
    loudnessTargetLufs: -14,
  });
  if (!resp || !resp.ok) {
    console.warn(`film ${job.film_id}: audio-mix unreachable/${resp ? resp.status : "null"}; degrading to single-track mux (#231)`);
    return null;
  }
  let body: AudioMixResult;
  try {
    body = (await resp.json()) as AudioMixResult;
  } catch {
    console.warn(`film ${job.film_id}: audio-mix returned non-JSON; degrading to single-track mux`);
    return null;
  }
  if (!body.ok || !body.key) {
    console.warn(`film ${job.film_id}: audio-mix not ok (${body.error ?? "no key"}); degrading to single-track mux`);
    return null;
  }
  return mixKey; // mixed dialogue + ducked music + loudnorm; remux this in place of the bare bed
}

const filmOutKey = (filmId: string) => `renders/${filmId}/film.mp4`;

// Cap on across-polls assemble re-attempts before a transient failure goes terminal (issue #82).
const MAX_ASSEMBLE_ATTEMPTS = 6;


/** Internal: the assemble leg. Gather the final clips (in scene order), presign each as a fetchable
 *  GET + presign the film output as a PUT, and hand them to the video-finish container, which ffmpeg-
 *  concats them into one mp4 and PUTs it. This is a CPU-only job (never GPU). The container call is
 *  synchronous; for a long film it can run a while, so if the request times out the phase stays
 *  "assemble" and the next advance re-attempts (re-PUTting the same key is idempotent). */
/** Best-effort: on the done-transition, fire the `notify` hook chain -- every installed notify module
 *  (email, webhook, ...) delivers independently. Presigns the film's download link + hands over the
 *  completion context. A notifier failure (or none installed) NEVER fails the already-assembled render;
 *  the film is in R2 by the time this runs. */
async function fireNotify(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  if (!job.film_key) return;
  try {
    const envRec = env as unknown as Record<string, unknown>;
    const notifiers = servingForHook(preModules ?? await discoverModules(envRec), "notify");
    if (!notifiers.length) return;
    const download_url = await presignR2Get(env, job.film_key, FILM_DOWNLOAD_TTL_SECONDS); // matches the poll summary
    const input: NotifyInput = {
      event: "render.complete", film_id: job.film_id, project: job.project,
      download_url,
    };
    const context = { project: job.project, job_id: job.film_id };
    for (const m of notifiers) {
      const fetcher = resolveFetcher(envRec, m.binding);
      if (!fetcher) continue;
      try {
        // Inject the operator-set install-config (e.g. notify-email's notify_email recipient) as the
        // user config, then clamp through the contract; render-scope fields stay at their defaults.
        const installConfig = await loadInstallConfig(env, m.name, m.config_schema);
        await invokeModule<NotifyInput, NotifyOutput>(fetcher, {
          hook: "notify", input, config: validateConfig(m.config_schema ?? {}, installConfig), context,
        });
      } catch { /* best-effort per notifier -- a delivery failure never fails the render */ }
    }
  } catch (e) {
    console.warn(`notify chain failed for ${job.film_id}: ${(e as Error).message}`);
  }
}

/** Final transition: run the film.finish chain (title / credit cards) on the assembled+muxed film,
 *  then mark done + notify. FAIL-SAFE: no film.finish module, no title/credits, or ANY error -> the
 *  film keeps its original key. A film.finish step must never drop a fully-rendered film. (#190) */
async function transitionToDone(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  try {
    await applyFilmFinish(env, job, preModules);
  } catch (e) {
    // A swallowed throw must not ship as a silent green: record it on the job so the degraded outcome is
    // observable. The film keeps its original (uncarded) key -- a finish step never drops the film. (#190)
    const msg = (e as Error).message;
    job.film_finish = {
      applied: job.film_finish?.applied ?? [],
      errors: [...(job.film_finish?.errors ?? []), `film.finish threw: ${msg}`],
      steps: job.film_finish?.steps,
      degraded: job.film_finish?.degraded ?? `threw: ${msg}`,
    };
    console.warn(`film.finish failed for ${job.film_id}: ${msg}; keeping the original film`);
  }
  job.phase = "done";
  await fireNotify(env, job, preModules);
}

// The film.finish hook I/O is the named FilmFinishInput / FilmFinishOutput pair in ./modules/types
// (every hook has one). The core reads FilmFinishOutput back: the (maybe new) film key, the per-step
// detail (`applied`: the module name on success, or a "passthrough:..."/"noop:..." reason on a
// soft-degrade), and `degraded` -- set when the film was passed through UNCARDED (e.g. the video-finish
// container was unreachable). The chain is fail-safe, so `degraded` is the only signal that requested
// cards were not applied; applyFilmFinish records it on the job rather than dropping it.

/** Inputs for runFilmFinish -- job-shape-agnostic so BOTH the single-film path (advanceFilmJob) and the
 *  scatter gather can run the film.finish chain on an assembled+muxed film (#284/#285). */
export interface RunFilmFinishInput {
  film_key: string;
  scenes: FilmScene[];
  dialogue_lines?: DialogueLine[];
  film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  film_finish_config?: Record<string, Record<string, unknown>>;
  bundle_key: string;
  project: string;
  job_id: string;
}
export interface RunFilmFinishResult {
  ran: boolean;      // false when no film.finish module is installed (caller leaves its state untouched)
  film_key: string;  // carded film key, or the input key on no-op / passthrough
  applied: string[];
  errors: string[];
  steps?: string[];
  degraded?: string;
}

/** Run the film.finish chain (subtitle / title / credit cards) on an assembled+muxed film. Reused by the
 *  single-film path AND the scatter gather. Captions are FILM-LEVEL (buildCaptionCues computes each
 *  line's start from the cumulative duration of preceding shots), so the caller passes the FULL scenes +
 *  dialogue_lines in assembled (shot) order. FAIL-SAFE: a module soft-degrade / failure passes the film
 *  through (recorded in degraded), never drops it. */
export async function runFilmFinish(env: Env, input: RunFilmFinishInput, preModules?: RegisteredModule[]): Promise<RunFilmFinishResult> {
  const envRec = env as unknown as Record<string, unknown>;
  const modules = preModules ?? await discoverModules(envRec);
  if (servingForHook(modules, "film.finish").length === 0) {
    return { ran: false, film_key: input.film_key, applied: [], errors: [] }; // nothing installed -> no-op
  }
  const outKey = input.film_key.replace(/\.mp4$/i, "") + "-titled-" + crypto.randomUUID().slice(0, 8) + ".mp4";
  // A soft .srt sidecar for the subtitle module's sidecar / both modes (its own presigned PUT). Cheap
  // to presign whether or not a subtitle module is installed; ignored by film-titles.
  const sidecarKey = outKey.replace(/\.mp4$/i, "") + ".srt";
  const [videoUrl, outputUrl, sidecarUrl] = await Promise.all([
    presignR2Get(env, input.film_key, 1800),
    presignR2Put(env, outKey, 1800),
    presignR2Put(env, sidecarKey, 1800),
  ]);
  // Time-synced dialogue captions for the subtitle film.finish module: the cumulative per-shot
  // windows (real beat-trimmed durations from the bundle, authored seconds as fallback) carrying each
  // speaking shot's line. Empty when the film has no dialogue -> the subtitle module no-ops. Narration
  // is NOT captioned (a single film-level track with no per-line timing); see src/captions.ts.
  const durations = await readShotDurationsFromBundle(env, input.bundle_key);
  const captions = buildCaptionCues(input.scenes, input.dialogue_lines ?? [], durations);
  const seed: FilmFinishInput = {
    film_key: input.film_key,
    video_url: videoUrl,
    output_url: outputUrl,
    output_key: outKey,
    title: input.film_titles?.title,
    credits: input.film_titles?.credits,
    captions,
    sidecar_url: sidecarUrl,
    sidecar_key: sidecarKey,
  };
  // Multiple film.finish modules chain (e.g. subtitle ui.order=5 then film-titles ui.order=10), each
  // consuming the PRIOR step's output. The seed presigns the FIRST step (read original film, write
  // outKey); every subsequent step must read what the previous step WROTE, not the original, or it
  // overwrites the prior step's work (#14: titles re-read the original and dropped the captions). So
  // nextInput presigns a FRESH GET (of the prior step's film_key) + PUT (to a new key) per step.
  const result = await dispatchChain<FilmFinishInput, FilmFinishOutput>(
    envRec,
    modules,
    "film.finish",
    seed,
    { project: input.project, job_id: input.job_id },
    {
      nextInput: async (prev) => {
        const prevKey = prev?.film_key ?? input.film_key;
        const stepOutKey = input.film_key.replace(/\.mp4$/i, "") + "-ff-" + crypto.randomUUID().slice(0, 8) + ".mp4";
        const stepSidecarKey = stepOutKey.replace(/\.mp4$/i, "") + ".srt";
        const [stepVideoUrl, stepOutputUrl, stepSidecarUrl] = await Promise.all([
          presignR2Get(env, prevKey, 1800),
          presignR2Put(env, stepOutKey, 1800),
          presignR2Put(env, stepSidecarKey, 1800),
        ]);
        return {
          ...seed,
          film_key: prevKey,
          video_url: stepVideoUrl,
          output_url: stepOutputUrl,
          output_key: stepOutKey,
          sidecar_url: stepSidecarUrl,
          sidecar_key: stepSidecarKey,
        };
      },
      // Per-module planner config (subtitle styling/mode/enabled, film-titles font/color/bg), clamped
      // by dispatchChain against each module's schema. Without this the film.finish chain dispatched with
      // {} and every styling/toggle knob was dead from the planner (the dead-config pattern, now closed).
      configFor: (name) => input.film_finish_config?.[name],
    },
  );
  // Record the chain outcome so a degraded or failed film.finish is observable state, not a silent green.
  // The module soft-degrades (passthrough) on a container failure and still returns ok:true, so the only
  // signal that cards were NOT applied is `output.degraded`; surface it (and any chain errors) here. (#207)
  const degradeParts = [...result.degraded];
  // Terminal-seam contract check (#345 / F5b): a film.finish module can be envelope-correct yet return a
  // payload that breaks the hook contract (e.g. no film_key). Don't thread it downstream -- record the
  // violation as an observable degrade and fall back to the input film (never a silent green).
  let out = result.output;
  if (out !== null) {
    const v = hookOutputViolation(result.applied[result.applied.length - 1] ?? "film.finish", "film.finish", out);
    if (v) { degradeParts.push(v); out = null; }
  }
  const degraded = degradeParts.length > 0 ? degradeParts.join("; ") : undefined;
  const finalKey = typeof out?.film_key === "string" && out.film_key.length > 0 ? out.film_key : input.film_key;
  return { ran: true, film_key: finalKey, applied: result.applied, errors: result.errors, steps: out?.applied, degraded };
}

/** Single-film film.finish: thin wrapper over runFilmFinish that folds the outcome back onto the job
 *  (behavior-identical to the pre-refactor inline version -- no-op leaves the job untouched). */
async function applyFilmFinish(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  if (!job.film_key) return;
  const r = await runFilmFinish(env, {
    film_key: job.film_key,
    scenes: job.scenes,
    dialogue_lines: job.dialogue_lines,
    film_titles: job.film_titles,
    film_finish_config: job.film_finish_config,
    bundle_key: job.bundle_key,
    project: job.project,
    job_id: job.film_id,
  }, preModules);
  if (!r.ran) return; // no film.finish module installed -> leave job untouched (identical to pre-refactor)
  if (r.errors.length > 0) {
    console.warn(`film.finish errors for ${job.film_id}: ${r.errors.join("; ")}`);
  }
  if (r.degraded) {
    console.warn(`film.finish degraded for ${job.film_id}: ${r.degraded} -- film shipped WITHOUT cards`);
  }
  job.film_finish = { applied: r.applied, errors: r.errors, steps: r.steps, degraded: r.degraded };
  job.film_key = r.film_key;
}

/** Emit the loud, structured degrade event when the video-finish tier is UNAVAILABLE (VIDEO_FINISH_VPC
 *  unbound, or the container/tunnel unreachable after the bounded assemble/mux retry) so the film
 *  COMPLETES with what was rendered instead of hard-failing after the GPU spend (#519). Mirrors the
 *  scatter.* structured events (docs/observability.md): a Loki-greppable `{"ev":"film.finish_unavailable"}`
 *  line the UI and smoke tests assert on. NEVER emitted for a genuine per-shot / container ERROR -- that
 *  still fails the render loud (#245/#249); this is the UNAVAILABILITY path only. */
function emitFinishUnavailable(job: FilmJob): void {
  const u = job.finish_unavailable;
  if (!u) return;
  console.log(JSON.stringify({
    ev: "film.finish_unavailable",
    film_id: job.film_id,
    project: job.project,
    at: u.at,
    delivered: u.delivered,
    clips: u.clips?.length ?? 0,
    reason: u.reason,
  }));
}

/** Video-finish tier UNAVAILABLE at assemble (VIDEO_FINISH_VPC unbound, or the concat container
 *  unreachable after the bounded retry): there is no single concatenated film, but every per-shot clip
 *  is rendered and sitting in R2. COMPLETE the film delivering those clips with a loud, structured
 *  "clips only, finish unavailable" status, rather than hard-failing after the keyframe/i2v/finish GPU
 *  spend (#519 -- "you can at least get your clips if you close your laptop"). UNAVAILABILITY ONLY: a
 *  container that RAN and reported a real assemble error still fails loud (#245/#249). */
function degradeAssembleUnavailable(
  job: FilmJob,
  finalClips: { shot_id: string; clip_key: string }[],
  reason: string,
): void {
  job.finish_unavailable = { at: "assemble", reason, delivered: "clips", clips: finalClips };
  job.assemble_attempts = 0;
  emitFinishUnavailable(job);
  job.phase = "done"; // no assembled film to finish/notify; the clips ARE the delivered render
}

/** Video-finish tier UNAVAILABLE at mux (VIDEO_FINISH_VPC unbound, or the remux container unreachable
 *  after the bounded retry): the SILENT assembled film exists in R2 (silentKey), the audio bed just
 *  could not be muxed onto it. Ship the silent film with a loud, structured status rather than
 *  hard-failing a fully-rendered film (#519). transitionToDone still runs any film.finish cards on the
 *  silent film and fires notify with its download link. UNAVAILABILITY ONLY (#245/#249). */
async function degradeMuxUnavailable(env: Env, job: FilmJob, silentKey: string, reason: string, preModules?: RegisteredModule[]): Promise<void> {
  job.finish_unavailable = { at: "mux", reason, delivered: "silent_film" };
  job.mux_attempts = 0;
  emitFinishUnavailable(job);
  job.film_key = silentKey;
  await transitionToDone(env, job, preModules);
}

async function enterMuxPhase(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  const silentKey = job.silent_film_key;
  const audioKey = job.audio_key;
  if (!silentKey || !audioKey) {
    job.film_key = silentKey;
    await transitionToDone(env, job, preModules);
    return;
  }
  if (!env.VIDEO_FINISH_VPC) {
    await degradeMuxUnavailable(env, job, silentKey, "video-finish tier not installed (VIDEO_FINISH_VPC unbound); shipped silent film", preModules);
    return;
  }

  const outKey = job.mux_output_key
    ?? silentKey.replace(/\.mp4$/i, "") + "-audio-" + crypto.randomUUID().slice(0, 8) + ".mp4";
  job.mux_output_key = outKey;

  // #231: a dialogue + music film gets a PROPER multi-track mix first -- duck the music under the
  // dialogue + loudness-normalize via the audio-mix container -- then remux that single mixed track.
  // Soft-degrades to the bare bed (single-track remux, prior behavior) when the audio-mix VPC is not
  // bound or the mix fails; an audio-polish miss never fails a fully-rendered film (#249/#77).
  let audioToMux = audioKey;
  if (shouldMultiTrackMix(job, env)) {
    const mixed = await mixFilmAudio(env, job, silentKey, audioKey);
    if (mixed) audioToMux = mixed;
  }

  const [videoUrl, audioUrl, outputUrl] = await Promise.all([
    presignR2Get(env, silentKey, 1800),
    presignR2Get(env, audioToMux, 1800),
    presignR2Put(env, outKey, 1800),
  ]);

  const resp = await callVideoFinish(env, {
    clips: [{ url: videoUrl }],
    outputUrl,
    outputKey: outKey,
    audioUrl,
    remuxAudioOnly: true,
  });

  const transport = classifyAssembleTransport(resp ? resp.status : null, job.mux_attempts ?? 0, MAX_ASSEMBLE_ATTEMPTS);
  job.mux_attempts = transport.attempts;
  if (transport.state === "retry") {
    job.phase = "mux";
    job.error = transport.error;
    return;
  }
  if (transport.state === "exhausted") {
    await degradeMuxUnavailable(env, job, silentKey, transport.error, preModules);
    return;
  }
  if (!resp) {
    await degradeMuxUnavailable(env, job, silentKey, "video-finish container unreachable; shipped silent film", preModules);
    return;
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.text()).slice(0, 400); } catch { /* body unreadable */ }
    job.phase = "failed";
    job.error = `video-finish mux returned ${resp.status}${detail ? `: ${detail}` : ""}`;
    return;
  }
  let body: FinishContainerResult;
  try {
    body = (await resp.json()) as FinishContainerResult;
  } catch {
    job.phase = "failed";
    job.error = "video-finish returned a non-JSON response";
    return;
  }
  if (!body.ok) {
    job.phase = "failed";
    job.error = `video-finish mux failed: ${body.error || "unknown error"}`;
    return;
  }
  job.film_key = outKey;
  await transitionToDone(env, job, preModules);
}


/** After the silent film is assembled and an audio bed exists: set up the `master` chain (if any master
 *  module is installed) to polish the bed before mux. No master module -> straight to mux with the bed
 *  as-is. Mirrors enterDialogueOrFinish -- it kicks the phase and lets advanceMasterPhase drive it. */
async function enterMasterOrMux(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  const envRec = env as unknown as Record<string, unknown>;
  const serving = servingForHook(preModules ?? await discoverModules(envRec), "master"); // ui.order; the full master chain
  const chain = serving.map((mod) => mod.binding);
  if (!chain.length) { job.phase = "mux"; await enterMuxPhase(env, job, preModules); return; } // no master installed: mux as-is
  // Per-step planner config, clamped against each module's schema (by name), aligned to chain order --
  // mirrors enterSpeechOrFinish / the finish chain so the audio-master knobs (target_lufs/upscale/format)
  // actually reach the module instead of dispatching with {}.
  const configs = resolveFinishConfigs(serving, job.master_config ?? {});
  job.master = { chain, idx: 0, applied: [], degraded: [], configs };
  job.phase = "master";
  await advanceMasterPhase(env, job, preModules);
}

/** Drive the master chain over the film's audio bed: submit the current step or poll the in-flight one,
 *  folding each mastered bed back into job.audio_key. FAIL-SAFE -- an unbound / failed / stalled step
 *  soft-degrades (passes the CURRENT bed through, records the reason) and the chain advances; the render
 *  NEVER fails on a master miss (#249 / #77). When the chain is exhausted, record the outcome and mux.
 *  One network round-trip (submit OR poll) per step per tick: a synchronous step folds and continues in
 *  the same tick; an async step parks on its poll token and returns (the next advanceFilmJob re-enters). */
async function advanceMasterPhase(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<void> {
  const m = job.master;
  if (!m || !job.audio_key) { job.phase = "mux"; await enterMuxPhase(env, job, preModules); return; } // defensive: nothing to master
  const envRec = env as unknown as Record<string, unknown>;
  const seconds = filmSeconds(job);

  // A step in flight can freeze (a RunPod envelope stuck IN_PROGRESS pends forever). If the phase has sat
  // past the stall ceiling with a step still pending, soft-degrade THIS step (passthrough) and move on --
  // a stuck polish ships the un-mastered bed, it never hangs the render or drops the film.
  if (m.poll && phaseAgeSeconds(job) >= MASTER_STALL_SECONDS) {
    console.warn(`film ${job.film_id}: master step ${m.chain[m.idx]} stalled; passing the bed through`);
    degradeMasterStep(m, "stalled");
  }

  while (!masterChainDone(m)) {
    const fetcher = resolveFetcher(envRec, m.chain[m.idx]);
    if (!fetcher) { degradeMasterStep(m, "module not bound"); continue; }
    if (!m.poll) {
      // CREDENTIALLESS module: the core owns the R2 S3 creds and presigns the bed GET + the mastered PUT
      // (the module/container hold no R2 creds), exactly as the film.finish chain does. Each step masters
      // the PRIOR step's output (job.audio_key carries forward), so presign per step from the current bed.
      const audioKey = job.audio_key;
      // The step's clamped planner config (target_lufs / upscale / format). The output key extension must
      // match the format the module/container will write, so derive it from the same config.
      const cfg = m.configs?.[m.idx] ?? {};
      const format = cfg.format === "mp3" ? "mp3" : "wav";
      const outputKey = masteredBedKey(audioKey, format);
      const [audioUrl, outputUrl] = await Promise.all([
        presignR2Get(env, audioKey, 1800), // 30min: covers a multi-minute CPU master
        presignR2Put(env, outputKey, 1800),
      ]);
      const req = {
        hook: "master" as const,
        input: {
          film_id: job.film_id, audio_key: audioKey,
          audio_url: audioUrl, output_url: outputUrl, output_key: outputKey, seconds,
        } as MasterInput,
        config: cfg,
        context: { project: job.project, job_id: job.film_id },
      };
      const r = await invokeModule<MasterInput, MasterOutput>(fetcher, req);
      if (!r.ok) {
        const d = classifyFinishRetry(r.error, m.attempts ?? 0, MASTER_STEP_MAX_ATTEMPTS);
        if (d.action === "retry") { m.attempts = d.attempts; return; } // transient: re-submit next tick
        degradeMasterStep(m, `invoke failed: ${r.error}`); continue;     // terminal: passthrough + advance
      }
      if ((r as { pending?: boolean }).pending) { m.poll = (r as { poll: string }).poll; m.attempts = 0; return; }
      if ("output" in r) { const v = hookOutputViolation(m.chain[m.idx], "master", r.output); if (v) { degradeMasterStep(m, v); continue; } job.audio_key = applyMasterOutput(m, job.audio_key, r.output as MasterOutput); continue; }
      degradeMasterStep(m, "module returned neither output nor a poll token"); continue;
    }
    const p = await pollModule<MasterOutput>(fetcher, { poll: m.poll });
    if (p.ok && !(p as { pending?: boolean }).pending) {
      const out = (p as { output: MasterOutput }).output;
      const v = hookOutputViolation(m.chain[m.idx], "master", out);
      if (v) { degradeMasterStep(m, v); continue; }
      job.audio_key = applyMasterOutput(m, job.audio_key, out); continue;
    }
    if (p.ok) return; // still mastering -- poll again next tick
    const d = classifyFinishRetry(p.error, m.attempts ?? 0, MASTER_STEP_MAX_ATTEMPTS);
    if (d.action === "retry") { m.attempts = d.attempts; return; } // transient poll blip: re-poll next tick
    degradeMasterStep(m, `poll failed: ${p.error}`); // terminal: passthrough + advance
  }

  // Chain exhausted: the (maybe mastered) bed is in job.audio_key. A degrade is observable, not a silent green.
  if (m.degraded.length) console.warn(`film ${job.film_id}: master degraded -- ${m.degraded.join("; ")}`);
  job.phase = "mux";
  await enterMuxPhase(env, job, preModules);
}

async function finishAssembledFilm(env: Env, job: FilmJob, silentKey: string, preModules?: RegisteredModule[]): Promise<void> {
  job.silent_film_key = silentKey;
  if (!job.audio_key) {
    job.film_key = silentKey;
    await transitionToDone(env, job, preModules);
    return;
  }
  // There IS an audio bed: master it (music upscale + loudness) if a master module is installed, then mux.
  // enterMasterOrMux soft-degrades to a straight mux when no master module is present (or the polish fails).
  await enterMasterOrMux(env, job, preModules);
}

async function enterAssemblePhase(
  env: Env,
  job: FilmJob,
  finalClips: { shot_id: string; clip_key: string }[],
  preModules?: RegisteredModule[],
): Promise<void> {
  if (!finalClips.length) { job.phase = "failed"; job.error = "no clips to assemble"; return; }

  // Derive completion from R2 presence: if the concat output is already in R2, a prior
  // attempt's ffmpeg PUT succeeded even though its response was lost (the container 504'd
  // after writing, or the poll window closed mid-PUT and the job was re-driven). Re-running
  // the concat would be wasted CPU, so finalize straight from the existing object. This is
  // what lets a stalled-after-PUT assemble self-heal on the next poll / sweep tick instead of
  // looping. (issue #122)
  const outputKey = filmOutKey(job.film_id);
  if (await r2ObjectExists(env, outputKey)) {
    job.assemble_attempts = 0;
    await finishAssembledFilm(env, job, outputKey, preModules);
    return;
  }

  if (!env.VIDEO_FINISH_VPC) {
    degradeAssembleUnavailable(job, finalClips, "video-finish tier not installed (VIDEO_FINISH_VPC unbound); delivered per-shot clips");
    return;
  }

  const clips: { url: string }[] = [];
  for (const c of finalClips) {
    clips.push({ url: await presignR2Get(env, c.clip_key, 1800) }); // 30min: covers a multi-clip concat
  }
  const outputUrl = await presignR2Put(env, outputKey, 1800);

  // Talking film: when shots carry per-shot dialogue, the lip-sync module baked that audio into each
  // clip. Tell the container to preserve per-clip audio through the concat (keepClipAudio) instead of
  // stripping it (-an) -- otherwise the assembled film comes out silent despite the spoken clips.
  const keepClipAudio = !!job.dialogue_audio && Object.keys(job.dialogue_audio).length > 0;

  // Resolution/fps are left to the container default (it normalizes the clips); the motion output
  // does not carry width/height, so matching the source resolution is a later polish, not a gate.
  const resp = await callVideoFinish(env, { clips, outputUrl, outputKey, keepClipAudio });
  // A transient gateway outcome (unreachable / 502 / 503 / 504) auto-recovers across polls instead of
  // going terminal: the clips are intact in R2 and re-PUTting the same film key is idempotent, so keep
  // phase="assemble" and let the next poll re-attempt against a (by then) warmer container -- bounded so
  // a genuinely stuck assemble still fails loudly (issue #82).
  const transport = classifyAssembleTransport(resp ? resp.status : null, job.assemble_attempts ?? 0, MAX_ASSEMBLE_ATTEMPTS);
  // One assignment for every outcome: the helper returns the next counter value (prior+1 on a transient
  // failure, 0 once the container gives a definitive answer -- so a slow-but-successful finish never
  // carries stale attempts toward the cap, and a manual phase-reset starts from a full budget).
  job.assemble_attempts = transport.attempts;
  if (transport.state === "retry") {
    job.phase = "assemble"; // unchanged; next advanceFilmJob poll re-enters this leg
    job.error = transport.error;
    return;
  }
  if (transport.state === "exhausted") {
    degradeAssembleUnavailable(job, finalClips, transport.error);
    return;
  }
  // state === "ok": a transient status is never null, so resp is non-null here. The guard keeps the
  // compiler happy and is a defensive backstop.
  if (!resp) { degradeAssembleUnavailable(job, finalClips, "video-finish container unreachable; delivered per-shot clips"); return; }
  if (!resp.ok) {
    // A non-transient error status: the container's own failure (e.g. a 500 with an ffmpeg/assemble
    // error body). Surface the body -- an opaque "returned 500" is undiagnosable -- and go terminal;
    // retrying a real assemble error would only loop.
    let detail = "";
    try { detail = (await resp.text()).slice(0, 400); } catch { /* body unreadable */ }
    job.phase = "failed";
    job.error = `video-finish container returned ${resp.status}${detail ? `: ${detail}` : ""}`;
    return;
  }
  let body: FinishContainerResult;
  try {
    body = (await resp.json()) as FinishContainerResult;
  } catch {
    job.phase = "failed"; job.error = "video-finish returned a non-JSON response"; return;
  }
  if (!body.ok) { job.phase = "failed"; job.error = `video-finish failed: ${body.error || "unknown error"}`; return; }
  await finishAssembledFilm(env, job, outputKey, preModules);
}


/** Start a film at the clips phase using existing keyframe keys (finalize / cloud / hybrid). */
export async function startFilmFromKeyframes(
  env: Env,
  args: {
    project: string;
    bundle_key: string;
    scenes: FilmScene[];
    keyframes: FilmKeyframeRef[];
    motion_backend?: string;
    per_shot_motion?: Record<string, string>;
    motion_config?: Record<string, unknown>;
    motion_configs?: Record<string, Record<string, unknown>>;
    finish_config?: Record<string, Record<string, unknown>>;
    speech_config?: Record<string, Record<string, unknown>>;
    film_finish_config?: Record<string, Record<string, unknown>>;
    master_config?: Record<string, Record<string, unknown>>;
    derive_mode: "finalized" | "cloud-finalized";
    parent_render_id?: number;
    audio_key?: string;
  },
  preModules?: RegisteredModule[],
): Promise<FilmJob> {
  const scenes = coerceSceneIds(args.scenes ?? []);
  const stagedAudio = await resolveStagedAudioKey(env, args.audio_key);
  const { matched, missing } = joinKeyframesToScenes(scenes, args.keyframes || []);
  const job: FilmJob = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project,
    bundle_key: args.bundle_key,
    scenes,
    motion_backend: args.motion_backend ?? null,
    motion_config: args.motion_config ?? {},
    finish_config: args.finish_config ?? {},
    speech_config: args.speech_config ?? {},
    film_finish_config: args.film_finish_config ?? {},
    master_config: args.master_config ?? {},
    keyframe_binding: null,
    phase: "failed",
    created_at: Date.now(),
    phase_started_at: Date.now(),
    derive_mode: args.derive_mode,
    parent_render_id: args.parent_render_id,
    audio_key: stagedAudio,
  };
  if (!matched.length) {
    job.error = `no keyframes matched requested shots (missing: ${missing.join(", ")})`;
    await putFilm(env, job);
    return job;
  }
  const shots: ClipShotInput[] = [];
  for (const m of matched) {
    const keyframe_url = await presignR2Get(env, m.keyframe_key, 1800);
    shots.push({
      shot_id: m.shot_id,
      keyframe_url,
      keyframe_key: m.keyframe_key,
      prompt: m.prompt,
      seconds: m.seconds,
      motion_backend: args.per_shot_motion?.[m.shot_id],
    });
  }
  const clip = await startClipJob(env, {
    project: args.project,
    shots,
    motion_backend: args.motion_backend,
    config: args.motion_config,
    module_configs: args.motion_configs,
  }, preModules);
  job.clip_job_id = clip.job_id;
  job.phase = summarizeJob(clip).failed === clip.shots.length ? "failed" : "clips";
  if (job.phase === "failed") job.error = "every clip submission failed";
  await putFilm(env, job);
  return job;
}

/** Start a film job: resolve the keyframe module, submit the project preview, persist the poll token. */
export async function startFilmJob(
  env: Env,
  args: {
    project: string; bundle_key: string; scenes: FilmScene[];
    motion_backend?: string; keyframe_backend?: string; keyframe_config?: Record<string, unknown>; motion_config?: Record<string, unknown>;
    finish_config?: Record<string, Record<string, unknown>>;
    speech_config?: Record<string, Record<string, unknown>>;
    film_finish_config?: Record<string, Record<string, unknown>>;
    master_config?: Record<string, Record<string, unknown>>;
    keyframes_only?: boolean;
    clips_only?: boolean;
    pretrained_loras?: Record<string, string>;
    audio_key?: string;
    dialogue_lines?: DialogueLine[];
    cast_loras?: Record<string, number>;
    film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  },
  preModules?: RegisteredModule[],
): Promise<FilmJob> {
  const scenes = coerceSceneIds(args.scenes ?? []);
  // Dialogue lines must join on the SAME coerced ids as the scenes, or a caller-supplied id scheme
  // (`s1`/`s2`) strands the TTS audio under keys no consumer reads (silent + uncaptioned film, #563).
  const dialogueLines = coerceDialogueLineIds(args.scenes ?? [], args.dialogue_lines);
  const stagedAudio = args.clips_only ? undefined : await resolveStagedAudioKey(env, args.audio_key);
  const envRec = env as unknown as Record<string, unknown>;
  const modules = preModules ?? await discoverModules(envRec);
  // Honor the planner's keyframe backend pick (e.g. cloud-keyframe) over the ui.order default, mirroring
  // motion.backend selection. An explicit-but-unknown choice resolves to null -> the render fails loud
  // with a clear "keyframe module <choice> not installed" rather than silently swapping backends.
  const kfServing = servingForHook(modules, "keyframe");
  const kf = (args.keyframe_backend ? kfServing.find((m) => m.name === args.keyframe_backend) : kfServing[0]) ?? null;
  const job: FilmJob = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project, bundle_key: args.bundle_key, scenes,
    motion_backend: args.motion_backend ?? null, motion_config: args.motion_config ?? {},
    finish_config: args.finish_config ?? {},
    speech_config: args.speech_config ?? {},
    film_finish_config: args.film_finish_config ?? {},
    master_config: args.master_config ?? {},
    keyframes_only: !!args.keyframes_only,
    clips_only: !!args.clips_only,
    audio_key: stagedAudio,
    film_titles: args.film_titles,
    keyframe_binding: kf ? kf.binding : null, phase: "keyframe", created_at: Date.now(),
    phase_started_at: Date.now(),
    dialogue_lines: dialogueLines && dialogueLines.length ? dialogueLines : undefined,
    cast_loras: args.cast_loras && Object.keys(args.cast_loras).length ? args.cast_loras : undefined,
  };
  const fetcher = kf ? resolveFetcher(envRec, kf.binding) : null;
  if (!kf || !fetcher) {
    job.phase = "failed";
    job.error = kf
      ? `keyframe module ${kf.name} (${kf.binding}) is not bound`
      : (args.keyframe_backend ? `keyframe module ${args.keyframe_backend} not installed` : "no keyframe module installed");
  } else {
    const config = validateConfig(kf.config_schema, args.keyframe_config);
    const keyframeInput: KeyframeInput = {
      project: args.project,
      bundle_key: args.bundle_key,
      shot_ids: scenes.map((s) => s.shot_id),
    };
    if (args.pretrained_loras && Object.keys(args.pretrained_loras).length) {
      keyframeInput.pretrained_loras = { ...args.pretrained_loras };
    }
    const r = await invokeModule<KeyframeInput, KeyframeOutput>(fetcher, {
      hook: "keyframe",
      input: keyframeInput,
      config,
      context: { project: args.project, job_id: job.film_id },
    });
    if (!r.ok) { job.phase = "failed"; job.error = r.error; }
    else if ((r as { pending?: boolean }).pending) { job.keyframe_poll = (r as { poll: string }).poll; job.keyframe_job_id = (r as { jobId?: string }).jobId; }
    else if ("output" in r) { const v = hookOutputViolation(kf.name, "keyframe", r.output); if (v) { job.phase = "failed"; job.error = v; } else { await afterKeyframeOutput(env, job, r.output as KeyframeOutput, modules); } }
    else { job.phase = "failed"; job.error = "keyframe module returned neither output nor a poll token"; }
  }
  await putFilm(env, job);
  return job;
}

/** Mark an in-flight film job cancelled. Terminal jobs are returned unchanged. */
export async function cancelFilmJob(env: Env, filmId: string): Promise<FilmJob | null> {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as FilmJob;
  if (job.phase === "done" || job.phase === "failed") return job;
  // #328: STOP the in-flight RunPod job, not just the studio state -- a cancel that leaves the GPU
  // training is a lie to the user and a money leak. Run this BEFORE mutating phase, so the helper can
  // still see the in-flight keyframe poll token. (Motion/finish/speech phases adopt /cancel in
  // follow-ups once their modules advertise `cancelable`; until then cancelInFlightKeyframe is a no-op
  // off the keyframe phase and the orphan, if any, is the existing behavior -- not made worse here.)
  await cancelInFlightKeyframe(env, job);
  // #536: the motion-phase sibling -- STOP any in-flight clip shots RunPod jobs too, so a user cancel off
  // the clips phase does not leave the GPU running (the follow-up the cancelInFlightKeyframe comment named).
  if (job.clip_job_id) await cancelInFlightClips(env, job.clip_job_id);
  job.cancelled = true;
  job.phase = "failed";
  job.error = "cancelled";
  await putFilm(env, job);
  return job;
}

/** List the keyframe PNGs the GPU wrote for a project and join them to the job's scenes. The keyframe
 *  stage writes `renders/<project>/keyframes/<shot_id>.png` itself (its own R2 creds; see the keyframe
 *  module), so the core can recover an orphaned keyframe phase straight from R2 presence -- no GPU re-
 *  run. Returns only keyframes whose shot_id is in the storyboard, so a stale PNG from an older render
 *  of the same project can never inject a shot the film did not ask for. */
export async function listProjectKeyframes(env: Env, project: string, scenes: FilmScene[]): Promise<FilmKeyframeRef[]> {
  const prefix = `renders/${project}/keyframes/`;
  const wanted = new Set(scenes.map((s) => s.shot_id));
  const out: FilmKeyframeRef[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.R2_RENDERS.list({ prefix, cursor, limit: 1000 });
    for (const o of listed.objects) {
      const file = o.key.slice(prefix.length);
      const shot_id = file.replace(/\.[^.]+$/, ""); // drop the extension (.png)
      if (shot_id && wanted.has(shot_id)) out.push({ shot_id, keyframe_key: o.key });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  // De-dupe (a project could in principle hold .png + another ext for a shot); keep the first seen.
  const seen = new Set<string>();
  return out.filter((k) => (seen.has(k.shot_id) ? false : (seen.add(k.shot_id), true)));
}

/** True iff EVERY scene's keyframe is already in R2 (the full set, one per shot). Gate for adopting on a
 *  pending poll (#129 envelope-freeze): a partial set means generation is still in flight, so we must NOT
 *  advance early -- only adopt once the set is complete. (The 20min stall backstop is intentionally
 *  lenient on partials, treating absent shots as genuine non-renders at the ceiling.) */
export async function keyframeSetCompleteInR2(env: Env, job: FilmJob): Promise<boolean> {
  if (!job.scenes.length) return false;
  const present = await listProjectKeyframes(env, job.project, job.scenes);
  const have = new Set(present.map((k) => k.shot_id));
  return job.scenes.every((s) => have.has(s.shot_id));
}

/** Cancel the film's in-flight keyframe RunPod job THROUGH its module, honestly. No-op when no keyframe
 *  job is in flight (wrong phase, no poll token, or no bound backend). When the bound module is missing
 *  or not `cancelable`, or the cancel call fails, we LOG the orphan rather than swallow it: an orphaned
 *  GPU job is a money leak that betrays scale-to-zero (#327 / #328), so it stays visible even when we
 *  cannot stop it. Read keyframe_poll BEFORE the caller clears it. Exported for the orchestrator
 *  unit test (it asserts the adopt + DELETE-cancel paths actually issue a cancel). */
export async function cancelInFlightKeyframe(env: Env, job: FilmJob): Promise<void> {
  if (job.phase !== "keyframe" || !job.keyframe_poll || !job.keyframe_binding) return;
  const poll = job.keyframe_poll;
  // NAME the backend job in every orphan log so a left-running job is actionable (an operator can
  // cancel it by hand -- exactly how this bug was caught). keyframe_job_id comes from the module's
  // #318 jobId on the pending invoke; "(job id unknown)" only if a module omitted that optional field.
  const jobId = job.keyframe_job_id ?? "(job id unknown)";
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const kf = modules.find((m) => m.binding === job.keyframe_binding) ?? null;
  const fetcher = kf ? resolveFetcher(envRec, kf.binding) : null;
  if (!kf || !fetcher) {
    console.warn(`film ${job.film_id}: cannot cancel in-flight keyframe job -- module ${job.keyframe_binding} not bound; RunPod job ${jobId} left running (ORPHAN) (#327)`);
    return;
  }
  if (!kf.cancelable) {
    console.warn(`film ${job.film_id}: keyframe module ${kf.name} has no cancel primitive (cancelable=false) -- RunPod job ${jobId} left running (ORPHAN) (#327)`);
    return;
  }
  const r = await cancelModule(fetcher, { poll });
  if (r.ok) {
    console.warn(`film ${job.film_id}: cancelled in-flight keyframe RunPod job ${jobId} via ${kf.name} (#327)`);
  } else {
    console.warn(`film ${job.film_id}: keyframe cancel FAILED (${r.error}) -- RunPod job ${jobId} left running (ORPHAN) (#327)`);
  }
}

/** Recover a keyframe phase whose module poll has gone stale (RunPod GC'd the finished job) by adopting
 *  the keyframes already in R2 and advancing exactly as a fresh keyframe completion would (afterKeyframe
 *  Output -> clips, or done for a keyframes-only preview). Idempotent: marks keyframe_recovered so it
 *  runs once, and a fresh-completion advance on a later poll is unaffected (the phase has moved on).
 *  Returns true iff it adopted keyframes and moved the phase. */
async function recoverStalledKeyframePhase(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<boolean> {
  const adopted = await listProjectKeyframes(env, job.project, job.scenes);
  if (!adopted.length) return false; // nothing in R2 to adopt -- not actually complete; let the ceiling handle it
  console.warn(`film ${job.film_id}: keyframe poll stale, adopting ${adopted.length} orphaned keyframes from R2 (#129)`);
  // #327: STOP the still-running RunPod job BEFORE discarding its poll token. Adopting the cached
  // keyframes satisfies the work, but the GPU job keeps training/rendering unless we cancel it; clearing
  // keyframe_poll without cancelling is exactly what orphaned it. Best-effort, honest-degrade-logged.
  await cancelInFlightKeyframe(env, job);
  job.keyframe_recovered = true;
  job.keyframe_poll = undefined; // the RunPod job is cancelled (or logged as an orphan) above
  await afterKeyframeOutput(env, job, { project: job.project, keyframes: adopted }, preModules);
  return true;
}

// clipFileMatchesShot + the shot-id->clip-key R2 listing live in render-orchestrator (the layer that owns
// the clip job + advanceClipJob), so the fail-time reclaim and the stall-recovery share ONE matcher (no
// drift). listProjectClips here is the scenes-shaped wrapper the film recovery uses.
export { clipFileMatchesShot };

/** List the motion clips the GPU wrote for a project, joined to the job's scenes by shot id (scene-shaped
 *  wrapper over render-orchestrator's listClipsByShotId). When a motion.backend poll never resolves (GC'd
 *  RunPod job), the clip is still in R2; matching by shot-id boundary recovers a stalled clips phase from
 *  R2 presence, no GPU re-run. Only shots in the storyboard are returned. */
export async function listProjectClips(env: Env, project: string, scenes: FilmScene[]): Promise<{ shot_id: string; clip_key: string }[]> {
  const wanted = scenes.map((s) => s.shot_id);
  const found = await listClipsByShotId(env, project, wanted);
  return wanted.filter((s) => found.has(s)).map((s) => ({ shot_id: s, clip_key: found.get(s) as string }));
}

/** Recover a clips phase whose motion.backend poll has gone stale by adopting the clips already in R2.
 *  Loads the clip job doc, marks any not-yet-done shot whose clip IS in R2 done with that key (pending OR
 *  a shot the module prematurely failed -- artifact present in R2 is the source of truth and overrides a
 *  module's failure verdict; #141), re-PUTs the clip doc, and -- only once every shot is terminal --
 *  advances to the finish chain exactly as a normal clips completion would.
 *
 *  RE-FIRES across sweeps (issue #143): the 10 clips finish + go stale at DIFFERENT times, so one pass may
 *  adopt only the shots whose clips have landed so far while others are still rendering. This must run
 *  every stalled sweep until the job is complete -- so it does NOT set a one-shot `clips_recovered` gate on
 *  a partial pass (unlike the keyframe batch, which completes all at once). `clips_recovered` is set ONLY
 *  when the job is complete and we advance to finish -- a record that adoption closed the job, not a guard
 *  that would block the next partial pass. Returns true iff it advanced the film phase out of "clips".
 *  A partial pass returns false (phase stays "clips"; the next stalled sweep re-attempts the rest); a pass
 *  that adopts nothing AND finds nothing already terminal also returns false (the hard ceiling decides). */
async function recoverStalledClipsPhase(env: Env, job: FilmJob, preModules?: RegisteredModule[]): Promise<boolean> {
  if (!job.clip_job_id) return false;
  const cjObj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
  if (!cjObj) return false;
  const clipJob = JSON.parse(await cjObj.text()) as ClipJob;
  // Same R2-presence reclaim the clip leg uses (adopt any not-done shot whose clip is in R2 -- pending OR
  // a module fast-fail; the artifact wins). Shared helper = one matcher, no drift. Persist partial progress
  // so a later sweep starts from it (idempotent re-PUT); a shot with no R2 clip is left for the next sweep.
  const adopted = await reclaimClipsFromR2(env, clipJob);
  if (adopted) {
    await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
    console.warn(`film ${job.film_id}: clips poll stale, adopted ${adopted} orphaned clips from R2 this pass (#143)`);
  }
  // Only advance once the WHOLE job is terminal -- otherwise stay in "clips" and let the next stalled sweep
  // pick up the shots that have since landed. Do NOT set a one-shot gate on a partial pass.
  if (!summarizeJob(clipJob).complete) return false;
  job.clips_recovered = true;
  await enterFinishPhase(env, job, clipJob, preModules);
  return true;
}

/** The stall-recovery pass, run after the normal phase advance. For a pollable phase that has not
 *  progressed within its deadline: try a same-phase recovery (keyframe adoption from R2), else, once
 *  past the absolute ceiling, fail loudly so a wedged render surfaces instead of hanging forever (#129).
 *  Returns true iff it changed the phase (so the caller re-stamps phase_started_at + persists). */
async function recoverStalledPhase(env: Env, job: FilmJob, preModules?: RegisteredModule[], now: number = Date.now()): Promise<boolean> {
  if (!POLLABLE_PHASES.has(job.phase)) return false;
  const age = phaseAgeSeconds(job, now);

  // Same-phase recovery: a keyframe poll that never resolved, but the keyframes are in R2.
  if (job.phase === "keyframe" && !job.keyframe_recovered && age >= KEYFRAME_STALL_SECONDS) {
    if (await recoverStalledKeyframePhase(env, job, preModules)) return true;
  }

  // Same-phase recovery: a clips (motion.backend) poll that never resolved, but the clips are in R2
  // (issue #139). Symmetric to keyframe adoption -- collect the orphaned clips by shot name and advance
  // to finish, so an own-gpu render whose GPU work completed does not loud-fail with its clips intact.
  // NO !clips_recovered guard (issue #143): clips finish + go stale at DIFFERENT times, so this must
  // RE-FIRE every stalled sweep to pick up shots whose clips land after an earlier partial pass;
  // recoverStalledClipsPhase only advances (and sets clips_recovered) once the whole job is complete.
  if (job.phase === "clips" && age >= KEYFRAME_STALL_SECONDS) {
    if (await recoverStalledClipsPhase(env, job, preModules)) return true;
  }

  // Absolute ceiling: a still-pollable phase this old is genuinely wedged with nothing in R2 to adopt
  // (keyframe/clips adoption above already rescued any phase whose artifacts landed; a finish phase has
  // no adoption yet; or the GPU truly produced nothing). Fail loudly rather than hang.
  if (age >= PHASE_HARD_DEADLINE_SECONDS) {
    const stuckPhase = job.phase;
    job.phase = "failed";
    job.error = `render stalled in phase "${stuckPhase}" for ${Math.floor(age / 60)}min with no progress; failing so it does not hang (resubmit to retry) (#129)`;
    return true;
  }
  return false;
}

/** Read the film + clip job docs without advancing anything: what a driver that LOST the advance
 *  lease returns (the winner's state propagates via the doc; the loser just reports it). */
async function readFilmJobReadOnly(env: Env, filmId: string): Promise<{ job: FilmJob; clipJob: ClipJob | null } | null> {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as FilmJob;
  let clipJob: ClipJob | null = null;
  if (job.clip_job_id) {
    const cj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
    if (cj) clipJob = JSON.parse(await cj.text()) as ClipJob;
  }
  return { job, clipJob };
}

/** Claim the film-advance lease, failing OPEN: the lease is a protective serializer, not a
 *  correctness gate on the doc contents, so a D1 blip must not stall every render (the sweep is
 *  the only driver for fire-and-forget jobs). On a claim error the tick advances unguarded --
 *  exactly the pre-lease behavior -- and says so. */
async function claimAdvanceOrFailOpen(env: Env, filmId: string): Promise<FilmAdvanceClaim> {
  if (!(env as { DB?: unknown }).DB) return { won: true }; // no D1 bound (unit-test fakes): nothing to claim against
  try {
    return await claimFilmAdvance(env, filmId);
  } catch (e) {
    console.warn(`film ${filmId}: advance lease unavailable (${(e as Error).message}); advancing unguarded`);
    return { won: true };
  }
}

/** Advance a film job across its two phases. Returns the job + the underlying clip job (for the
 *  summary), or null if no such film job exists.
 *
 *  ONE DRIVER PER TICK (S4): this function is driven concurrently by the 1-minute cron sweep AND
 *  every client status poll, and its body is an unlocked read-modify-write on the R2 job doc with
 *  submit-bearing legs (clip start, dialogue batch, per-shot finish/speech/master steps, mux,
 *  notify). Two concurrent drivers could each observe phase N incomplete and BOTH submit phase
 *  N+1's external work -- duplicated GPU spend -- and clobber each other's doc writes (a lost
 *  poll token orphans a RunPod job). So the whole tick runs under a D1 lease (claimFilmAdvance,
 *  the claimFinish conditional-UPDATE pattern): the loser skips quietly and reports the doc
 *  read-only; the lease is released after the tick and expires on its own if the winner crashed,
 *  so a genuine retry is never deadlocked. */
export async function advanceFilmJob(env: Env, filmId: string): Promise<{ job: FilmJob; clipJob: ClipJob | null } | null> {
  const claim = await claimAdvanceOrFailOpen(env, filmId);
  if (!claim.won) return readFilmJobReadOnly(env, filmId);
  try {
    return await advanceFilmJobLocked(env, filmId);
  } finally {
    if (claim.lease !== undefined) {
      try {
        await releaseFilmAdvance(env, filmId, claim.lease);
      } catch (e) {
        console.warn(`film ${filmId}: advance lease release failed (${(e as Error).message}); it expires on its own`);
      }
    }
  }
}

/** The advance tick body; the caller holds (or fail-opened past) the advance lease. */
async function advanceFilmJobLocked(env: Env, filmId: string): Promise<{ job: FilmJob; clipJob: ClipJob | null } | null> {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text()) as FilmJob;
  if (job.cancelled) return { job, clipJob: null };
  const envRec = env as unknown as Record<string, unknown>;
  const entryPhase = job.phase;
  // #521: discover the module registry ONCE per tick and thread it through every phase leg, instead of
  // each phase function re-fanning-out N `/module.json` subrequests. A tick can chain several discovering
  // legs (finish -> assemble -> master/mux -> film.finish + notify), so the old per-leg discovery blew the
  // free-plan 50-subrequest cap on a 25-module install (F9). Manifests are static within a tick.
  const modules = await discoverModules(envRec);

  // Stall recovery (#129): a pollable phase whose module poll never resolves (RunPod GC'd the finished
  // job) would otherwise hang IN_PROGRESS forever. Run BEFORE the phase legs so an adopted keyframe
  // phase advances to clips and the clips leg below drives it in the same tick. A persist happens at the
  // end via the phase-transition stamp; the helper only mutates the in-memory job.
  await recoverStalledPhase(env, job, modules);

  // Phase 1: poll the keyframe job; on completion, presign + hand off to the clip orchestrator.
  if (job.phase === "keyframe" && job.keyframe_poll) {
    const fetcher = job.keyframe_binding ? resolveFetcher(envRec, job.keyframe_binding) : null;
    if (!fetcher) { job.phase = "failed"; job.error = "keyframe module no longer bound"; }
    else {
      const p = await pollModule<KeyframeOutput>(fetcher, { poll: job.keyframe_poll });
      if (!p.ok) { job.phase = "failed"; job.error = p.error; }
      else if (!(p as { pending?: boolean }).pending) {
        const out = (p as { output: KeyframeOutput }).output;
        const v = hookOutputViolation(job.keyframe_binding ?? "keyframe", "keyframe", out);
        if (v) { job.phase = "failed"; job.error = v; }
        else await afterKeyframeOutput(env, job, out, modules);
      } else if (await keyframeSetCompleteInR2(env, job)) {
        // R2 PRESENCE IS AUTHORITATIVE, even on a *pending* poll (#129 sibling, mirrors #154 for finish):
        // the keyframe job's RunPod envelope can freeze at IN_PROGRESS after the GPU already wrote every
        // renders/<project>/keyframes/shot_NN.png to R2, so the poll reads pending forever. Don't wait for
        // KEYFRAME_STALL_SECONDS (20min) to adopt -- once the FULL set is in R2, advance now. The
        // completeness guard is essential: adopting a PARTIAL set (mid-generation) would advance to clips
        // with keyframes missing. (recoverStalledKeyframePhase stays as the >20min backstop, which is
        // lenient on partial = genuine non-renders.)
        await recoverStalledKeyframePhase(env, job, modules);
      }
    }
    await putFilm(env, job);
  }

  // Phase 2: drive the clip orchestrator; when every shot is terminal, hand off to the finish chain.
  let clipJob: ClipJob | null = null;
  if (job.phase === "clips" && job.clip_job_id) {
    clipJob = await advanceClipJob(env, job.clip_job_id, modules);
    // R2 PRESENCE IS AUTHORITATIVE, BEFORE the complete-judgment (issue #141): a module fast-fail (#142)
    // makes summarizeJob read complete (done+failed===total) at ~150s; without this, enterFinishPhase
    // builds from done clips only and DROPS the failed shots -- even though their clips are in R2. Reclaim
    // any not-done shot whose clip is in R2 (only lists when failed>0; idempotent with advanceClipJob's own
    // reclaim) so the film never advances/assembles with a clip dropped that actually landed.
    if (clipJob && summarizeJob(clipJob).failed > 0) {
      const adopted = await reclaimClipsFromR2(env, clipJob);
      if (adopted > 0) await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
    }
    if (clipJob && summarizeJob(clipJob).complete) { await enterFinishPhase(env, job, clipJob, modules); }
    await putFilm(env, job);
  } else if (job.clip_job_id) {
    const cj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id)); // load for the summary
    if (cj) clipJob = JSON.parse(await cj.text()) as ClipJob;
  }

  // Phase 2.5: synthesize per-shot dialogue audio (one batch via the dialogue module), then -> finish.
  // Soft-degrades to a silent finish on any failure (see advanceDialoguePhase).
  if (job.phase === "dialogue") {
    await advanceDialoguePhase(env, job, modules);
    await putFilm(env, job);
  }

  // Phase 2.6: enhance per-shot dialogue audio (the speech chain, async across requests), then -> finish.
  // A POLISH phase: a hard step failure degrades the shot (keeps the original audio) and the render
  // proceeds to finish -- a speech glitch must never fail a fully-rendered film (see advanceSpeechPhase).
  if (job.phase === "speech") {
    await advanceSpeechPhase(env, job);
    await putFilm(env, job);
  }

  // Phase 3: drive the finish chain per clip (async, across requests), then -> assemble.
  if (job.phase === "finish" && job.finish_shots) {
    await advanceFinishPhase(env, job, modules);
    await putFilm(env, job);
  }

  // Phase 4: assemble the final clips into one film (CPU-only ffmpeg concat in the video-finish
  // container), then -> done. The final clips are the finish-chain outputs if finish ran, else the
  // raw rendered clips; either way ordered by the storyboard. Reached inline once finish/clips
  // complete (the intermediate "assemble" was persisted above, so a timed-out concat just retries).
  if (job.phase === "assemble") {
    const source = job.finish_shots
      ? job.finish_shots
          .filter((fs) => fs.status === "done")
          .map((fs) => ({ shot_id: fs.shot_id, clip_key: fs.clip_key }))
      : (clipJob?.shots || [])
          .filter((s) => s.status === "done" && s.clip_key)
          .map((s) => ({ shot_id: s.shot_id, clip_key: s.clip_key as string }));
    await enterAssemblePhase(env, job, orderFinalClips(job.scenes, source), modules);
    await putFilm(env, job);
  }

  // Phase 4.5: master the assembled film's audio bed (music upscale + loudness) before mux. Pollable
  // like dialogue; FAIL-SAFE -- a master miss passes the bed through and proceeds to mux (#249 / #77).
  if (job.phase === "master") {
    await advanceMasterPhase(env, job, modules);
    await putFilm(env, job);
  }

  // Phase 5: mux the (mastered) audio bed onto the silent film via video-finish (VPC remuxAudioOnly).
  if (job.phase === "mux") {
    await enterMuxPhase(env, job, modules);
    await putFilm(env, job);
  }

  // Re-stamp the stall clock on REAL progress (#136). The clips/finish/speech phases advance per shot
  // over many minutes inside ONE phase, so a UI stall signal measured from phase_started_at alone cries
  // wolf on a healthy long phase. filmProgressMarker changes on any finished shot (or a phase
  // transition), so a change is genuine progress -> refresh last_progress_at. The DRIVER's recovery
  // (phaseAgeSeconds + the 90min ceiling) deliberately still measures from phase_started_at; this only
  // fixes the in-flight UI signal, never the recovery semantics.
  const marker = filmProgressMarker(job, clipJob);
  const progressed = marker !== job.progress_marker;
  if (progressed) {
    job.progress_marker = marker;
    job.last_progress_at = Date.now();
  }
  // On any phase transition this tick, stamp when the new phase began (the stall recovery measures
  // against it) and persist. The phase legs above already persisted on the paths they took; this also
  // covers a recovery that failed the job at the ceiling (no leg ran after it), so that verdict lands
  // in R2. putFilm is an idempotent re-PUT, so the belt-and-suspenders double write is harmless.
  if (job.phase !== entryPhase) {
    job.phase_started_at = Date.now();
    await putFilm(env, job);
  } else if (progressed) {
    await putFilm(env, job);
  }

  return { job, clipJob };
}
