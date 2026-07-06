// Finish param-hash (#583): the SINGLE source of the `<output_key>.hash` sidecar VALUE. The core
// computes it at finish-invoke time and passes it to the producer (which stamps it verbatim, opaque);
// the future adoption gate recomputes it here to decide reuse-vs-rerun. Both call sites MUST use this
// one exported symbol -- that is the whole point of #583 Design 2: the stamp and the gate cannot drift.
// The canonical form + golden vectors are pinned in docs/CONTRACT.md 3.3.1.
// crypto.subtle is the Workers runtime (and Node webcrypto under vitest); no runtime dependency.

/** Strip the surrounding double quotes R2 may return on an ETag (`"abc"` -> `abc`); verbatim otherwise.
 *  The Workers R2 binding's `.etag` is already unquoted; this keeps the hash robust if handed the quoted
 *  `.httpEtag` form. */
function normalizeEtag(etag: string | null | undefined): string | null {
  if (etag == null) return null;
  let e = etag.trim();
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1);
  return e;
}

/** Canonical JSON: object keys sorted (recursively), compact separators, standard JSON string escaping,
 *  and JS `JSON.stringify` number semantics (an integral value renders with no decimal point). Matches
 *  docs/CONTRACT.md 3.3.1. */
export function canonicalJson(o: unknown): string {
  if (o === true) return "true";
  if (o === false) return "false";
  if (o === null || o === undefined) return "null";
  const t = typeof o;
  if (t === "string") return JSON.stringify(o);
  if (t === "number") {
    if (!Number.isFinite(o as number)) throw new Error("finish-hash: non-finite number in config");
    return String(o); // JS: 2 -> "2", 4.0 -> "4", 0.5 -> "0.5"
  }
  if (Array.isArray(o)) return "[" + o.map(canonicalJson).join(",") + "]";
  if (t === "object") {
    const rec = o as Record<string, unknown>;
    return "{" + Object.keys(rec).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(rec[k])).join(",") + "}";
  }
  throw new Error(`finish-hash: unserializable type ${t}`);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The 64-char lowercase hex sidecar value for a finish step (docs/CONTRACT.md 3.3.1). `clipEtag` is the
 *  input clip's R2 ETag; `audioEtag` is the consumed audio's ETag or null for a step that does not consume
 *  audio; `config` is the orchestrator's validated `fs.configs[idx]`. ONE function for the invoke-time
 *  stamp AND the adoption gate. */
export async function finishStepInputHash(
  clipEtag: string | null | undefined,
  audioEtag: string | null | undefined,
  config: Record<string, unknown> | undefined,
): Promise<string> {
  const payload = {
    clip_etag: normalizeEtag(clipEtag),
    audio_etag: normalizeEtag(audioEtag),
    config: config ?? {},
  };
  return sha256Hex(canonicalJson(payload));
}
