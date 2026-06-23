// Pure cloud-keyframe logic: model/dimension clamps, prompt composition, the R2 key conventions, the
// per-shot render plan, and the async poll token. No I/O here, so it unit-tests without the runtime,
// the AI binding, or model spend.

import type { BundleScene, RegistryCharacter } from "./bundle";
import type { KeyframeShot } from "./contract";

// The image models this module can drive. FLUX-2 klein-9b is the default: cheapest (fixed 4-step),
// fast, identity holds well, and it honors width/height so aspect is controllable. nano-banana-pro is
// the quality-up option (more photoreal, slightly more faithful identity), pricier + slower.
export const MODELS = [
  "@cf/black-forest-labs/flux-2-klein-9b",
  "google/nano-banana-pro",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-dev",
] as const;
export type Model = (typeof MODELS)[number];

export const MIN_DIM = 512;
export const MAX_DIM = 1536;

/** Clamp a model id to one this module drives (default flux-2-klein-9b). */
export function clampModel(v: unknown): Model {
  return (MODELS as readonly string[]).includes(v as string) ? (v as Model) : MODELS[0];
}

/** Clamp a keyframe dimension to the model-safe range, default `fallback`. */
export function clampDim(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, n));
}

/** Clamp refs-per-slot to [1, 4] (FLUX-2's hard input cap), default 1 (the canonical portrait). */
export function clampRefsPerSlot(v: unknown): number {
  const n = Math.round(Number(v) || 1);
  return Math.max(1, Math.min(4, n));
}

/** Compose one shot's gen prompt: the project style_prefix (when set) + the scene prompt + the
 *  identity text of each character in the shot (name + bible, capped). The reference PORTRAIT carries
 *  identity; this text reinforces it, the way cast-image folds the character bible into its prompts. */
export function composePrompt(
  stylePrefix: string,
  scenePrompt: string,
  shotSlots: string[],
  registry: Record<string, RegistryCharacter>,
): string {
  const lead = stylePrefix.trim() ? `${stylePrefix.trim()}. ` : "";
  const ids: string[] = [];
  for (const slot of shotSlots) {
    const c = registry[slot];
    if (!c) continue;
    const bible = c.prompt.trim();
    const capped = bible.length > 300 ? bible.slice(0, 300) : bible;
    const namePart = c.name.trim();
    const piece = [namePart, capped].filter(Boolean).join(": ");
    if (piece) ids.push(piece);
  }
  const idText = ids.length ? ` Featuring ${ids.join("; ")}.` : "";
  return `${lead}${scenePrompt.trim()}${idText}`;
}

// --- R2 key conventions ------------------------------------------------------------------------

/** The R2 key a generated keyframe lands under (the contract: renders/<project>/keyframes/<shot>.png). */
export function keyframeKey(project: string, shotId: string): string {
  return `renders/${project}/keyframes/${shotId}.png`;
}

/** A staged (downscaled) reference portrait for one slot of one job. */
export function stageRefKey(project: string, jobId: string, slot: string, index: number): string {
  return `keyframe-stage/${project}/${jobId}/ref_${slot}_${String(index).padStart(2, "0")}.png`;
}

/** The async run-state doc for a cloud-keyframe job. */
export function stateKey(project: string, jobId: string): string {
  return `keyframe-stage/${project}/${jobId}.state.json`;
}

// --- render plan + run state -------------------------------------------------------------------

/** One shot to render: its composed prompt + the slots whose staged refs condition it. */
export interface ShotPlan {
  shot_id: string;
  prompt: string;
  slots: string[];
}

/** The persisted run state (an R2 json doc), advanced one shot at a time per /poll. */
export interface CloudKeyframeState {
  project: string;
  job_id: string;
  model: Model;
  width: number;
  height: number;
  /** slot -> staged (downscaled) ref portrait R2 keys this run conditions on. */
  slot_refs: Record<string, string[]>;
  shots: ShotPlan[];      // remaining shots to render
  done: KeyframeShot[];   // keyframes rendered + stored so far
  total: number;          // how many were requested (for progress)
}

/** Select the scenes to render: the requested subset (`shot_ids`) or every scene in the bundle. */
export function selectScenes(scenes: BundleScene[], shotIds?: string[]): BundleScene[] {
  if (!shotIds || shotIds.length === 0) return scenes;
  const want = new Set(shotIds.filter((s) => typeof s === "string" && s.length > 0));
  return scenes.filter((s) => want.has(s.shot_id));
}

/** The distinct character slots referenced across a set of scenes (for staging refs once). */
export function usedSlots(scenes: BundleScene[]): string[] {
  const set = new Set<string>();
  for (const s of scenes) for (const slot of s.slots) set.add(slot);
  return [...set].sort();
}

// --- async poll token (a stable pointer; the state lives in R2) --------------------------------

export interface PollToken {
  project: string;
  job_id: string;
}

export function encodePoll(t: PollToken): string {
  return btoa(JSON.stringify(t));
}

export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.project === "string" && typeof o.job_id === "string") {
      return { project: o.project, job_id: o.job_id };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Map a finished run's state into the hook's KeyframeOutput. */
export function readOutput(state: CloudKeyframeState): { project: string; keyframes: KeyframeShot[] } {
  return { project: state.project, keyframes: state.done };
}
