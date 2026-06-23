// Scatter job doc shape (dependency-free so notify + orchestrator can share it).

export interface ScatterJob {
  scatter_id: string;
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  expected_shot_ids: string[];
  shard_film_ids: string[];
  shard_shots: string[][];
  motion_backend?: string;
  audio_key?: string;
  // True when this scatter render has per-shot dialogue (talking film) -- the shards' lip-sync bakes
  // audio into each clip, so the gather must keep per-clip audio through the concat (keepClipAudio)
  // or the assembled film comes out silent. Mirrors the single-film assemble's dialogue_audio gate.
  has_dialogue?: boolean;
  user_email?: string;
  // film.finish on the scatter gather (#284/#285): the FULL (unfiltered) film-level inputs persisted so
  // the gather can run subtitle/title/credits on the assembled film with aggregated captions.
  scenes?: { shot_id: string; prompt: string; seconds: number }[];
  dialogue_lines?: { shot_id: string; text: string; voice_id?: string }[];
  film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  film_finish_config?: Record<string, Record<string, unknown>>;
  film_finish?: { applied: string[]; errors: string[]; steps?: string[]; degraded?: string };
  // #289 (atomic submit / self-heal): the doc is written to R2 BEFORE the D1 render rows, so the
  // poll path can reconstruct a missing UI-list row entirely from the doc (project_id is the FK to
  // storyboard_projects; render_overrides round-trips the submit knobs). Optional / back-compat.
  project_id?: number | null;
  render_overrides?: Record<string, unknown>;
  phase: "shards" | "gather" | "mux" | "done" | "failed";
  film_key?: string;
  silent_film_key?: string;
  mux_output_key?: string;
  assemble_attempts?: number;
  error?: string;
  created_at: number;
  cancelled?: boolean;
}
