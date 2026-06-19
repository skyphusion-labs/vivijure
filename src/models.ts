// Model catalog for POST /api/chat image dispatch (findModel). Planning models live in
// planner-catalog.ts and are served at GET /api/storyboard/models.
//
// Each entry's `id` is the routing key. The worker's dispatch logic uses
// the `provider` field (defaulting to "workers-ai") plus the `byok_alias`
// when present to pick a code path. The `type` field controls which
// dispatcher runs (chat / image / tts / video / stt / music). The
// `capabilities` array is mostly UI-driven (vision toggles the attach
// affordance for vision-capable chat models). The `streaming` flag opts
// chat models in to POST /api/chat/stream.
//
// Catalog conventions for adding a new model:
//   - Use the upstream's canonical ID for the prefix
//     (anthropic/, xai/, openai/, google/, @cf/<vendor>/, etc.)
//   - Keep labels clean: do NOT put billing markers like "BYOK" or "needs CF
//     credits" in the label (they were removed in v0.111.0); the worker knows
//     the billing path from `provider` / `byok_alias`
//   - Set streaming: true if the model can stream and your provider's
//     stream parser handles it (Anthropic, xAI, OpenAI, Google, Workers AI
//     are all covered)
//   - For BYOK video: set byok_alias to the provider's model name and
//     leave provider set to the provider's slug

// "voice" = conversational/streaming STT (a live WebSocket session, not a
// one-shot request like "stt"); handled out of /api/chat via /api/stt/stream.
export type ModelType = "chat" | "image" | "tts" | "video" | "stt" | "music" | "voice";
export type Provider =
  | "workers-ai"
  | "anthropic"
  | "xai"
  | "google"
  | "openai"
  | "bytedance"
  | "minimax"
  | "runwayml"
  | "alibaba"
  | "pixverse"
  | "vidu"
  | "recraft";

export interface ModelEntry {
  id: string;
  label: string;
  group: string;
  type: ModelType;
  // "vision" = accepts image input in chat; "image-input" = image-to-video
  // source image required (e.g. alibaba/hh1-i2v, v0.21.5).
  capabilities: Array<"vision" | "image-input">;
  provider?: Provider; // defaults to "workers-ai" when omitted
  // For video models: if set, the worker uses the per-provider BYOK endpoint
  // (xAI direct API for xai/*) instead of the env.AI.run binding. The value
  // is the model name expected by the direct provider API. Without this,
  // video gen requires Unified Billing on the AI Gateway.
  byok_alias?: string;
  // v0.13.0: when true, the model can be invoked via POST /api/chat/stream
  // (server-sent events). Covers Anthropic, Workers AI, xAI, OpenAI, and
  // Google. Chat models only - irrelevant for image/tts/video/stt/music types.
  streaming?: boolean;
}

