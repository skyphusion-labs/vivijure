// The model layer for plan.enhance: pick a provider, call it, extract the reply.
//
// Two providers, in preference order:
//   1. Opus via Cloudflare AI Gateway (Unified Billing, keyless) -- the cinematic-director pass.
//   2. Workers AI local open-weight model -- the free fallback when no Opus token is configured, or
//      when the Opus call fails. This is the Vivijure modularity thesis in one module: swap an
//      expensive cloud model for a free/local one without changing the hook contract.
//
// The pure pieces (pickProvider, toAnthropic, extractAnthropicText) unit-test without the runtime;
// the I/O (callOpus, callLocal) is a thin shell over them.

import type { ChatMessage } from "./enhance";

// The free fallback model on the account (the module's original, self-contained provider).
export const LOCAL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// The default cloud model: latest Opus, listed in the core model registry + planner catalog.
export const DEFAULT_OPUS_MODEL = "claude-opus-4-8";

// Structural binding: the Workers AI runner plus the AI Gateway accessor. Kept minimal so the module
// stays free of the full Ai overload surface and any @cloudflare/workers-types version pin.
export interface ProviderEnv {
  AI: {
    run(model: string, input: { messages: ChatMessage[] }): Promise<{ response?: string | string[] }>;
    gateway(id: string): { getUrl(provider: string): Promise<string> };
  };
  GATEWAY_ID?: string;
  CF_AIG_TOKEN?: string;
  ENHANCE_MODEL?: string;
}

export type Provider = "opus" | "local";

/** Use Opus only when BOTH the gateway id and the Unified-Billing token are configured; otherwise
 *  fall back to the free local model. Pure, so the selection is unit-tested. */
export function pickProvider(env: ProviderEnv): Provider {
  return env.GATEWAY_ID && env.CF_AIG_TOKEN ? "opus" : "local";
}

/** The Opus model id this deployment uses (env override, else the latest-Opus default). */
export function opusModel(env: ProviderEnv): string {
  const m = env.ENHANCE_MODEL?.trim();
  return m && m.length > 0 ? m.replace(/^anthropic\//, "") : DEFAULT_OPUS_MODEL;
}

/** Transform our OpenAI-style chat messages into the Anthropic Messages shape: the system prompt is
 *  pulled to a top-level field, the rest become user/assistant turns. Pure. */
export function toAnthropic(
  messages: ChatMessage[],
): { system?: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  let system: string | undefined;
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    // Our buildMessages only emits system + user; treat anything non-system as a user turn.
    out.push({ role: "user", content: m.content });
  }
  return system ? { system, messages: out } : { messages: out };
}

/** Concatenate the text blocks of an Anthropic Messages response into one string, or null when the
 *  shape has no usable text. Pure. */
export function extractAnthropicText(raw: unknown): string | null {
  const content = (raw as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b): b is { type?: string; text?: string } => typeof b === "object" && b !== null)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return text.trim().length > 0 ? text : null;
}

/** Call Opus through the AI Gateway (Unified Billing: cf-aig-authorization only, never x-api-key).
 *  Throws on a missing token, a non-2xx, or an empty reply, so the caller can fall back. */
export async function callOpus(env: ProviderEnv, messages: ChatMessage[]): Promise<string> {
  if (!env.GATEWAY_ID || !env.CF_AIG_TOKEN) {
    throw new Error("opus requires GATEWAY_ID and CF_AIG_TOKEN");
  }
  const baseUrl = await env.AI.gateway(env.GATEWAY_ID).getUrl("anthropic");
  const { system, messages: aMessages } = toAnthropic(messages);

  const body: Record<string, unknown> = {
    model: opusModel(env),
    max_tokens: 4096,
    messages: aMessages,
  };
  if (system) body.system = system;

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      // Unified Billing: keyless. An x-api-key would flip the gateway to BYOK billing, so never set one.
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`anthropic ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const text = extractAnthropicText(await resp.json());
  if (!text) throw new Error("anthropic returned no text content");
  return text;
}

/** Call the free Workers AI local model. Returns its raw reply (string or string array) for the
 *  shared parser; throws on a runner error so the caller can degrade to passthrough. */
export async function callLocal(
  env: ProviderEnv,
  messages: ChatMessage[],
): Promise<string | string[] | undefined> {
  const res = await env.AI.run(LOCAL_MODEL, { messages });
  return res?.response;
}
