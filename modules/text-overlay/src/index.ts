// text-overlay: a finish module worker (vivijure-module/1). Burns text overlays (titles, credits,
// lower-thirds, subtitles) onto a rendered clip via ffmpeg drawtext, running in the always-on
// video-finish CPU container over Workers VPC (VIDEO_FINISH_VPC).
//
// SYNCHRONOUS: drawtext on a 5-10 s clip completes in a few seconds on the CPU container, well
// within the Worker timeout. No /poll needed. The core chains this after finish-rife (ui.order 20).
//
// Flow:
//   1. Read req.config.overlays[] to build the drawtext filter string (pure, unit-testable).
//   2. Stream the input clip from R2, POST to VIDEO_FINISH_VPC /overlay with the filter spec.
//   3. Write the result bytes to R2 under a new key, return FinishOutput.
//
// Soft degrade: if overlays is empty/absent, the module passes the clip through unchanged and tags
// applied with "noop:no-overlays" (same pattern as finish-rife, #77). A container failure tags
// "passthrough:container-failed" and sets `degraded`.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type FinishInput,
  type FinishOutput,
} from "./contract";
import {
  coerceConfig,
  coerceOverlays,
  buildDrawtextFilter,
  buildContainerSpec,
  outputClipKey,
  passthroughOutput,
} from "./overlay";

interface R2Body {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface Env {
  VIDEO_FINISH_VPC: { fetch(url: RequestInfo, init?: RequestInit): Promise<Response> };
  R2_RENDERS: {
    get(key: string): Promise<R2Body | null>;
    put(key: string, value: ArrayBuffer): Promise<unknown>;
  };
}

const MANIFEST: ModuleManifest = {
  name: "text-overlay",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["finish"],
  provides: [{ id: "text-overlay", label: "Text overlay (titles / credits / subtitles)" }],
  config_schema: {
    font:        { type: "string", default: "Arial",  label: "default font" },
    size:        { type: "int",    default: 48, min: 8, max: 400, label: "default font size (px)" },
    color:       { type: "string", default: "white",  label: "default font color (name or #rrggbb)" },
    safe_margin: { type: "int",    default: 50, min: 0, max: 500, label: "safe margin (px from edge)" },
  },
  ui: { section: "finish", order: 20 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function passthrough(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): InvokeResponse<FinishOutput> {
  const output = passthroughOutput(input, reason, opts);
  if (output.degraded) console.warn(`text-overlay: passthrough (${output.degraded}) shot=${input.shot_id}`);
  return { ok: true, output };
}

async function invoke(env: Env, req: InvokeRequest<FinishInput>): Promise<InvokeResponse<FinishOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.clip_key) {
    return { ok: false, error: "text-overlay: input needs shot_id and clip_key" };
  }

  // Overlays live in config (the core passes per-render config to every finish module in the chain).
  const cfg = coerceConfig(req.config);
  const overlays = coerceOverlays(req.config.overlays);
  const filter = buildDrawtextFilter(overlays, cfg);

  // Intentional no-op: no overlays defined for this shot. Not a degrade.
  if (!filter) return passthrough(input, "no-overlays", { degraded: false });

  if (!env.VIDEO_FINISH_VPC) return passthrough(input, "no-vpc-binding");
  if (!env.R2_RENDERS) return passthrough(input, "no-r2-binding");

  // Download source clip from R2.
  let clipBytes: ArrayBuffer;
  try {
    const obj = await env.R2_RENDERS.get(input.clip_key);
    if (!obj) return passthrough(input, "r2-clip-not-found", { detail: input.clip_key });
    clipBytes = await obj.arrayBuffer();
  } catch (e) {
    return passthrough(input, "r2-get-failed", { detail: (e as Error).message });
  }

  // Build the container spec header (base64 JSON).
  const outKey = outputClipKey(input.clip_key);
  const spec = buildContainerSpec(filter, outKey);
  const specHeader = btoa(JSON.stringify(spec));

  // Call the video-finish container /overlay endpoint.
  let respBytes: ArrayBuffer;
  try {
    const r = await env.VIDEO_FINISH_VPC.fetch("/overlay", {
      method: "POST",
      headers: {
        "content-type": "video/mp4",
        "x-overlay-spec": specHeader,
      },
      body: clipBytes,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return passthrough(input, "container-failed", { detail: `HTTP ${r.status}: ${errText.slice(0, 200)}` });
    }
    respBytes = await r.arrayBuffer();
  } catch (e) {
    return passthrough(input, "container-failed", { detail: (e as Error).message });
  }

  if (!respBytes || respBytes.byteLength === 0) {
    return passthrough(input, "container-empty-response");
  }

  // Write overlaid clip to R2.
  try {
    await env.R2_RENDERS.put(outKey, respBytes);
  } catch (e) {
    return passthrough(input, "r2-put-failed", { detail: (e as Error).message });
  }

  return {
    ok: true,
    output: {
      shot_id: input.shot_id,
      clip_key: outKey,
      out_fps: input.src_fps ?? 24,
      frames: input.frames ?? 0,
      applied: [`text-overlay:${overlays.length}`],
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<FinishInput>;
      try { req = (await request.json()) as InvokeRequest<FinishInput>; }
      catch { return json({ ok: false, error: "invalid JSON body" } as InvokeResponse); }
      if (req.hook !== "finish") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await invoke(env, req));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
