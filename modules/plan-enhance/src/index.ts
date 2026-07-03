// plan-enhance: the first Vivijure module worker (vivijure-module/2).
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

// The Worker's own binding surface. GATEWAY_ID + CF_AIG_TOKEN are bound from the account-level
// Cloudflare Secrets Store (declarative config, durable across fresh-create), so the fetch handler
// resolves them to plain strings and hands the pure model layer (provider.ts) an ordinary
// ProviderEnv -- no Secrets Store type leaks into the unit-tested pure code. Both are OPTIONAL:
// with neither, pickProvider degrades to the free Workers AI local model.
interface WorkerEnv {
  AI: ProviderEnv["AI"];
  GATEWAY_ID?: SecretsStoreSecret;
  CF_AIG_TOKEN?: SecretsStoreSecret;
  ENHANCE_MODEL?: string;
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value.
 *  Returns "" if unset/unreadable so the existing "not configured" guards still fire. */
async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  if (typeof s === "string") return s;
  if (!s) return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + (e as Error).message);
    return "";
  }
}

const MANIFEST: ModuleManifest = {
  name: "plan-enhance",
  version: "0.2.1",
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
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
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
      // Resolve the Secrets Store bindings to plain strings, then hand the pure model layer an
      // ordinary ProviderEnv. secretValue -> "" for an unset/unreadable secret, so pickProvider
      // degrades to the free local model exactly as before.
      const provEnv: ProviderEnv = {
        AI: env.AI,
        GATEWAY_ID: await secretValue(env.GATEWAY_ID),
        CF_AIG_TOKEN: await secretValue(env.CF_AIG_TOKEN),
        ENHANCE_MODEL: env.ENHANCE_MODEL,
      };
      return json(await runEnhance(provEnv, req));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
