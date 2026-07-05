// #523 Layer 1: in-Worker STRUCTURAL clip validation at motion-clip intake.
//
// A CF Worker has no video decoder, so it CANNOT inspect pixels. What it CAN do, cheaply, is parse
// the mp4 box tree from a few ranged reads and reject the STRUCTURAL-corruption class -- truncated /
// empty uploads, zero-frame or zero-duration containers, non-mp4 bodies -- BEFORE the finish /
// dialogue / upscale chain spends anything downstream (#523: a satellite GPU upscaled 411KB of noise
// to 2.8MB because nothing looked at the clip).
//
// HONEST LIMIT (stated so no one mistakes this for full coverage): the local-16gb#35 pure-noise clip
// is a STRUCTURALLY VALID mp4 (right duration, right dimensions, real frame count). Byte entropy of an
// h264 bitstream is high for both noise and real content, so it is not separable in-Worker. Detecting
// noise needs a pixel decode; that is Layer 2, a pre-finish gate in the video-finish CPU container
// (which already runs ffmpeg), filed as a follow-up and wired at this same clip-intake seam.
//
// The parser is split into a PURE core (parseMoov / judgeClip over an in-memory buffer, unit-tested
// with synthetic fixtures) and an async wrapper (validateClipArtifact) that does the bounded R2 reads.

import type { Env } from "./env";

// --- Tunable bounds (core render behavior, not a per-module knob; see CONTRACT + observability docs).
// Deliberately LENIENT: these are set so a real clip from ANY motion.backend (a fixed-length CogVideoX
// 49-frame clip, an 8fps LTX clip, a cloud i2v clip) cannot trip them. They catch only degenerate
// output, never legitimate content -- the false-positive floor #523 asked for.
export const CLIP_VALIDATE_ENABLED = true;
export const CLIP_MIN_BYTES = 2048; // a real mp4 (even 1s) is far larger; catches truncated/empty
export const CLIP_MIN_DURATION_S = 0.15; // catches a zero / near-zero duration container
export const CLIP_MAX_DURATION_S = 900; // runaway guard only (15 min); never a real per-shot clip
export const CLIP_MAX_DIMENSION = 16384; // sane upper bound on a track dimension
// Cap the moov bytes we pull into memory. moov is metadata (sample tables), small vs the mdat; a few
// hundred KB even for long videos. If it is larger than this we treat the container as present but
// skip the deep (frame/dimension) checks rather than pull an unbounded object into the isolate.
export const MOOV_FETCH_CAP = 8 * 1024 * 1024;
// Cap on how far we scan top-level box headers to locate moov (a handful of boxes; guards a hostile file).
const MAX_TOPLEVEL_BOXES = 64;

export interface ClipValidateChecks {
  container: boolean; // a valid ftyp brand AND a moov box were found
  video_track: boolean; // at least one track with a "vide" handler
  duration_s: number | null; // movie duration from mvhd (seconds), null if unread
  expected_s: number; // the requested shot seconds (context only, NOT gated: backends have fixed lengths)
  frames: number | null; // summed video-track sample count (stsz), null if unread
  width: number | null;
  height: number | null;
  bytes: number; // full object size
}
export interface ClipValidateResult {
  verdict: "pass" | "fail" | "skip"; // skip = artifact unreadable (transient); never a hard fail
  reason?: string; // set on fail / skip
  checks: ClipValidateChecks;
}

