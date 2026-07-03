// xAI BYOK chat dispatch (v0.19.1).
//
// Extracted from src/index.ts following the v0.19.0 pattern set by
// src/providers/anthropic.ts. Owns the request builder, non-streaming
// caller, and streaming caller for xAI Grok models through Cloudflare
// AI Gateway.
//
// xAI's API is OpenAI-compatible (same wire format), so no message transform
// is needed. Routed through AI Gateway's xAI provider endpoint for caching,
// logging, and rate-limiting.
//
// Auth strategy: stored-keys-first. If env.XAI_API_KEY is set, we send it as
// Authorization: Bearer (inline auth, takes priority at the gateway). If it
// isn't, we omit the header and let the gateway inject the key you've stored
// in dashboard > AI Gateway > Provider Keys. Either path works.
//
// Note: Grok 4.x models are reasoning models that expect max_completion_tokens
// rather than the older max_tokens field.

import type { Env } from "../env";
import type { ModelEntry } from "../models";
import type { ProviderStreamEvent } from "../parsers/types";
import { secretValue } from "../secret-store";
import { extractSSEDataPayloads } from "../parsers/sse-framer";
import { interpretXaiSSEFrame } from "../parsers/xai-sse";

// Shared request builder for both callXai (non-streaming) and callXaiStream
// (SSE). All the URL/headers/body construction lives here; callers differ
// only in whether they pass `signal`, whether they read `cf-aig-log-id`,
// and how they consume the response body.

async function prepareXaiRequest(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>,
  opts: { stream: boolean },
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(await secretValue(env.GATEWAY_ID)).getUrl("grok");

  // Strip "xai/" prefix; xAI's API expects just the model name (e.g. "grok-4.3").
  const modelName = model.id.replace(/^xai\//, "");

  const body: Record<string, unknown> = {
    model: modelName,
    messages,
    max_completion_tokens: 4096,
  };
  if (opts.stream) {
    body.stream = true;
    // include_usage:true asks xAI to send token counts in the final pre-[DONE]
    // chunk. Without this, usage stays null on streamed responses.
    body.stream_options = { include_usage: true };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (env.XAI_API_KEY) headers["Authorization"] = `Bearer ${env.XAI_API_KEY}`;
  const aigToken = await secretValue(env.CF_AIG_TOKEN);
  if (aigToken) headers["cf-aig-authorization"] = `Bearer ${aigToken}`;

  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers,
    body: JSON.stringify(body),
  };
}

export async function callXai(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>,
): Promise<{ raw: unknown; logId: string | null }> {
  const { url, headers, body } = await prepareXaiRequest(env, model, messages, { stream: false });

  const resp = await fetch(url, { method: "POST", headers, body });

  const logId = resp.headers.get("cf-aig-log-id");

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`xAI API ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const raw = await resp.json();
  return { raw, logId };
}

// Async generator: drives an xAI Grok model via direct fetch with stream:true
// and yields normalized text + usage events.
//
// xAI uses standard OpenAI-compatible SSE:
//   data: {"choices":[{"delta":{"content":"..."}}]}        // per chunk
//   data: {"choices":[],"usage":{...}}                      // final usage chunk
//   data: [DONE]                                            // terminal sentinel
//
// The usage chunk only fires when stream_options.include_usage:true is set
// on the request, which we do. The gateway proxies the SSE body through
// transparently.
//
// Abort handling: fetch() takes the AbortSignal directly. When the client
// disconnects, runChatStream aborts the controller and the upstream fetch
// is cancelled mid-stream, releasing the worker invocation immediately.

export async function* callXaiStream(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  const { url, headers, body } = await prepareXaiRequest(env, model, messages, { stream: true });

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`xAI API ${resp.status}: ${errText.slice(0, 500)}`);
  }
  if (!resp.body) {
    throw new Error("xAI streaming: response body missing");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const { payloads, remainder } = extractSSEDataPayloads(buffer);
      buffer = remainder;

      for (const payload of payloads) {
        let data: unknown;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const event of interpretXaiSSEFrame(data)) yield event;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}
