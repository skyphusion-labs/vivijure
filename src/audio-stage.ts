// Stage an audio bed R2 key into env.R2_RENDERS when needed (MiniMax out/ keys).

import type { Env } from "./env";
import { needsAudioCrossBucketCopy } from "./audio-routing";

export async function stageAudioKeyForRenders(env: Env, audioKey: string): Promise<string> {
  const key = audioKey.trim();
  if (!key) throw new Error("audioKey required");
  if (!needsAudioCrossBucketCopy(key)) return key;
  // An `out/<uuid>.<ext>` key can now come from TWO sources sharing the prefix:
  //   - the score-bed MODULE workers (music-gen / narration-gen, #158) write `out/` to THIS bucket
  //     (their R2_RENDERS = vivijure, the same bucket bound here) -> already present, no copy needed.
  //   - the legacy chat-side MiniMax generation writes `out/` to env.R2 (the skyphusion-llm bucket) ->
  //     copy into R2_RENDERS so the GPU worker can read it.
  // So check R2_RENDERS FIRST and use it as-is; only cross-copy from env.R2 when it is not here. Without
  // this, a score-bed key (in R2_RENDERS, absent from env.R2) threw "audio source not found" -> the film
  // kick 500'd (the scored-render path).
  if (await env.R2_RENDERS.head(key)) return key;
  const src = await env.R2.get(key);
  if (!src) throw new Error(`audio source not found: ${key}`);
  const ext = key.split(".").pop() || "mp3";
  const dest = `audio/${crypto.randomUUID()}.${ext}`;
  const mime = src.httpMetadata?.contentType || "audio/mpeg";
  await env.R2_RENDERS.put(dest, await src.arrayBuffer(), { httpMetadata: { contentType: mime } });
  return dest;
}

/** Cross-bucket copy when needed; returns undefined when no key was given. */
export async function resolveStagedAudioKey(env: Env, audioKey: string | undefined): Promise<string | undefined> {
  if (!audioKey?.trim()) return undefined;
  return stageAudioKeyForRenders(env, audioKey.trim());
}