// Big-endian readers over a Uint8Array.
function u32(b: Uint8Array, o: number): number {
  return (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function u64(b: Uint8Array, o: number): number {
  // File offsets / durations stay well under 2^53, so a Number is exact here.
  return u32(b, o) * 0x100000000 + u32(b, o + 4);
}
function boxType(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

interface BoxHeader {
  type: string;
  size: number; // total box size incl. header; 0 means "to end of buffer"
  headerSize: number; // 8 or 16 (64-bit size)
}
// Parse one box header at offset o within b. Returns null if there are not enough bytes.
function readBoxHeader(b: Uint8Array, o: number): BoxHeader | null {
  if (o + 8 > b.length) return null;
  let size = u32(b, o);
  const type = boxType(b, o + 4);
  let headerSize = 8;
  if (size === 1) {
    if (o + 16 > b.length) return null;
    size = u64(b, o + 8);
    headerSize = 16;
  }
  return { type, size, headerSize };
}

const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex"]);

export interface MoovInfo {
  durationS: number | null;
  hasVideoTrack: boolean;
  frames: number | null; // summed sample_count across video tracks
  width: number | null;
  height: number | null;
}

// PURE: parse a moov box PAYLOAD region [start,end) for the handful of facts the structural gate needs.
// Descends the standard container nesting (moov > trak > mdia > minf > stbl) and reads mvhd (duration),
// tkhd (dimensions), hdlr (is this track video?) and stsz (frame count). Robust to unknown/extra boxes
// and to a truncated buffer -- it reads what it can and reports nulls for the rest, never throwing.
export function parseMoov(buf: Uint8Array, start = 0, end: number = buf.length): MoovInfo {
  const info: MoovInfo = { durationS: null, hasVideoTrack: false, frames: null, width: null, height: null };
  walk(buf, start, end, info, { inVideoTrak: false });
  return info;
}

interface TrakCtx { inVideoTrak: boolean; trakWidth?: number; trakHeight?: number; }
function walk(buf: Uint8Array, start: number, end: number, info: MoovInfo, ctx: TrakCtx): void {
  let o = start;
  while (o + 8 <= end) {
    const h = readBoxHeader(buf, o);
    if (!h) break;
    const boxEnd = h.size === 0 ? end : o + h.size;
    if (h.size !== 0 && (h.size < h.headerSize || boxEnd > end)) break; // malformed / overruns: stop honestly
    const payloadStart = o + h.headerSize;
    if (h.type === "trak") {
      const tctx: TrakCtx = { inVideoTrak: false };
      walk(buf, payloadStart, boxEnd, info, tctx);
      if (tctx.inVideoTrak) {
        info.hasVideoTrack = true;
        if (tctx.trakWidth != null && info.width == null) info.width = tctx.trakWidth;
        if (tctx.trakHeight != null && info.height == null) info.height = tctx.trakHeight;
      }
    } else if (CONTAINER_BOXES.has(h.type)) {
      walk(buf, payloadStart, boxEnd, info, ctx);
    } else if (h.type === "mvhd") {
      readMvhd(buf, payloadStart, boxEnd, info);
    } else if (h.type === "tkhd") {
      readTkhd(buf, payloadStart, boxEnd, ctx);
    } else if (h.type === "hdlr") {
      // handler_type is at payload offset 8 (after version/flags + pre_defined).
      if (payloadStart + 12 <= boxEnd && boxType(buf, payloadStart + 8) === "vide") ctx.inVideoTrak = true;
    } else if (h.type === "stsz") {
      // version/flags(4) sample_size(4) sample_count(4)
      if (payloadStart + 12 <= boxEnd && ctx.inVideoTrak) {
        const count = u32(buf, payloadStart + 8);
        info.frames = (info.frames ?? 0) + count;
      }
    }
    if (h.size === 0) break; // extends to end
    o = boxEnd;
  }
}

function readMvhd(buf: Uint8Array, payloadStart: number, end: number, info: MoovInfo): void {
  if (payloadStart + 4 > end) return;
  const version = buf[payloadStart];
  let ts: number, dur: number;
  if (version === 1) {
    if (payloadStart + 28 > end) return;
    ts = u32(buf, payloadStart + 20);
    dur = u64(buf, payloadStart + 24);
  } else {
    if (payloadStart + 20 > end) return;
    ts = u32(buf, payloadStart + 12);
    dur = u32(buf, payloadStart + 16);
  }
  if (ts > 0) info.durationS = dur / ts;
}

function readTkhd(buf: Uint8Array, payloadStart: number, end: number, ctx: TrakCtx): void {
  if (payloadStart + 4 > end) return;
  const version = buf[payloadStart];
  // width/height are the last two 32-bit 16.16 fixed-point fields of tkhd.
  const base = version === 1 ? payloadStart + 32 : payloadStart + 20; // through the duration field
  const wOff = base + 8 + 2 + 2 + 2 + 2 + 36; // reserved(8) layer(2) alt(2) vol(2) reserved(2) matrix(36)
  if (wOff + 8 > end) return;
  ctx.trakWidth = u32(buf, wOff) >>> 16;
  ctx.trakHeight = u32(buf, wOff + 4) >>> 16;
}

// PURE: turn the collected checks into a verdict. Fails ONLY on positive evidence of structural
// corruption (never on a missing read -- that is a skip). Kept separate from I/O so it is exhaustively
// unit-testable.
export function judgeClip(checks: ClipValidateChecks): ClipValidateResult {
  if (checks.bytes < CLIP_MIN_BYTES) {
    return { verdict: "fail", reason: `clip is ${checks.bytes} bytes (< ${CLIP_MIN_BYTES} floor); truncated or empty`, checks };
  }
  if (!checks.container) {
    return { verdict: "fail", reason: "not a valid mp4 (no ftyp/moov box tree); corrupt or wrong format", checks };
  }
  if (checks.duration_s != null && (checks.duration_s < CLIP_MIN_DURATION_S || checks.duration_s > CLIP_MAX_DURATION_S)) {
    return { verdict: "fail", reason: `clip duration ${checks.duration_s.toFixed(3)}s is out of sane bounds [${CLIP_MIN_DURATION_S}, ${CLIP_MAX_DURATION_S}]s`, checks };
  }
  if (!checks.video_track) {
    return { verdict: "fail", reason: "no video track in the clip (audio-only or corrupt container)", checks };
  }
  if (checks.frames != null && checks.frames <= 0) {
    return { verdict: "fail", reason: "video track has zero frames (empty/corrupt clip)", checks };
  }
  if (checks.width != null && checks.height != null &&
    (checks.width <= 0 || checks.height <= 0 || checks.width > CLIP_MAX_DIMENSION || checks.height > CLIP_MAX_DIMENSION)) {
    return { verdict: "fail", reason: `video dimensions ${checks.width}x${checks.height} are out of sane bounds`, checks };
  }
  return { verdict: "pass", checks };
}

type RangeReader = (offset: number, length: number) => Promise<Uint8Array | null>;

// Locate ftyp + moov by walking top-level box HEADERS only (each read is a few bytes; mdat is skipped by
// its size, never downloaded). moov may be at the front (faststart) or after mdat; both are handled.
async function locateStructure(read: RangeReader, totalBytes: number): Promise<{ ftypOk: boolean; moov?: { offset: number; size: number; headerSize: number } }> {
  let ftypOk = false;
  let offset = 0;
  for (let i = 0; i < MAX_TOPLEVEL_BOXES && offset + 8 <= totalBytes; i++) {
    const hdrBytes = await read(offset, 16);
    if (!hdrBytes || hdrBytes.length < 8) break;
    const h = readBoxHeader(hdrBytes, 0);
    if (!h) break;
    if (i === 0) {
      if (h.type !== "ftyp") break; // a real mp4 opens with ftyp; anything else is not our format
      ftypOk = true;
    }
    if (h.type === "moov") return { ftypOk, moov: { offset, size: h.size, headerSize: h.headerSize } };
    if (h.size === 0) break; // last box extends to EOF and is not moov
    offset += h.size;
  }
  return { ftypOk };
}

// Async wrapper: bounded R2 reads -> structural checks -> verdict. NEVER throws; an unreadable artifact
// is a "skip" (transient), not a fail, so a blip cannot false-reject a real render. Returns skip when
// validation is disabled or the object is absent.
export async function validateClipArtifact(env: Env, key: string, expectedSeconds: number): Promise<ClipValidateResult> {
  const empty: ClipValidateChecks = { container: false, video_track: false, duration_s: null, expected_s: expectedSeconds, frames: null, width: null, height: null, bytes: 0 };
  if (!CLIP_VALIDATE_ENABLED) return { verdict: "skip", reason: "clip validation disabled", checks: empty };
  try {
    const head = await env.R2_RENDERS.head(key);
    if (!head) return { verdict: "skip", reason: "clip artifact not found in R2", checks: empty };
    const totalBytes = head.size;
    const checks: ClipValidateChecks = { ...empty, bytes: totalBytes };
    const read: RangeReader = async (offset, length) => {
      const obj = await env.R2_RENDERS.get(key, { range: { offset, length } });
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    };
    const loc = await locateStructure(read, totalBytes);
    if (loc.ftypOk && loc.moov) {
      checks.container = true;
      const payloadOffset = loc.moov.offset + loc.moov.headerSize;
      const payloadLen = loc.moov.size - loc.moov.headerSize;
      if (payloadLen > 0 && payloadLen <= MOOV_FETCH_CAP) {
        const moovBytes = await read(payloadOffset, payloadLen);
        if (moovBytes && moovBytes.length) {
          const info = parseMoov(moovBytes);
          checks.duration_s = info.durationS;
          checks.video_track = info.hasVideoTrack;
          checks.frames = info.frames;
          checks.width = info.width;
          checks.height = info.height;
        }
      } else {
        // moov present but too large to introspect: trust the container, skip the deep checks.
        checks.video_track = true;
      }
    }
    return judgeClip(checks);
  } catch (e) {
    // Reading/parsing threw: do NOT fail the shot on an I/O hiccup; skip and let the render proceed.
    return { verdict: "skip", reason: `clip validation errored: ${e instanceof Error ? e.message : String(e)}`, checks: empty };
  }
}
