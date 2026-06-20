// Pure text-overlay logic: overlay spec validation/coercion, ffmpeg drawtext filter-string
// building, container request body construction, and passthrough shaping.
//
// No I/O here -- fully unit-testable without ffmpeg, the Worker runtime, or any bindings. The
// drawtext filter builder is the critical pure piece: it turns the caller's overlay specs into a
// valid ffmpeg -vf filter string. The container runs it; this module just builds the string.

import type { FinishInput, FinishOutput } from "./contract";

// ---------------------------------------------------------------------------
// Types

export type OverlayKind = "title" | "credit" | "lower-third" | "subtitle";
export type OverlayPosition =
  | "top-center" | "center" | "bottom-center"
  | "top-left"  | "top-right"
  | "lower-left" | "lower-right";

/** A single text burn-in spec (from req.config.overlays[]). All fields except text are optional;
 *  kind drives position and style defaults. */
export interface OverlaySpec {
  text: string;
  kind?: OverlayKind;
  start?: number;   // seconds; default 0
  end?: number;     // seconds; default = clip duration (no disable)
  position?: OverlayPosition; // override the kind-derived default
  font?: string;
  size?: number;
  color?: string;
}

/** Module config resolved from req.config + schema defaults. */
export interface OverlayConfig {
  font: string;           // default font name (fallback for overlays that don't specify one)
  size: number;           // default font size in pixels
  color: string;          // default font color (ffmpeg color syntax: "white", "#rrggbb", etc.)
  safe_margin: number;    // pixels from the edge for positional presets
}

// ---------------------------------------------------------------------------
// Config coercion

export function defaultConfig(): OverlayConfig {
  // "DejaVu Sans" is the family the video-finish container actually installs
  // (fonts-dejavu-core + fontconfig). A Windows/Mac family like "Arial" does
  // not exist on the Linux container and drawtext fails to resolve it.
  return { font: "DejaVu Sans", size: 48, color: "white", safe_margin: 50 };
}

const SAFE_COLOR_RE = /^[a-zA-Z0-9#@]{1,32}$/; // ffmpeg color names + hex + @alpha suffix

export function coerceConfig(raw: Record<string, unknown>): OverlayConfig {
  const d = defaultConfig();
  const font =
    typeof raw.font === "string" && raw.font.trim().length > 0 ? raw.font.trim() : d.font;
  const rawSize = raw.size !== undefined && raw.size !== null ? Number(raw.size) : d.size;
  const size = Number.isFinite(rawSize) ? Math.max(8, Math.min(400, Math.round(rawSize))) : d.size;
  const color =
    typeof raw.color === "string" && SAFE_COLOR_RE.test(raw.color.trim())
      ? raw.color.trim()
      : d.color;
  const safe_margin = Math.max(0, Math.min(500, Math.round(Number(raw.safe_margin) || d.safe_margin)));
  return { font, size, color, safe_margin };
}

// ---------------------------------------------------------------------------
// Overlay spec coercion / validation

const VALID_KINDS = new Set<OverlayKind>(["title", "credit", "lower-third", "subtitle"]);
const VALID_POSITIONS = new Set<OverlayPosition>([
  "top-center", "center", "bottom-center", "top-left", "top-right", "lower-left", "lower-right",
]);

export function coerceOverlaySpec(raw: unknown): OverlaySpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text : "";
  if (!text.trim()) return null; // empty text: skip
  const kind = VALID_KINDS.has(o.kind as OverlayKind) ? (o.kind as OverlayKind) : "subtitle";
  const position = VALID_POSITIONS.has(o.position as OverlayPosition)
    ? (o.position as OverlayPosition)
    : undefined;
  const start = typeof o.start === "number" && o.start >= 0 ? o.start : 0;
  const end = typeof o.end === "number" && o.end > start ? o.end : undefined;
  const font = typeof o.font === "string" && o.font.trim() ? o.font.trim() : undefined;
  const size =
    typeof o.size === "number" && o.size >= 8 && o.size <= 400
      ? Math.round(o.size)
      : undefined;
  const color =
    typeof o.color === "string" && SAFE_COLOR_RE.test(o.color.trim()) ? o.color.trim() : undefined;
  return { text, kind, start, end, position, font, size, color };
}

export function coerceOverlays(raw: unknown): OverlaySpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(coerceOverlaySpec).filter((o): o is OverlaySpec => o !== null);
}

// ---------------------------------------------------------------------------
// ffmpeg drawtext filter building

// Default position expression by kind. ffmpeg evaluates `text_w` and `text_h` at render time, so
// these are verbatim filter expressions, not literal pixel values.
function kindDefaultPosition(kind: OverlayKind): OverlayPosition {
  switch (kind) {
    case "title":       return "top-center";
    case "credit":      return "center";
    case "lower-third": return "lower-left";
    case "subtitle":    return "bottom-center";
  }
}

