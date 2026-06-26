// Post-process static-asset responses on their way out of the Worker (the studio pages + welcome
// are served from env.ASSETS; the Worker is the only place to touch them, a public/_headers file
// does not apply to env.ASSETS.fetch responses). Two concerns funnel through one chokepoint so the
// asset exits stay simple:
//   - Web Analytics deploy-injection (here): the public artifact ships NO analytics token, so a
//     self-hosted /welcome phones home to NO ONE; the operator's own deploy sets WEB_ANALYTICS_TOKEN
//     and the Worker injects the beacon at serve time. (Privacy: the self-host boundary, #363.)
//   - Security headers (CSP et al.) are added to this same finalizer separately.
//
// Only text/html GET bodies are ever rewritten; everything else passes through untouched (and keeps
// its original ETag). When the body IS rewritten we drop the now-stale Content-Length + ETag.

import type { Env } from "./env";

/** Build the Cloudflare Web Analytics beacon for a token. JSON.stringify escapes the token safely
 *  into the data-cf-beacon attribute (no HTML/JS injection from a malformed deploy value). */
function beaconTag(token: string): string {
  return (
    `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ` +
    `data-cf-beacon='${JSON.stringify({ token })}'></script>`
  );
}

/** A Cloudflare Web Analytics token is a 32-char hex id. Validate the deploy value against that shape
 *  before it is ever placed into the page: an empty OR malformed token injects NOTHING (fail-safe to
 *  zero analytics), so a misconfigured / hostile WEB_ANALYTICS_TOKEN can neither phone home nor break
 *  out of the beacon attribute. (Input-boundary validation, like isValidJobId / isSafeRelKey.) */
const CF_ANALYTICS_TOKEN = /^[a-f0-9]{32}$/i;

/** Inject the analytics beacon into a welcome-page HTML string, before </head>. Pure + testable.
 *  A blank or non-well-formed token is a NO-OP (returns the html unchanged): the default self-host
 *  posture is zero analytics. Idempotent: if a beacon for this exact script src is already present,
 *  do nothing (so a double-finalize or an artifact that still carries one cannot double-count). */
export function injectWelcomeBeacon(html: string, token: string): string {
  const t = (token || "").trim();
  if (!CF_ANALYTICS_TOKEN.test(t)) return html;
  if (html.includes("static.cloudflareinsights.com/beacon.min.js")) return html;
  const idx = html.lastIndexOf("</head>");
  if (idx === -1) return html; // no head to inject into; leave the page untouched
  return html.slice(0, idx) + `  ${beaconTag(t)}\n` + html.slice(idx);
}

/** True for an asset path that is the public welcome page (served at /welcome -> /welcome.html, or
 *  hit directly as /welcome.html through the catch-all). */
function isWelcomeAsset(assetPath: string): boolean {
  return assetPath === "/welcome.html" || assetPath.endsWith("/welcome.html");
}

/** Finalize a static-asset response before it leaves the Worker. Currently: deploy-inject the
 *  Web Analytics beacon into /welcome when WEB_ANALYTICS_TOKEN is set. Non-HTML, non-welcome, and
 *  empty-token responses pass straight through. */
export async function finalizeAssetResponse(res: Response, env: Env, assetPath: string): Promise<Response> {
  const token = (env.WEB_ANALYTICS_TOKEN || "").trim();
  if (!token || !isWelcomeAsset(assetPath)) return res;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res;
  const original = await res.text();
  if (!original) return new Response(original, { status: res.status, headers: res.headers }); // HEAD / empty
  const injected = injectWelcomeBeacon(original, token);
  if (injected === original) return new Response(original, { status: res.status, headers: res.headers });
  const headers = new Headers(res.headers);
  headers.delete("content-length"); // body grew; let the runtime recompute
  headers.delete("etag");           // body changed; the asset ETag no longer matches
  return new Response(injected, { status: res.status, headers });
}
