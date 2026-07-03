// Small shared helpers the render handlers lean on. Kept tiny and dependency-free.

// --- R2 key / path safety (security #6) ----------------------------------------------------------
// Untrusted strings (a storyboard title, start_image, refs_dir) end up as R2 keys / fetch paths
// downstream, so anything that could steer a key or a fetch to an unintended object must be rejected:
// path traversal ("..": e.g. bundles/../../secret.tar.gz), an absolute key (leading "/"), a URL scheme
// ("://"; ":" is simply not in the allowed set), and control / non-ASCII bytes. The allowed set is the
// strict relative-key pattern from issue #6.

const REL_KEY_CHARS = /^[A-Za-z0-9._\-\/]+$/;

/** True when `key` is a safe RELATIVE R2 key under the STRICT input charset: non-empty, <=1024 chars,
 *  no leading "/", only letters/digits/. _ - /, and no ".." path segment. Use this to validate an
 *  externally-supplied path field (start_image, refs_dir) at the input boundary, where a clean
 *  relative key is expected and anything odd (spaces, specials) should be rejected loudly. */
export function isSafeRelKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/")) return false;
  if (!REL_KEY_CHARS.test(key)) return false;
  return !key.split("/").includes("..");
}

/** The canonical bundle namespace: bundle-assembler writes bundles/<project>.tar.gz and every
 *  render submit references a key under it. Kept as a constant so the boundary checks agree on
 *  one spelling instead of a scattered literal. */
export const BUNDLE_KEY_PREFIX = "bundles/";

/** True when `key` is a well-formed bundle reference: a safe relative key (isSafeRelKey) under
 *  the bundles/ namespace. Use at every request boundary that accepts a bundle key, mirroring
 *  how the artifact serve route scopes its key to the known artifact prefixes. */
export function isSafeBundleKey(key: unknown): key is string {
  return isSafeRelKey(key) && key.startsWith(BUNDLE_KEY_PREFIX);
}

/** Defense-in-depth check for a key about to be SIGNED. Narrower than isSafeRelKey: it blocks only
 *  the shapes that can steer a signed request off its intended object -- empty/oversized, absolute
 *  ("/..."), a "://" scheme, a ".." traversal segment, or any non-printable / non-ASCII byte -- while
 *  still allowing benign printable specials (space, "#", ...) that SigV4 uriEncode handles. This
 *  keeps legitimate keys signable without re-opening the injection hole. (security #6) */
export function isPresignSafeKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/")) return false;
  if (key.includes("://")) return false;
  if (/[^ -~]/.test(key)) return false; // control chars, DEL, non-ASCII
  return !key.split("/").includes("..");
}

/** Coerce an untrusted string into a safe single path SEGMENT (no "/"), for a derived slug like the
 *  project name that becomes one key component (bundles/<seg>.tar.gz). Replaces any char outside the
 *  segment charset with "_", collapses any ".." run (so no traversal substring survives), strips
 *  leading separators, and falls back when nothing safe remains. The result always passes a segment
 *  check, so the same value can flow downstream (bundle key AND the backend `project` field) with no
 *  desync. */
export function sanitizeKeySegment(raw: string, fallback = "project"): string {
  const s = raw
    .replace(/[^A-Za-z0-9._\-]/g, "_") // only the segment charset survives
    .replace(/\.\.+/g, "_") // no ".." run can survive
    .replace(/^[._-]+/, ""); // no leading separators
  return s.length > 0 ? s : fallback;
}

/** JSON response with the content-type set; merges any extra init. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

// --- HTTP byte-range parsing (RFC 7233) ---------------------------------------------------------
// A media element (Safari/iOS especially) will not play a video it cannot range-request, and Chrome
// re-fetches from byte 0 on every seek without 206 support. This parses a single-range `Range` header
// against a known object size so the artifact route can answer 206 / 416 correctly.

export type ByteRange = { offset: number; length: number; start: number; end: number };

/** Parse a `Range` header (RFC 7233) against a known object `size`. Returns:
 *   - a ByteRange {offset,length,start,end} for a satisfiable single range (caller sends 206),
 *   - "unsatisfiable" for a syntactically valid but out-of-bounds range (caller sends 416),
 *   - null to ignore the header and serve the full body (no/blank header, malformed, a non-"bytes"
 *     unit, or a MULTI-range request) (caller sends 200).
 *  Only the "bytes" unit and a SINGLE range are supported; a multi-range request is served in full (a
 *  valid RFC 7233 response) rather than as multipart/byteranges. `offset`/`length` map straight onto
 *  the R2 get() range option; `start`/`end` are the inclusive positions for the Content-Range header. */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(.*)$/.exec(header.trim());
  if (!m) return null;
  const specs = m[1].split(",");
  if (specs.length !== 1) return null; // multi-range -> serve the full body
  const spec = specs[0].trim();
  const dash = spec.indexOf("-");
  if (dash === -1) return null;
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();
  // Each side must be empty or digits only; anything else is malformed -> ignore.
  const digits = /^[0-9]*$/;
  if (!digits.test(startStr) || !digits.test(endStr)) return null;

  if (size <= 0) return "unsatisfiable"; // an empty object has no satisfiable range

  // suffix form: bytes=-N (the last N bytes)
  if (startStr === "") {
    if (endStr === "") return null; // "bytes=-" is malformed
    const n = Number(endStr);
    if (n === 0) return "unsatisfiable"; // last 0 bytes is unsatisfiable
    const start = n >= size ? 0 : size - n; // clamp: -N past the start = whole file
    const end = size - 1;
    return { offset: start, length: end - start + 1, start, end };
  }

  const start = Number(startStr);
  if (start >= size) return "unsatisfiable"; // first-byte-pos at/after the end
  // open-ended form: bytes=N-
  if (endStr === "") {
    const end = size - 1;
    return { offset: start, length: end - start + 1, start, end };
  }
  // closed form: bytes=N-M
  let end = Number(endStr);
  if (end < start) return null; // reversed range is invalid -> ignore
  if (end >= size) end = size - 1; // clamp last-byte-pos to the object end
  return { offset: start, length: end - start + 1, start, end };
}
