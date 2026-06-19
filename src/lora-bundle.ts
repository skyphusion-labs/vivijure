// Pure helpers for standalone LoRA training bundles.
//
// Route handlers wrap these with env-touching pieces (assembleBundle,
// submitTrainLoraJob). Keeping data-shaping here lets vitest cover the
// bundle-builder logic without importing cloudflare:workers.

import type { StoryboardValidated } from "./storyboard-validate";
import type { CastMember } from "./cast-db";

export interface LoraBundleTrainingImage {
  key: string;
}

export interface LoraBundleCharacterRef {
  name: string;
  prompt: string;
  trainingImages: LoraBundleTrainingImage[];
  portrait?: LoraBundleTrainingImage;
}

export interface LoraBundleArgs {
  storyboard: StoryboardValidated;
  characterRefs: Record<string, LoraBundleCharacterRef>;
}

// Build the (storyboard, characterRefs) tuple that assembleBundle takes
// for a single-slot LoRA training bundle. The synthesized storyboard
// satisfies the validator: one scene with a non-empty prompt that
// references slot A, which is also the only entry in use_characters.
export function buildLoraTrainingBundleArgs(
  cast: CastMember,
  bundleSuffix: string,
): LoraBundleArgs {
  const safeSlug = cast.slug || `cast-${cast.id}`;
  const projectName = `lora-${safeSlug}-${bundleSuffix}`;
  return {
    storyboard: {
      title: projectName,
      projectName,
      full_prompt: "",
      duration_seconds: undefined,
      clip_seconds: undefined,
      style_prefix: "",
      style_category: "None",
      style_preset: "None",
      use_characters: ["A"],
      cast_rules: "",
      scenes: [
        {
          id: "lora_train_shot",
          prompt: "lora training reference shot (not rendered)",
          character_slots: ["A"],
          target_seconds: 1,
        },
      ],
    },
    characterRefs: {
      A: {
        name: cast.name,
        prompt: cast.bible || cast.name,
        trainingImages: cast.ref_keys.map((r) => ({ key: r.key })),
        portrait: cast.portrait_key ? { key: cast.portrait_key } : undefined,
      },
    },
  };
}

// Build the destination R2 key for the trained .safetensors. Per-cast
// prefix lets a future GC pass enumerate by cast id; the timestamp
// version keeps retraining immutable so an in-flight render that
// references the prior key does not break. The GPU backend may use its
// own convention; this is returned to the client for traceability.
export function deriveLoraDestKey(castId: number, timestamp: number): string {
  return `loras/cast-${castId}/${timestamp}.safetensors`;
}

// The trained-LoRA R2 key from a completed train_lora job envelope. The clean-room
// backend returns it nested under result.lora[slot].lora_id (a cast-training bundle
// is single-slot, so it's the one entry); the legacy vivijure-serverless envelope
// used a top-level lora_key. Reads both shapes so the cast page harvests the key
// either way; returns null only if neither carries one.
export function extractTrainedLoraKey(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.lora_key === "string" && o.lora_key) return o.lora_key;
  const lora = o.lora;
  if (lora && typeof lora === "object" && !Array.isArray(lora)) {
    for (const entry of Object.values(lora as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        const id = (entry as { lora_id?: unknown }).lora_id;
        if (typeof id === "string" && id) return id;
      }
    }
  }
  return null;
}
