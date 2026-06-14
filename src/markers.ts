// NLE markers export (v0.53.0).
//
// Pure compute over a validated storyboard. Emits one marker per scene
// with cumulative time = sum of target_seconds across prior scenes
// (with a clip_seconds fallback when a scene's target is unset).
//
// Output formats:
//   "premiere_csv"  Adobe Premiere Pro CSV. Tab-separated, columns:
//                   Marker Name, Description, In, Out, Duration,
//                   Marker Type (chapter|comment|... ; we use Comment).
//                   Premiere accepts the file via File -> Import ->
//                   "Marker List CSV" on a sequence.
//
//   "resolve_csv"   DaVinci Resolve EDL-style marker CSV. Comma-separated,
//                   columns: # Markers, Color, Name, Time. Resolve picks
//                   it up via Marker > Import Marker List.
//
// Both formats use SMPTE timecode at the storyboard's FPS. We default
// to 24 fps unless the storyboard specifies otherwise (the renderer's
// fps_default is 24; bundle assembly writes 24 unless explicitly
// overridden).
//
// Pure: no I/O, no env, no D1. The Worker route in src/index.ts wraps
// this with the validator + a Content-Type/Content-Disposition response.

interface StoryboardSceneLike {
  id?: string;
  prompt?: string;
  act?: string;
  target_seconds?: number;
  character_slots?: string[];
}

interface StoryboardLike {
  title?: string;
  clip_seconds?: number;
  scenes?: StoryboardSceneLike[];
}

export type MarkersFormat = "premiere_csv" | "resolve_csv";

export function formatTimecode(seconds: number, fps: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  if (!Number.isFinite(fps) || fps <= 0) fps = 24;
  const totalFrames = Math.round(seconds * fps);
  const totalSecondsWhole = Math.floor(totalFrames / fps);
  const frames = totalFrames - totalSecondsWhole * fps;
  const h = Math.floor(totalSecondsWhole / 3600);
  const m = Math.floor((totalSecondsWhole - h * 3600) / 60);
  const s = totalSecondsWhole - h * 3600 - m * 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

interface MarkerRow {
  index: number;
  inSeconds: number;
  outSeconds: number;
  durationSeconds: number;
  name: string;
  description: string;
}

export function buildMarkers(
  storyboard: StoryboardLike,
  defaultFps: number = 24,
): MarkerRow[] {
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const fallback =
    typeof storyboard.clip_seconds === "number" && storyboard.clip_seconds > 0
      ? storyboard.clip_seconds
      : 5;
  let cursor = 0;
  void defaultFps;
  return scenes.map((scene, idx) => {
    const dur =
      typeof scene.target_seconds === "number" && scene.target_seconds > 0
        ? scene.target_seconds
        : fallback;
    const inSec = cursor;
    const outSec = cursor + dur;
    cursor = outSec;
    const id = scene.id || `scene_${(idx + 1).toString().padStart(2, "0")}`;
    const actLabel = scene.act ? `[${scene.act}] ` : "";
    const prompt = (scene.prompt || "").replace(/\s+/g, " ").trim();
    const cast =
      Array.isArray(scene.character_slots) && scene.character_slots.length > 0
        ? ` (cast: ${scene.character_slots.join(", ")})`
        : "";
    const description = `${actLabel}${prompt}${cast}`;
    return {
      index: idx + 1,
      inSeconds: inSec,
      outSeconds: outSec,
      durationSeconds: dur,
      name: id,
      description,
    };
  });
}

// Premiere marker CSV. Tab-separated header + rows. We use "Comment"
// markers (a generic timeline note). Numeric times are SMPTE timecode
// at the storyboard's fps.
export function emitPremiereCsv(
  storyboard: StoryboardLike,
  fps: number = 24,
): string {
  const rows = buildMarkers(storyboard);
  const header = [
    "Marker Name",
    "Description",
    "In",
    "Out",
    "Duration",
    "Marker Type",
  ].join("\t");
  const lines = rows.map((r) =>
    [
      r.name,
      sanitize(r.description),
      formatTimecode(r.inSeconds, fps),
      formatTimecode(r.outSeconds, fps),
      formatTimecode(r.durationSeconds, fps),
      "Comment",
    ].join("\t"),
  );
  return [header, ...lines].join("\n") + "\n";
}

// Resolve marker CSV. Comma-separated. Color is a marker color label
// Resolve picks up; we cycle Blue/Green/Yellow/Red across acts for
// visual variety (default Blue when no act is set).
const RESOLVE_ACT_COLORS: Record<string, string> = {
  opening: "Blue",
  rising: "Green",
  turn: "Yellow",
  climax: "Red",
  resolution: "Cyan",
};

export function emitResolveCsv(
  storyboard: StoryboardLike,
  fps: number = 24,
): string {
  const rows = buildMarkers(storyboard);
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const header = ["#", "Color", "Name", "Time"].join(",");
  const lines = rows.map((r, idx) => {
    const sceneAct = (scenes[idx]?.act || "").toLowerCase();
    const color = RESOLVE_ACT_COLORS[sceneAct] || "Blue";
    return [
      r.index,
      color,
      csvQuote(`${r.name} - ${r.description}`),
      formatTimecode(r.inSeconds, fps),
    ].join(",");
  });
  return [header, ...lines].join("\n") + "\n";
}

function sanitize(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ").trim();
}

function csvQuote(s: string): string {
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function emitMarkers(
  storyboard: StoryboardLike,
  format: MarkersFormat,
  fps: number = 24,
): { body: string; contentType: string; filename: string } {
  const title = storyboard.title || "storyboard";
  const safeTitle = slugForFilename(title);
  switch (format) {
    case "premiere_csv":
      return {
        body: emitPremiereCsv(storyboard, fps),
        contentType: "text/csv; charset=utf-8",
        filename: `${safeTitle}-premiere-markers.csv`,
      };
    case "resolve_csv":
      return {
        body: emitResolveCsv(storyboard, fps),
        contentType: "text/csv; charset=utf-8",
        filename: `${safeTitle}-resolve-markers.csv`,
      };
  }
}

function slugForFilename(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "storyboard";
}
