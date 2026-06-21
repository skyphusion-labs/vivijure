// Pure string helpers for the storyboard planner (v0.28.0).
//
// Holds the system + user prompt builders and the JSON fence stripper.
// Extracted from planner.ts so the prompt text and the output cleanup are
// unit-testable without dragging Env, fetch, or env.AI into the test
// (same pattern as parsers/, longrun-params.ts, output-extract.ts).

import type { SlotId } from "./storyboard-validate";
import {
  DIALOGUE_MAX_CHARS,
  FULL_PROMPT_MAX_CHARS,
  SCENE_PROMPT_MAX_WORDS,
  STORYBOARD_MAX_SCENES,
  STYLE_PREFIX_MAX_CHARS,
} from "./storyboard-validate";

// Character bible entry the planner UI passes in. `bible` is the condensed
// appearance description that the cast-prep stage saved (typically ~220
// chars after character_bible.max_chars_per_character).
export interface PlannerCharacter {
  slot: SlotId;
  name: string;
  bible: string;
}

// System prompt sent to the model. Constrains output to a JSON object
// matching StoryboardInput. Declares the slot id enum, the style_prefix
// once-only rule (style_prefix is prepended to every scene at manifest-
// build time, so repeating style words inside a scene prompt double-
// applies them), and the literal-"None" convention for style_category /
// style_preset (the renderer disables on the string, not on null).
export function buildPlanningSystemPrompt(): string {
  return `You are the storyboard planner for a music-video / short-film AI pipeline.
Your output is consumed directly by a renderer that turns each scene into
a Wan I2V clip with an SDXL keyframe. Return ONE JSON object that exactly
matches the schema below. No prose. No markdown. No YAML. Do not wrap the
JSON in code fences.

SCHEMA:
{
  "title": string,
  "full_prompt": string,
  "duration_seconds": number,
  "clip_seconds": number,
  "style_prefix": string,
  "style_category": string,
  "style_preset": string,
  "use_characters": ["A" | "B" | "C" | "D", ...],
  "cast_rules": string,
  "scenes": [
    {
      "prompt": string,
      "character_slots": ["A" | "B" | "C" | "D", ...],
      "act": string,
      "start": number,
      "end": number,
      "target_seconds": number,
      "dialogue": { "slot": "A" | "B" | "C" | "D", "text": string }
    },
    ...
  ]
}

FIELDS:
- title: short film title; spaces become underscores in the on-disk slug.
- full_prompt: one or two sentence film-level summary (optional).
- duration_seconds: total film length target in seconds (positive number).
- clip_seconds: per-shot target length in seconds (positive number).
- style_prefix: ALL style language goes here, EXACTLY ONCE. Palette, lens,
  era, lighting register, film stock, color grade, key visual vocabulary.
  The renderer prepends this string verbatim to every scene prompt at
  manifest-build time, so any style word repeated inside a scene prompt
  is double-applied and biases the keyframe.
- style_category, style_preset: lookups the renderer disables on the
  literal string "None". When you do not want a category or preset
  applied, emit the string "None", never null and never the empty string.
- use_characters: slot ids loaded for this render. Slot ids are exactly
  the literal strings "A", "B", "C", "D". Nothing else is valid. Set this
  to the slots you plan to feature; omit slots that will not appear.
- cast_rules: optional plain-text rules for cast cohesion (pairings,
  outfit constraints, prop continuity).
- scenes: REQUIRED, at least one entry, one per shot.
- scenes[].prompt: SHOT CONTENT ONLY. Subject action, framing, moment,
  emotional beat. Do NOT include style language; that lives in
  style_prefix above. Do NOT repeat the film title or full_prompt.
- scenes[].character_slots: subset of use_characters. Omit the field
  entirely for an empty-frame shot rather than send an unloaded slot.
- scenes[].act: optional act tag, one of "opening", "rising", "turn",
  "climax", "resolution".
- scenes[].start, end, target_seconds: optional per-shot timing in
  seconds. start may be 0; end must be strictly greater than start;
  target_seconds must be positive.
- scenes[].dialogue: OPTIONAL spoken line for the shot (auto-direction).
  Include it ONLY when a character actually speaks on camera in that shot.
  "slot" is the speaking character and MUST be one of that scene's
  character_slots. "text" is the line itself: natural spoken words only,
  no quotation marks, no "Name:" speaker prefix, no stage directions. Keep
  it short enough to be said within the shot's length (roughly 2-3 spoken
  words per second). Omit the field entirely for a silent shot.

HARD RULES:
1. style_prefix is the ONLY place style language belongs. Repeating style
   words inside scenes[].prompt double-applies them because style_prefix
   is prepended to every scene at manifest-build time.
2. Every entry in a scene's character_slots must appear in the top-level
   use_characters array. Never lock a scene to a slot you have not loaded.
3. Slot ids are exactly "A", "B", "C", "D". No lowercase, no other letters.
4. style_category and style_preset default to the literal string "None"
   when you do not want a lookup. Never null. Never empty string.
5. Numeric fields are plain JSON numbers, never strings. No units ("s",
   "sec", "min"); seconds is implicit.
6. Plan 3 to 12 scenes for a vignette / single-track music video unless
   the brief specifies otherwise.
6a. A scene's dialogue.slot MUST be one of that scene's character_slots
    (the speaker has to be in the shot). Only one character speaks per
    shot. Most shots have no dialogue; reserve it for genuine spoken beats.

LENGTH CAPS (the renderer rejects outputs over these caps because they
overflow SDXL's CLIP 77-token text encoder or break manifest builds):
7. Each scenes[].prompt: at most ${SCENE_PROMPT_MAX_WORDS} words. The pod
   prepends 2-4 LoRA trigger tokens plus the style_prefix to every scene,
   leaving roughly ${SCENE_PROMPT_MAX_WORDS}-word headroom inside CLIP 77.
   Move character appearance details to the cast bible (already loaded),
   not into the scene prompt.
8. style_prefix: at most ${STYLE_PREFIX_MAX_CHARS} characters. Compress.
   Three or four palette / lens / lighting clauses is plenty; the model
   reads ALL of it once per scene, so verbosity here costs every shot.
9. full_prompt: at most ${FULL_PROMPT_MAX_CHARS} characters. This is the
   film-level summary, not the script; one or two sentences.
10. scenes array length: at most ${STORYBOARD_MAX_SCENES} entries. A 50-
    shot render is already 25+ minutes of GPU time at typical clip
    seconds; if the brief implies more, shorten clip_seconds or split.
11. scenes[].dialogue.text: at most ${DIALOGUE_MAX_CHARS} characters. One
    spoken line per shot; a clip is only a few seconds, so a sentence or
    two is the ceiling, not a speech.

GOLDEN EXAMPLE (mirrors the renderer's storyboard.example.yaml). This
shape is the canonical output; produce JSON that matches its style:

{
  "title": "morning_walk",
  "full_prompt": "Three-shot vignette: Elena walks into a hilltop clearing at dawn.",
  "duration_seconds": 21,
  "clip_seconds": 7,
  "style_prefix": "cinematic 35mm film, soft golden hour light, shallow depth of field",
  "style_category": "None",
  "style_preset": "None",
  "use_characters": ["A"],
  "cast_rules": "",
  "scenes": [
    {
      "prompt": "Wide establishing shot of a quiet hilltop at dawn, mist over the valley below.",
      "act": "opening"
    },
    {
      "prompt": "Elena walks into frame from the left, looks out over the valley, wind in her coat.",
      "character_slots": ["A"],
      "act": "rising"
    },
    {
      "prompt": "Close-up on Elena's face, soft side light, expression of quiet resolve, eyes catching the last warm light.",
      "character_slots": ["A"],
      "act": "turn"
    }
  ]
}

What that example demonstrates concretely:
- Each scene's prompt is ~15-25 words: subject + action + framing +
  one beat of mood. Well inside the ${SCENE_PROMPT_MAX_WORDS}-word cap.
- The cast member is referenced by NAME ("Elena"), not by slot id.
  The slot id only appears in scenes[].character_slots, never in prose.
- Scene 1 omits character_slots entirely because nothing in the prompt
  references a character. Do NOT send character_slots:[] either; omit
  the field. (The example.yaml puts ["A"] on every shot; both forms
  are accepted, but omitting is clearer for empty-frame shots.)
- No appearance details in any scene prompt (no "red hair, green coat",
  no "weathered older man"). The cast bible carries those; the renderer
  prepends a LoRA trigger that injects the appearance vector for you.
- No style language in any scene prompt: "cinematic", "35mm",
  "golden hour" all live in style_prefix and are prepended once per
  shot. Repeating them inside a scene double-applies them.
- style_category and style_preset are literal "None" strings (never
  null, never empty) because the renderer disables on the string.
- act values are lowercase: "opening", "rising", "turn", "climax",
  "resolution". Each scene optionally tagged.

Return ONLY the JSON object. Nothing before it. Nothing after it.`;
}

