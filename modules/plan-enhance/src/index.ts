// plan-enhance: the first Vivijure module worker (vivijure-module/1).
//
// Serves the two contract endpoints:
//   GET  /module.json  -> the manifest (the core's registry discovers + indexes it)
//   POST /invoke       -> run the plan.enhance hook: a director pass over the storyboard's shot
//                         prompts, returning the enhanced storyboard.
//
// The director pass runs on Opus through the AI Gateway when an Opus token is configured, and
// degrades to the free Workers AI local model otherwise (or when Opus errors). A failure is DATA,
// never an exception across the wire: a bad request returns { ok:false }, and a soft miss (no model
// available, or an unparseable reply) degrades to passing the storyboard through unchanged with a
// note, so the core's chain never breaks on this stage.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PlanEnhanceInput,
  type PlanEnhanceOutput,
} from "./contract";
import { buildMessages, parseEnhanced, mergeEnhanced, scenePrompts, type Intensity } from "./enhance";
import {
  pickProvider,
  opusModel,
  callOpus,
  callLocal,
  LOCAL_MODEL,
  type ProviderEnv,
} from "./provider";

type Env = ProviderEnv;

const MANIFEST: ModuleManifest = {
  name: "plan-enhance",
  version: "0.2.0",
  api: MODULE_API,
  hooks: ["plan.enhance"],
  provides: [{ id: "auto-direction", label: "Opus auto-direction" }],
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

// Run the director pass, returning the model's raw reply plus a label of the model that produced it
// (for an honest note). Opus first when configured; on any Opus error, degrade to the free local
// model. Either provider erroring throws to the caller, which degrades to passthrough.
async function direct(
  env: Env,
  messages: ReturnType<typeof buildMessages>,
): Promise<{ reply: string | string[] | undefined; model: string }> {
  if (pickProvider(env) === "opus") {
    try {
      return { reply: await callOpus(env, messages), model: opusModel(env) };
    } catch {
      // Opus unavailable -> fall through to the free local model rather than failing the stage.
      return { reply: await callLocal(env, messages), model: `${LOCAL_MODEL} (opus fell back)` };
    }
  }
  return { reply: await callLocal(env, messages), model: LOCAL_MODEL };
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

  let reply: string | string[] | undefined;
  let model: string;
  try {
    ({ reply, model } = await direct(env, buildMessages(prompts, intensity)));
  } catch (e) {
    // Soft degrade: no model available -> pass the storyboard through unchanged.
    return {
      ok: true,
      output: { storyboard, notes: [`enhancement skipped: model error (${(e as Error).message})`] },
    };
  }

  const enhanced = parseEnhanced(reply, prompts.length);
  if (!enhanced) {
    return {
      ok: true,
      output: { storyboard, notes: [`enhancement skipped: ${model} reply was not a clean prompt array`] },
    };
  }

  return {
    ok: true,
    output: {
      storyboard: mergeEnhanced(storyboard, enhanced),
      notes: [`enhanced ${enhanced.length} shot(s) at ${intensity} intensity via ${model}`],
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
