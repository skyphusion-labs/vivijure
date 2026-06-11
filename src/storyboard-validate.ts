// Storyboard input validator for the planning Worker (v0.27.0).
//
// Pure, synchronous, no I/O. Validates the structural shape of a planner
// output before it is serialized to storyboard.yaml and bundled for the
// vivijure-serverless GPU worker. Slot readiness (registry prompt plus
// >=8 reference images on disk) is checked separately as a pre-flight
// against R2; this validator does not touch the filesystem or network.
//
// Schema source of truth: vivijure-serverless/build/vivijure-src/
// storyboard.example.yaml, plus what orchestrator.build_render_payload
// and core.build_manifest in that repo actually consume. Slot IDs
// ("A", "B", "C", "D") mirror characters.SLOTS in the same repo.
// normalizeProjectName mirrors studio_service.norm_project.
//
// Minimal-dep convention (matches src/env.ts, src/longrun-params.ts):
// hand-authored interfaces, no zod / ajv at runtime, no codegen.

export type SlotId = "A" | "B" | "C" | "D";
export const SLOT_IDS: readonly SlotId[] = ["A", "B", "C", "D"] as const;

const SLOT_SET: ReadonlySet<string> = new Set(SLOT_IDS);

// v0.80.0: content-shape guards that the GPU renderer relies on but the
// structural validator (lines below) historically did not enforce.
// These caps protect downstream paths from LLM Assist outputs that pass
// the structural schema but break renderer constraints. See the audit
// memo for the four gaps these close.
//
// SCENE_PROMPT_MAX_TOKENS: SDXL's CLIP-L and OpenCLIP-G text encoders
// each cap at 77 tokens. Diffusers silently truncates above that. The
// pod's regional path prepends 2-4 trigger tokens + ~10 style_prefix
// tokens, leaving ~60 tokens of scene-prompt budget before truncation
// starts dropping setting clauses. Word-to-token ratio for English in
// the BPE tokenizers SDXL uses is ~1.3 tokens per word, so the word
// count check uses 60 / 1.3 = ~46 words. We round to 50 with a small
// margin and surface the offending scene + word count in the error.
export const SCENE_PROMPT_MAX_WORDS = 50;
// Hard cap on scenes per storyboard. The pod's max_scenes default is
// 100; below 50 is the preflight comfort zone. A 50-scene render with
// Wan I2V at ~30s per shot is already ~25 minutes of GPU time, beyond
// which RunPod's per-job timeout starts mattering more than schema.
export const STORYBOARD_MAX_SCENES = 50;
// Length caps on the two top-level free-text strings the renderer
// reads at manifest-build time. style_prefix is what the pod's 0.4.38
// background_prompt() now leans on - an LLM Assist style_prefix > 256
// chars would itself overflow CLIP 77 even before any scene-prompt
// tokens are added.
export const FULL_PROMPT_MAX_CHARS = 1024;
export const STYLE_PREFIX_MAX_CHARS = 256;
// Scene-id format the renderer expects (core.py shot manifest looks up
// scenes by this id). LLM Assist outputs like "scene_dramatic_sunset"
// silently break downstream tools that expect the shot_NN pattern.
// Coerce rather than reject so the LLM doesn't have to know the format;
// the validator renumbers in declaration order.
const SHOT_ID_RE = /^shot_\d+$/;

