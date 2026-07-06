// Build the per-shot dialogue batch for the `dialogue` hook from the AUTHORITATIVE storyboard.
//
// The storyboard is persisted lossless in D1 (storyboard_projects.last_storyboard); the bundle's
// storyboard.yaml is a lossy GPU-render snapshot that drops dialogue. So at render submission we read
// the stored storyboard, pull each speaking shot's line, and resolve the speaker's voice from the
// slot -> voice_id map already produced by resolveCastLoras (one cast-row fetch, single-user, no new
// identity dependency). The line is authored content (from the storyboard); the voice is authoritative
// (from the cast). Result is threaded onto the FilmJob; the orchestrator submits it after clips.

import { coerceShotId } from "./storyboard-validate";
import type { DialogueLine } from "./modules/types";
import { coerceVoiceId, DEFAULT_VOICE_ID } from "./voices";
import type { ParsedBundleScene } from "./planner-yaml";

interface StoredScene {
  id?: unknown;
  dialogue?: unknown;
}

/** Defensively pull the scenes[] out of an untyped stored storyboard. */
function extractScenes(storyboard: unknown): StoredScene[] {
  if (!storyboard || typeof storyboard !== "object") return [];
  const scenes = (storyboard as Record<string, unknown>).scenes;
  return Array.isArray(scenes) ? (scenes as StoredScene[]) : [];
}

/** Per-shot dialogue lines for the shots being rendered. `voices` is slot -> voice_id (from
 *  resolveCastLoras); `shotIds` is the render's shot set (so dialogue for shots not in this render --
 *  e.g. a scatter shard -- is excluded). A scene with no/invalid dialogue is skipped (silent shot).
 *  Pure + defensive: the stored storyboard is untyped JSON, so every field is checked. */
export function buildDialogueLines(
  storyboard: unknown,
  voices: Record<string, string>,
  shotIds: string[],
): DialogueLine[] {
  const scenes = extractScenes(storyboard);
  if (!scenes.length) return [];
  const want = new Set(shotIds);
  const lines: DialogueLine[] = [];
  scenes.forEach((scene, i) => {
    const dlg = scene.dialogue;
    if (!dlg || typeof dlg !== "object") return;
    const slot = (dlg as Record<string, unknown>).slot;
    const text = (dlg as Record<string, unknown>).text;
    if (typeof slot !== "string" || typeof text !== "string" || !text.trim()) return;
    // Reproduce the same shot_NN the validator/bundle assigned, so the line maps to the rendered shot.
    const shotId = coerceShotId(typeof scene.id === "string" ? scene.id : undefined, i);
    if (!want.has(shotId)) return;
    // Voice from the cast (authoritative); default for a speaker whose cast has none assigned.
    const voice = coerceVoiceId(voices[slot]) ?? DEFAULT_VOICE_ID;
    lines.push({ shot_id: shotId, text: text.trim(), voice_id: voice });
  });
  return lines;
}


/** Cast voicing for EXPLICIT dialogue_lines (#582): a caller-supplied line without a voice_id used
 *  to fall straight to DEFAULT_VOICE_ID -- even when the shot's speaking slot is bound to a cast
 *  member with a voice (Wren, voice asteria, spoke as angus in film-08dd5777). Resolve each
 *  voiceless line's shot to its speaking slot via the bundle storyboard's per-shot dialogue, then
 *  the slot to its cast voice via `voices` (slot -> voice_id, from resolveCastLoras). The default
 *  applies ONLY when there is genuinely no mapping (no scene dialogue for the shot, or a slot whose
 *  cast has no voice). An explicit line voice_id always wins -- it is never overwritten. Pure. */
export function resolveExplicitLineVoices(
  lines: DialogueLine[],
  scenes: ParsedBundleScene[],
  voices: Record<string, string>,
): DialogueLine[] {
  const slotByShot = new Map<string, string>();
  for (const s of scenes) {
    if (s.dialogue && typeof s.dialogue.slot === "string") slotByShot.set(s.shot_id, s.dialogue.slot);
  }
  return lines.map((line) => {
    if (typeof line.voice_id === "string" && line.voice_id.trim()) return line;
    const slot = slotByShot.get(line.shot_id);
    const voice = (slot !== undefined ? coerceVoiceId(voices[slot]) : undefined) ?? DEFAULT_VOICE_ID;
    return { ...line, voice_id: voice };
  });
}

/** Bundle-only voicing (#313): build the per-shot dialogue batch from the dialogue carried in a
 *  bundle's storyboard.yaml (parsed by parseStoryboardScenes), resolving each speaking slot's voice
 *  from `voices` (slot -> voice_id; empty on a bundle-only render with no cast) and defaulting
 *  otherwise. A scene with no/blank dialogue is skipped (silent shot). The /api/render/film path uses
 *  this when the caller passed no explicit dialogue_lines, so a self-describing dialogue bundle renders
 *  voiced end to end with no D1 project or arg. */
export function dialogueLinesFromBundleScenes(
  scenes: ParsedBundleScene[],
  voices: Record<string, string>,
): DialogueLine[] {
  const lines: DialogueLine[] = [];
  for (const s of scenes) {
    const dlg = s.dialogue;
    if (!dlg || typeof dlg.text !== "string" || !dlg.text.trim()) continue;
    const voice = coerceVoiceId(voices[dlg.slot]) ?? DEFAULT_VOICE_ID;
    lines.push({ shot_id: s.shot_id, text: dlg.text.trim(), voice_id: voice });
  }
  return lines;
}