/** Resolve the ffmpeg x/y position expressions for a given position preset and safe margin. */
export function resolvePositionExprs(
  pos: OverlayPosition,
  margin: number,
): { x: string; y: string } {
  const m = String(margin);
  switch (pos) {
    case "top-center":    return { x: "(w-text_w)/2",     y: m };
    case "center":        return { x: "(w-text_w)/2",     y: "(h-text_h)/2" };
    case "bottom-center": return { x: "(w-text_w)/2",     y: `h-text_h-${m}` };
    case "top-left":      return { x: m,                  y: m };
    case "top-right":     return { x: `w-text_w-${m}`,    y: m };
    case "lower-left":    return { x: m,                  y: `h*3/4-text_h/2` };
    case "lower-right":   return { x: `w-text_w-${m}`,    y: `h*3/4-text_h/2` };
  }
}

/** Escape text for use inside an ffmpeg drawtext `text=` value.
 *  Rules: `\` -> `\\`, `:` -> `\:`, `'` -> `\\\'` (three chars), newlines stay as `\n`.
 *  The resulting string is safe to embed in a filter string delimited by single-quotes. */
export function escapeDrawtext(text: string): string {
  // Order matters: escape backslashes first, then colons, then single quotes.
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

/** Build a single ffmpeg `drawtext=...` filter segment for one overlay spec. */
export function overlayToDrawtext(spec: OverlaySpec, cfg: OverlayConfig): string {
  const pos = spec.position ?? kindDefaultPosition(spec.kind ?? "subtitle");
  const { x, y } = resolvePositionExprs(pos, cfg.safe_margin);
  const font = spec.font ?? cfg.font;
  const size = spec.size ?? cfg.size;
  const color = spec.color ?? cfg.color;
  const text = escapeDrawtext(spec.text);

  const parts = [
    `font=${font}`,
    `text='${text}'`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
    `x=${x}`,
    `y=${y}`,
  ];

  const hasStart = spec.start !== undefined && spec.start > 0;
  const hasEnd = spec.end !== undefined;
  if (hasStart || hasEnd) {
    const s = (spec.start ?? 0).toFixed(3);
    if (hasEnd) {
      parts.push(`enable='between(t,${s},${spec.end!.toFixed(3)})'`);
    } else {
      parts.push(`enable='gte(t,${s})'`);
    }
  }

  return "drawtext=" + parts.join(":");
}

/** Build the complete ffmpeg -vf filter string for a list of overlay specs. Returns null when the
 *  list is empty (caller should passthrough rather than invoking ffmpeg with an empty filter). */
export function buildDrawtextFilter(overlays: OverlaySpec[], cfg: OverlayConfig): string | null {
  if (overlays.length === 0) return null;
  return overlays.map((o) => overlayToDrawtext(o, cfg)).join(",");
}

// ---------------------------------------------------------------------------
// Container request body

/** JSON spec passed in the X-Overlay-Spec header to the /overlay container route (base64-encoded
 *  in transit). Contains the resolved drawtext filter string + passthrough metadata. */
export interface ContainerOverlaySpec {
  filter: string;           // complete ffmpeg -vf value
  output_key: string;       // the R2 key the container should emit (for logging)
}

export function buildContainerSpec(filter: string, output_key: string): ContainerOverlaySpec {
  return { filter, output_key };
}

/** Derive the output clip key from the input: insert "-overlay" before the extension (or append
 *  it when the key has no extension). */
export function outputClipKey(clip_key: string): string {
  const replaced = clip_key.replace(/(\.[^./]+)$/, "-overlay$1");
  // If no extension was found the regex matched nothing and replaced === clip_key; append suffix.
  return replaced === clip_key ? clip_key + "-overlay" : replaced;
}

// ---------------------------------------------------------------------------
// Passthrough helper (mirrors finish-rife pattern for degrade tracking, #77)

/** Build the passthrough FinishOutput that records WHY the clip went through unchanged. A genuine
 *  degrade (misconfig / container down) tags `applied` with `passthrough:<reason>` and sets
 *  `degraded`; the intentional no-op (no overlays) tags `noop:<reason>` and leaves `degraded`
 *  unset. The index worker does any console.warn; this just shapes the data. */
export function passthroughOutput(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): FinishOutput {
  const degraded = opts.degraded ?? true;
  const out: FinishOutput = {
    shot_id: input.shot_id,
    clip_key: input.clip_key,
    out_fps: input.src_fps ?? 24,
    frames: input.frames ?? 0,
    applied: [`${degraded ? "passthrough" : "noop"}:${reason}`],
  };
  if (degraded) out.degraded = opts.detail ? `${reason}: ${opts.detail}` : reason;
  return out;
}
