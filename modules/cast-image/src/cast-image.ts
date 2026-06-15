// Pure cast-image logic: the training-prompt set, prompt composition, the async progress token, and
// output mapping. No I/O here -- unit-tests without the runtime or model spend. Lifted from the
// browser-side generator in public/cast.js (generateTrainingSet) so the studio path matches it
// exactly, then moved server-side as a module so it is swappable and no longer blocks the page.

import type { CastImageOutput } from "./contract";

// The 10 orthogonal training prompts: diverse framing / angle / lighting / expression / pose so the
// LoRA learns IDENTITY independent of any single framing (lifted verbatim from cast.js TRAINING_PROMPTS).
export const TRAINING_PROMPTS: readonly string[] = [
  "close-up portrait, neutral expression, eye level, soft studio lighting, clean grey background",
  "medium shot, three-quarter angle, looking forward, golden-hour outdoor lighting, blurred natural background",
  "full-body shot, standing pose, hands at sides, even daylight, plain neutral indoor space",
  "profile shot looking left, shoulders-up framing, soft window light from the side, plain wall background",
  "three-quarter shot from slightly above, looking down, warm interior lighting, soft bokeh background",
  "medium close-up, slight smile, looking off to the right, overcast natural daylight, outdoor blurred treeline",
  "close-up portrait, serious expression, looking at camera, dramatic side lighting from the right, dark backdrop",
  "medium shot, dynamic mid-action pose, looking forward, harsh midday sunlight, plain background",
  "three-quarter shot, sitting on a stool, looking thoughtfully to the side, warm indoor lamp lighting, plain dark background",
  "close-up portrait, slight head tilt, looking up at the camera, soft natural window light, plain background",
];

// The image-gen model that over-flags least on stylized characters; the generator falls back to it
// once when the primary model exhausts its safety-flag retries (lifted from cast.js FLAG_FALLBACK_MODEL).
export const FLAG_FALLBACK_MODEL = "google/nano-banana-pro";

/** A safety-flag error from the image model (vs a real failure) -- worth a retry / fallback, not an
 *  abort. Lifted from cast.js isFlaggedError. */
export function isFlaggedError(msg: unknown): boolean {
  const s = String(msg || "").toLowerCase();
  return s.includes("3030") || s.includes("has been flagged") || s.includes("choose another prompt");
}

/** Build one training prompt: an explicit art-style lead (when set) + the pose template + the bible
 *  (capped so the joined prompt stays under the gateway limit). Lifted verbatim from cast.js
 *  composeTrainingPrompt -- stating the style outright is what makes a stylized portrait yield
 *  on-style refs (a "match the reference image" instruction does NOT, verified in cast.js). Pure. */
export function composeTrainingPrompt(template: string, bible?: string, style?: string): string {
  const safeStyle = String(style || "").trim();
  const lead = safeStyle ? `${safeStyle} art style, ${safeStyle} illustration. ` : "";
  const safeBible = String(bible || "").trim();
  if (!safeBible) return lead + template;
  const trimmed = safeBible.length > 600 ? safeBible.slice(0, 600) : safeBible;
  return `${lead}${template}. ${trimmed}`;
}

/** How many images to generate, clamped sane: >= 4 (the LoRA-training floor enforced in cast.js) and
 *  <= the prompt set. Default 10 (the full diverse set). */
export function clampNumImages(n: unknown): number {
  const v = Math.round(Number(n) || 10);
  return Math.max(4, Math.min(TRAINING_PROMPTS.length, v));
}

/** The R2 key a generated reference image is stored under, per cast member + index. The core
 *  registers these onto the cast member's ref set after the run completes. */
export function refKey(castId: number, index: number, ext: string): string {
  const safeExt = /^(png|jpg|jpeg|webp)$/i.test(String(ext)) ? ext.toLowerCase() : "png";
  return `cast-gen/${castId}/ref_${String(index).padStart(2, "0")}.${safeExt}`;
}

// --- async run: R2-backed state + a stable poll token -------------------------------------------
// cast.image renders N images, a FEW per /poll cycle (each gen is a bounded Worker request -- a
// 10-image batch can't finish inside one /invoke). PollResponse carries no updated token, so the run
// STATE cannot live in the token; it lives in R2 (a state doc) and the token is a stable pointer the
// caller round-trips unchanged. /invoke writes the initial state; each /poll loads it, renders the
// next prompt(s), writes it back, and returns pending until `prompts` is empty.

/** The persisted run state (an R2 json doc), advanced one /poll at a time. */
export interface CastImageState {
  cast_id: number;
  model: string;
  fallback_used: boolean;
  prompts: string[];                        // composed prompts still to render
  done: { key: string; mime: string }[];    // images rendered + stored so far
  total: number;                            // how many were requested (for progress)
  ref_urls: string[];                       // presigned portrait + source URLs the gen conditions on
}

/** The stable poll pointer: which cast + which run. The caller round-trips this unchanged; the state
 *  it points at lives in R2 and advances per poll. */
export interface PollToken {
  cast_id: number;
  job_id: string;
}

export function encodePoll(t: PollToken): string {
  return btoa(JSON.stringify(t));
}
export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.cast_id === "number" && typeof o.job_id === "string") return { cast_id: o.cast_id, job_id: o.job_id };
  } catch {
    /* fall through */
  }
  return null;
}

/** R2 key of the run-state doc for a cast-image job. */
export function stateKey(castId: number, jobId: string): string {
  return `cast-gen/${castId}/${jobId}.state.json`;
}

/** Build the initial run state from the hook input + chosen model + count: one composed prompt per
 *  template (up to `num`), each carrying the bible + art-style. Pure. */
export function buildState(
  input: { cast_id: number; portrait_url: string; source_urls?: string[]; bible?: string; art_style?: string },
  model: string,
  num: number,
): CastImageState {
  const n = clampNumImages(num);
  const prompts = TRAINING_PROMPTS.slice(0, n).map((t) => composeTrainingPrompt(t, input.bible, input.art_style));
  const ref_urls = [input.portrait_url, ...(input.source_urls || [])].filter(Boolean);
  return { cast_id: input.cast_id, model, fallback_used: false, prompts, done: [], total: n, ref_urls };
}

/** Map a finished run's state into the hook's CastImageOutput. */
export function readOutput(state: CastImageState): CastImageOutput {
  return {
    cast_id: state.cast_id,
    images: state.done,
    applied: [
      `model:${state.model}${state.fallback_used ? "+nano-banana-fallback" : ""}`,
      `generated:${state.done.length}`,
    ],
  };
}
