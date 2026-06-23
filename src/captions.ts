// Caption cue timing for the film.finish subtitle module.
//
// Captions MUST sync to the audio, so the only honestly-timed text today is per-shot DIALOGUE: each
// speaking shot's TTS audio is baked into that shot's clip (job.dialogue_audio[shot_id]), so the line
// is spoken DURING that shot's window in the assembled film. We time each line to its shot's
// [start, end) window, where start = the cumulative duration of every preceding shot. The per-shot
// durations are the REAL ones the hybrid assembler beat-trims each clip to (readShotDurationsFromBundle's
// target_seconds), falling back to the authored scene seconds when the bundle carries no target.
//
// Narration is deliberately NOT captioned here: narration-gen emits a single film-level voiceover
// track with NO per-line timestamps, so shot-aligned narration cues would be guessed, not synced --
// which the "pull the REAL timing, do not guess" rule forbids. When narration grows real per-line
// timings, add them as cues alongside these; never fake them.

/** One time-synced caption cue, in seconds from the assembled film's 0-based start. */
export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

/** A shot in PLAY order (scene order == concat order). `seconds` is the authored per-shot duration,
 *  used only when the bundle carries no beat-trimmed target for this shot. */
export interface CaptionScene {
  shot_id: string;
  seconds: number;
}

/** One spoken dialogue line, addressed to a shot. */
export interface CaptionLine {
  shot_id: string;
  text: string;
}

// Never emit a zero/negative-length cue (a shot with a line but no known duration still shows briefly).
const MIN_CUE_SECONDS = 0.2;

/** Resolve a shot's real duration: the bundle's beat-trimmed target_seconds (preferred), else the
 *  authored scene seconds, else 0 (an unknown-length shot contributes no time but still anchors a cue). */
function shotDuration(scene: CaptionScene, durations: Record<string, number>): number {
  const fromBundle = durations[scene.shot_id];
  if (typeof fromBundle === "number" && Number.isFinite(fromBundle) && fromBundle > 0) return fromBundle;
  if (typeof scene.seconds === "number" && Number.isFinite(scene.seconds) && scene.seconds > 0) return scene.seconds;
  return 0;
}

/** Build time-synced dialogue cues for the assembled film. `scenes` are in PLAY order; `durations`
 *  maps shot_id -> the real beat-trimmed seconds (a scene's authored `seconds` is the fallback). Only
 *  shots with a non-empty dialogue line produce a cue, timed to that shot's cumulative [start, end)
 *  window. Returns cues in play order; an empty array when nothing is spoken (the module then no-ops).
 *  A shot may carry at most one line; a later line for the same shot wins (last-write), matching how
 *  the dialogue stage resolves one line per speaking shot. */
export function buildCaptionCues(
  scenes: CaptionScene[],
  lines: CaptionLine[],
  durations: Record<string, number> = {},
): CaptionCue[] {
  const textByShot = new Map<string, string>();
  for (const l of lines ?? []) {
    if (!l || typeof l.shot_id !== "string") continue;
    const text = typeof l.text === "string" ? l.text.trim() : "";
    if (text) textByShot.set(l.shot_id, text);
  }

  const cues: CaptionCue[] = [];
  let cursor = 0;
  for (const scene of scenes ?? []) {
    if (!scene || typeof scene.shot_id !== "string") continue;
    const start = cursor;
    cursor += shotDuration(scene, durations);
    const text = textByShot.get(scene.shot_id);
    if (!text) continue; // a silent shot advances time but adds no caption
    const end = Math.max(start + MIN_CUE_SECONDS, cursor);
    cues.push({ start, end, text });
  }
  return cues;
}
