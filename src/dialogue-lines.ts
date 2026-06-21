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
