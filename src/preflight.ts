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
  // #454: the keyframe-stage backend display token (the route resolves it from the module registry;
  // default "SDXL" keeps the pure-function callers and their tests backend-agnostic).
  keyframeLabel = "SDXL",
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
        message: `${member.name} (slot ${slot}) has no portrait; render will fail at the ${keyframeLabel} keyframe stage`,
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

// Cast-binding id resolution (#576).
//
// The public API projects a cast member's UUID as its `id` (see toPublicCast in
// cast-db.ts), but checkCastBindingsReady above keys on the INTERNAL numeric row
// id. A castBindings value can therefore arrive in three honest forms: the UUID
// the API handed the client, the numeric row id, or a numeric string of one. The
// preflight ROUTE calls this resolver first so the numeric-keyed pure check stays
// dependency-free while an agent/MCP client can bind a slot with the id it was
// actually given. Anything that resolves feeds checkCastBindingsReady; anything
// that does not becomes a preflight error here, with a message that distinguishes
// an unknown id (looked up, not found) from a wrong id kind (not a usable id at all).

// The catalog subset the resolver needs: the numeric row id and the public UUID it
// is exposed as. CastMember (cast-db.ts) is a structural superset of this.
interface CastIdRow {
  id: number;
  public_id?: string | null;
}

export interface ResolvedCastBindings {
  // Slots resolved to a numeric row id -- feed this straight to checkCastBindingsReady.
  resolved: Record<string, number>;
  // Slots whose value could not be resolved, already shaped as preflight error issues.
  unresolved: PreflightIssue[];
}

export function resolveCastBindings(
  bindings: Record<string, unknown> | null | undefined,
  catalog: CastIdRow[],
): ResolvedCastBindings {
  const resolved: Record<string, number> = {};
  const unresolved: PreflightIssue[] = [];
  if (!bindings) return { resolved, unresolved };

  const byNumericId = new Map<number, CastIdRow>(catalog.map((c) => [c.id, c]));
  const byPublicId = new Map<string, CastIdRow>();
  for (const c of catalog) {
    if (typeof c.public_id === "string" && c.public_id) byPublicId.set(c.public_id, c);
  }

  for (const slot of Object.keys(bindings)) {
    const value = bindings[slot];
    const scope = `cast[${slot}]`;

    // Numeric row id, or the numeric-string form of one.
    if (typeof value === "number" || (typeof value === "string" && /^[0-9]+$/.test(value))) {
      const numeric = typeof value === "number" ? value : Number(value);
      if (byNumericId.has(numeric)) {
        resolved[slot] = numeric;
      } else {
        unresolved.push({
          level: "error",
          scope,
          message: `slot ${slot} is bound to unknown cast id ${numeric} (no cast member has this numeric id)`,
        });
      }
      continue;
    }

    // Public UUID -- the id the API returns to clients.
    if (typeof value === "string") {
      const member = byPublicId.get(value);
      if (member) {
        resolved[slot] = member.id;
      } else {
        unresolved.push({
          level: "error",
          scope,
          message: `slot ${slot} is bound to unknown cast id "${value}" (no cast member has this public id)`,
        });
      }
      continue;
    }

    // Neither a number nor a string: a wrong id kind, not a lookup miss.
    unresolved.push({
      level: "error",
      scope,
      message: `slot ${slot} is bound to an invalid cast id (${value === null ? "null" : typeof value}); expected a cast public id or numeric row id`,
    });
  }

  return { resolved, unresolved };
}

// Duration-grid clamp warning (#707). A fixed-grid motion backend (pinned fps + per-tier frame
// caps, e.g. CogVideoX: 8fps, draft <= 25 frames) honestly clamps a shot's requested duration at
// render time; this check surfaces the clamp AT STORYBOARD TIME instead of it staying silent until
// the clip lands short. WARNING, never an error: clamping is legitimate behavior, silence is the
// bug. The grid comes from the selected motion module's manifest (duration_grid, relayed from the
// backend); no declared grid -> no issues, absence is honest.

interface DurationGridLike {
  fps?: number;
  tiers?: Record<string, { max_frames?: number }>;
}

export function checkDurationGrid(
  storyboard: StoryboardLike,
  grid: DurationGridLike | null | undefined,
  quality: string | null | undefined,
  backendName = "the selected motion backend",
  // #751: the per-shot duration FLOOR fraction (FILM_CLIP_DURATION_FLOOR; default 0.5, 0 disables the
  // gate). When the route passes it, a clamp that would land BELOW floor x planned is not a warning --
  // that render is guaranteed to hard-fail the #697 duration gate, so we escalate the issue to `error`
  // (which blocks the submit) instead of telling the user the clip is merely "clamped" and "unblocked".
  // Omitted (pure-function callers / older clients) keeps the pre-#751 warning-only behavior.
  floorFraction?: number,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  if (!grid || typeof grid.fps !== "number" || !(grid.fps > 0) || !grid.tiers) return issues;
  const caps = Object.entries(grid.tiers)
    .filter((e): e is [string, { max_frames: number }] => typeof e[1]?.max_frames === "number" && e[1].max_frames > 0);
  if (caps.length === 0) return issues;

  // The declared tier when the caller names one; otherwise the LOOSEST declared cap, so with an
  // unknown tier we only warn on shots that get clamped no matter which tier renders (no false alarms).
  const declared = quality ? caps.find(([t]) => t === quality) : undefined;
  const maxFrames = declared ? declared[1].max_frames : Math.max(...caps.map(([, t]) => t.max_frames));
  const maxSeconds = Math.round((maxFrames / grid.fps) * 1000) / 1000;
  const tierPhrase = declared ? `at the ${declared[0]} tier` : "even at its largest tier";
  const gateArmed = typeof floorFraction === "number" && floorFraction > 0;

  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  scenes.forEach((scene, idx) => {
    const sid = scene.id || `scene_${(idx + 1).toString().padStart(2, "0")}`;
    const planned = typeof scene.target_seconds === "number" ? scene.target_seconds
      : typeof storyboard.clip_seconds === "number" ? storyboard.clip_seconds
      : undefined;
    if (planned === undefined || !(planned > 0)) return; // no planned duration to compare (shape checks own <=0)
    if (planned > maxSeconds + 0.001) {
      // #751: a clamp that breaches the duration floor is a guaranteed hard-fail, not a warning.
      const floorSeconds = gateArmed ? Math.round(floorFraction! * planned * 1000) / 1000 : 0;
      const breachesFloor = gateArmed && maxSeconds < floorSeconds - 0.001;
      issues.push(breachesFloor
        ? {
            level: "error",
            scope: `scene[${sid}]`,
            message: `${sid} plans ${planned}s but ${backendName} delivers at most ${maxSeconds}s ${tierPhrase} (${maxFrames} frames at ${grid.fps}fps) -- below the ${Math.round(floorFraction! * 100)}% duration floor (${floorSeconds}s), so this render would fail the duration gate. Shorten the shot to <= ${maxSeconds}s or choose a backend/tier that delivers more frames.`,
          }
        : {
            level: "warning",
            scope: `scene[${sid}]`,
            message: `${sid} plans ${planned}s but ${backendName} delivers at most ${maxSeconds}s ${tierPhrase} (${maxFrames} frames at ${grid.fps}fps); the clip will be clamped`,
          });
    }
  });
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
