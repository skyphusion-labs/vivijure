// Worker Env binding for the Vivijure studio core.
//
// Hand-authored interface mirroring wrangler.toml. Adding a binding: update wrangler.toml, then
// mirror it here.
//
// R2_RENDERS is the `vivijure` bucket (bundles, keyframes, clips, MP4s, cast assets). R2 is the
// chat-side bucket (`skyphusion-llm`); image chat outputs and cross-bucket audio staging still use
// it. RUNPOD_* and R2_S3_* are secrets/vars.
//
// MODULE bindings: opt-in module workers attach as service bindings named `MODULE_<NAME>` (Fetcher),
// discovered by the registry (src/modules/registry.ts). Not statically listed; a deployment installs
// only the modules it wants.

import type { RateLimitBinding } from "./rate-limit";

// RPC surface of the skyphusion-email Worker's EmailService entrypoint (the notify-email module
// uses it to send render-complete mail). Kept minimal + local so this repo does not depend on that package.
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

  // Phase 3 (Workers for Platforms): the OUTBOUND dynamic-dispatch binding to the `vivijure-modules`
  // dispatch namespace. A module uploaded into the namespace is resolved at request time by
  // MODULE_DISPATCH.get(<script-name>) -> Fetcher, then invoked over the SAME /invoke envelope as a
  // service-bound module (registry.fetcherFor). OPTIONAL: a deploy without WfP (the standard self-host
  // path) leaves it unbound, everything falls back to `MODULE_*` service bindings, and the whole
  // dispatch layer is a no-op (registry.discoverDispatchModules short-circuits). Distinct key from the
  // `MODULE_${string}` index signature below: a DispatchNamespace has `.get()`, not `.fetch()`.
  MODULE_DISPATCH?: DispatchNamespace;

  // AI Gateway (LLM storyboard planning + image chat + cloud-animate scoring prompts).
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
  VIDEO_FINISH_VPC: Fetcher; // Workers VPC -> always-on fleet video-finish (issue #83)
  IMAGE_PREP_VPC: Fetcher; // Workers VPC -> always-on fleet image-prep (issue #83)
  AUDIO_BEAT_SYNC_VPC: Fetcher; // Workers VPC -> always-on fleet audio-beat-sync (issue #83)
  // OPTIONAL (#231): Workers VPC -> always-on fleet audio-mix container (/mix: multi-track duck +
  // loudnorm). Optional so the Worker deploys before the VPC service is provisioned; the mux phase
  // degrades to the single-track remux when it is absent. Provisioned + bound by infra (Strummer).
  AUDIO_MIX_VPC?: Fetcher;

  // CF Access JWT verification (F2, src/access-auth.ts): fail-CLOSED in-Worker backstop so the data
  // plane never depends solely on the edge Access app. Deploy-specific, NOT secrets -> wrangler.toml
  // [vars]. ACCESS_TEAM_DOMAIN = the Zero Trust team hostname (e.g. "skyphusion.cloudflareaccess.com");
  // ACCESS_AUD = the Access application AUD tag. When BOTH are set, /api/* requires a valid Access JWT
  // (fail closed). When unset, the backstop is not armed: /api/* is allowed with a loud one-time warning
  // and the app relies solely on the edge Access gate. Production MUST set both. See docs/SECURITY.md.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Conscious opt-out (dev/local/test or a deployer fronting their own auth proxy): when neither
  // ACCESS_TEAM_DOMAIN nor ACCESS_AUD is set, /api/* is DENIED by default unless this is "true".
  ALLOW_UNAUTHENTICATED?: string;

  // Cloudflare Web Analytics token, deploy-injected into /welcome at serve time (src/asset-response.ts).
  // PUBLIC, non-secret, but DEFAULT EMPTY in the public artifact: a self-hosted /welcome ships NO beacon
  // and phones home to NO ONE. The operator keeps their own analytics by setting this in their deploy
  // [vars]; empty/unset -> no beacon. (Self-host privacy boundary, #363.)
  WEB_ANALYTICS_TOKEN?: string;

  // Rate limiting for GPU/spend endpoints (F3, src/rate-limit.ts). The Cloudflare native Rate
  // Limiting binding; added to wrangler.toml [[ratelimits]] by infra (Strummer). Optional: when
  // unbound the spend routes fail OPEN (allowed + warned), since rate-limit is availability-
  // protective, not an auth gate. See docs/SECURITY.md.
  SPEND_RATE_LIMITER?: RateLimitBinding;

  // Transactional mail (render-complete notification). Optional; guard with `if (env.EMAIL)`.
  EMAIL?: EmailServiceBinding;

  // BYOK OpenAI image gen (transparent PNG for gpt-image-1.5). Optional.
  OPENAI_API_KEY?: string;

  // Opt-in module workers: `MODULE_<NAME>` service bindings (Fetcher), discovered by the registry.
  // The value type also admits DispatchNamespace so the one dispatch binding in this prefix
  // (MODULE_DISPATCH, above) satisfies this index signature; the registry's `isFetcher` guard keeps a
  // service-binding access from ever being handed the namespace (it has `.get()`, not `.fetch()`).
  [key: `MODULE_${string}`]: Fetcher | DispatchNamespace | undefined;
}