function countWords(prompt: string): number {
  return prompt.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

function coerceShotId(rawId: string | undefined, index: number): string {
  const desired = `shot_${String(index + 1).padStart(2, "0")}`;
  if (typeof rawId !== "string") return desired;
  const trimmed = rawId.trim();
  if (trimmed.length === 0) return desired;
  return SHOT_ID_RE.test(trimmed) ? trimmed : desired;
}

// One entry per shot. Only `prompt` is required; the rest flow through
// to core.build_manifest's per-scene reader unchanged.
export interface StoryboardScene {
  id?: string;
  prompt: string;
  character_slots?: SlotId[];
  start?: number;
  end?: number;
  target_seconds?: number;
  act?: string;
  start_image?: string;
}

// Top-level storyboard. Mirrors storyboard.example.yaml. The serverless
// worker does not consume any key not listed here, so this is the full
// authored surface.
export interface StoryboardInput {
  title: string;
  full_prompt?: string;
  duration_seconds?: number;
  clip_seconds?: number;
  style_prefix?: string;
  style_category?: string | null;
  style_preset?: string | null;
  use_characters?: SlotId[];
  cast_rules?: string;
  refs_dir?: string;
  scenes: StoryboardScene[];
}

// Normalized form returned on success. style_category / style_preset are
// forced to the literal string "None" when missing, null, or empty after
// trim (the renderer disables on the string, not on null). projectName
// is the studio_service.norm_project equivalent; safe to use as a
// directory or R2 key segment.
export interface StoryboardValidated {
  title: string;
  projectName: string;
  full_prompt: string;
  duration_seconds: number | undefined;
  clip_seconds: number | undefined;
  style_prefix: string;
  style_category: string;
  style_preset: string;
  use_characters: SlotId[];
  cast_rules: string;
  refs_dir?: string;
  scenes: StoryboardScene[];
}

export type ValidationResult =
  | { ok: true; value: StoryboardValidated }
  | { ok: false; errors: string[] };

// studio_service.norm_project (vivijure-serverless studio_service.py):
//   return (name or "project").strip().replace(" ", "_") or "project"
// Collapses internal whitespace runs (\s+) rather than only literal
// spaces, since YAML parsers can hand us tabs or other whitespace too.
export function normalizeProjectName(title: string | undefined | null): string {
  const raw = typeof title === "string" ? title : "";
  const slug = raw.trim().replace(/\s+/g, "_");
  return slug || "project";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sceneLabel(scene: Record<string, unknown>, index: number): string {
  const id =
    typeof scene.id === "string" && scene.id.trim().length > 0
      ? scene.id.trim()
      : null;
  return id ? `scenes[${index}] (id="${id}")` : `scenes[${index}]`;
}

// missing / null / empty / whitespace-only collapse to "None" (the literal
// string the renderer treats as "no style lookup"). Non-string types
// silently collapse too; the planner's TypeScript types disallow them at
// authoring time, so reaching this branch at runtime is a programmer
// error worth defending against rather than rejecting.
function normalizeStyleNone(value: unknown): string {
  if (typeof value !== "string") return "None";
  const trimmed = value.trim();
  return trimmed.length === 0 ? "None" : value;
}

export function validateStoryboard(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [
        `storyboard must be an object (got ${describeType(input)})`,
      ],
    };
  }

  // ---- title ------------------------------------------------------------
  let title = "";
  let projectName = "project";
  const rawTitle = input.title;
  if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) {
    errors.push("title is required and must be a non-empty string");
  } else {
    title = rawTitle;
    projectName = normalizeProjectName(rawTitle);
  }

  // ---- use_characters ---------------------------------------------------
  const useCharacters: SlotId[] = [];
  if (input.use_characters !== undefined) {
    if (!Array.isArray(input.use_characters)) {
      errors.push(
        `use_characters must be an array of slot ids if provided (got ${describeType(input.use_characters)})`,
      );
    } else {
      const seen = new Set<string>();
      input.use_characters.forEach((slot, i) => {
        if (typeof slot !== "string") {
          errors.push(
            `use_characters[${i}] must be a string (got ${describeType(slot)})`,
          );
          return;
        }
        if (!SLOT_SET.has(slot)) {
          errors.push(
            `use_characters[${i}] = "${slot}" is not a valid slot id (allowed: ${SLOT_IDS.join(", ")})`,
          );
          return;
        }
        if (seen.has(slot)) {
          errors.push(`use_characters[${i}] = "${slot}" is duplicated`);
          return;
        }
        seen.add(slot);
        useCharacters.push(slot as SlotId);
      });
    }
  }

  // ---- scenes -----------------------------------------------------------
  const validatedScenes: StoryboardScene[] = [];
  if (!Array.isArray(input.scenes)) {
    errors.push(
      `scenes is required and must be a non-empty array (got ${describeType(input.scenes)})`,
    );
  } else if (input.scenes.length === 0) {
    errors.push(
      "scenes is required and must be a non-empty array (got empty array)",
    );
  } else if (input.scenes.length > STORYBOARD_MAX_SCENES) {
    // v0.80.0: hard cap on scene count. Preflight warns at 24; this
    // is the firm ceiling. Catches LLM Assist outputs that try to
    // produce a 100-shot epic on a draft pass.
    errors.push(
      `scenes count ${input.scenes.length} exceeds the hard cap of ${STORYBOARD_MAX_SCENES} (preflight warns at 24; consider splitting the storyboard or shortening the duration)`,
    );
  } else {
    input.scenes.forEach((scene, i) => {
      if (!isPlainObject(scene)) {
        errors.push(
          `scenes[${i}] must be an object (got ${describeType(scene)})`,
        );
        return;
      }
      const label = sceneLabel(scene, i);
      const out: StoryboardScene = { prompt: "" };

      // prompt: required, non-empty after trim
      if (
        typeof scene.prompt !== "string" ||
        scene.prompt.trim().length === 0
      ) {
        errors.push(`${label} is missing prompt (must be a non-empty string)`);
      } else {
        out.prompt = scene.prompt;
        // v0.80.0: token-count guard so LLM Assist outputs that
        // overflow SDXL's CLIP 77-token limit get caught here
        // rather than silently truncating at render time. The pod's
        // regional path prepends triggers + style_prefix, leaving
        // ~60 tokens of headroom, ~46 words at 1.3 tokens/word; we
        // cap at 50 with a small margin.
        const wc = countWords(scene.prompt);
        if (wc > SCENE_PROMPT_MAX_WORDS) {
          errors.push(
            `${label} prompt is ${wc} words; cap is ${SCENE_PROMPT_MAX_WORDS} to fit within SDXL CLIP 77 tokens after triggers + style_prefix. Tighten the prompt or move appearance details to the cast bible.`,
          );
        }
      }

      // id: optional; v0.80.0 always coerces to the shot_NN pattern
      // the renderer expects. LLM Assist outputs like
      // "scene_dramatic_sunset" become "shot_NN" in declaration
      // order. A valid scene.id like "shot_07" survives intact.
      // Non-string ids are tolerated (coerced to the default).
      if (scene.id !== undefined && typeof scene.id !== "string") {
        errors.push(
          `${label} id must be a string if provided (got ${describeType(scene.id)})`,
        );
      }
      out.id = coerceShotId(
        typeof scene.id === "string" ? scene.id : undefined,
        i,
      );

      // character_slots: optional array of SlotId, must be subset of useCharacters
      if (scene.character_slots !== undefined) {
        if (!Array.isArray(scene.character_slots)) {
          errors.push(
            `${label} character_slots must be an array if provided (got ${describeType(scene.character_slots)})`,
          );
        } else {
          const slotsOut: SlotId[] = [];
          const seenLocal = new Set<string>();
          scene.character_slots.forEach((slot, j) => {
            if (typeof slot !== "string") {
              errors.push(
                `${label} character_slots[${j}] must be a string (got ${describeType(slot)})`,
              );
              return;
            }
            if (!SLOT_SET.has(slot)) {
              errors.push(
                `${label} character_slots[${j}] = "${slot}" is not a valid slot id (allowed: ${SLOT_IDS.join(", ")})`,
              );
              return;
            }
            if (seenLocal.has(slot)) {
              errors.push(
                `${label} character_slots[${j}] = "${slot}" is duplicated within the scene`,
              );
              return;
            }
            // Subset rule: every per-scene slot must be loaded for the render.
            if (!useCharacters.includes(slot as SlotId)) {
              const loaded =
                useCharacters.length > 0 ? useCharacters.join(", ") : "(none)";
              errors.push(
                `${label} character_slots references slot "${slot}" which is not in use_characters (loaded: ${loaded})`,
              );
              return;
            }
            seenLocal.add(slot);
            slotsOut.push(slot as SlotId);
          });
          out.character_slots = slotsOut;
        }
      }

      // start: optional non-negative number (0.0 is a legal film-time origin)
      if (scene.start !== undefined) {
        if (!isNonNegativeFiniteNumber(scene.start)) {
          errors.push(
            `${label} start must be a non-negative finite number if provided`,
          );
        } else {
          out.start = scene.start;
        }
      }

      // end / target_seconds: optional positive numbers
      for (const key of ["end", "target_seconds"] as const) {
        const v = scene[key];
        if (v !== undefined) {
          if (!isPositiveFiniteNumber(v)) {
            errors.push(
              `${label} ${key} must be a positive finite number if provided`,
            );
          } else {
            out[key] = v;
          }
        }
      }

      // Cross-field: if both start and end are valid, end must be > start.
      if (
        typeof out.start === "number" &&
        typeof out.end === "number" &&
        out.end <= out.start
      ) {
        errors.push(
          `${label} end (${out.end}) must be greater than start (${out.start})`,
        );
      }

      // act / start_image: optional strings
      for (const key of ["act", "start_image"] as const) {
        const v = scene[key];
        if (v !== undefined) {
          if (typeof v !== "string") {
            errors.push(
              `${label} ${key} must be a string if provided (got ${describeType(v)})`,
            );
          } else {
            out[key] = v;
          }
        }
      }

      validatedScenes.push(out);
    });
  }

  // ---- top-level optional fields ---------------------------------------
  let fullPrompt = "";
  if (input.full_prompt !== undefined) {
    if (typeof input.full_prompt !== "string") {
      errors.push(
        `full_prompt must be a string if provided (got ${describeType(input.full_prompt)})`,
      );
    } else if (input.full_prompt.length > FULL_PROMPT_MAX_CHARS) {
      // v0.80.0: cap free-text length so a runaway LLM Assist
      // synopsis can't bloat the manifest. full_prompt is read at
      // manifest-build time on the pod.
      errors.push(
        `full_prompt is ${input.full_prompt.length} chars; cap is ${FULL_PROMPT_MAX_CHARS}`,
      );
    } else {
      fullPrompt = input.full_prompt;
    }
  }

  let stylePrefix = "";
  if (input.style_prefix !== undefined) {
    if (typeof input.style_prefix !== "string") {
      errors.push(
        `style_prefix must be a string if provided (got ${describeType(input.style_prefix)})`,
      );
    } else if (input.style_prefix.length > STYLE_PREFIX_MAX_CHARS) {
      // v0.80.0: style_prefix is what the pod's 0.4.38 background_
      // prompt() builds the bg backplate from; an LLM Assist output
      // over 256 chars would itself overflow CLIP 77 before any
      // scene-prompt tokens are added.
      errors.push(
        `style_prefix is ${input.style_prefix.length} chars; cap is ${STYLE_PREFIX_MAX_CHARS} (the pod's bg-pass uses style_prefix verbatim and SDXL CLIP truncates at 77 tokens)`,
      );
    } else {
      stylePrefix = input.style_prefix;
    }
  }

  let castRules = "";
  if (input.cast_rules !== undefined) {
    if (typeof input.cast_rules !== "string") {
      errors.push(
        `cast_rules must be a string if provided (got ${describeType(input.cast_rules)})`,
      );
    } else {
      castRules = input.cast_rules;
    }
  }

  let durationSeconds: number | undefined;
  if (input.duration_seconds !== undefined) {
    if (!isPositiveFiniteNumber(input.duration_seconds)) {
      errors.push(
        "duration_seconds must be a positive finite number if provided",
      );
    } else {
      durationSeconds = input.duration_seconds;
    }
  }

  let clipSeconds: number | undefined;
  if (input.clip_seconds !== undefined) {
    if (!isPositiveFiniteNumber(input.clip_seconds)) {
      errors.push(
        "clip_seconds must be a positive finite number if provided",
      );
    } else {
      clipSeconds = input.clip_seconds;
    }
  }

  let refsDir: string | undefined;
  if (input.refs_dir !== undefined) {
    if (
      typeof input.refs_dir !== "string" ||
      input.refs_dir.trim().length === 0
    ) {
      errors.push(
        "refs_dir must be a non-empty string if provided",
      );
    } else {
      refsDir = input.refs_dir;
    }
  }

  // None-normalization for the two style fields. The renderer disables on
  // the literal string "None", not on null/undefined, so we collapse to it.
  const styleCategory = normalizeStyleNone(input.style_category);
  const stylePreset = normalizeStyleNone(input.style_preset);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // v0.134.3: backfill each scene's target_seconds when the model omitted the
  // (optional) field, so the planner's scene editor shows an explicit per-shot
  // duration instead of a blank box and the value is explicit downstream (beat
  // snap, YAML, render) rather than relying on a silent fallback. Priority: an
  // explicit start/end span, else the storyboard's clip_seconds (the per-shot
  // default), else an even split of duration_seconds across the scenes. This is
  // the same clip_seconds fallback markers.ts / preflight apply at render time,
  // just materialized into the data. No-op when there's nothing to derive from.
  const perShotFallback =
    typeof clipSeconds === "number" && clipSeconds > 0
      ? clipSeconds
      : typeof durationSeconds === "number" &&
          durationSeconds > 0 &&
          validatedScenes.length > 0
        ? Math.round((durationSeconds / validatedScenes.length) * 100) / 100
        : undefined;
  for (const s of validatedScenes) {
    if (typeof s.target_seconds === "number") continue;
    if (typeof s.start === "number" && typeof s.end === "number" && s.end > s.start) {
      s.target_seconds = Math.round((s.end - s.start) * 100) / 100;
    } else if (perShotFallback !== undefined) {
      s.target_seconds = perShotFallback;
    }
  }

  const value: StoryboardValidated = {
    title,
    projectName,
    full_prompt: fullPrompt,
    duration_seconds: durationSeconds,
    clip_seconds: clipSeconds,
    style_prefix: stylePrefix,
    style_category: styleCategory,
    style_preset: stylePreset,
    use_characters: useCharacters,
    cast_rules: castRules,
    scenes: validatedScenes,
  };
  if (refsDir !== undefined) value.refs_dir = refsDir;
  return { ok: true, value };
}

