// Clip + keyframe adoption provenance (#767). The raw motion clip and the SDXL keyframe both land at
// PROJECT-SCOPED R2 keys (renders/<project>/clips/<shot>_<backend>.mp4, renders/<project>/keyframes/
// <shot>.png) that carry NO render-job id, so every render of the same project shares the namespace.
// That sharing is deliberate (an identical resubmit reuses the artifact instead of re-paying GPU), but a
// SECOND render of the same project with a DIFFERENT motion backend / config leaves its OWN artifact next
// to the first at the same shot-id path. The R2-presence reclaim (reclaimClipsFromR2 / listProjectKeyframes)
// matched by shot-id boundary alone -- with only the #661 upload-time floor as a guard -- so it could adopt
// the WRONG render's clip and ship byte-identical-but-mismatched content (the #245/#249 honesty class,
// observed cross-render: a minimax scatter that came back byte-identical to a seedance film).
//
// This mirrors the finish path's #583 provenance sidecar: a core-computed param hash written next to the
// artifact (<key>.prov) captures every input that changes the OUTPUT. The reclaim adopts a candidate ONLY
// when its sidecar PROVES identical-config; a mismatch is skipped (re-render, never serve mismatched bytes).
// Unlike #583, the core writes the sidecar itself (the studio owns the reclaim seam), so it needs no
// producer / contract change.

import type { Env } from "./env";
import { canonicalJson } from "./finish-hash";

/** The provenance sidecar key for an artifact (clip or keyframe). */
export function provKey(artifactKey: string): string {
  return `${artifactKey}.prov`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Unquoted R2 ETag for a key, or null if the key is absent / a HEAD fails. A null etag still yields a
 *  deterministic hash (the sidecar simply keys on the non-etag inputs), so a HEAD miss never mis-adopts. */
export async function headEtag(env: Env, key: string | undefined | null): Promise<string | null> {
  if (!key) return null;
  try {
    const e = (await env.R2_RENDERS.head(key))?.etag ?? null;
    if (e == null) return null;
    const t = e.trim();
    return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  } catch {
    return null;
  }
}

/** The 64-char hex provenance value for a RAW MOTION CLIP: everything that makes the clip output differ --
 *  the motion backend, its validated config, the start keyframe (by content etag, so a regenerated keyframe
 *  re-renders), the motion prompt, and the seconds. A second render of the same project+shot with a
 *  different backend/config hashes differently, so its clip is never adopted in place of this one. */
export async function clipProvenanceHash(input: {
  motion_backend: string | null | undefined;
  config: Record<string, unknown> | undefined;
  keyframe_etag: string | null;
  prompt: string;
  seconds: number;
}): Promise<string> {
  const payload = {
    motion_backend: input.motion_backend ?? null,
    config: input.config ?? {},
    keyframe_etag: input.keyframe_etag,
    prompt: input.prompt,
    seconds: input.seconds,
  };
  return sha256Hex(canonicalJson(payload));
}

/** The 64-char hex provenance value for a KEYFRAME. Keyframes are motion-backend-agnostic (SDXL), so the
 *  backend is deliberately NOT in the hash: two renders of the same project that differ only in motion
 *  backend legitimately SHARE keyframes. The project namespace is already the content-addressed bundle
 *  stem (#759), so same-project keyframes can differ only by the keyframe config -- that is the fingerprint. */
export async function keyframeProvenanceHash(input: {
  keyframe_config: Record<string, unknown> | undefined;
}): Promise<string> {
  return sha256Hex(canonicalJson({ keyframe_config: input.keyframe_config ?? {} }));
}

async function readProv(env: Env, artifactKey: string): Promise<string | null> {
  try {
    const sc = await env.R2_RENDERS.get(provKey(artifactKey));
    if (!sc) return null;
    return (await sc.text()).trim();
  } catch {
    return null;
  }
}

/** Verdict for adopting a SINGLE artifact against an expected provenance hash. "absent" (no sidecar) keeps
 *  the legacy freshness-floored behavior (a pre-#767 or lost-poll artifact); "mismatch" means a
 *  different-config render wrote it -> never adopt; "match" is proven identical-config. */
export async function provVerdict(env: Env, artifactKey: string, expected: string): Promise<"match" | "absent" | "mismatch"> {
  const prov = await readProv(env, artifactKey);
  if (prov === null) return "absent";
  return prov === expected ? "match" : "mismatch";
}

/** Best-effort: write an artifact provenance sidecar. A write failure never fails the render (provenance is
 *  a guard; a missing sidecar falls back to the freshness-floored legacy behavior), it is only logged. */
export async function writeProv(env: Env, artifactKey: string, hash: string): Promise<void> {
  try {
    await env.R2_RENDERS.put(provKey(artifactKey), hash, { httpMetadata: { contentType: "text/plain" } });
  } catch (e) {
    console.warn(`clip-provenance: failed to stamp ${provKey(artifactKey)}: ${(e as Error).message}`);
  }
}

/** Choose the candidate artifact whose provenance sidecar PROVES it matches `expected`, from the set of
 *  same-shot candidates a project-scoped R2 listing returned. Returns the matched key (stampNeeded=false),
 *  or -- when no sidecar matches -- a SINGLE unstamped candidate to adopt-and-heal (a legacy artifact or a
 *  lost-poll clip THIS render produced, already excluded-if-stale by the caller freshness floor). Returns
 *  null when nothing can be PROVEN identical-config: a mismatched sidecar, or an ambiguous multi-candidate
 *  unstamped set (rival renders, both lost-poll) -- the honest outcome is to re-render, never guess. */
export async function chooseProvenanceMatch(
  env: Env,
  expected: string,
  candidateKeys: string[],
): Promise<{ key: string; stampNeeded: boolean } | null> {
  const unstamped: string[] = [];
  for (const key of candidateKeys) {
    const verdict = await provVerdict(env, key, expected);
    if (verdict === "absent") { unstamped.push(key); continue; }
    if (verdict === "match") return { key, stampNeeded: false };
    // a present-but-mismatched sidecar => a different-config render wrote this; skip it
  }
  if (unstamped.length === 1) return { key: unstamped[0], stampNeeded: true };
  return null;
}
