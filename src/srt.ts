// SRT (SubRip) sidecar re-timer for the film.finish chain (#663).
//
// The subtitle film.finish module (ui.order 5) writes its soft .srt sidecar against the assembled
// 0-based timeline: each cue starts at the film`s real start, because the timed cues the core hands it
// are measured from the assembled film`s 0 (see src/captions.ts). A LATER film.finish step -- film-titles
// (ui.order 10) -- then PREPENDS an opening title card, shifting the FINAL film forward by title_seconds.
// The BURNED captions ride the video through that prepend (they are part of the frames), but the soft
// .srt sidecar is a SEPARATE artifact and does NOT, so against the final film every cue runs early by the
// prepend duration. The core re-times the sidecar AFTER the chain by that known offset (module-reported
// prepend_seconds), so the soft subtitles line up with the delivered film.
//
// Pure string transform, no I/O: parse each `HH:MM:SS,mmm --> HH:MM:SS,mmm` cue line, add the offset
// (a negative result clamps to 0), reformat with minute/hour rollover. Everything else (cue indices,
// caption text, blank lines, any trailing position extension on the cue line) passes through verbatim.

/** Parse an SRT `HH:MM:SS,mmm` timestamp to whole milliseconds (0 on a non-match, defensively). */
export function parseTimestamp(ts: string): number {
  const m = /(\d{1,2}):(\d{2}):(\d{2}),(\d{3})/.exec(ts);
  if (!m) return 0;
  return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4]);
}

/** Format whole milliseconds as an SRT `HH:MM:SS,mmm` timestamp, rolling seconds into minutes and
 *  minutes into hours. A negative input clamps to zero; hours are not capped (SubRip zero-pads to 2 but
 *  tolerates more, and a very long film can in theory exceed 99h). */
export function formatTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const msPart = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msPart, 3)}`;
}

/** Shift every cue timestamp in an SRT document by `offsetSeconds`. A zero (or non-finite) offset returns
 *  the input UNCHANGED (the no-op the core relies on when there is no title card / credits-only). Only
 *  lines carrying the `-->` cue arrow are rewritten, so indices and caption text are preserved exactly. */
export function retimeSrt(srt: string, offsetSeconds: number): string {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0) return srt;
  const offsetMs = Math.round(offsetSeconds * 1000);
  return srt
    .split("\n")
    .map((line) => {
      if (!line.includes("-->")) return line;
      return line.replace(/(\d{1,2}):(\d{2}):(\d{2}),(\d{3})/g, (_m, h, mm, ss, mmm) => {
        const base = Number(h) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + Number(mmm);
        return formatTimestamp(base + offsetMs);
      });
    })
    .join("\n");
}
