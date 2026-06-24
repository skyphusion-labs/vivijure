// Cast LoRA training: submit a single-slot bundle, poll RunPod, harvest the key.

import type { Env } from "./env";
import {
  getCastById,
  markLoraFailed,
  markLoraReady,
  setLoraJob,
  type CastMember,
} from "./cast-db";
import { assembleBundle } from "./bundle-assembler";
import { pollRenderJob, submitTrainLoraJob, type RunpodResult } from "./runpod-submit";
import {
  buildLoraTrainingBundleArgs,
  deriveLoraDestKey,
  extractTrainedLoraKey,
} from "./lora-bundle";

const MIN_TRAINING_REFS = 4;

// --- Stuck-training reconciler (#295) ---------------------------------------------------------
// A cast LoRA training row transitions off `training` only when a poll observes a TERMINAL RunPod
// status. If the backing job ages out of RunPod's retention window before any poll catches a terminal
// state, the poll keeps returning not-found/non-terminal and the row wedges in `training` forever --
// and the train-lora route then 409s, so the character can never be retrained without a manual D1
// edit. The reconciler closes that hole: a not-found (404) past a grace window, or a row older than a
// hard ceiling, is force-failed (an HONEST degrade with a clear lora_error, never a silent reset) so
// the user can re-fire.

// Ignore a 404 within this window of the row's last write: a just-submitted job can briefly 404 before
// RunPod registers it (mirrors the GC-grace discipline on the status path).
export const LORA_TRAIN_404_GRACE_SECONDS = 120;
// Hard ceiling: cast training is ~10-15 min, so a row sitting in `training` past this was never
// observed terminal and is treated as failed regardless of the poll (backstop for a vanished job).
export const LORA_TRAIN_MAX_AGE_SECONDS = 60 * 60;

export interface StuckTrainingDecision {
  reconcile: boolean;
  reason?: string;
}

// SQLite `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone. Parse it as a UTC epoch
// in ms; returns null for a missing/unparseable value (the caller then declines to reconcile, never
// false-failing a row whose age it cannot establish).
export function sqliteUtcToMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.includes("T") ? s : s.replace(" ", "T");
  const withZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(t) ? t : t + "Z";
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

// How long a row has sat in `training`, measured from its last write (updated_at -- set by setLoraJob
// when the job was submitted). null when the timestamp can't be parsed.
export function trainingAgeSeconds(cast: CastMember, now: number): number | null {
  const ms = sqliteUtcToMs(cast.updated_at);
  if (ms === null) return null;
  return (now - ms) / 1000;
}

// Pure decision: should a `training` row whose backing job we just polled be force-failed? `poll` is
// the pollRenderJob result; ageSeconds is trainingAgeSeconds (null => unknown, never reconcile). A 404
// past the grace window means the job is gone from RunPod retention; the max-age ceiling is the
// backstop for a job that simply never reported terminal.
export function decideStuckTraining(
  poll: { ok: boolean; status?: number },
  ageSeconds: number | null,
): StuckTrainingDecision {
  if (ageSeconds === null) return { reconcile: false };
  const notFound = poll.ok === false && poll.status === 404;
  if (notFound && ageSeconds >= LORA_TRAIN_404_GRACE_SECONDS) {
    return {
      reconcile: true,
      reason:
        `backing RunPod job not found (HTTP 404; aged out of retention) after ` +
        `${Math.round(ageSeconds)}s in training -- it cannot complete; re-fire training`,
    };
  }
  if (ageSeconds >= LORA_TRAIN_MAX_AGE_SECONDS) {
    return {
      reconcile: true,
      reason:
        `training exceeded max age (${Math.round(ageSeconds)}s >= ${LORA_TRAIN_MAX_AGE_SECONDS}s); ` +
        `backing job not observed terminal -- re-fire training`,
    };
  }
  return { reconcile: false };
}

export async function refreshTrainingLora(
  env: Env,
  cast: CastMember | null,
  now: number = Date.now(),
): Promise<CastMember | null> {
  if (!cast || cast.lora_status !== "training" || !cast.lora_job_id) return cast;
  const ageSeconds = trainingAgeSeconds(cast, now);
  let poll: RunpodResult;
  try {
    poll = await pollRenderJob(env, cast.lora_job_id);
  } catch {
    poll = { ok: false, error: "poll threw" };
  }
  if (poll.ok) {
    const view = poll.view;
    if (view.status === "COMPLETED") {
      const loraKey = extractTrainedLoraKey(view.output);
      if (loraKey) return (await markLoraReady(env, cast.id, loraKey)) || cast;
      return (
        (await markLoraFailed(
          env,
          cast.id,
          "GPU job completed but envelope did not include lora_key",
        )) || cast
      );
    }
    if (
      view.status === "FAILED" ||
      view.status === "TIMED_OUT" ||
      view.status === "CANCELLED"
    ) {
      return (
        (await markLoraFailed(
          env,
          cast.id,
          view.error || `training ${view.status.toLowerCase()}`,
        )) || cast
      );
    }
  }
  // Not terminal (poll 404 / transport error / a non-terminal-but-wedged view): reconcile a row whose
  // backing job is gone past the grace window, or that has simply aged out. #295 -- never leave it
  // wedged in `training` (that 409s every retry).
  const decision = decideStuckTraining(poll, ageSeconds);
  if (decision.reconcile) {
    return (await markLoraFailed(env, cast.id, decision.reason as string)) || cast;
  }
  return cast;
}

