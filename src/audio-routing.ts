// Audio bed key routing (v0.52.0).
//
// The planner can hand the render-submit route an audio R2 key from one
// of two sources:
//
//   audio/<uuid>.<ext>   BYO audio bed uploaded via POST /api/storyboard/
//                        audio-upload. Already in env.R2_RENDERS, where
//                        the GPU worker (vivijure-serverless 0.4.11+)
//                        reads from. No copy needed.
//
//   out/<uuid>.<ext>     MiniMax Music 2.6 chat-side generation output.
//                        Lives in env.R2 (the chat bucket); the GPU
//                        worker has no binding to that bucket and can
//                        not resolve the key. The submit handler must
//                        copy bytes into env.R2_RENDERS under
//                        audio/<new-uuid>.<ext> and submit the new key.
//
// This module owns the routing decision in a pure helper so vitest can
// cover the branch logic without dragging in the cloudflare:workers
// runtime. The actual cross-bucket copy lives in src/index.ts where it
// has env access.

export function needsAudioCrossBucketCopy(
  key: string | null | undefined,
): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  return key.startsWith("out/");
}
