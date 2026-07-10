// Pure subtitle logic: config coercion, SRT assembly from the core's timed cues, the /subtitle
// container request body, and the passthrough output. No I/O here, so it unit-tests without the
// runtime, the container, or ffmpeg. Timing is NOT computed here -- the core hands fully-timed cues
// (it owns the per-shot dialogue + the real shot durations); this module only FORMATS and BURNS.

import type { FilmFinishInput, FilmFinishOutput, CaptionCue } from "./contract";

export type SubtitleMode = "burn" | "sidecar" | "both";
export type SubtitlePosition = "bottom" | "top" | "middle";
export type SubtitleBoxStyle = "outline" | "box";

export interface SubtitleConfig {
  enabled: boolean;
  mode: SubtitleMode;
  font: string;
  font_size: number;
  color: string;
  position: SubtitlePosition;
  box_style: SubtitleBoxStyle;
  margin_v: number;
}

const num = (v: unknown, dflt: number, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.max(lo, Math.min(hi, n));
};
const str = (v: unknown, dflt: string): string => (typeof v === "string" && v.length > 0 ? v : dflt);
const oneOf = <T extends string>(v: unknown, values: readonly T[], dflt: T): T =>
  (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : dflt);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);

export function coerceConfig(cfg: Record<string, unknown>): SubtitleConfig {
  return {
    enabled: bool(cfg.enabled, true),
    mode: oneOf(cfg.mode, ["burn", "sidecar", "both"] as const, "burn"),
    font: str(cfg.font, "DejaVu Sans"),
    font_size: num(cfg.font_size, 28, 8, 120),
    color: str(cfg.color, "white"),
    position: oneOf(cfg.position, ["bottom", "top", "middle"] as const, "bottom"),
    box_style: oneOf(cfg.box_style, ["outline", "box"] as const, "outline"),
    margin_v: num(cfg.margin_v, 36, 0, 400),
  };
}

/** A cue is renderable when it has non-empty text. */
function renderable(c: CaptionCue): boolean {
  return !!c && typeof c.text === "string" && c.text.trim().length > 0;
}

/** True when there is at least one renderable cue. With none, the module passes the film through
 *  unchanged (a silent film, or a film with no dialogue lines, has nothing to caption). */
export function hasCaptions(input: FilmFinishInput): boolean {
  return Array.isArray(input.captions) && input.captions.some(renderable);
}

/** Drop empty cues and normalize times (clamp >= 0, guarantee end > start). Keeps play order. */
export function cleanCues(cues: CaptionCue[] | undefined): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const c of cues ?? []) {
    if (!renderable(c)) continue;
    const start = typeof c.start === "number" && Number.isFinite(c.start) ? Math.max(0, c.start) : 0;
    const rawEnd = typeof c.end === "number" && Number.isFinite(c.end) ? c.end : start;
    const end = rawEnd > start ? rawEnd : start + 0.2;
    out.push({ start, end, text: c.text.trim() });
  }
  return out;
}

