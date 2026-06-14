// Small shared helpers the render handlers lean on. Lifted verbatim from skyphusion-llm-public so
// the moved handlers behave identically (move, do not rewrite). Kept tiny and dependency-free.

/** JSON response with the content-type set; merges any extra init. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** The owner key every render/cast/storyboard row is scoped to. Vivijure is a SINGLE-OPERATOR
 *  studio (not multi-user -- per-user identity was playground heritage), so there is one shared
 *  owner: everything is visible to everyone with access, and non-browser clients (the Discord bot /
 *  CF Access service tokens, which carry no user email) see the same data. Email is no longer an
 *  access gate. (If per-user provenance/notify is ever wanted, read the Access header separately --
 *  do not reintroduce it here as a visibility filter.) */
export const STUDIO_OWNER = "studio";
export function getUserEmail(_request: Request): string {
  return STUDIO_OWNER;
}
