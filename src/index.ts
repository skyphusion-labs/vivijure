// Vivijure studio core: the module host.
//
// Phase 0 spine. This worker owns the module registry and the self-assembling studio UI. It serves:
//   GET /health        liveness, no bindings touched
//   GET /api/modules   the live registry (what is plugged in) -- the frontend renders itself from this
//   *                  everything else falls through to ASSETS (the studio frontend in public/)
//
// The render API (storyboard / cast / render / scatter-gather) is staged in src/ (cast-db, renders-db,
// runpod-submit, scatter, r2-presign, render-*, storyboard-*, the containers) but is deliberately NOT
// routed here yet: this entrypoint imports zero of it. Wiring those routes in (and exporting the
// container DO classes) is the Phase-1 migration, tracked as the #1 epic. The core never grows a
// feature it could host as a module instead.

import { discoverModules, modulesResponse } from "./modules/registry";
import type { Env } from "./env";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "vivijure-studio", phase: 0 });
    }

    // The registry, live: scan the env for MODULE_* bindings, read their manifests, return the
    // merged view. Zero modules installed is a valid, lean studio (empty modules + hooks).
    if (url.pathname === "/api/modules" && request.method === "GET") {
      const modules = await discoverModules(env as unknown as Record<string, unknown>);
      return json(modulesResponse(modules));
    }

    // Everything else is the static studio frontend.
    return env.ASSETS.fetch(request);
  },
};
