// audio-master: a `master` module worker (vivijure-module/2). Film-level audio mastering -- music
// upscale (VHQ soxr resample to 48k + gentle high-shelf air lift) + LUFS loudness normalization -- via
// the always-on audio-master CPU container on the fleet over Workers VPC (AUDIO_MASTER_VPC).
//
// CPU mastering is ffmpeg DSP, so it must NEVER touch a GPU/RunPod (GPU money is for GPU work only). The
// work runs on the CPU VPC container, the same pattern as the audio-mix + subtitle modules.
//
// It is the audio sibling of `finish` (which polishes a clip) and the dialogue / speech lane (which
// polishes per-shot voice): `master` runs ONCE, on the whole film's assembled audio bed, AFTER the mix
// is built (score + narration) and BEFORE the bed is muxed onto the silent film. A music-video maker
// reaches for it as cleanly as a dialogue maker reaches for the voice lane.
//
// SYNCHRONOUS: a two-pass ffmpeg master of a few-minute bed completes within the Worker request budget,
// so there is ONE round-trip and no /poll:
//   GET  /module.json -> manifest
//   POST /invoke      -> one synchronous AUDIO_MASTER_VPC.fetch to the container; return the output
//
// CREDENTIALLESS by design: the core presigns the bed GET + the mastered PUT and hands them in the input
// (audio_url / output_url / output_key); this worker forwards them to the container and reports the
// output key. It never touches R2 or holds S3 creds.
//
// Failures are DATA, never an exception across the wire. master is a POLISH step, so the soft degrade
// (pass the INPUT bed through unchanged, but RECORDED) is preferred over a hard ok:false unless the input
// itself is malformed -- a master miss must never drop a fully-rendered film (#249 / #77).

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type MasterInput,
  type MasterOutput,
} from "./contract";
import {
  coerceConfig, buildMasterBody, parseContainerResult, masterOutputFromResult, passthroughOutput,
} from "./master";

interface Env {
  AUDIO_MASTER_VPC: { fetch(url: RequestInfo, init?: RequestInit): Promise<Response> };
}

const MANIFEST: ModuleManifest = {
  name: "audio-master",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["master"],
  provides: [
    { id: "master", label: "Master film audio (loudness + music upscale)" },
  ],
  config_schema: {
    target_lufs: { type: "float", default: -14, min: -24, max: -9, label: "loudness target (LUFS)" },
    upscale: { type: "bool", default: true, label: "music upscale (soxr 48k + air lift)" },
    format: { type: "enum", values: ["wav", "mp3"], default: "wav", label: "output format" },
  },
  ui: { section: "master", icon: "sliders", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Soft degrade: pass the INPUT bed through unchanged (a no-op beats a drop in the render), but ALWAYS
 *  record why -- `passthroughOutput` tags `applied` and sets `degraded`, so a real misconfig / container
 *  failure is never indistinguishable from a no-op (#77). A real degrade is also warned. */
function passthrough(
  input: MasterInput,
  reason: string,
  opts: { detail?: string } = {},
): InvokeResponse<MasterOutput> {
  const output = passthroughOutput(input, reason, opts);
  console.warn(`audio-master: passthrough (${output.degraded}) film=${input.film_id}`);
  return { ok: true, output };
}

async function invoke(env: Env, req: InvokeRequest<MasterInput>): Promise<InvokeResponse<MasterOutput>> {
  const input = req.input;
  if (!input?.film_id || !input?.audio_key || !input?.audio_url || !input?.output_url || !input?.output_key) {
    return { ok: false, error: "audio-master: input needs film_id, audio_key, audio_url, output_url, output_key" };
  }
  if (!env.AUDIO_MASTER_VPC) return passthrough(input, "no-vpc-binding");  // not configured: degrade, but say so

  const cfg = coerceConfig(req.config);

  let resp: Response;
  try {
    // Absolute URL (the host is the VPC service, ignored by the binding). A bare "/master" is not a valid
    // URL and throws in the Workers runtime, which the catch below would mask as "container-unreachable",
    // silently shipping the bed unmastered. (The #207 film-titles lesson, mirrored from subtitle.)
    resp = await env.AUDIO_MASTER_VPC.fetch("http://audio-master/master", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildMasterBody(input, cfg)),
    });
  } catch (e) {
    return passthrough(input, "container-unreachable", { detail: (e as Error).message });
  }
  if (!resp.ok) return passthrough(input, "container-failed", { detail: "HTTP " + resp.status });

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return passthrough(input, "container-bad-response");
  }
  const res = parseContainerResult(body);
  if (!res || !res.ok) return passthrough(input, "container-failed");
  if (!res.key) return passthrough(input, "no-output-key", { detail: "container returned no mastered key" });

  return { ok: true, output: masterOutputFromResult(input, res) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<MasterInput>;
      try { req = await request.json() as InvokeRequest<MasterInput>; }
      catch { return json({ ok: false, error: "invalid JSON body" } as InvokeResponse); }
      if (req.hook !== "master") return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      return json(await invoke(env, req));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
