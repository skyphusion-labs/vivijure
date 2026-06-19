import { describe, it, expect } from "vitest";
import {
  DEFAULT_USER_PREFS,
  normalizeUserPrefs,
  mergeUserPrefs,
} from "../src/user-prefs";

describe("normalizeUserPrefs", () => {
  it("returns defaults for empty / non-object input", () => {
    expect(normalizeUserPrefs(undefined)).toEqual(DEFAULT_USER_PREFS);
    expect(normalizeUserPrefs(null)).toEqual(DEFAULT_USER_PREFS);
    expect(normalizeUserPrefs([])).toEqual(DEFAULT_USER_PREFS);
    expect(normalizeUserPrefs("nope")).toEqual(DEFAULT_USER_PREFS);
    expect(DEFAULT_USER_PREFS.emailNotifications).toBe(false);
  });

  it("accepts a valid emailNotifications boolean", () => {
    expect(normalizeUserPrefs({ emailNotifications: true })).toEqual({
      emailNotifications: true,
    });
    expect(normalizeUserPrefs({ emailNotifications: false })).toEqual({
      emailNotifications: false,
    });
  });

  it("drops a non-boolean emailNotifications (defaults it)", () => {
    expect(normalizeUserPrefs({ emailNotifications: "yes" })).toEqual({
      emailNotifications: false,
    });
    expect(normalizeUserPrefs({ emailNotifications: 1 })).toEqual({
      emailNotifications: false,
    });
  });

  it("drops unknown keys (forward-compatible)", () => {
    expect(
      normalizeUserPrefs({ emailNotifications: true, futurePref: "x" }),
    ).toEqual({ emailNotifications: true });
  });
});

describe("mergeUserPrefs", () => {
  it("applies a known patch over current", () => {
    const cur = { emailNotifications: false };
    expect(mergeUserPrefs(cur, { emailNotifications: true })).toEqual({
      emailNotifications: true,
    });
  });

  it("ignores a non-object patch (keeps current)", () => {
    const cur = { emailNotifications: true };
    expect(mergeUserPrefs(cur, null)).toEqual({ emailNotifications: true });
    expect(mergeUserPrefs(cur, "x")).toEqual({ emailNotifications: true });
  });

  it("drops unknown keys in the patch", () => {
    const cur = { emailNotifications: false };
    expect(mergeUserPrefs(cur, { emailNotifications: true, bogus: 9 })).toEqual({
      emailNotifications: true,
    });
  });
});
