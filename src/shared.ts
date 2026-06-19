// Small shared helpers the render handlers lean on. Kept tiny and dependency-free.

/** JSON response with the content-type set; merges any extra init. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** The owner key every render/cast/storyboard row is scoped to. Vivijure is a single-operator
 *  studio, so there is one shared owner: everything is visible to everyone with CF Access, and
 *  non-browser clients (service tokens with no user email) see the same data. Email is provenance,
 *  not an access gate. */
export const STUDIO_OWNER = "studio";
export function getUserEmail(_request: Request): string {
  return STUDIO_OWNER;
}

/** CF Access identity for provenance + per-user settings (whoami, prefs, notify). Not used as a
 *  visibility filter -- studio data stays under STUDIO_OWNER. Service tokens / local dev may lack
 *  the header; callers treat a missing email as anonymous. */
export function getAccessUserEmail(request: Request): string {
  return request.headers.get("cf-access-authenticated-user-email") ?? "anonymous";
}
