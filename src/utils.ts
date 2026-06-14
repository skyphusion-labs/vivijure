// Cross-cutting helpers (v0.19.0).
//
// Pulled from src/index.ts so provider modules and future feature modules
// can import them without round-tripping through the worker entry. All
// pure functions with no I/O or env dependencies.

/**
 * Parse a `data:` URL into mime + base64 payload. Returns null for any URL
 * that isn't a base64-encoded data URL (URL-encoded data URLs not supported;
 * none of our upload paths produce them).
 */
export function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

/**
 * Decode a base64 string to a fresh owned Uint8Array. Return type is
 * Uint8Array<ArrayBuffer> (not the looser default Uint8Array<ArrayBufferLike>)
 * so callers like `new Blob([...])` typecheck without explicit casts under
 * TypeScript 5.7+.
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Encode bytes to a base64 string. Chunked because the naive
 * `btoa(String.fromCharCode(...bytes))` spreads every byte as an argument and
 * overflows the call stack on multi-MB inputs (e.g. an uploaded source image).
 * 0x8000 chars/chunk is the standard safe window. Round-trips with
 * base64ToBytes. (v0.21.6: used to inline an R2 source image as a data: URI
 * for image-to-video, since the upstream accepts data URIs.)
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Pick a file extension for a MIME type. Used for R2 object key construction
 * and for the Content-Disposition filename header on artifact downloads.
 * Falls through to "bin" for unknown types (covered by v0.10.3's fix: the
 * video-gen path hardcodes mime to video/mp4 before this is called so we
 * always get the right extension even when upstream CDNs lie about types).
 */
export function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png"))  return "png";
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("jpg"))  return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif"))  return "gif";
  if (m.includes("mp4"))  return "mp4";
  if (m.includes("quicktime")) return "mov";
  if (m.includes("mov"))  return "mov";
  if (m.includes("matroska") || m.includes("mkv")) return "mkv";
  if (m.includes("mp3"))  return "mp3";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("wav"))  return "wav";
  if (m.includes("ogg"))  return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("m4a"))  return "m4a";
  return "bin";
}
