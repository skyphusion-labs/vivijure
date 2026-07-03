// Types for the pure cast-selection helper in cast-select.js. Hand-authored
// (no build step) so tests/cast-select.test.ts typechecks under the CI tsc
// gate. Runtime stays plain vanilla JS.

export interface CastListItem {
  // S9 (F13): opaque public id (UUID string), never a number.
  id: string;
  [k: string]: unknown;
}

export function pickInitialCastId(
  cast: CastListItem[] | null | undefined,
  lastViewedId: string | null | undefined,
): string | null;
