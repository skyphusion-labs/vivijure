// Chat-side R2 artifacts (env.R2): image outputs from POST /api/chat with image models.

import type { Env } from "./env";
import { extFromMime } from "./utils";

export interface OutputArtifact {
  key: string;
  mime: string;
  type: "image";
}

export async function putChatArtifact(
  env: Env,
  mime: string,
  bytes: Uint8Array,
): Promise<OutputArtifact> {
  const key = `out/${crypto.randomUUID()}.${extFromMime(mime)}`;
  await env.R2.put(key, bytes, {
    httpMetadata: { contentType: mime },
  });
  return { key, mime, type: "image" };
}
