// v0.139.0: User Preferences. Vivijure is a SINGLE-OPERATOR studio, so this is a GLOBAL
// settings singleton -- one row (id = 1) in the `user_prefs` table holding a JSON blob, so new
// preferences can be added without a schema change. (The legacy identity key was dropped in the
// identity strip; memory: vivijure-user-email-strip.) Reads always return the full shape
// (missing/invalid keys fall back to defaults), so callers never branch on "is this pref set".
// Writes are a shallow merge over the current prefs.
//
// The normalize/merge functions are pure so vitest can assert the contract
// without a D1 binding (matches the renders-db / runpod-submit split: pure
// helpers tested, query code verified live).

import type { Env } from "./env";

export interface UserPrefs {
  // When true, the user is emailed when one of their renders reaches a terminal
  // status (COMPLETED / FAILED). Default false: opt-in, no surprise mail.
  emailNotifications: boolean;
}

export const DEFAULT_USER_PREFS: UserPrefs = {
  emailNotifications: false,
};

// Coerce a stored or incoming prefs object to the known shape: unknown keys are
// dropped, missing or wrong-typed keys take the default. Forward-compatible -- a
// newer client writing a key this version does not understand is simply dropped
// here, never crashing the read.
export function normalizeUserPrefs(raw: unknown): UserPrefs {
  const out: UserPrefs = { ...DEFAULT_USER_PREFS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.emailNotifications === "boolean") {
      out.emailNotifications = r.emailNotifications;
    }
  }
  return out;
}

// Shallow-merge a patch over the current prefs, then normalize. Only known keys
// in the patch take effect; everything else is dropped.
export function mergeUserPrefs(current: UserPrefs, patch: unknown): UserPrefs {
  const patchObj =
    patch && typeof patch === "object" && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {};
  return normalizeUserPrefs({ ...current, ...patchObj });
}

export async function getUserPrefs(env: Env): Promise<UserPrefs> {
  const row = await env.DB.prepare("SELECT prefs_json FROM user_prefs WHERE id = 1")
    .first<{ prefs_json: string }>();
  if (!row) return { ...DEFAULT_USER_PREFS };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.prefs_json);
  } catch {
    parsed = null;
  }
  return normalizeUserPrefs(parsed);
}

export async function setUserPrefs(env: Env, patch: unknown): Promise<UserPrefs> {
  const current = await getUserPrefs(env);
  const next = mergeUserPrefs(current, patch);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO user_prefs (id, prefs_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(next), now)
    .run();
  return next;
}
