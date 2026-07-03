// Backfill a render row for a job submitted outside the worker (idempotent adopt).

import type { Env } from "./env";
import { insertRender, markFinishDone } from "./renders-db";
import { coerceQualityTier, deriveProjectFromBundleKey } from "./runpod-submit";
import { isSafeBundleKey } from "./shared";

export async function handleAdoptRender(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: {
    jobId?: unknown;
    project?: unknown;
    bundleKey?: unknown;
    qualityTier?: unknown;
    mode?: unknown;
    outputKey?: unknown;
    seconds?: unknown;
    hasAudio?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.jobId !== "string" || body.jobId.trim().length === 0) {
    return json({ error: "jobId is required (non-empty string)" }, 400);
  }
  const jobId = body.jobId.trim();

  const outputKey =
    typeof body.outputKey === "string" && body.outputKey.trim().length > 0
      ? body.outputKey.trim()
      : null;
  if (body.seconds !== undefined && (typeof body.seconds !== "number" || !Number.isFinite(body.seconds))) {
    return json({ error: "seconds must be a finite number if provided" }, 400);
  }
  if (body.hasAudio !== undefined && typeof body.hasAudio !== "boolean") {
    return json({ error: "hasAudio must be a boolean if provided" }, 400);
  }
  if (body.qualityTier !== undefined && coerceQualityTier(body.qualityTier) === undefined) {
    return json(
      { error: "qualityTier must be 'draft' | 'standard' | 'final' if provided" },
      400,
    );
  }
  if (body.mode !== undefined && body.mode !== "full" && body.mode !== "keyframes-only") {
    return json(
      { error: "mode must be 'full' | 'keyframes-only' if provided" },
      400,
    );
  }

  const bundleKey = typeof body.bundleKey === "string" ? body.bundleKey : "";
  // Optional field, but when present it lands in the renders row and can later be read back as a
  // storage key (regen-shot): require the canonical bundle shape, like the submit handlers.
  if (bundleKey && !isSafeBundleKey(bundleKey)) {
    return json({ error: "bundleKey must be a plain relative key under bundles/" }, 400);
  }
  const project =
    typeof body.project === "string" && body.project.trim().length > 0
      ? body.project.trim()
      : bundleKey
        ? deriveProjectFromBundleKey(bundleKey)
        : jobId;

  const outJson = (): string => {
    const out: Record<string, unknown> = { output_key: outputKey };
    if (typeof body.seconds === "number") out.seconds = body.seconds;
    if (typeof body.hasAudio === "boolean") out.has_audio = body.hasAudio;
    return JSON.stringify(out);
  };

  try {
    const existing = await env.DB.prepare(
      "SELECT id FROM renders WHERE job_id = ? LIMIT 1",
    )
      .bind(jobId)
      .first<{ id: number }>();
    if (existing) {
      if (outputKey) await markFinishDone(env, jobId, outputKey, outJson());
      return json({
        ok: true,
        jobId,
        project,
        adopted: true,
        completed: !!outputKey,
        deduped: true,
      });
    }

    await insertRender(env, {
      jobId,
      project,
      bundleKey,
      qualityTier: coerceQualityTier(body.qualityTier) ?? "final",
      status: outputKey ? "COMPLETED" : "SUBMITTED",
      mode: (body.mode as "full" | "keyframes-only" | undefined) ?? "full",
      projectId: null,
    });
    if (outputKey) {
      await markFinishDone(env, jobId, outputKey, outJson());
    }
  } catch (err) {
    console.error("adopt render insert failed:", err);
    return json({ error: "could not adopt render" }, 500);
  }

  return json({ ok: true, jobId, project, adopted: true, completed: !!outputKey });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