export async function handleCastTrainLora(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  let bodyRenderOverrides: Record<string, unknown> | undefined;
  try {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const parsed = (await request.json()) as { renderOverrides?: unknown };
      if (
        parsed?.renderOverrides &&
        typeof parsed.renderOverrides === "object" &&
        !Array.isArray(parsed.renderOverrides)
      ) {
        bodyRenderOverrides = parsed.renderOverrides as Record<string, unknown>;
      }
    }
  } catch {
    /* empty body is fine */
  }

  const cast = await getCastById(env, id);
  if (!cast) return json({ error: "cast not found" }, 404);
  if (cast.lora_status === "training") {
    return json(
      {
        error: "a LoRA training job is already in flight for this cast member",
        jobId: cast.lora_job_id,
      },
      409,
    );
  }
  if (!cast.portrait_key) {
    return json(
      { error: "cast member needs a portrait before training (set one via /cast)" },
      400,
    );
  }
  if (cast.ref_keys.length < MIN_TRAINING_REFS) {
    return json(
      {
        error: `cast member has only ${cast.ref_keys.length} training refs; need at least ${MIN_TRAINING_REFS}. Use the training-set generator on /cast.`,
      },
      400,
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const args = buildLoraTrainingBundleArgs(cast, String(timestamp));

  let bundleResult;
  try {
    bundleResult = await assembleBundle(env, args);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `bundle assembly failed: ${m}` }, 500);
  }
  if (!bundleResult.ok) {
    return json(
      { error: "bundle assembly failed", details: bundleResult.errors },
      500,
    );
  }

  const loraDestKey = deriveLoraDestKey(cast.id, timestamp);
  const submit = await submitTrainLoraJob(env, {
    project: args.storyboard.projectName,
    bundleKey: bundleResult.bundleKey,
    renderOverrides: bodyRenderOverrides,
  });
  if (!submit.ok) {
    return json({ error: submit.error }, 502);
  }

  const updated = await setLoraJob(env, cast.id, submit.view.jobId);
  return json({
    ok: true,
    jobId: submit.view.jobId,
    status: submit.view.status,
    statusRaw: submit.view.statusRaw,
    bundleKey: bundleResult.bundleKey,
    loraDestKey,
    cast: updated || cast,
  });
}

export async function handleCastLoraStatus(
  env: Env,
  id: number,
): Promise<Response> {
  const cast = await getCastById(env, id);
  if (!cast) return json({ error: "cast not found" }, 404);
  if (!cast.lora_job_id) {
    return json({ cast, view: null });
  }

  const ageSeconds = trainingAgeSeconds(cast, Date.now());
  let poll: RunpodResult;
  try {
    poll = await pollRenderJob(env, cast.lora_job_id);
  } catch {
    poll = { ok: false, error: "poll threw" };
  }

  if (poll.ok) {
    const view = poll.view;
    if (view.status === "COMPLETED") {
      const loraKey = extractTrainedLoraKey(view.output);
      if (!loraKey) {
        const updated = await markLoraFailed(
          env,
          cast.id,
          "GPU job completed but envelope did not include lora_key",
        );
        return json({ cast: updated || cast, view });
      }
      const updated = await markLoraReady(env, cast.id, loraKey);
      return json({ cast: updated || cast, view });
    }
    if (view.status === "FAILED" || view.status === "TIMED_OUT" || view.status === "CANCELLED") {
      const msg = view.error || `training ${view.status.toLowerCase()}`;
      const updated = await markLoraFailed(env, cast.id, msg);
      return json({ cast: updated || cast, view });
    }
    return json({ cast, view });
  }

  // poll failed (404 / transport): reconcile a wedged `training` row (#295) before surfacing the
  // error, so an aged-out job can't keep the row stuck (which 409s every retry). A 404 inside the
  // grace window, or any non-training row, falls through to the honest 502.
  if (cast.lora_status === "training") {
    const decision = decideStuckTraining(poll, ageSeconds);
    if (decision.reconcile) {
      const updated = await markLoraFailed(env, cast.id, decision.reason as string);
      return json({ cast: updated || cast, view: null, reconciled: true });
    }
  }
  return json({ error: poll.error, cast }, 502);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
