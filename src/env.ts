// Worker Env binding for the Vivijure studio core.
//
// Hand-authored interface mirroring wrangler.example.toml (the committed template; the real
// wrangler.toml is gitignored). Adding a binding: update wrangler.example.toml, then mirror it here.
//
// Phase 0 (current). The render island has been *staged* into src/ (cast-db, renders-db,
// runpod-submit, scatter, r2-presign, render-*, storyboard-*, the three containers) but is NOT yet
// wired: index.ts routes only /health + /api/modules, and nothing imports the island from the
// entrypoint. These bindings are declared ahead of the Phase-1 migration that will wire those routes
// in (tracked in #1); until then they are present in the interface but unused at runtime, so a deploy
// stays a lean module host. R2_RENDERS is the existing `vivijure` bucket; R2 is the chat-side bucket
// the render flow will cross-bucket-copy a staged audio bed from (both bound, same resources as the
// Playground, no data migration). RUNPOD_* and R2_S3_* are secrets/vars.
//
// MODULE BINDINGS: opt-in module workers attach as service bindings named `MODULE_<NAME>` (Fetcher),
// discovered by the registry (src/modules/registry.ts). Not statically listed: a deployment installs
// only the modules it wants.

// RPC surface of the skyphusion-email Worker's EmailService entrypoint (render-email.ts uses it to
// send a render-complete mail). Kept minimal + local so this repo does not depend on that package.
export interface EmailServiceBinding {
  send(req: {
    to: string | string[];
    from?: string | { email: string; name?: string };
    replyTo?: string | { email: string; name?: string };
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

export interface Env {
  // Static frontend (the studio UI), served via Workers Assets.
  ASSETS: Fetcher;

  // AI Gateway (LLM storyboard planning + cloud-animate scoring prompts).
  AI: Ai;
  GATEWAY_ID: string;
  // Planner LLM auth: authenticated AI Gateway token + xAI BYOK (secrets, optional).
  CF_AIG_TOKEN?: string;
  XAI_API_KEY?: string;

  // Storage. R2_RENDERS = the `vivijure` bucket (bundles, keyframes, clips, MP4s, project state).
  // R2 = the chat-side bucket; the render flow copies a staged audio bed across from it.
  R2: R2Bucket;
  R2_RENDERS: R2Bucket;
  DB: D1Database;

  // R2 S3-compatible creds for SigV4 presigning (r2-presign.ts): the CPU containers have no R2
  // binding, so the Worker presigns short-lived GET/PUT URLs. ACCESS/SECRET are secrets; ENDPOINT +
  // BUCKET are vars. Optional so a presign-free deploy still typechecks.
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  R2_S3_ENDPOINT?: string;
  R2_S3_BUCKET?: string;

  // RunPod serverless render endpoint (runpod-submit.ts). Secrets.
  RUNPOD_API_KEY: string;
  RUNPOD_ENDPOINT_ID: string;

  // CPU container Durable Objects (off-GPU beat-sync, portrait prep, ffmpeg finish).
  AUDIO_BEAT_SYNC: DurableObjectNamespace;
  IMAGE_PREP: DurableObjectNamespace;
  VIDEO_FINISH: DurableObjectNamespace;
  VIDEO_FINISH_VPC: Fetcher; // Workers VPC -> always-on fleet video-finish (issue #83)
  IMAGE_PREP_VPC: Fetcher; // Workers VPC -> always-on fleet image-prep (issue #83)
  AUDIO_BEAT_SYNC_VPC: Fetcher; // Workers VPC -> always-on fleet audio-beat-sync (issue #83)

  // Transactional mail (render-complete notification). Optional; guard with `if (env.EMAIL)`.
  EMAIL?: EmailServiceBinding;

  // Opt-in module workers: `MODULE_<NAME>` service bindings. Discovered by the registry.
  [key: `MODULE_${string}`]: Fetcher | undefined;
}