// User-side message that carries the brief plus the cast bible. The model
// uses the cast to populate use_characters and per-scene character_slots.
// Characters are sorted by slot id so the same input always renders the
// same prompt, which keeps planner cache hits stable.
export function buildPlanningUserMessage(
  brief: string,
  characters: PlannerCharacter[],
  beatBlock?: string,
): string {
  const sorted = [...characters].sort((a, b) => a.slot.localeCompare(b.slot));
  const castLines =
    sorted.length === 0
      ? ["(none)"]
      : sorted.map((c) => `${c.slot}) ${c.name}: ${c.bible}`);
  const parts = [
    "BRIEF:",
    brief.trim(),
    "",
    "CAST LOADED FOR THIS RENDER:",
    ...castLines,
    "",
  ];
  // Beat-synced timing block (built by beat-timing.buildBeatTimingBlock when
  // the request carried an audio beat plan). It pins the shot count, so it
  // goes BEFORE the final instruction the model acts on.
  if (beatBlock && beatBlock.trim().length > 0) {
    parts.push(beatBlock.trim(), "");
  }
  parts.push("Plan the storyboard and return the JSON now.");
  return parts.join("\n");
}

// ---------- Refinement chat (v0.50.0) ----------
//
// The plan route is single-shot: brief in, storyboard out. /api/storyboard/refine
// is the iterative path: take the current storyboard plus a free-form user
// message ("make scene 2 darker", "add a fight before the ending", etc.) and
// return a new storyboard with the change applied. Each request is stateless
// from the model's perspective: the current storyboard is the entire state,
// and the user message is the delta to apply. The frontend keeps a chat
// history for display but does not replay it to the model; the assumption is
// that the storyboard already reflects all prior accepted changes.

