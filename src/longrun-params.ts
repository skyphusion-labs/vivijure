// Param construction for the long-run video/music workflow (v0.21.5).
//
// Extracted as a pure function so the per-model param shapes are unit-testable
// without importing index.ts (cloudflare:workers). The shapes differ enough
// that getting them wrong means a rejected upstream call:
//   - text-to-video (Veo/Seedance/etc): { prompt, duration:"8s", aspect_ratio,
//     resolution:"720p", generate_audio } -- duration is a STRING here.
//   - image-to-video: each model has its OWN image field + param shape, and
//     additionalProperties is false on these CF schemas, so a stray field or
//     the wrong image key is rejected. Selected per modelId (see I2V below).
//   - music (minimax/music-2.6): { prompt, lyrics? }
//
// i2v is selected by the presence of imageUrl, not a separate kind, so the
// workflow keeps a single "video" kind.

export type GenKind = "video" | "music";

export interface GenParamOpts {
  prompt: string;
  lyrics?: string;
  imageUrl?: string;   // present => image-to-video
  modelId?: string;    // v0.143.0: selects the per-model i2v param shape
}

// v0.143.0: per-model image-to-video param shapes, verified against the
// Cloudflare model pages (developers.cloudflare.com/ai/models/<id>) on
// 2026-06-07. `image` accepts a fetchable URL or a base64 data: URI for all of
// these; the workflow hands us one or the other. Models whose schema makes
// `prompt` required get a gentle default motion prompt when the caller passed
// none. Each shape sends only fields the model's schema declares (so it never
// trips additionalProperties:false) and includes the documented
// required-with-default fields (so it never misses a required key).
//
// Google Veo is intentionally NOT wired here yet: its `image_input` wants raw
// base64, not a URL/data-URI, which needs an extra conversion step in the
// workflow. Tracked as a follow-up.
const DEFAULT_MOTION_PROMPT = "subtle, natural cinematic motion";

function imageToVideoParams(
  modelId: string | undefined,
  imageUrl: string,
  prompt: string,
): Record<string, unknown> {
  const motion = prompt && prompt.trim() ? prompt : DEFAULT_MOTION_PROMPT;

  switch (modelId) {
    // ByteDance Seedance 2.0: field `image`; integer duration 4-12; resolution
    // 480p/720p/1080p; aspect_ratio. generate_audio off (we score separately).
    case "bytedance/seedance-2.0":
    case "bytedance/seedance-2.0-fast":
      return {
        image: imageUrl,
        prompt: motion,
        aspect_ratio: "16:9",
        duration: 5,
        resolution: "720p",
        fps: 24,
        camera_fixed: false,
        watermark: false,
        generate_audio: false,
      };

    // MiniMax Hailuo 2.3: field `first_frame_image`; resolution 768P/1080P.
    case "minimax/hailuo-2.3":
    case "minimax/hailuo-2.3-fast":
      return {
        first_frame_image: imageUrl,
        prompt: motion,
        duration: 6,
        resolution: "768P",
        fast_pretreatment: false,
        prompt_optimizer: true,
      };

    // RunwayML Gen-4.5: field `image_input`; integer duration 2-10; `ratio`
    // (not resolution).
    case "runwayml/gen-4.5":
      return {
        image_input: imageUrl,
        prompt: motion,
        duration: 5,
        ratio: "1280:720",
        // v0.145.1: loosen Runway's input moderation to its lowest documented
        // setting. The default flags AI-generated photoreal characters as
        // possible real people / public figures and rejects the keyframe (a
        // false positive on our own synthetic renders). This is the only
        // moderation knob any of the wired i2v models exposes; Seedance / Hailuo
        // / hh1 hard-code it provider-side with no override. Operator-gated
        // platform (single key-holder, monitored logs, enforced acceptable use).
        content_moderation: { public_figure_threshold: "low" },
      };

    // Alibaba hh1-i2v (the original i2v wiring) and the safe default: field
    // `image`; resolution 720P; integer duration 3-15; prompt optional.
    case "alibaba/hh1-i2v":
    default: {
      const params: Record<string, unknown> = {
        image: imageUrl,
        resolution: "720P",
        duration: 5,
      };
      if (prompt && prompt.trim()) params.prompt = prompt;
      return params;
    }
  }
}

export function buildGenParams(kind: GenKind, opts: GenParamOpts): Record<string, unknown> {
  const { prompt, lyrics, imageUrl, modelId } = opts;

  if (kind === "video" && imageUrl) {
    // image-to-video (per-model shape)
    return imageToVideoParams(modelId, imageUrl, prompt);
  }

  if (kind === "video") {
    // text-to-video (existing shape)
    return {
      prompt,
      duration: "8s",
      aspect_ratio: "16:9",
      resolution: "720p",
      generate_audio: true,
    };
  }

  // music
  const params: Record<string, unknown> = { prompt };
  if (lyrics && lyrics.trim()) params.lyrics = lyrics;
  return params;
}
