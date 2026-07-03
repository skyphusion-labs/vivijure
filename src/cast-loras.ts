// Resolve planner castLoras ({ slot: <opaque cast public id> }) into pretrained LoRA R2 keys for the
// GPU backend, and
// (riding the same cast-row fetch) the per-slot dialogue voice. The studio is single-user, so the cast
// lookup is not really identity-scoped; voice comes free off the row we already read for the LoRA.

import type { Env } from "./env";
import { getCastById, getCastIdByPublicId } from "./cast-db";
import { isPublicId } from "./public-id";
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
  // Slots whose LoRA is NOT ready (bad id, missing cast row, still training, or no trained adapter).
  // The render path hard-rejects on this rather than letting the GPU silently inline-train (~20-min
  // tax). `skipped` is the slot ids only (back-compat with scatter's emptiness check); `skippedDetail`
  // carries the per-character name + reason so the caller can name exactly who needs training.
  skipped: string[];
  skippedDetail: SkippedCast[];
}

export interface SkippedCast {
  slot: string;
  // Display name of the cast member, when the row resolved (absent for a bad id / missing row). The
  // internal integer cast id is NEVER carried here (S9 F13): it must not ride an externally-derived
  // struct, and an integer probe never resolves to a row, so it never earns a name.
  name?: string;
  reason: "not a valid cast id" | "cast member not found" | "LoRA still training" | "no trained LoRA";
}

/** Map slot -> cast_id from the request body into slot -> loras/ R2 key (drops non-ready rows),
 *  slot -> voice_id (kept for every resolvable cast row), and slot -> cast_id (every well-formed
 *  entry, used to bank a freshly-trained adapter back onto the cast member). */
export async function resolveCastLoras(
  env: Env,
  castLoras: Record<string, unknown> | undefined,
): Promise<ResolvedCastLoras> {
  const pretrained: Record<string, string> = {};
  const voices: Record<string, string> = {};
  const castIds: Record<string, number> = {};
  const skipped: string[] = [];
  const skippedDetail: SkippedCast[] = [];
  const skip = (d: SkippedCast) => { skipped.push(d.slot); skippedDetail.push(d); };
  if (!castLoras || typeof castLoras !== "object") return { pretrained, voices, castIds, skipped, skippedDetail };

  for (const [slot, raw] of Object.entries(castLoras)) {
    if (typeof slot !== "string" || !slot.trim()) continue;
    // S9 (F13): castLoras values are OPAQUE cast public ids from the browser, resolved to the internal
    // int at THIS boundary. A bare integer (an enumeration probe) fails isPublicId and lands in the
    // same "not a valid cast id" skip as any garbage -- with NO row data attached -- so the
    // untrained-cast message can never become an id-enumeration oracle (harvesting names by counting).
    if (!isPublicId(raw)) {
      skip({ slot, reason: "not a valid cast id" });
      continue;
    }
    const id = await getCastIdByPublicId(env, raw);
    if (id === null) {
      skip({ slot, reason: "cast member not found" });
      continue;
    }
    castIds[slot] = id;
    let cast = await getCastById(env, id);
    if (cast?.lora_status === "training") {
      cast = await refreshTrainingLora(env, cast);
    }
    // Voice rides the row we already fetched, independent of LoRA readiness.
    if (cast) voices[slot] = coerceVoiceId(cast.voice_id) ?? DEFAULT_VOICE_ID;
    if (!cast) {
      skip({ slot, reason: "cast member not found" });
      continue;
    }
    if (cast.lora_status !== "ready" || !cast.lora_key || !cast.lora_key.startsWith("loras/")) {
      skip({
        slot, name: cast.name,
        reason: cast.lora_status === "training" ? "LoRA still training" : "no trained LoRA",
      });
      continue;
    }
    pretrained[slot] = cast.lora_key;
  }
  return { pretrained, voices, castIds, skipped, skippedDetail };
}

/** Build an actionable, per-character rejection message from the skipped slots: name who needs
 *  training (falling back to the slot id when the cast row did not resolve) and where to do it. */
export function untrainedCastMessage(skippedDetail: SkippedCast[]): string {
  const names = skippedDetail.map((d) => {
    const who = d.name ?? `slot ${d.slot}`;
    return d.reason === "LoRA still training" ? `${who} (still training)` : who;
  });
  return `These characters have no trained LoRA -- train them on the Cast page first: ${names.join(", ")}.`;
}
