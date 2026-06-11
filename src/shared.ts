// Small shared helpers the render handlers lean on. Lifted verbatim from skyphusion-llm-public so
// the moved handlers behave identically (move, do not rewrite). Kept tiny and dependency-free.

/** JSON response with the content-type set; merges any extra init. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** The caller's identity. Cloudflare Access sets this header; the worker trusts it to scope every
 *  render/cast/storyboard row per user. `wrangler dev` has no Access -> "anonymous". */
export function getUserEmail(request: Request): string {
  return request.headers.get("cf-access-authenticated-user-email") ?? "anonymous";
}
