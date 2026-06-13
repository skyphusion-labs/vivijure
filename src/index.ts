// Vivijure studio core: the module host.
//
// Phase 1 (render migration, epic #25). This worker owns the module registry, the self-assembling
// studio UI, and the staged render API (storyboard / cast / render / scatter-gather). It serves:
//   GET /health        liveness, no bindings touched
//   GET /api/modules   the live registry (what is plugged in) -- the frontend renders itself from this
//   *                  everything else falls through to ASSETS (the studio frontend in public/)
//
// The render routes are wired in incrementally (PR 2). The three CPU container Durable Object classes
// are exported below so the runtime can register them (bound in wrangler.toml). The core never grows
// a feature it could host as a module instead.

import { discoverModules, modulesResponse } from "./modules/registry";
import type { Env } from "./env";

// CPU container Durable Objects (off-GPU beat-sync, portrait prep, ffmpeg finish). Exported from the
// entrypoint so wrangler/the runtime can register them; bound as AUDIO_BEAT_SYNC / IMAGE_PREP /
// VIDEO_FINISH (wrangler.toml [[durable_objects.bindings]] + [[containers]]).
export { AudioBeatSyncContainer } from "./containers/audio-beat-sync";
export { ImagePrepContainer } from "./containers/image-prep";
export { VideoFinishContainer } from "./containers/video-finish";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "vivijure-studio", phase: 1 });
    }

    // The registry, live: scan the env for MODULE_* bindings, read their manifests, return the
    // merged view. Zero modules installed is a valid, lean studio (empty modules + hooks).
    if (url.pathname === "/api/modules" && request.method === "GET") {
      const modules = await discoverModules(env as unknown as Record<string, unknown>);
      return json(modulesResponse(modules));
    }

    // Render routes (storyboard / cast / render / scatter-gather) wire in here -- PR 2 (epic #25).

    // Everything else is the static studio frontend.
    return env.ASSETS.fetch(request);
  },
};
