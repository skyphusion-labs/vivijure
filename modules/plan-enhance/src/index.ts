// plan-enhance: the first Vivijure module worker (vivijure-module/1).
//
// Serves the two contract endpoints:
//   GET  /module.json  -> the manifest (the core's registry discovers + indexes it)
//   POST /invoke       -> run the plan.enhance hook: a director pass over the storyboard's shot
//                         prompts via Workers AI, returning the enhanced storyboard.
//
// A failure is DATA, never an exception across the wire: a bad request returns { ok:false }, and a
// soft miss (model unavailable or unparseable reply) degrades to passing the storyboard through
// unchanged with a note, so the core's chain never breaks on this stage.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PlanEnhanceInput,
  type PlanEnhanceOutput,
} from "./contract";
import { buildMessages, parseEnhanced, mergeEnhanced, scenePrompts, type ChatMessage, type Intensity } from "./enhance";

// Structural binding type: just the runner we call, so the module stays free of the full Ai
// overload surface (and of any @cloudflare/workers-types version pin).
interface Env {
  AI: { run(model: string, input: { messages: ChatMessage[] }): Promise<{ response?: string | string[] }> };
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MANIFEST: ModuleManifest = {
  name: "plan-enhance",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["plan.enhance"],
  provides: [{ id: "auto-direction", label: "LLM auto-direction" }],
  config_schema: {
    intensity: {
      type: "enum",
      values: ["light", "medium", "bold"],
      default: "medium",
      label: "direction intensity",
    },
  },
  ui: { section: "plan", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runEnhance(
  env: Env,
  req: InvokeRequest<PlanEnhanceInput>,
): Promise<InvokeResponse<PlanEnhanceOutput>> {
  const storyboard = req.input?.storyboard;
  const prompts = storyboard ? scenePrompts(storyboard) : null;
  if (!storyboard || !prompts) {
    return { ok: false, error: "plan.enhance: input.storyboard has no scenes" };
  }
  const intensity = (req.config?.intensity as Intensity) || "medium";

  let reply: string | undefined;
  try {
    const res = await env.AI.run(MODEL, { messages: buildMessages(prompts, intensity) });
    reply = res?.response;
  } catch (e) {
    // Soft degrade: model unavailable -> pass the storyboard through unchanged.
    return {
      ok: true,
      output: { storyboard, notes: [`enhancement skipped: model error (${(e as Error).message})`] },
    };
  }

  const enhanced = parseEnhanced(reply, prompts.length);
  if (!enhanced) {
    return {
      ok: true,
      output: { storyboard, notes: ["enhancement skipped: model reply was not a clean prompt array"] },
    };
  }

  return {
    ok: true,
    output: {
      storyboard: mergeEnhanced(storyboard, enhanced),
      notes: [`enhanced ${enhanced.length} shot(s) at ${intensity} intensity`],
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") {
      return json(MANIFEST);
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<PlanEnhanceInput>;
      try {
        req = (await request.json()) as InvokeRequest<PlanEnhanceInput>;
      } catch {
        const bad: InvokeResponse = { ok: false, error: "invalid JSON body" };
        return json(bad);
      }
      if (req.hook !== "plan.enhance") {
        const bad: InvokeResponse = { ok: false, error: `unsupported hook ${String(req.hook)}` };
        return json(bad);
      }
      return json(await runEnhance(env, req));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
