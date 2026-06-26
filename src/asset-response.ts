// Post-process static-asset responses on their way out of the Worker (the studio pages + welcome
// are served from env.ASSETS; the Worker is the only place to touch them -- a public/_headers file
// does not apply to env.ASSETS.fetch responses). Two concerns funnel through one chokepoint so the
// asset exits stay simple:
//   - Security headers (CSP + companions) on every HTML document.
//   - Web Analytics deploy-injection: the public artifact ships NO analytics token, so a self-hosted
//     /welcome phones home to NO ONE; the operator's own deploy sets WEB_ANALYTICS_TOKEN and the
//     Worker injects the beacon at serve time. (Privacy: the self-host boundary, #363.)
//
// CSP policies are Joan's verified inventory-derived literals (not guessed): studio pages carry zero
// inline scripts/styles, so they get the fully strict policy; /welcome has one inline <style> block
// plus inline style= attributes (a hash cannot cover attributes), so it allows 'unsafe-inline' on
// style-src ONLY, scripts stay strict 'self'. The analytics CSP delta and the beacon injection share
// ONE token gate (analyticsTokenValid), so the policy and the beacon can never disagree (#363/CSP).

import type { Env } from "./env";

// --------------------------------------------------------------------------- analytics token gate

/** A Cloudflare Web Analytics token is a 32-char hex id. ONE gate drives both the beacon injection
 *  and the analytics CSP delta, so a self-hoster (no/invalid token) gets neither and they can never
 *  disagree. An empty OR malformed value is rejected (fail-safe to zero analytics). */
const CF_ANALYTICS_TOKEN = /^[a-f0-9]{32}$/i;
export function analyticsTokenValid(token: string | undefined): boolean {
  return CF_ANALYTICS_TOKEN.test((token || "").trim());
}

// --------------------------------------------------------------------------- CSP policies (literal)

/** Strict CSP for every studio page (verified: zero inline scripts/styles/on*= handlers). */
export const STUDIO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";

/** CSP for /welcome. BASE (analyticsOn=false) is the self-hoster policy (no analytics origins).
 *  analyticsOn=true adds EXACTLY the two analytics origins -- static.cloudflareinsights.com on
 *  script-src and cloudflareinsights.com on connect-src -- and is gated on analyticsTokenValid, the
 *  same check the beacon injection uses. 'unsafe-inline' is on style-src only (inline <style> + style=
 *  attributes); scripts stay strict 'self'. */
export function welcomeCsp(analyticsOn: boolean): string {
  const scriptSrc = analyticsOn ? "script-src 'self' https://static.cloudflareinsights.com" : "script-src 'self'";
  const connectSrc = analyticsOn ? "connect-src 'self' https://cloudflareinsights.com" : "connect-src 'self'";
  return (
    `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
    "img-src 'self' data: https://assets.skyphusion.net; media-src 'self' https://assets.skyphusion.net; " +
    `font-src 'self'; ${connectSrc}; object-src 'none'; base-uri 'none'; ` +
    "frame-ancestors 'none'; form-action 'self'"
  );
}

/** Set the security headers on an HTML response. OVERWRITE (set, not append): the CF zone already
 *  injects x-content-type-options / x-frame-options / x-xss-protection, so set() avoids duplicates.
 *  CSP frame-ancestors 'none' supersedes X-Frame-Options; X-Frame-Options: DENY is kept as a belt for
 *  pre-CSP agents. */
function applySecurityHeaders(h: Headers, csp: string): Headers {
  h.set("content-security-policy", csp);
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "same-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return h;
}

// --------------------------------------------------------------------------- analytics beacon

/** Build the Cloudflare Web Analytics beacon for a token. JSON.stringify escapes the token safely
 *  into the data-cf-beacon attribute. */
function beaconTag(token: string): string {
  return (
    `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ` +
    `data-cf-beacon='${JSON.stringify({ token })}'></script>`
  );
}

/** Inject the analytics beacon into a welcome-page HTML string, before </head>. Pure + testable.
 *  A blank or non-well-formed token is a NO-OP (the default self-host posture is zero analytics).
 *  Idempotent: if a beacon for this script src is already present, do nothing. */
export function injectWelcomeBeacon(html: string, token: string): string {
  if (!analyticsTokenValid(token)) return html;
  if (html.includes("static.cloudflareinsights.com/beacon.min.js")) return html;
  const idx = html.lastIndexOf("</head>");
  if (idx === -1) return html; // no head to inject into; leave the page untouched
  return html.slice(0, idx) + `  ${beaconTag(token.trim())}\n` + html.slice(idx);
}

// --------------------------------------------------------------------------- finalizer

/** True for an asset path that is the public welcome page (served at /welcome -> /welcome.html, or
 *  hit directly as /welcome.html through the catch-all). */
function isWelcomeAsset(assetPath: string): boolean {
  return assetPath === "/welcome.html" || assetPath.endsWith("/welcome.html");
}

/** Finalize a static-asset response before it leaves the Worker: stamp the security headers (CSP +
 *  companions) on every HTML document, and deploy-inject the Web Analytics beacon into /welcome when
 *  WEB_ANALYTICS_TOKEN is set + valid. Non-HTML responses (css/js/images/fonts) pass straight through
 *  untouched. Only the welcome+analytics path rewrites the body (and drops the now-stale
 *  Content-Length/ETag); the headers-only path streams the original body unchanged. */
export async function finalizeAssetResponse(res: Response, env: Env, assetPath: string): Promise<Response> {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res; // CSP/security headers apply to HTML documents only

  const welcome = isWelcomeAsset(assetPath);
  const analyticsOn = welcome && analyticsTokenValid(env.WEB_ANALYTICS_TOKEN);
  const csp = welcome ? welcomeCsp(analyticsOn) : STUDIO_CSP;

  if (analyticsOn) {
    const original = await res.text();
    const injected = injectWelcomeBeacon(original, (env.WEB_ANALYTICS_TOKEN || "").trim());
    const headers = applySecurityHeaders(new Headers(res.headers), csp);
    headers.delete("content-length"); // body grew; let the runtime recompute
    headers.delete("etag");           // body changed; the asset ETag no longer matches
    return new Response(injected, { status: res.status, statusText: res.statusText, headers });
  }

  // Headers-only: stream the original body unchanged (Content-Length/ETag stay valid).
  const headers = applySecurityHeaders(new Headers(res.headers), csp);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
