// Public demo studio -- Phase B assistant (#631, constraints 6-9). A demo-scoped AI helper on an OSS
// model (Workers AI llama-3.3-70b class) behind its OWN hard-capped AI Gateway. The point is NOT cost --
// it is denying the demo as a free public LLM proxy. So the bound is CONFIG + COUNTERS, not hope:
//
//  * per-IP + global DAILY caps in D1 (the demo_counter the render path uses), checked BEFORE the model
//    is ever called, so an exhausted visitor spends zero tokens;
//  * the AI Gateway itself carries a HARD daily budget (set at provisioning, rider 2) as the backstop;
//  * a demo-scoped system prompt + a LOW max_tokens: the assistant answers about the seeded catalog and
//    how vivijure works, and has NO tool/binding reach beyond read-only studio state (it cannot render,
//    mutate, or read anything the read-only gate denies);
//  * honest exhaustion (constraint 7): the cap reply is plain text, browse keeps working, never a spinner
//    and never a silent downgrade.
//
// Env-free + the model call is an injected seam, so the cap logic + prompt shaping unit-test without a
// Worker runtime or a token spend.

import { bumpCounter, utcDay, type D1Like } from "./demo-render";

/** The injected model runner (real: a thin wrapper over env.AI.run through the demo gateway). Returns
 *  the assistant text, or throws -- the caller degrades a throw to an honest error, never a silent blank. */
export type DemoChatModel = (args: { system: string; user: string; maxTokens: number }) => Promise<string>;

export interface DemoChatCaps {
  perIpDaily: number;   // per-IP chats per UTC day
  globalDaily: number;  // global chats per UTC day
  maxTokens: number;    // hard output cap (short answers)
  maxInputChars: number; // reject an over-long prompt before it reaches the model
}

export const DEFAULT_DEMO_CHAT_CAPS: DemoChatCaps = {
  perIpDaily: 20,       // D4 ruling
  globalDaily: 2000,    // D4 ruling
  maxTokens: 400,
  maxInputChars: 1500,
};

// The demo-scoped system prompt. Deliberately narrow: it describes the demo, points at the seeded menu,
// and refuses to be a general assistant. No tools, no browsing, no code execution -- read-only studio help.
export const DEMO_CHAT_SYSTEM_PROMPT =
  "You are the assistant on the PUBLIC DEMO of Vivijure, an open-source AI film studio. You run on a free " +
  "open-weights model here, so you are not as sharp as the studio's real brain. Be brief and friendly. Help " +
  "the visitor understand what Vivijure is and how to use the demo: they can browse the seeded catalog and " +
  "cast, and render ONE short clip from the seeded scene menu on a real GPU. You CANNOT render for them, " +
  "change anything, or access private data -- the demo is read-only apart from the menu render. If asked for " +
  "anything outside helping with this demo (general coding, unrelated questions, acting as a free chatbot), " +
  "briefly decline and steer back to the demo. Encourage anyone who wants the full experience to run their " +
  "own Vivijure studio (it is open source).";

export interface DemoChatDeps {
  db: D1Like;
  model: DemoChatModel;
  caps: DemoChatCaps;
  now: number;
}

export type DemoChatResult =
  | { ok: true; reply: string }
  | { ok: false; reason: "empty" | "too-long" | "exhausted" | "error"; message: string };

/** Run one capped demo chat turn. Caps are checked (and counted) BEFORE the model call, so an exhausted
 *  visitor never spends a token; a model throw degrades to an honest error, never a silent blank. */
export async function runDemoChat(deps: DemoChatDeps, input: { ip: string; message: string }): Promise<DemoChatResult> {
  const message = (input.message ?? "").trim();
  if (!message) return { ok: false, reason: "empty", message: "type a question about the demo" };
  if (message.length > deps.caps.maxInputChars) {
    return { ok: false, reason: "too-long", message: "that message is too long for the demo assistant" };
  }
  const day = utcDay(deps.now);
  const ipCount = await bumpCounter(deps.db, `chat:ip:${input.ip}:${day}`, day);
  if (ipCount > deps.caps.perIpDaily) {
    return { ok: false, reason: "exhausted", message: "you have used your demo assistant messages for today -- browse the catalog, or run your own studio for the full brain. Resets at UTC midnight." };
  }
  const globalCount = await bumpCounter(deps.db, `chat:global:${day}`, day);
  if (globalCount > deps.caps.globalDaily) {
    return { ok: false, reason: "exhausted", message: "the free demo assistant is out of capacity for today -- browse keeps working, and you can run your own studio for the full brain." };
  }
  try {
    const reply = (await deps.model({ system: DEMO_CHAT_SYSTEM_PROMPT, user: message, maxTokens: deps.caps.maxTokens })).trim();
    if (!reply) return { ok: false, reason: "error", message: "the demo assistant had nothing to say -- try rephrasing" };
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, reason: "error", message: "the demo assistant is unavailable right now -- browse keeps working" };
  }
}
