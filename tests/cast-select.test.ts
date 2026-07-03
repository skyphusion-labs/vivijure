import { describe, expect, it } from "vitest";

import { pickInitialCastId, type CastListItem } from "../public/cast-select.js";

// #146: on a fresh load the cast list highlighted nothing and the detail pane
// stayed on "pick a character" even when characters existed. pickInitialCastId
// decides which character the page opens on load so highlight + detail stay in
// sync (the caller runs the normal select path on the result).
//
// S9 (F13): a cast id is an opaque public id (UUID string), never a number; the
// helper compares ids verbatim, so these fixtures use UUID-shaped strings.
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const U7 = "77777777-7777-4777-8777-777777777777";
const U8 = "88888888-8888-4888-8888-888888888888";
const U9 = "99999999-9999-4999-8999-999999999999";
const STALE = "deadbeef-0000-4000-8000-000000000000";

const cast = (...ids: string[]): CastListItem[] => ids.map((id) => ({ id, name: "c" + id }));

describe("pickInitialCastId (#146)", () => {
  it("returns null for an empty or missing catalog", () => {
    expect(pickInitialCastId([], U3)).toBeNull();
    expect(pickInitialCastId(null, U3)).toBeNull();
    expect(pickInitialCastId(undefined, null)).toBeNull();
  });

  it("returns the most-recently-viewed id when it still exists", () => {
    expect(pickInitialCastId(cast(U1, U2, U3), U2)).toBe(U2);
  });

  it("falls back to the first character when there is no last-viewed id", () => {
    expect(pickInitialCastId(cast(U7, U8, U9), null)).toBe(U7);
    expect(pickInitialCastId(cast(U7, U8, U9), undefined)).toBe(U7);
  });

  it("falls back to the first character when the last-viewed id is stale (deleted)", () => {
    expect(pickInitialCastId(cast(U1, U2, U3), STALE)).toBe(U1);
  });

  it("compares opaque ids verbatim (no numeric coercion)", () => {
    // A UUID whose leading chars are digits must still match only itself, never
    // a parseInt() truncation of it.
    expect(pickInitialCastId(cast(U1, U2), U1)).toBe(U1);
  });
});
