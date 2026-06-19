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
