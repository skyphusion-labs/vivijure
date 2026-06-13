// Pre-render preflight (v0.54.0).
//
// Pure checks over a validated storyboard plus optional context (bundle
// key, audio key, cast bindings). The Worker route in src/index.ts adds
// the R2 HEAD checks (bundle / audio existence) on top; this module
// owns the "is the storyboard shape itself ready to render?" decision
// so vitest can cover it without env.
//
// Issue model: each finding is one entry with a level (error / warning
// / info), a scope tag for the UI to group on, and a human-readable
// message. Errors must be resolved before render (the UI gates the
// submit button); warnings are advisory.

export type PreflightLevel = "error" | "warning" | "info";

export interface PreflightIssue {
  level: PreflightLevel;
  scope: string;
  message: string;
}

interface SceneLike {
  id?: string;
  prompt?: string;
  character_slots?: string[];
  target_seconds?: number;
  act?: string;
}

interface StoryboardLike {
  title?: string;
  use_characters?: string[];
  clip_seconds?: number;
  scenes?: SceneLike[];
}

interface CastMemberLike {
  id: number;
  name: string;
  portrait_key?: string | null;
  ref_keys?: Array<{ key: string }>;
}

// A storyboard is considered "renderable" when every scene has a prompt,
// every referenced character slot is loaded, and no scene is
// pathologically short (which usually means the user forgot to set
// target_seconds and is leaning on the clip_seconds default).
export function checkStoryboardShape(storyboard: StoryboardLike): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const loadedSlots = new Set(
    Array.isArray(storyboard.use_characters) ? storyboard.use_characters : [],
  );

  if (scenes.length === 0) {
    issues.push({ level: "error", scope: "scenes", message: "storyboard has no scenes" });
    return issues;
  }

  if (scenes.length > 24) {
    issues.push({
      level: "warning",
      scope: "scenes",
      message: `${scenes.length} scenes is a lot for one render; consider splitting (>15 min Wan I2V time)`,
    });
  }

  scenes.forEach((scene, idx) => {
    const sid = scene.id || `scene_${(idx + 1).toString().padStart(2, "0")}`;
    const scope = `scene[${sid}]`;
    if (!scene.prompt || !scene.prompt.trim()) {
      issues.push({ level: "error", scope, message: `${sid} has an empty prompt` });
    } else if (scene.prompt.trim().length < 8) {
      issues.push({
        level: "warning",
        scope,
        message: `${sid} prompt is very short (${scene.prompt.trim().length} chars); the keyframe model may underspecify`,
      });
    }
    if (Array.isArray(scene.character_slots)) {
      for (const slot of scene.character_slots) {
        if (!loadedSlots.has(slot)) {
          issues.push({
            level: "error",
            scope,
            message: `${sid} references slot "${slot}" which is not in use_characters`,
          });
        }
      }
    }
    if (typeof scene.target_seconds === "number") {
      if (scene.target_seconds <= 0) {
        issues.push({
          level: "error",
          scope,
          message: `${sid} has target_seconds <= 0 (got ${scene.target_seconds})`,
        });
      } else if (scene.target_seconds < 1.5) {
        issues.push({
          level: "warning",
          scope,
          message: `${sid} target_seconds is ${scene.target_seconds}s; Wan I2V default minimum is ~1.5s`,
        });
      } else if (scene.target_seconds > 12) {
        issues.push({
          level: "warning",
          scope,
          message: `${sid} target_seconds is ${scene.target_seconds}s; long clips often look static`,
        });
      }
    }
  });

  return issues;
}

// Cast-binding readiness. If a slot was bound to a persisted cast
// member at plan time (planState.castBindings on the planner), the
// member needs a portrait (used as the SDXL start image) and a
// non-empty reference set (used by LoRA training). Both missing =
// error; portrait present but refs sparse = warning.
export function checkCastBindingsReady(
  bindings: Record<string, number> | null | undefined,
  catalog: CastMemberLike[],
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  if (!bindings) return issues;
  const byId = new Map<number, CastMemberLike>(catalog.map((c) => [c.id, c]));
  for (const slot of Object.keys(bindings)) {
    const id = bindings[slot];
    const member = byId.get(id);
    const scope = `cast[${slot}]`;
    if (!member) {
      issues.push({
        level: "error",
        scope,
        message: `slot ${slot} is bound to cast id ${id} which no longer exists`,
      });
      continue;
    }
    const refCount = member.ref_keys?.length ?? 0;
    if (!member.portrait_key) {
      issues.push({
        level: "error",
        scope,
        message: `${member.name} (slot ${slot}) has no portrait; render will fail at the SDXL keyframe stage`,
      });
    }
    if (refCount === 0) {
      issues.push({
        level: "error",
        scope,
        message: `${member.name} (slot ${slot}) has no training refs; LoRA training will fail`,
      });
    } else if (refCount < 4) {
      issues.push({
        level: "warning",
        scope,
        message: `${member.name} (slot ${slot}) has only ${refCount} training refs; 4-8 is recommended for stable LoRAs`,
      });
    }
  }
  return issues;
}

export interface PreflightResult {
  ok: boolean;
  counts: { error: number; warning: number; info: number };
  issues: PreflightIssue[];
}

export function summarize(issues: PreflightIssue[]): PreflightResult {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.level]++;
  return {
    ok: counts.error === 0,
    counts,
    issues,
  };
}
