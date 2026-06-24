import { describe, expect, it } from "vitest";

import { pickInitialCastId, type CastListItem } from "../public/cast-select.js";

// #146: on a fresh load the cast list highlighted nothing and the detail pane
// stayed on "pick a character" even when characters existed. pickInitialCastId
// decides which character the page opens on load so highlight + detail stay in
// sync (the caller runs the normal select path on the result).

const cast = (...ids: number[]): CastListItem[] => ids.map((id) => ({ id, name: "c" + id }));

describe("pickInitialCastId (#146)", () => {
  it("returns null for an empty or missing catalog", () => {
    expect(pickInitialCastId([], 3)).toBeNull();
    expect(pickInitialCastId(null, 3)).toBeNull();
    expect(pickInitialCastId(undefined, null)).toBeNull();
  });

  it("returns the most-recently-viewed id when it still exists", () => {
    expect(pickInitialCastId(cast(1, 2, 3), 2)).toBe(2);
  });

  it("falls back to the first character when there is no last-viewed id", () => {
    expect(pickInitialCastId(cast(7, 8, 9), null)).toBe(7);
    expect(pickInitialCastId(cast(7, 8, 9), undefined)).toBe(7);
  });

  it("falls back to the first character when the last-viewed id is stale (deleted)", () => {
    expect(pickInitialCastId(cast(1, 2, 3), 99)).toBe(1);
  });

  it("does not treat id 0 as absent (0 is a valid id)", () => {
    expect(pickInitialCastId(cast(0, 1), 0)).toBe(0);
  });
});
