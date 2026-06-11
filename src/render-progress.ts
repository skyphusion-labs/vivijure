// Render progress channel reader (v0.156.0).
//
// The vivijure-backend GPU worker writes a structured, best-effort progress
// channel to R2 for every render: a per-job snapshot at
//   renders/<slug(project)>/progress/<slug(job_id)>.json
// plus an NDJSON event log alongside it. This module builds those keys so the
// control plane can read a live render's stage/snapshot back through the
// R2_RENDERS binding, no SSH to the pod required.
//
// COUPLING: renderSlug and the key layout MUST stay byte-identical to the
// backend (vivijure_backend/harness/keys.py `_slug`, `progress_snapshot_key`,
// `progress_log_key`) and the snapshot shape to harness/progress.py. A drift
// here is a silent 404 (we read a key the worker never wrote). Kept in its own
// file so vitest can cover the key builder without importing the Worker runtime.

// Mirror of vivijure_backend.harness.keys._slug:
//   "_".join(str(project).strip().split()).replace("/", "_") or "untitled"
// Python str.split() with no args splits on any whitespace run and drops empty
// pieces, so leading / trailing / internal whitespace all collapse to one "_",
// and the "/" replacement runs after the join.
export function renderSlug(name: string): string {
  const collapsed = String(name).trim().split(/\s+/).filter(Boolean).join("_").replace(/\//g, "_");
  return collapsed || "untitled";
}

export function progressSnapshotKey(project: string, jobId: string): string {
  return `renders/${renderSlug(project)}/progress/${renderSlug(jobId)}.json`;
}

export function progressLogKey(project: string, jobId: string): string {
  return `renders/${renderSlug(project)}/progress/${renderSlug(jobId)}.ndjson`;
}

// The snapshot the backend rewrites on each emit (harness/progress.py). Every
// field is best-effort: `last_event` is the most recent stage event, `counts`
// tallies the repeatable stages (train_done / keyframe_done / i2v_done / ...),
// `status` is one of "running" | "complete" | "error".
export interface RenderProgressSnapshot {
  project: string;
  job_id: string;
  status: string;
  started_ts: number | null;
  updated_ts: number | null;
  counts: Record<string, number>;
  last_event: Record<string, unknown> | null;
  error: { stage?: string; message?: string } | null;
}