// v0.147.0: per-shot cloud i2v model overrides for animate-cloud (Phase 4a).
// Maps shot_id -> model id so one cloud animation can mix models across shots
// (e.g. the standoff on Runway, the atmosphere on Seedance). Pure + testable;
// the route supplies `allowedModelIds` (the image-input video catalog) so this
// stays free of the model catalog import. Returns the accepted overrides plus a
// list of human errors; the route 400s when any entry is bad rather than
// silently dropping it (a shot the caller meant to override would otherwise run
// on the default model unnoticed). A missing/empty input is valid (no overrides).
export function normalizePerShotModels(
  raw: unknown,
  allowedModelIds: ReadonlySet<string>,
): { perShot: Record<string, string>; errors: string[] } {
  const perShot: Record<string, string> = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { perShot, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("perShot must be an object mapping shot_id to a model id");
    return { perShot, errors };
  }
  for (const [shotId, modelId] of Object.entries(raw as Record<string, unknown>)) {
    if (!shotId.trim()) continue;
    if (typeof modelId !== "string" || !modelId) {
      errors.push(`perShot["${shotId}"] must be a model id string`);
      continue;
    }
    if (!allowedModelIds.has(modelId)) {
      errors.push(`perShot["${shotId}"] "${modelId}" is not an image-input video model`);
      continue;
    }
    perShot[shotId] = modelId;
  }
  return { perShot, errors };
}

