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
  phase: "shards" | "gather" | "mux" | "done" | "failed";
  film_key?: string;
  silent_film_key?: string;
  mux_output_key?: string;
  assemble_attempts?: number;
  error?: string;
  created_at: number;
  cancelled?: boolean;
}
