// Resolve planner castLoras ({ slot: cast_id }) into pretrained LoRA R2 keys for the GPU backend, and
// (riding the same cast-row fetch) the per-slot dialogue voice. The studio is single-user, so the cast
// lookup is not really identity-scoped; voice comes free off the row we already read for the LoRA.

import type { Env } from "./env";
import { getCastById } from "./cast-db";
import { refreshTrainingLora } from "./cast-lora-train";
import { coerceVoiceId, DEFAULT_VOICE_ID } from "./voices";

export interface ResolvedCastLoras {
  pretrained: Record<string, string>;
  // slot -> aura-1 voice_id for dialogue, captured for every slot with a cast row regardless of LoRA
  // readiness (a character can speak while its face LoRA is still training). DEFAULT_VOICE_ID when the
  // cast member has no voice assigned. The dialogue stage reads this; no second cast lookup.
  voices: Record<string, string>;
  // slot -> cast_member id for every well-formed entry (regardless of LoRA readiness). The film
  // orchestrator uses this at keyframe completion to write a freshly-trained adapter back onto the
  // right cast member (markLoraReady) so it is reused across projects instead of retrained.
  castIds: Record<string, number>;
  skipped: string[];
}

/** Map slot -> cast_id from the request body into slot -> loras/ R2 key (drops non-ready rows),
 *  slot -> voice_id (kept for every resolvable cast row), and slot -> cast_id (every well-formed
 *  entry, used to bank a freshly-trained adapter back onto the cast member). */
export async function resolveCastLoras(
  env: Env,
  userEmail: string,
  castLoras: Record<string, unknown> | undefined,
): Promise<ResolvedCastLoras> {
  const pretrained: Record<string, string> = {};
  const voices: Record<string, string> = {};
  const castIds: Record<string, number> = {};
  const skipped: string[] = [];
  if (!castLoras || typeof castLoras !== "object") return { pretrained, voices, castIds, skipped };

  for (const [slot, raw] of Object.entries(castLoras)) {
    if (typeof slot !== "string" || !slot.trim()) continue;
    const id = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      skipped.push(slot);
      continue;
    }
    castIds[slot] = id;
    let cast = await getCastById(env, id, userEmail);
    if (cast?.lora_status === "training") {
      cast = await refreshTrainingLora(env, cast, userEmail);
    }
    // Voice rides the row we already fetched, independent of LoRA readiness.
    if (cast) voices[slot] = coerceVoiceId(cast.voice_id) ?? DEFAULT_VOICE_ID;
    if (!cast || cast.lora_status !== "ready" || !cast.lora_key || !cast.lora_key.startsWith("loras/")) {
      skipped.push(slot);
      continue;
    }
    pretrained[slot] = cast.lora_key;
  }
  return { pretrained, voices, castIds, skipped };
}
