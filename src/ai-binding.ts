// env.AI binding wrappers (v0.19.3).
//
// Extracted from src/index.ts so provider modules and other code paths that
// call env.AI.run (chat, STT, image gen, TTS, embeddings, the LongRun
// workflow) share one binding wrapper rather than each constructing its
// own opts object.
//
// `aiRun` is the standard call path: pass model, params, optional flag to
// return the raw Response (rather than a parsed object) for binary-output
// models like TTS.
//
// `aiLogId` reads the Cloudflare AI Gateway log ID from the env.AI binding
// after a call, when one exists. The binding mutates a per-invocation field
// after each .run(); calling aiLogId immediately after aiRun returns the
// log ID for that specific call.

import type { Env } from "./env";
import { secretValue } from "./secret-store";

type RunOpts = { gateway: { id: string }; returnRawResponse?: boolean };
type RunFn = (model: string, params: unknown, opts?: RunOpts) => Promise<unknown>;

export async function aiRun(env: Env, model: string, params: unknown, returnRaw = false): Promise<unknown> {
  const opts: RunOpts = { gateway: { id: await secretValue(env.GATEWAY_ID) } };
  if (returnRaw) opts.returnRawResponse = true;
  return (env.AI as unknown as { run: RunFn }).run(model, params, opts);
}

export function aiLogId(env: Env): string | null {
  return (env.AI as unknown as { aiGatewayLogId?: string }).aiGatewayLogId ?? null;
}
