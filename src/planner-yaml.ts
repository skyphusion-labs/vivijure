// Storyboard YAML emitter (v0.28.0).
//
// Pure, no runtime dep. Emits the storyboard.yaml the vivijure-serverless
// worker reads, from a StoryboardValidated produced by validateStoryboard.
// All string values are double-quoted unconditionally to avoid edge cases
// (colons inside scene prompts, quote characters, backslashes, newlines,
// leading whitespace). The schema is small and fixed, so a general-purpose
// YAML library is not needed; PyYAML on the GPU worker parses the output.
//
// Output ordering matches storyboard.example.yaml so a human can diff
// emitted vs hand-authored files without reordering noise.

import type {
  StoryboardScene,
  StoryboardValidated,
} from "./storyboard-validate";

function escapeForDoubleQuoted(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function quote(s: string): string {
  return `"${escapeForDoubleQuoted(s)}"`;
}

// Flow-style sequence for slot lists. SlotId values are single letters
// A-D, so no escaping or quoting is required.
function emitSlotList(slots: readonly string[]): string {
  return `[${slots.join(", ")}]`;
}

function emitScene(scene: StoryboardScene): string[] {
  const lines: string[] = [];
  // First key carries the `- ` block-sequence marker; subsequent keys are
  // indented to align under it.
  lines.push(`  - prompt: ${quote(scene.prompt)}`);
  const inner = "    ";
  if (scene.id !== undefined) lines.push(`${inner}id: ${quote(scene.id)}`);
  if (scene.character_slots !== undefined) {
    lines.push(`${inner}character_slots: ${emitSlotList(scene.character_slots)}`);
  }
  if (scene.act !== undefined) lines.push(`${inner}act: ${quote(scene.act)}`);
  if (scene.start !== undefined) lines.push(`${inner}start: ${scene.start}`);
  if (scene.end !== undefined) lines.push(`${inner}end: ${scene.end}`);
  if (scene.target_seconds !== undefined) {
    lines.push(`${inner}target_seconds: ${scene.target_seconds}`);
  }
  if (scene.start_image !== undefined) {
    lines.push(`${inner}start_image: ${quote(scene.start_image)}`);
  }
  return lines;
}

// v0.154.0 (Phase 4 hybrid, slice-3): extract { shot_id -> target_seconds }
// from a storyboard.yaml this module emitted. Used by the hybrid assembler to
// beat-trim BOTH lanes' clips to the authored per-shot durations (beat-synced
// films carry target_seconds on every scene, stamped by applyBeatTiming). The
// scene key is its `id` when present, else the positional shot_NN (1-based),
// matching the renderer's shot numbering (bundle-assembler). Pure + tolerant:
// the format is the deterministic one serializeStoryboardYaml produces, so a
// targeted line scan is enough; any unrecognized line is skipped, and a scene
// with no (or non-positive) target_seconds is simply omitted from the map.
export function parseShotDurations(yaml: string): Record<string, number> {
  const out: Record<string, number> = {};
  let inScenes = false;
  let idx = 0; // 1-based scene counter, advanced at each scene marker
  let curId: string | null = null;
  let curTarget: number | null = null;
  const flush = (): void => {
    if (idx === 0) return;
    const shot = curId || `shot_${String(idx).padStart(2, "0")}`;
    if (curTarget !== null && Number.isFinite(curTarget) && curTarget > 0) {
      out[shot] = curTarget;
    }
  };
  for (const line of yaml.split(/\r?\n/)) {
    if (!inScenes) {
      if (/^scenes:\s*$/.test(line)) inScenes = true;
      continue;
    }
    // Scene blocks are emitted last, so everything after `scenes:` is a scene.
    // A new scene begins with the block-sequence marker ("  - prompt: ...").
    if (/^ {2}-\s/.test(line)) {
      flush();
      idx++;
      curId = null;
      curTarget = null;
      continue;
    }
    const idM = line.match(/^ {4}id:\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (idM) {
      curId = idM[1].replace(/\\(.)/g, "$1");
      continue;
    }
    const tsM = line.match(/^ {4}target_seconds:\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (tsM) {
      curTarget = parseFloat(tsM[1]);
      continue;
    }
  }
  flush();
  return out;
}

export function serializeStoryboardYaml(value: StoryboardValidated): string {
  const lines: string[] = [];
  lines.push(`title: ${quote(value.title)}`);
  lines.push(`full_prompt: ${quote(value.full_prompt)}`);
  if (value.duration_seconds !== undefined) {
    lines.push(`duration_seconds: ${value.duration_seconds}`);
  }
  if (value.clip_seconds !== undefined) {
    lines.push(`clip_seconds: ${value.clip_seconds}`);
  }
  lines.push(`style_prefix: ${quote(value.style_prefix)}`);
  // style_category / style_preset are always emitted (validator forces
  // them to a string, defaulting to the literal "None" the renderer keys
  // its disable path on).
  lines.push(`style_category: ${quote(value.style_category)}`);
  lines.push(`style_preset: ${quote(value.style_preset)}`);
  lines.push(`use_characters: ${emitSlotList(value.use_characters)}`);
  lines.push(`cast_rules: ${quote(value.cast_rules)}`);
  if (value.refs_dir !== undefined) {
    lines.push(`refs_dir: ${quote(value.refs_dir)}`);
  }
  lines.push("scenes:");
  for (const scene of value.scenes) {
    for (const sceneLine of emitScene(scene)) {
      lines.push(sceneLine);
    }
  }
  return lines.join("\n") + "\n";
}