// v0.151.0 (Phase 4 hybrid): per-shot BACKEND assignment for animate-hybrid.
// Maps shot_id -> { backend: "gpu" | "cloud", model? } so one film can route
// some shots to the pod's Wan i2v and others to a cloud i2v model. Pure +
// testable; the route supplies `allowedModelIds` (the image-input video catalog)
// for the cloud model check. A cloud entry may omit `model` (the route's
// defaultCloudModel applies). Bad entries error (route 400s) rather than
// silently dropping. Missing/empty input is valid (route falls back to
// defaultBackend for every shot).
export function normalizeHybridBackends(
  raw: unknown,
  allowedModelIds: ReadonlySet<string>,
): {
  backends: Record<string, { backend: "gpu" | "cloud"; model?: string }>;
  errors: string[];
} {
  const backends: Record<string, { backend: "gpu" | "cloud"; model?: string }> = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { backends, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("backends must be an object mapping shot_id to { backend, model? }");
    return { backends, errors };
  }
  for (const [shotId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!shotId.trim()) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      errors.push(`backends["${shotId}"] must be an object { backend, model? }`);
      continue;
    }
    const backend = (v as { backend?: unknown }).backend;
    if (backend !== "gpu" && backend !== "cloud") {
      errors.push(`backends["${shotId}"].backend must be "gpu" or "cloud"`);
      continue;
    }
    const entry: { backend: "gpu" | "cloud"; model?: string } = { backend };
    if (backend === "cloud") {
      const model = (v as { model?: unknown }).model;
      if (model !== undefined) {
        if (typeof model !== "string" || !allowedModelIds.has(model)) {
          errors.push(
            `backends["${shotId}"].model "${String(model)}" is not an image-input video model`,
          );
          continue;
        }
        entry.model = model;
      }
    }
    backends[shotId] = entry;
  }
  return { backends, errors };
}
