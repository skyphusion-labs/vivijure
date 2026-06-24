// Types for the pure cast-selection helper in cast-select.js. Hand-authored
// (no build step) so tests/cast-select.test.ts typechecks under the CI tsc
// gate. Runtime stays plain vanilla JS.

export interface CastListItem {
  id: number;
  [k: string]: unknown;
}

export function pickInitialCastId(
  cast: CastListItem[] | null | undefined,
  lastViewedId: number | null | undefined,
): number | null;
