// Pure plan.enhance logic: build the director prompt, parse the model's reply, and merge the
// enhanced prompts back into the storyboard. No I/O here, so it unit-tests without the AI binding.

import type { PlanEnhanceScene, PlanEnhanceStoryboard } from "./contract";

export type Intensity = "light" | "medium" | "bold";

const INTENSITY_GUIDE: Record<Intensity, string> = {
  light:
    "Add a light touch of cinematic direction: one concrete camera or lighting detail per shot. Stay close to the original.",
  medium:
    "Add clear cinematic direction: camera framing or movement, lens feel, and lighting or mood, in a natural sentence or two per shot.",
  bold:
    "Direct each shot vividly: camera framing and movement, lens, lighting, mood, and a sense of motion, while keeping the original subject and action.",
};

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Build the chat messages for one enhancement pass over all scene prompts. The model is asked to
 *  return ONLY a JSON array of N rewritten prompts: same order, same length. */
export function buildMessages(prompts: string[], intensity: Intensity): ChatMessage[] {
  const guide = INTENSITY_GUIDE[intensity] ?? INTENSITY_GUIDE.medium;
  const numbered = prompts.map((p, i) => `${i + 1}. ${p}`).join("\n");
  return [
    {
      role: "system",
      content:
        "You are a film director doing a pass over a storyboard's shot descriptions. " +
        guide +
        " Preserve each shot's subject, action, and meaning; do not add or remove shots; do not change who appears. " +
        "Reply with ONLY a JSON array of strings: the rewritten shot descriptions, in the same order, the same length as the input. No prose, no keys, no markdown fences.",
    },
    { role: "user", content: `Rewrite these ${prompts.length} shot descriptions:\n${numbered}` },
  ];
}

/** A clean JSON array of exactly `n` non-empty strings, or null. Tolerates a code fence and
 *  surrounding prose (extracts the first [ to the last ]). */
function tryJsonArray(raw: string, n: number): string[] | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length !== n) return null;
  if (!arr.every((x) => typeof x === "string" && (x as string).trim().length > 0)) return null;
  return (arr as string[]).map((x) => x.trim());
}

/** Fallback for the shape models love when they ignore "JSON only": a numbered or bulleted list
 *  ("1. ...", "1) ...", "- ...", "* ..."). Returns the N item texts (quotes stripped) iff exactly N
 *  list items are present, so a stray preamble/postamble line does not corrupt the mapping. */
function tryNumberedList(raw: string, n: number): string[] | null {
  const items: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/);
    if (m) items.push(m[1].replace(/^["']|["']$/g, "").trim());
  }
  if (items.length !== n || !items.every((x) => x.length > 0)) return null;
  return items;
}

/** Parse the model's reply into exactly `n` rewritten prompts, or null. Accepts a clean JSON array
 *  first, then falls back to a numbered/bulleted list. */
export function parseEnhanced(raw: unknown, n: number): string[] | null {
  // Some Workers AI models return `response` already as a string array, not a JSON string.
  if (Array.isArray(raw)) {
    if (raw.length === n && raw.every((x) => typeof x === "string" && (x as string).trim().length > 0)) {
      return (raw as string[]).map((x) => x.trim());
    }
    return null;
  }
  if (typeof raw !== "string") return null;
  return tryJsonArray(raw, n) ?? tryNumberedList(raw, n);
}

/** Merge enhanced prompts back into a storyboard, preserving every other field on the storyboard and
 *  on each scene. Returns a new object (no mutation). */
export function mergeEnhanced(
  storyboard: PlanEnhanceStoryboard,
  enhanced: string[],
): PlanEnhanceStoryboard {
  const scenes: PlanEnhanceScene[] = storyboard.scenes.map((scene, i) =>
    typeof enhanced[i] === "string" ? { ...scene, prompt: enhanced[i] } : scene,
  );
  return { ...storyboard, scenes };
}

/** The scene prompts to enhance, or null when there is nothing to do (no scenes). Missing prompts
 *  coerce to empty strings so the array length always matches scenes.length. */
export function scenePrompts(storyboard: PlanEnhanceStoryboard): string[] | null {
  if (!storyboard || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) return null;
  return storyboard.scenes.map((s) => (typeof s.prompt === "string" ? s.prompt : ""));
}
