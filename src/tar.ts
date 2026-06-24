// Minimal, dependency-free USTAR tar reader/writer.
//
// The cast bundle (issue #324) is a single portable file. We use plain (uncompressed) tar as the
// container because: (1) it is a documented, universally-readable standard -- a user can inspect a
// bundle with `tar tf cast.vvcast` with no vivijure tooling; (2) it needs no runtime dependency
// (the project keeps deps minimal); (3) the payload (safetensors + png/webp/jpeg) is already
// compressed, so gzip would add CPU + a dep for ~no size win. We only implement the normal-file
// ("0") typeflag -- bundles carry regular files, nothing else.
//
// Header layout is the classic 512-byte USTAR block; numeric fields are NUL-terminated octal.
// mtime is fixed at 0 so a given cast always serializes to byte-identical bundle headers
// (reproducible export, deterministic tests).

export const TAR_BLOCK = 512;

const enc = new TextEncoder();
const dec = new TextDecoder();

// Encode a non-negative integer as a NUL-terminated octal field of `fieldLen` bytes
// (the last byte is the NUL terminator, so `fieldLen - 1` octal digits are available).
function octalField(value: number, fieldLen: number): Uint8Array {
  const digits = fieldLen - 1;
  const s = Math.floor(value).toString(8);
  if (s.length > digits) {
    throw new Error(`tar: value ${value} does not fit a ${fieldLen}-byte octal field`);
  }
  const out = new Uint8Array(fieldLen);
  const padded = s.padStart(digits, "0");
  for (let i = 0; i < digits; i++) out[i] = padded.charCodeAt(i);
  out[digits] = 0; // NUL terminator
  return out;
}

// Bytes of zero padding needed to round `size` up to the next 512-byte block boundary.
export function tarPadding(size: number): Uint8Array {
  const rem = size % TAR_BLOCK;
  return new Uint8Array(rem === 0 ? 0 : TAR_BLOCK - rem);
}

// The two all-zero blocks that mark end-of-archive.
export function tarEof(): Uint8Array {
  return new Uint8Array(TAR_BLOCK * 2);
}

// Build one 512-byte USTAR header block for a normal file.
export function tarHeader(name: string, size: number): Uint8Array {
  const nameBytes = enc.encode(name);
  if (nameBytes.length > 100) {
    // We never generate names this long (bundle paths are short + fixed), so this is a guard, not a
    // PAX-extension path. Loud, not silent.
    throw new Error(`tar: entry name too long (${nameBytes.length} > 100): ${name}`);
  }
  const h = new Uint8Array(TAR_BLOCK);
  h.set(nameBytes, 0);
  h.set(octalField(0o644, 8), 100); // mode
  h.set(octalField(0, 8), 108); // uid
  h.set(octalField(0, 8), 116); // gid
  h.set(octalField(size, 12), 124); // size
  h.set(octalField(0, 12), 136); // mtime (fixed 0 -> reproducible)
  // checksum field is computed over the header with these 8 bytes set to ASCII spaces
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  h[156] = 0x30; // typeflag '0' = normal file
  h.set(enc.encode("ustar"), 257); // magic "ustar\0" (byte 262 already 0)
  h[263] = 0x30; // version "00"
  h[264] = 0x30;

  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += h[i];
  // checksum: 6 octal digits, NUL, then a trailing space
  const chk = octalField(sum, 7); // 6 digits + NUL
  h.set(chk, 148);
  h[155] = 0x20; // trailing space (byte 154 is the NUL from octalField)
  return h;
}

export interface TarFile {
  name: string;
  data: Uint8Array;
}

// Build a complete in-memory tar from a list of files. Used for small archives and tests; the cast
// EXPORT path streams instead (tarHeader + tarPadding + tarEof) so a large LoRA is never fully
// buffered.
export function buildTar(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const f of files) {
    const header = tarHeader(f.name, f.data.length);
    const pad = tarPadding(f.data.length);
    parts.push(header, f.data, pad);
    total += header.length + f.data.length + pad.length;
  }
  const eof = tarEof();
  parts.push(eof);
  total += eof.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function readCString(block: Uint8Array, start: number, len: number): string {
  let end = start;
  const limit = start + len;
  while (end < limit && block[end] !== 0) end++;
  return dec.decode(block.subarray(start, end));
}

function parseOctal(block: Uint8Array, start: number, len: number): number {
  let s = "";
  const limit = start + len;
  for (let i = start; i < limit; i++) {
    const b = block[i];
    if (b === 0 || b === 0x20) {
      if (s.length) break;
      else continue; // skip leading spaces
    }
    s += String.fromCharCode(b);
  }
  return s ? parseInt(s, 8) : 0;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

// Parse an in-memory tar into its normal-file entries. Malformed input (a truncated entry, a size
// running past the buffer) throws -- a bundle is a contract, so bad bytes fail loud, never silently
// drop data. Non-normal-file typeflags are skipped (we never write them, but a hand-built tar might).
export function parseTar(buf: Uint8Array): TarFile[] {
  const out: TarFile[] = [];
  let off = 0;
  while (off + TAR_BLOCK <= buf.length) {
    const block = buf.subarray(off, off + TAR_BLOCK);
    if (isZeroBlock(block)) break; // end-of-archive marker
    const name = readCString(block, 0, 100);
    const size = parseOctal(block, 124, 12);
    const typeflag = block[156];
    off += TAR_BLOCK;
    if (off + size > buf.length) {
      throw new Error(`tar: truncated entry "${name}" (declared size ${size} runs past the archive)`);
    }
    if (typeflag === 0x30 || typeflag === 0) {
      out.push({ name, data: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return out;
}
