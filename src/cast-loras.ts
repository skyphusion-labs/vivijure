// Resolve planner castLoras ({ slot: cast_id }) into pretrained LoRA R2 keys for the GPU backend.

import type { Env } from "./env";
import { getCastById } from "./cast-db";
import { refreshTrainingLora } from "./cast-lora-train";

export interface ResolvedCastLoras {
  pretrained: Record<string, string>;
  skipped: string[];
}

/** Map slot -> cast_id from the request body into slot -> loras/ R2 key. Drops non-ready rows. */
export async function resolveCastLoras(
  env: Env,
  userEmail: string,
  castLoras: Record<string, unknown> | undefined,
): Promise<ResolvedCastLoras> {
  const pretrained: Record<string, string> = {};
  const skipped: string[] = [];
  if (!castLoras || typeof castLoras !== "object") return { pretrained, skipped };

  for (const [slot, raw] of Object.entries(castLoras)) {
    if (typeof slot !== "string" || !slot.trim()) continue;
    const id = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      skipped.push(slot);
      continue;
    }
    let cast = await getCastById(env, id, userEmail);
    if (cast?.lora_status === "training") {
      cast = await refreshTrainingLora(env, cast, userEmail);
    }
    if (!cast || cast.lora_status !== "ready" || !cast.lora_key || !cast.lora_key.startsWith("loras/")) {
      skipped.push(slot);
      continue;
    }
    pretrained[slot] = cast.lora_key;
  }
  return { pretrained, skipped };
}
