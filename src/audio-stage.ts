// Stage an audio bed R2 key into env.R2_RENDERS when needed (MiniMax out/ keys).

import type { Env } from "./env";
import { needsAudioCrossBucketCopy } from "./audio-routing";

export async function stageAudioKeyForRenders(env: Env, audioKey: string): Promise<string> {
  const key = audioKey.trim();
  if (!key) throw new Error("audioKey required");
  if (!needsAudioCrossBucketCopy(key)) return key;
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
