// Pure film-titles logic: config coercion + the /film-titles container request body, plus the
// passthrough output. No I/O here, so it unit-tests without the runtime, the container, or ffmpeg.

import type { FilmFinishInput, FilmFinishOutput } from "./contract";

export interface TitlesConfig {
  font: string;
  color: string;
  bg: string;          // card background color (ffmpeg color name or #rrggbb)
  title_seconds: number;
  credit_seconds: number;
}

const num = (v: unknown, dflt: number, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.max(lo, Math.min(hi, n));
};
const str = (v: unknown, dflt: string): string => (typeof v === "string" && v.length > 0 ? v : dflt);

export function coerceConfig(cfg: Record<string, unknown>): TitlesConfig {
  return {
    font: str(cfg.font, "DejaVu Sans"),
    color: str(cfg.color, "white"),
    bg: str(cfg.bg, "black"),
    title_seconds: num(cfg.title_seconds, 3, 1, 15),
    credit_seconds: num(cfg.credit_seconds, 5, 1, 30),
  };
}

/** True when there is at least one card to render. With neither a title nor non-empty credits, the
 *  module passes the film through unchanged (noop) -- never an empty/cosmetic container round-trip. */
export function hasCards(input: FilmFinishInput): boolean {
  const titled = !!(input.title && typeof input.title.text === "string" && input.title.text.trim().length > 0);
  const credited = !!(input.credits && Array.isArray(input.credits.lines) && input.credits.lines.some((l) => typeof l === "string" && l.trim().length > 0));
  return titled || credited;
}

/** True when there is a non-empty opening TITLE card specifically (credits are appended at the END and
 *  never shift the timeline). This is the ONLY card that prepends the film, so it is what the core needs
 *  to re-time an .srt sidecar by (#663). */
export function hasTitleCard(input: FilmFinishInput): boolean {
  return !!(input.title && typeof input.title.text === "string" && input.title.text.trim().length > 0);
}

/** The JSON body POSTed to the video-finish container's /film-titles route. Presigned URLs come from
 *  the core (the module is credentialless); the container downloads the film, generates the cards,
 *  concats [title?, film, credits?], and uploads the result to output_url. */
export function buildContainerSpec(input: FilmFinishInput, cfg: TitlesConfig): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    videoUrl: input.video_url,
    outputUrl: input.output_url,
    outputKey: input.output_key,
    width: input.width ?? 1920,
    height: input.height ?? 1080,
    fps: input.fps ?? 24,
    font: cfg.font,
    color: cfg.color,
    bg: cfg.bg,
  };
  if (input.title && input.title.text.trim().length > 0) {
    spec.title = { text: input.title.text, subtitle: input.title.subtitle ?? "", seconds: cfg.title_seconds };
  }
  if (input.credits && input.credits.lines.some((l) => l.trim().length > 0)) {
    spec.credits = { lines: input.credits.lines.filter((l) => l.trim().length > 0), seconds: cfg.credit_seconds };
  }
  return spec;
}

/** Pass the film through unchanged (no cards, or a recoverable container failure). film_key is
 *  unchanged so the chain / done-transition keeps the original assembled film. */
export function passthroughOutput(input: FilmFinishInput, reason: string, opts: { degraded?: boolean } = {}): FilmFinishOutput {
  return {
    film_key: input.film_key,
    applied: [reason],
    ...(opts.degraded ? { degraded: reason } : {}),
  };
}

// --- async job+poll (#602) ---------------------------------------------------------------------
// A film.finish encode (title/credit cards) can outlast a Worker request budget on a long film. The
// module submits the film to the video-finish container's async route and returns a poll token, so the
// CORE drives submit+poll across ticks (mirroring the GPU finish satellites) instead of one module
// holding a long request open. The token is opaque to the core and decoded only here.

export interface FinishPoll {
  jobId: string;       // the container's background job id
  filmKey: string;     // the input film key (the fallback result key)
  outputKey: string;   // the deterministic key the container writes the carded film to
  submittedAt: number; // epoch ms; measures the container "job not found" (restart) grace window
  titleSeconds: number; // seconds prepended by the opening title card (0 = none); reported back to the
                        // core as prepend_seconds so it can re-time the .srt sidecar (#663)
}

export function encodePoll(s: FinishPoll): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): FinishPoll | null {
  try {
    const o = JSON.parse(atob(token)) as FinishPoll;
    if (o && typeof o.jobId === "string" && typeof o.filmKey === "string" && typeof o.outputKey === "string") {
      return { jobId: o.jobId, filmKey: o.filmKey, outputKey: o.outputKey, submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : 0, titleSeconds: typeof o.titleSeconds === "number" && Number.isFinite(o.titleSeconds) && o.titleSeconds > 0 ? o.titleSeconds : 0 };
    }
  } catch { /* fall through */ }
  return null;
}

// How long after submit a container "job not found" is treated as a restart race (keep polling) vs a
// real drop (fail, so the core re-dispatches or degrades). The container job store is in-process, so a
// container restart drops the job; the deterministic output key makes a core re-run idempotent.
export const CONTAINER_NOTFOUND_GRACE_MS = 30_000;

/** Map the container's completed /film-titles result to a FilmFinishOutput. A real write lands the
 *  carded film at outputKey (result.key echoes it); a missing key falls back to the deterministic
 *  outputKey the core presigned, never the raw input (a card WAS applied). */
export function completedOutput(result: { key?: string } | null, st: FinishPoll): FilmFinishOutput {
  const filmKey = result && typeof result.key === "string" && result.key.length > 0 ? result.key : st.outputKey;
  return { film_key: filmKey, applied: ["film-titles"], ...(st.titleSeconds > 0 ? { prepend_seconds: st.titleSeconds } : {}) };
}