/** SRT timestamp: HH:MM:SS,mmm (comma before milliseconds, per the SubRip spec). */
export function formatTimestamp(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Assemble a SubRip (.srt) document from timed cues. Cues are renumbered from 1 in play order; empty
 *  cues are dropped. Returns "" when there is nothing to render. */
export function buildSrt(cues: CaptionCue[] | undefined): string {
  const clean = cleanCues(cues);
  if (!clean.length) return "";
  const blocks = clean.map(
    (c, i) => `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}`,
  );
  return blocks.join("\n\n") + "\n";
}

/** The JSON body POSTed to the video-finish container's /subtitle route. Presigned URLs come from the
 *  core (the module is credentialless); the container downloads the film, burns the SRT via the ffmpeg
 *  subtitles (libass) filter, uploads the result to outputUrl, and -- in sidecar / both modes -- PUTs
 *  the raw .srt to sidecarUrl. `srt` is the already-formatted document; the container never re-times. */
export function buildContainerSpec(
  input: FilmFinishInput,
  cfg: SubtitleConfig,
  srt: string,
): Record<string, unknown> {
  const wantSidecar = cfg.mode === "sidecar" || cfg.mode === "both";
  const haveSidecarUrl = wantSidecar && typeof input.sidecar_url === "string" && input.sidecar_url.length > 0;
  // Effective mode: degrade to burn-only if a sidecar was requested but the core presigned no sidecar
  // URL (sidecar-only with no URL is handled upstream in index.ts as a passthrough, not here).
  const mode: SubtitleMode = wantSidecar && !haveSidecarUrl ? "burn" : cfg.mode;
  const spec: Record<string, unknown> = {
    videoUrl: input.video_url,
    outputUrl: input.output_url,
    outputKey: input.output_key,
    srt,
    mode,
    width: input.width ?? 1920,
    height: input.height ?? 1080,
    fps: input.fps ?? 24,
    style: {
      font: cfg.font,
      fontSize: cfg.font_size,
      color: cfg.color,
      position: cfg.position,
      box: cfg.box_style,
      marginV: cfg.margin_v,
    },
  };
  if (mode === "sidecar" || mode === "both") {
    spec.sidecarUrl = input.sidecar_url;
    spec.sidecarKey = input.sidecar_key ?? "";
  }
  return spec;
}

/** Pass the film through unchanged (nothing to caption, or a recoverable container failure). film_key
 *  is the original so the chain / done-transition keeps the assembled film. Per the honest-degrade
 *  discipline: applied carries ONLY the real reason (no fake "subtitle" tag), and `degraded` is set
 *  exactly when a requested burn could not run. */
export function passthroughOutput(input: FilmFinishInput, reason: string, opts: { degraded?: boolean } = {}): FilmFinishOutput {
  return {
    film_key: input.film_key,
    applied: [reason],
    ...(opts.degraded ? { degraded: reason } : {}),
  };
}

// --- async job+poll (#602) ---------------------------------------------------------------------
// A subtitle burn is a full libx264 re-encode; on a long film it can outlast a Worker request budget.
// The module submits to the video-finish container's async route and returns a poll token, so the CORE
// drives submit+poll across ticks (mirroring the GPU finish satellites). The token is opaque to the
// core and decoded only here.

export interface FinishPoll {
  jobId: string;       // the container's background job id
  filmKey: string;     // the input film key (the sidecar-only / passthrough result key)
  outputKey: string;   // the deterministic key the container writes the burned film to
  submittedAt: number; // epoch ms; measures the container "job not found" (restart) grace window
}

export function encodePoll(s: FinishPoll): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): FinishPoll | null {
  try {
    const o = JSON.parse(atob(token)) as FinishPoll;
    if (o && typeof o.jobId === "string" && typeof o.filmKey === "string" && typeof o.outputKey === "string") {
      return { jobId: o.jobId, filmKey: o.filmKey, outputKey: o.outputKey, submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : 0 };
    }
  } catch { /* fall through */ }
  return null;
}

// How long after submit a container "job not found" is a restart race (keep polling) vs a real drop
// (fail, so the core re-dispatches or degrades). The container job store is in-process.
export const CONTAINER_NOTFOUND_GRACE_MS = 30_000;

/** Map the container's completed /subtitle result to a FilmFinishOutput, composing an HONEST `applied`:
 *  "subtitle" only when captions were actually burned (film_key then points at the burned film),
 *  "subtitle:sidecar" when a .srt was written. A sidecar-only run burns nothing, so film_key stays the
 *  original -- no fake burn tag (the #77 honest-degrade discipline). */
export function completedOutput(result: { key?: string; burned?: boolean; sidecar?: boolean } | null, st: FinishPoll): FilmFinishOutput {
  const applied: string[] = [];
  if (result?.burned) applied.push("subtitle");
  if (result?.sidecar) applied.push("subtitle:sidecar");
  if (!applied.length) applied.push("noop:no-dialogue");
  const filmKey = result?.burned
    ? (typeof result.key === "string" && result.key.length > 0 ? result.key : st.outputKey)
    : st.filmKey;
  return { film_key: filmKey, applied };
}
