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

/** The owner key every render/cast/storyboard row is scoped to. Vivijure is a single-operator
 *  studio, so there is one shared owner: everything is visible to everyone with CF Access, and
 *  non-browser clients (service tokens with no user email) see the same data. Email is provenance,
 *  not an access gate. */
export const STUDIO_OWNER = "studio";
export function getUserEmail(_request: Request): string {
  return STUDIO_OWNER;
}

/** CF Access identity for provenance + per-user settings (whoami, prefs, notify). Not used as a
 *  visibility filter -- studio data stays under STUDIO_OWNER. Service tokens / local dev may lack
 *  the header; callers treat a missing email as anonymous. */
export function getAccessUserEmail(request: Request): string {
  return request.headers.get("cf-access-authenticated-user-email") ?? "anonymous";
}
