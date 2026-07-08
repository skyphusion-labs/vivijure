// THE single source of truth for vivijure's response security headers. Cloudflare's zone-wide
// "Add security headers" managed transform is OFF (the worker owns headers, #370), so EVERY response
// leaving fetch() funnels through applyResponseSecurity -- not just the HTML pages. Coverage by class:
//
//   studio pages (/, /planner, /cast, /modules, /settings)  -> strict studio CSP + companions
//   /welcome                                                 -> welcome CSP (+ Umami script if a
//                                                               valid UMAMI_WEBSITE_ID is set) + companions
//   everything else (api/json, non-HTML assets, redirects,   -> baseline companions + a LOCKED CSP
//     the 429, and any non-page HTML)                           (default-src 'none')
//
// Companions on every response: x-content-type-options: nosniff, referrer-policy: same-origin,
// x-frame-options: DENY. CSP is page-specific for the known page routes and locked for everything
// else, so a mislabeled/unknown HTML response can never get the permissive page policy. Headers are
// SET (overwrite), never appended, so nothing duplicates. Only /welcome+analytics rewrites the body
// (and drops the stale Content-Length/ETag); every other path streams the original body unchanged.

import type { Env } from "./env";

// --------------------------------------------------------------------------- Umami analytics gate

export const UMAMI_ANALYTICS_HOST = "https://analytics.skyphusion.org";

/** Umami website UUID. ONE gate drives both the script injection and the analytics CSP delta. */
const UMAMI_WEBSITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function umamiWebsiteIdValid(id: string | undefined): boolean {
  return UMAMI_WEBSITE_ID.test((id || "").trim());
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
 *  analyticsOn=true adds EXACTLY analytics.skyphusion.org on script-src and connect-src, gated on
 *  umamiWebsiteIdValid -- the same check the Umami script injection uses. */
export function welcomeCsp(analyticsOn: boolean): string {
  const scriptSrc = analyticsOn
    ? `script-src 'self' ${UMAMI_ANALYTICS_HOST}`
    : "script-src 'self'";
  const connectSrc = analyticsOn
    ? `connect-src 'self' ${UMAMI_ANALYTICS_HOST}`
    : "connect-src 'self'";
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

/** Baseline header set for every non-page response: companions + the locked CSP + a default
 *  Cache-Control. #416: the worker is the complete Cache-Control authority so an outsider deployment
 *  is correct WITHOUT the operator zone-level cache-bypass rule (that rule is optional hardening, not
 *  a requirement). A dynamic worker-generated non-page response (api/json, the 429, marker downloads)
 *  that ships no Cache-Control of its own defaults to `no-store`; anything that already set one keeps
 *  it (SET-IF-ABSENT), so a route's explicit value wins (artifact's `private, max-age=300`,
 *  cast-bundle's `no-store`) and a static asset from the ASSETS binding -- which always emits its own
 *  `public, max-age=0, must-revalidate` -- stays cacheable and untouched. */
function baselineHeaders(h: Headers): Headers {
  companions(h);
  h.set("content-security-policy", LOCKED_CSP);
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  return h;
}

// --------------------------------------------------------------------------- Umami analytics script

function umamiScriptTag(websiteId: string): string {
  return (
    `<script defer src="${UMAMI_ANALYTICS_HOST}/script.js" ` +
    `data-website-id="${websiteId.trim()}"></script>`
  );
}

/** Inject the Umami tracker into a welcome-page HTML string, before </head>. Pure + testable.
 *  A blank or non-UUID website id is a NO-OP (default self-host posture is zero analytics).
 *  Idempotent: if the Umami script is already present, do nothing. */
export function injectWelcomeUmami(html: string, websiteId: string): string {
  if (!umamiWebsiteIdValid(websiteId)) return html;
  if (html.includes(`${UMAMI_ANALYTICS_HOST}/script.js`)) return html;
  const idx = html.lastIndexOf("</head>");
  if (idx === -1) return html;
  return html.slice(0, idx) + `  ${umamiScriptTag(websiteId.trim())}\n` + html.slice(idx);
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
    const analyticsOn = umamiWebsiteIdValid(env.UMAMI_WEBSITE_ID);
    const csp = welcomeCsp(analyticsOn);
    if (analyticsOn) {
      const original = await res.text();
      const injected = injectWelcomeUmami(original, (env.UMAMI_WEBSITE_ID || "").trim());
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
