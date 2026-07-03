// Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its
// value. Returns "" if unset/unreadable so the existing "not configured" guards still fire
// FAIL CLOSED. Mirrors the per-module helper (modules/*/src/index.ts). Part of #238 (core half):
// the credential secrets move from `wrangler secret put` to declarative [[secrets_store_secrets]]
// bindings, and every read goes through here.
export async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  if (typeof s === "string") return s;
  if (!s) return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + (e as Error).message);
    return "";
  }
}
