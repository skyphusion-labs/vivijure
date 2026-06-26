// THE single source of truth for vivijure's response security headers. Cloudflare's zone-wide
// "Add security headers" managed transform is OFF (the worker owns headers, #370), so EVERY response
// leaving fetch() funnels through applyResponseSecurity -- not just the HTML pages. Coverage by class:
//
//   studio pages (/, /planner, /cast, /modules, /settings)  -> strict studio CSP + companions
//   /welcome                                                 -> welcome CSP (+ analytics beacon if a
//                                                               valid token is set) + companions
//   everything else (api/json, non-HTML assets, redirects,   -> baseline companions + a LOCKED CSP
//     the 429, and any non-page HTML)                           (default-src 'none')
//
// Companions on every response: x-content-type-options: nosniff, referrer-policy: same-origin,
// x-frame-options: DENY. CSP is page-specific for the known page routes and locked for everything
// else, so a mislabeled/unknown HTML response can never get the permissive page policy. Headers are
// SET (overwrite), never appended, so nothing duplicates. Only /welcome+analytics rewrites the body
// (and drops the stale Content-Length/ETag); every other path streams the original body unchanged.

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

/** Locked CSP for every NON-page response (api/json, assets, redirects, the 429, unknown HTML). A
 *  JSON/asset response is not a document, so it should load nothing; if such a response is ever
 *  navigated to directly (e.g. an SVG or a stray HTML), default-src 'none' neutralizes it. */
export const LOCKED_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** CSP for /welcome. BASE (analyticsOn=false) is the self-hoster policy (no analytics origins).
 *  analyticsOn=true adds EXACTLY static.cloudflareinsights.com on script-src and cloudflareinsights.com
 *  on connect-src, gated on analyticsTokenValid -- the same check the beacon injection uses.
 *  'unsafe-inline' is on style-src only (welcome has one inline <style> block + inline style= attrs;
 *  a hash cannot cover attributes); scripts stay strict 'self'. */
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

// --------------------------------------------------------------------------- header sets

/** The companions present on EVERY response. set() (overwrite) so a zone default can never duplicate.
 *  x-frame-options: DENY is kept for pre-CSP agents; CSP frame-ancestors 'none' supersedes it. */
function companions(h: Headers): Headers {
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "same-origin");
  h.set("x-frame-options", "DENY");
  return h;
}

/** Page header set: the page-specific CSP + companions + a Permissions-Policy locking down powerful
 *  browser features the studio never uses (documents only; pointless on a JSON/asset response). */
function pageHeaders(h: Headers, csp: string): Headers {
  companions(h);
  h.set("content-security-policy", csp);
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return h;
}

/** Baseline header set for every non-page response: companions + the locked CSP. */
function baselineHeaders(h: Headers): Headers {
  companions(h);
  h.set("content-security-policy", LOCKED_CSP);
  return h;
}

// --------------------------------------------------------------------------- analytics beacon

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

// --------------------------------------------------------------------------- page classification

/** /welcome aliases (the route + the trailing-slash + the direct asset). */
const WELCOME_PATHS = new Set(["/welcome", "/welcome/", "/welcome.html"]);

/** Studio app page routes (mirror STUDIO_PAGE_ASSETS in index.ts) + the SPA root + direct .html hits.
 *  ONLY these HTML responses get the permissive studio CSP; every other response is locked down. */
const STUDIO_PAGE_PATHS = new Set([
  "/", "/index.html",
  "/planner", "/planner/", "/planner.html",
  "/cast", "/cast/", "/cast.html",
  "/modules", "/modules/", "/modules.html",
  "/settings", "/settings/", "/settings.html",
]);

type PageClass = "welcome" | "studio" | null;
function pageClass(pathname: string): PageClass {
  if (WELCOME_PATHS.has(pathname)) return "welcome";
  if (STUDIO_PAGE_PATHS.has(pathname)) return "studio";
  return null;
}

function rebuild(res: Response, headers: Headers, body: BodyInit | null): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

// --------------------------------------------------------------------------- the chokepoint

/** Stamp the correct security headers on a response by its class. Called ONCE on every response that
 *  leaves fetch(), so the worker is the complete header authority with CF's managed transforms off. */
export async function applyResponseSecurity(res: Response, request: Request, env: Env): Promise<Response> {
  const ct = res.headers.get("content-type") || "";
  const cls = ct.includes("text/html") ? pageClass(new URL(request.url).pathname) : null;

  if (cls === "welcome") {
    const analyticsOn = analyticsTokenValid(env.WEB_ANALYTICS_TOKEN);
    const csp = welcomeCsp(analyticsOn);
    if (analyticsOn) {
      const original = await res.text();
      const injected = injectWelcomeBeacon(original, (env.WEB_ANALYTICS_TOKEN || "").trim());
      const h = pageHeaders(new Headers(res.headers), csp);
      h.delete("content-length"); // body grew; let the runtime recompute
      h.delete("etag");           // body changed; the asset ETag no longer matches
      return rebuild(res, h, injected);
    }
    return rebuild(res, pageHeaders(new Headers(res.headers), csp), res.body);
  }
  if (cls === "studio") {
    return rebuild(res, pageHeaders(new Headers(res.headers), STUDIO_CSP), res.body);
  }
  // Non-page: api/json, non-HTML assets, redirects, the 429, or any HTML that is NOT a known page
  // route (locked down -- never the permissive page CSP).
  return rebuild(res, baselineHeaders(new Headers(res.headers)), res.body);
}
