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
import { pollRenderJob, submitTrainLoraJob } from "./runpod-submit";
import {
  buildLoraTrainingBundleArgs,
  deriveLoraDestKey,
  extractTrainedLoraKey,
} from "./lora-bundle";

const MIN_TRAINING_REFS = 4;

export async function refreshTrainingLora(
  env: Env,
  cast: CastMember | null,
): Promise<CastMember | null> {
  if (!cast || cast.lora_status !== "training" || !cast.lora_job_id) return cast;
  try {
    const poll = await pollRenderJob(env, cast.lora_job_id);
    if (!poll.ok) return cast;
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
  } catch {
    // leave the row as-is on a poll error
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

  const poll = await pollRenderJob(env, cast.lora_job_id);
  if (!poll.ok) {
    return json({ error: poll.error, cast }, 502);
  }
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
