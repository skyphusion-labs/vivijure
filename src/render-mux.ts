// Off-GPU audio mux onto a finished render via the video-finish container (remuxAudioOnly).
//
// Used by POST /api/storyboard/renders/:id/add-audio after the caller supplies an R2 audio key.
// Narration flows synthesize audio through a score module first, then call the same mux path.

import type { Env } from "./env";
import { callVideoFinish } from "./film-orchestrator";
import { stageAudioKeyForRenders } from "./audio-stage";
import { getRenderByIdForUser, setRenderAudioOutput } from "./renders-db";
import { presignR2Get, presignR2Put } from "./r2-presign";

const TERMINAL_OK = new Set(["COMPLETED"]);

export { stageAudioKeyForRenders } from "./audio-stage";

/** Mux an audio bed onto a finished silent MP4 via video-finish (VPC). */
export async function muxAudioOntoVideoKey(
  env: Env,
  videoKey: string,
  audioKey: string,
): Promise<{ ok: true; output_key: string } | { ok: false; error: string }> {
  if (!env.VIDEO_FINISH_VPC) return { ok: false, error: "video-finish VPC binding not configured" };

  let stagedKey: string;
  try {
    stagedKey = await stageAudioKeyForRenders(env, audioKey);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const outKey = videoKey.replace(/\.mp4$/i, "") + "-audio-" + crypto.randomUUID().slice(0, 8) + ".mp4";
  const [videoUrl, audioUrl, outputUrl] = await Promise.all([
    presignR2Get(env, videoKey, 1800),
    presignR2Get(env, stagedKey, 1800),
    presignR2Put(env, outKey, 1800),
  ]);

  const resp = await callVideoFinish(env, {
    clips: [{ url: videoUrl }],
    outputUrl,
    outputKey: outKey,
    audioUrl,
    remuxAudioOnly: true,
  });

  if (!resp || !resp.ok) {
    const errBody = resp ? await resp.text().catch(() => "") : "video-finish unreachable";
    return {
      ok: false,
      error: "video-finish mux failed: " + (errBody.slice(0, 200) || String(resp?.status ?? "network")),
    };
  }

  let body: { ok?: boolean; error?: string };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    return { ok: false, error: "video-finish returned invalid JSON" };
  }
  if (!body.ok) return { ok: false, error: body.error || "video-finish mux failed" };
  return { ok: true, output_key: outKey };
}

export async function muxAudioOntoRender(
  env: Env,
  renderId: number,
  audioKey: string,
): Promise<{ ok: true; output_key: string } | { ok: false; error: string }> {
  const row = await getRenderByIdForUser(env, renderId);
  if (!row) return { ok: false, error: "render not found" };
  if (!TERMINAL_OK.has(row.status)) return { ok: false, error: "render is not completed" };
  if (!row.output_key) return { ok: false, error: "render has no output video" };

  const muxed = await muxAudioOntoVideoKey(env, row.output_key, audioKey);
  if (!muxed.ok) return muxed;

  const updated = await setRenderAudioOutput(env, renderId, muxed.output_key, null);
  if (!updated) return { ok: false, error: "could not update render row" };
  return { ok: true, output_key: muxed.output_key };
}
