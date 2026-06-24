// Types for the pure render-ETA helpers in render-eta.js. Hand-authored (the
// project has no build step) so tests/render-eta.test.ts typechecks under the
// CI tsc gate. Runtime stays plain vanilla JS.

export interface PipelinePhaseBand {
  key: string;
  start: number;
  span: number;
}

// A status-poll output envelope (data.output from GET
// /api/storyboard/render/:jobId). Every field is optional / best-effort.
export interface RenderProgressOutput {
  phase?: string;
  progress?: number;
  scene_index?: number;
  scene_total?: number;
  log?: unknown[];
  [k: string]: unknown;
}

export const PIPELINE_PHASES: PipelinePhaseBand[];
export const MIN_FRACTION_FOR_ETA: number;
export const MIN_ELAPSED_MS_FOR_ETA: number;

export function progressFraction(
  out: RenderProgressOutput | null | undefined,
): number | null;

export function remainingMs(
  fraction: number | null | undefined,
  elapsedMs: number,
): number | null;