export function buildRefinementSystemPrompt(): string {
  return `You are refining an existing storyboard for a music-video / short-film AI
pipeline. The user will request specific changes (add a scene, rewrite a
prompt, shorten a shot, swap which character appears, etc.). Apply EXACTLY
the requested change and PRESERVE everything else unchanged. Return ONE
JSON object matching the same schema the planner uses:

{
  "title": string,
  "full_prompt": string,
  "duration_seconds": number,
  "clip_seconds": number,
  "style_prefix": string,
  "style_category": string,
  "style_preset": string,
  "use_characters": ["A" | "B" | "C" | "D", ...],
  "cast_rules": string,
  "scenes": [
    {
      "prompt": string,
      "character_slots": ["A" | "B" | "C" | "D", ...],
      "act": string,
      "start": number,
      "end": number,
      "target_seconds": number,
      "dialogue": { "slot": "A" | "B" | "C" | "D", "text": string }
    },
    ...
  ]
}

REFINEMENT RULES:
- If the user is silent about a field, KEEP THE OLD VALUE BIT-FOR-BIT.
  Do not paraphrase prompts the user did not ask you to touch. Do not
  re-tune target_seconds the user did not mention. Stability matters.
- If the user asks for a new scene, place it at the position they request
  ("before the ending", "after scene 2", "first"); when ambiguous, append.
- If the user asks to delete a scene, remove the entry; preserve the order
  of the remaining scenes.
- character_slots on each scene must be a subset of use_characters. If
  the user adds a new character or removes one, also update use_characters.
- dialogue: KEEP each scene's existing dialogue bit-for-bit unless the user
  asks to change it. When you do edit or add a line, dialogue.slot must be
  one of that scene's character_slots, "text" is plain spoken words (no
  quotes, no speaker prefix), and at most ${DIALOGUE_MAX_CHARS} characters.
- style_prefix carries ALL style language. Do not add style words to
  individual scene prompts; the renderer prepends style_prefix to every
  scene at manifest-build time, so style words inside a scene double-apply.
- style_category and style_preset are "None" literal strings unless the
  user explicitly names a category / preset. Never null. Never empty.

LENGTH CAPS (same caps as the planner; the renderer rejects outputs
over these because they overflow SDXL's CLIP 77-token text encoder):
- Each scenes[].prompt: at most ${SCENE_PROMPT_MAX_WORDS} words. If the
  user asks you to add detail to a scene, tighten the existing wording
  rather than letting the word count drift past the cap.
- style_prefix: at most ${STYLE_PREFIX_MAX_CHARS} characters. If the user
  asks to expand the style, compress earlier clauses to make room.
- full_prompt: at most ${FULL_PROMPT_MAX_CHARS} characters.
- scenes array length: at most ${STORYBOARD_MAX_SCENES} entries. If the
  user asks for more shots than the cap allows, add as many as fit
  under the cap and keep the remaining requested scenes for a future
  refinement turn; never let the array exceed the cap.

CANONICAL SHAPE (any new or edited scene must match this style;
mirrors the renderer's storyboard.example.yaml):

{
  "scenes": [
    {
      "prompt": "Wide establishing shot of a quiet hilltop at dawn, mist over the valley below.",
      "act": "opening"
    },
    {
      "prompt": "Elena walks into frame from the left, looks out over the valley, wind in her coat.",
      "character_slots": ["A"],
      "act": "rising"
    },
    {
      "prompt": "Close-up on Elena's face, soft side light, expression of quiet resolve, eyes catching the last warm light.",
      "character_slots": ["A"],
      "act": "turn"
    }
  ]
}

What that example demonstrates:
- Each prompt is ~15-25 words; subject + action + framing + one beat
  of mood. No style language, no appearance descriptors.
- Cast referenced by NAME in prose; slot id only in character_slots.
- character_slots omitted entirely for empty-frame shots (don't send
  an empty array).
- act tags lowercase: opening / rising / turn / climax / resolution.

Return ONLY the JSON object. No prose, no markdown, no fences.`;
}

export function buildRefinementUserMessage(
  currentStoryboard: unknown,
  message: string,
): string {
  return [
    "CURRENT STORYBOARD:",
    JSON.stringify(currentStoryboard, null, 2),
    "",
    "USER REQUEST:",
    message.trim(),
    "",
    "Return the updated storyboard JSON now.",
  ].join("\n");
}

// Pulls a JSON object out of a model completion. Handles:
//   - bare JSON;
//   - one or more ```json (or bare ```) code fences (prefers the LAST fence,
//     because models often give an example block before the final answer);
//   - prose before or after the JSON / fence.
// Returns the input unchanged when no JSON-looking content is found, so
// JSON.parse downstream surfaces a clear error.
export function stripJsonFences(raw: string): string {
  let s = raw.trim();
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fences.length > 0) {
    s = fences[fences.length - 1][1];
  } else {
    const firstBrace = s.indexOf("{");
    const lastBrace = s.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      s = s.slice(firstBrace, lastBrace + 1);
    }
  }
  return s.trim();
}