export const MODELS: ModelEntry[] = [
  // ---- Chat (text generation) ----
  // Anthropic (Unified Billing via cf-aig-authorization, routed through AI Gateway)
  // v0.13.0: streaming: true makes these eligible for POST /api/chat/stream.
  { id: "anthropic/claude-opus-4-8",                    label: "Claude Opus 4.8 (Anthropic)",          group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },
  { id: "anthropic/claude-opus-4-7",                    label: "Claude Opus 4.7 (Anthropic)",          group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },
  { id: "anthropic/claude-opus-4-6",                    label: "Claude Opus 4.6 (Anthropic)",          group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },
  { id: "anthropic/claude-sonnet-4-6",                  label: "Claude Sonnet 4.6 (Anthropic)",        group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },
  { id: "anthropic/claude-haiku-4-5",                   label: "Claude Haiku 4.5 (Anthropic)",         group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },

  // xAI / Grok (BYOK via Bearer auth or stored keys, routed through AI Gateway)
  { id: "xai/grok-4.3",                                 label: "Grok 4.3 (xAI)",                       group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai", streaming: true },
  { id: "xai/grok-4.20-multi-agent-0309",               label: "Grok 4.20 Multi-Agent (xAI)",          group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai", streaming: true },
  { id: "xai/grok-4.20-0309-reasoning",                 label: "Grok 4.20 Reasoning (xAI)",            group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai", streaming: true },
  { id: "xai/grok-build-0.1",                           label: "Grok Build 0.1 (xAI, coding)",         group: "Chat \u00b7 xAI",       type: "chat", capabilities: [],         provider: "xai", streaming: true },

  // Frontier
  { id: "@cf/moonshotai/kimi-k2.6",                     label: "Kimi K2.6 (1T)",               group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/openai/gpt-oss-120b",                      label: "GPT-OSS 120B (reasoning)",     group: "Chat \u00b7 Frontier", type: "chat", capabilities: [], streaming: true },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct",      label: "Llama 4 Scout (MoE, vision)",  group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/google/gemma-4-26b-a4b-it",                label: "Gemma 4 26B (vision)",         group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"], streaming: true },
  // OpenAI open weights
  { id: "@cf/openai/gpt-oss-20b",                       label: "GPT-OSS 20B",                  group: "Chat \u00b7 OpenAI",   type: "chat", capabilities: [], streaming: true },
  // OpenAI proxied via AI Gateway unified billing (v0.21.0; streaming added
  // v0.21.1). Routed through env.AI.run("openai/<model>", { messages }) on the
  // generic chat path; extractOutput handles both the chat-completions
  // ({choices}) and Responses API ({output[].content[]}) shapes. streaming: true
  // uses callOpenAIStream + interpretOpenAISSEFrame (which tolerates both the
  // OpenAI-native delta and CF-normalized flat frame shapes); confirmed live
  // against gpt-5.5 in v0.21.1, including token-usage on the final frame.
  // capabilities is empty: multimodal-in through the proxied binding is
  // unverified, so the attach affordance stays off.
  { id: "openai/gpt-5.5",                               label: "GPT-5.5 (OpenAI)",          group: "Chat \u00b7 OpenAI",   type: "chat", capabilities: [], provider: "openai", streaming: true },
  { id: "openai/gpt-5.4",                               label: "GPT-5.4 (OpenAI)",          group: "Chat \u00b7 OpenAI",   type: "chat", capabilities: [], provider: "openai", streaming: true },
  { id: "openai/gpt-5.4-mini",                          label: "GPT-5.4 mini (OpenAI)",     group: "Chat \u00b7 OpenAI",   type: "chat", capabilities: [], provider: "openai", streaming: true },
  { id: "openai/o4-mini",                               label: "o4-mini (OpenAI, reasoning)", group: "Chat \u00b7 OpenAI", type: "chat", capabilities: [], provider: "openai", streaming: true },
  // Meta
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",     label: "Llama 3.3 70B (fp8)",          group: "Chat \u00b7 Meta",     type: "chat", capabilities: [], streaming: true },
  { id: "@cf/meta/llama-3.2-11b-vision-instruct",       label: "Llama 3.2 11B (vision)",       group: "Chat \u00b7 Meta",     type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/meta/llama-3.2-3b-instruct",               label: "Llama 3.2 3B",                 group: "Chat \u00b7 Meta",     type: "chat", capabilities: [], streaming: true },
  // Qwen
  { id: "@cf/qwen/qwen3-30b-a3b-fp8",                   label: "Qwen3 30B MoE",                group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [], streaming: true },
  { id: "@cf/qwen/qwq-32b",                             label: "QwQ 32B (reasoning)",          group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [], streaming: true },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct",          label: "Qwen2.5 Coder 32B",            group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [], streaming: true },
  // Other
  { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", label: "DeepSeek R1 32B",              group: "Chat \u00b7 Other",    type: "chat", capabilities: [], streaming: true },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 (vision)",   group: "Chat \u00b7 Other",    type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/zai-org/glm-4.7-flash",                    label: "GLM-4.7 Flash (Z.AI, 100+ lang)", group: "Chat \u00b7 Other", type: "chat", capabilities: [], streaming: true },
  { id: "@cf/nvidia/nemotron-3-120b-a12b",              label: "Nemotron 3 120B (NVIDIA, agentic)", group: "Chat \u00b7 Other", type: "chat", capabilities: [], streaming: true },
  { id: "@cf/aisingapore/gemma-sea-lion-v4-27b-it",     label: "SEA-LION v4 27B (SE Asian langs)", group: "Chat \u00b7 Other", type: "chat", capabilities: [], streaming: true },
  // Gemini proxied via Unified Billing (v0.21.3; streaming v0.21.4). NOT
  // OpenAI-shaped: native contents/candidates format, transformed by
  // src/providers/google.ts. Streaming via callGeminiStream +
  // interpretGeminiSSEFrame, with a dual-mode delta reconciler (handles
  // incremental or cumulative chunks). Text-only (multimodal vision deferred).
  { id: "google/gemini-3.1-pro",                        label: "Gemini 3.1 Pro (Google)", group: "Chat \u00b7 Google",   type: "chat", capabilities: [], provider: "google", streaming: true },
  { id: "@cf/google/gemma-3-12b-it",                    label: "Gemma 3 12B (vision, 128K)",   group: "Chat \u00b7 Google",   type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/ibm-granite/granite-4.0-h-micro",          label: "Granite 4.0 Micro (IBM)",      group: "Chat \u00b7 Other",    type: "chat", capabilities: [], streaming: true },
  { id: "@hf/nousresearch/hermes-2-pro-mistral-7b",     label: "Hermes 2 Pro (function calling)", group: "Chat \u00b7 Other", type: "chat", capabilities: [], streaming: true },
  // LLaVA 1.5: image-to-text, single-shot. Surfaced as a vision chat model so
  // the attach UI works, but runChat routes it to the { image, prompt } wire
  // format. No streaming (omitted): it returns one { description } per call.
  { id: "@cf/llava-hf/llava-1.5-7b-hf",                 label: "LLaVA 1.5 7B (image Q&A, single-shot)", group: "Chat \u00b7 Other", type: "chat", capabilities: ["vision"] },
  { id: "@cf/meta/llama-3.2-1b-instruct",               label: "Llama 3.2 1B (tiny, cheap)",   group: "Chat \u00b7 Meta",     type: "chat", capabilities: [], streaming: true },

  // ---- Image generation ----
  // Google proxied (Unified Billing): URL-returning, different schema from the
  // @cf models; handled by the provider:"google" branch in runImage (v0.21.2).
  { id: "google/nano-banana-pro",                       label: "Nano Banana Pro (Google)",   group: "Image Gen",            type: "image", capabilities: [], provider: "google" },
  // gpt-image-1.5 (v0.22.0/.1). Transparency is NOT available through the CF
  // proxy: that schema is { prompt, images, quality, size, style } and
  // 7003-rejects background/output_format. So the worker uses a BYOK direct call
  // to api.openai.com when OPENAI_API_KEY is set (transparent PNG), and falls
  // back to the opaque proxy path otherwise. See providers/openai-image.ts and
  // the v0.22.1 CHANGELOG entry.
  { id: "openai/gpt-image-1.5",                         label: "GPT Image 1.5 (OpenAI; transparent PNG with OPENAI_API_KEY, else opaque)", group: "Image Gen", type: "image", capabilities: [], provider: "openai" },
  // recraftv4 is opaque and art-directed (the CF proxy exposes no alpha flag,
  // only an opaque background_color). Strong text rendering and style controls;
  // returns webp. Added for logos/icons-on-bg/styled scenes, NOT transparency.
  { id: "recraft/recraftv4",                            label: "Recraft V4 (art-directed, opaque)", group: "Image Gen", type: "image", capabilities: [], provider: "recraft" },
  { id: "@cf/black-forest-labs/flux-2-klein-9b",        label: "FLUX 2 Klein 9B (frontier)",   group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-2-klein-4b",        label: "FLUX 2 Klein 4B (faster)",     group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-2-dev",             label: "FLUX 2 Dev (multi-reference)", group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-1-schnell",         label: "FLUX-1 schnell (fast)",        group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/leonardo/lucid-origin",                    label: "Lucid Origin (Leonardo)",      group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/leonardo/phoenix-1.0",                     label: "Phoenix 1.0 (Leonardo)",       group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/lykon/dreamshaper-8-lcm",                  label: "Dreamshaper 8 LCM (fast SD)",  group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/stabilityai/stable-diffusion-xl-base-1.0", label: "Stable Diffusion XL (SDXL)",   group: "Image Gen",            type: "image", capabilities: [] },

  // ---- Text-to-speech ----
  { id: "@cf/deepgram/aura-2-en",                       label: "Aura-2 English (Deepgram)",    group: "TTS",                  type: "tts",   capabilities: [] },
  { id: "@cf/deepgram/aura-2-es",                       label: "Aura-2 Spanish (Deepgram)",    group: "TTS",                  type: "tts",   capabilities: [] },
  { id: "@cf/myshell-ai/melotts",                       label: "MeloTTS (multilingual)",       group: "TTS",                  type: "tts",   capabilities: [] },

  // ---- Speech-to-text ----
  // Attach an audio file, pick a model, get the transcript. Audio file is
  // required; everything else (prompt, system prompt) is ignored. Whisper and
  // Deepgram have different input/output contracts; runStt adapts per model.
  { id: "@cf/openai/whisper-large-v3-turbo",            label: "Whisper Large v3 Turbo (best)", group: "Speech-to-text",      type: "stt",   capabilities: [] },
  { id: "@cf/openai/whisper",                           label: "Whisper (general purpose)",    group: "Speech-to-text",       type: "stt",   capabilities: [] },
  { id: "@cf/openai/whisper-tiny-en",                   label: "Whisper Tiny EN (fast, beta)", group: "Speech-to-text",       type: "stt",   capabilities: [] },
  { id: "@cf/deepgram/nova-3",                          label: "Deepgram Nova-3 (accurate)",   group: "Speech-to-text",       type: "stt",   capabilities: [] },
  // @cf/deepgram/flux is websocket-only (error 8006 over the request/response
  // binding), so it is NOT a one-shot "stt" model. It is a live "voice" session:
  // selecting it opens the mic streamer (/api/stt/stream), not the /api/chat
  // composer. type "voice" is special-cased on both the routing and UI sides.
  { id: "@cf/deepgram/flux",                            label: "Deepgram Flux (live mic)",     group: "Speech-to-text",       type: "voice", capabilities: [], provider: "workers-ai" },

  // ---- Music generation (Unified Billing only) ----
  { id: "minimax/music-2.6",                            label: "MiniMax Music 2.6", group: "Music Gen",     type: "music", capabilities: [], provider: "minimax" },

  // ---- Video generation (Cloudflare Unified Billing via env.AI.run) ----
  // All routed through env.AI.run("provider/model", ...) - CF handles auth and
  // billing. No BYOK to xAI/Google/etc needed for these models.
  { id: "google/veo-3.1",                               label: "Veo 3.1 (Google)",               group: "Video Gen", type: "video", capabilities: [], provider: "google" },
  { id: "google/veo-3.1-fast",                          label: "Veo 3.1 Fast (Google)",          group: "Video Gen", type: "video", capabilities: [], provider: "google" },
  { id: "google/veo-3",                                 label: "Veo 3 (Google)",                 group: "Video Gen", type: "video", capabilities: [], provider: "google" },
  { id: "google/veo-3-fast",                            label: "Veo 3 Fast (Google)",            group: "Video Gen", type: "video", capabilities: [], provider: "google" },
  { id: "bytedance/seedance-2.0",                       label: "Seedance 2.0 (ByteDance)",       group: "Video Gen", type: "video", capabilities: ["image-input"], provider: "bytedance" },
  { id: "bytedance/seedance-2.0-fast",                  label: "Seedance 2.0 Fast (ByteDance)",  group: "Video Gen", type: "video", capabilities: ["image-input"], provider: "bytedance" },
  { id: "minimax/hailuo-2.3",                           label: "Hailuo 2.3 (MiniMax)",           group: "Video Gen", type: "video", capabilities: ["image-input"], provider: "minimax" },
  { id: "minimax/hailuo-2.3-fast",                      label: "Hailuo 2.3 Fast (MiniMax)",      group: "Video Gen", type: "video", capabilities: ["image-input"], provider: "minimax" },
  { id: "xai/grok-imagine-video",                       label: "Grok Imagine Video (xAI)",                   group: "Video Gen", type: "video", capabilities: [], provider: "xai",      byok_alias: "grok-imagine-video" },
  { id: "runwayml/gen-4.5",                             label: "Gen-4.5 (RunwayML)",             group: "Video Gen", type: "video", capabilities: ["image-input"], provider: "runwayml" },
  { id: "alibaba/hh1-t2v",                              label: "HappyHorse 1.0 T2V (Alibaba)", group: "Video Gen", type: "video", capabilities: [], provider: "alibaba" },
  // Image-to-video (v0.21.5): requires a source image. Flagged "image-input";
  // runVideo requires body.image_url, and buildGenParams sends the i2v shape.
  { id: "alibaba/hh1-i2v",                              label: "HappyHorse 1.0 I2V (Alibaba, image-to-video)", group: "Video Gen", type: "video", capabilities: ["image-input"], provider: "alibaba" },
  { id: "pixverse/v6",                                  label: "PixVerse v6",                   group: "Video Gen", type: "video", capabilities: [], provider: "pixverse" },
  { id: "pixverse/v5.6",                                label: "PixVerse v5.6",                 group: "Video Gen", type: "video", capabilities: [], provider: "pixverse" },
  { id: "vidu/q3-pro",                                  label: "Vidu Q3 Pro",                   group: "Video Gen", type: "video", capabilities: [], provider: "vidu" },
  { id: "vidu/q3-turbo",                                label: "Vidu Q3 Turbo",                 group: "Video Gen", type: "video", capabilities: [], provider: "vidu" },
];

export function findModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}
