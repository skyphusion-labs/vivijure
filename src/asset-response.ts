// THE single source of truth for vivijure's response security headers. Cloudflare's zone-wide
// "Add security headers" managed transform is OFF (the worker owns headers, #370), so EVERY response
// leaving fetch() funnels through applyResponseSecurity -- not just the HTML pages. Coverage by class:
//
//   studio pages (/, /planner, /cast, /modules, /settings)  -> strict studio CSP + companions
//   everything else (api/json, non-HTML assets, redirects,   -> baseline companions + a LOCKED CSP
//     the 429, the /welcome 301, and any non-page HTML)          (default-src 'none')
//
// Companions on every response: x-content-type-options: nosniff, referrer-policy: same-origin,
// x-frame-options: DENY. CSP is page-specific for the known studio page routes and locked for
// everything else, so a mislabeled/unknown HTML response can never get the permissive page policy.
// Headers are SET (overwrite), never appended, so nothing duplicates. Every response streams its
// original body unchanged (#617 removed the only body-rewriting path, the /welcome Umami inject:
// the marketing page moved to the vivijure.com storefront).

import { isDemoMode } from "./auth-gate";
import type { Env } from "./env";

// --------------------------------------------------------------------------- CSP policies (literal)

/** Strict CSP for every studio page (verified: zero inline scripts/styles/on*= handlers). */
export const STUDIO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";

/** The ONE external origin the public demo studio (#625) loads from: the S23 showcase films (media) AND
 *  the seeded cast portraits (images). Host-pinned (no wildcard) so the demo CSP admits exactly our asset
 *  host and nothing else. */
export const DEMO_MEDIA_ORIGIN = "https://assets.skyphusion.net";

/** Demo-studio page CSP: STUDIO_CSP with the showcase host admitted on TWO directives, and ONLY on a demo
 *  deploy (a prod/self-host deploy never serves this policy):
 *    - img-src: the seeded cast portraits are absolute assets.skyphusion.net URLs (the demo binds NO R2),
 *      so the portrait <img> would be blocked without this. img-src is the ONLY prod directive widened.
 *    - media-src: the showcase films. Media has no explicit directive in STUDIO_CSP (it falls back to
 *      default-src 'self'), so this ADDS media-src. It is APPENDED LAST on purpose -- the Phase-B
 *      dynamic artifact-origin append in applyResponseSecurity extends the media-src directive by
 *      concatenating onto the end of this string, so media-src MUST stay last. Every other directive
 *      (script/style/font/connect/object/base/frame/form) is byte-identical to prod. */
export const STUDIO_DEMO_CSP =
  STUDIO_CSP.replace("img-src 'self' data: blob:", "img-src 'self' data: blob: " + DEMO_MEDIA_ORIGIN) +
  "; media-src 'self' " + DEMO_MEDIA_ORIGIN;

/** Locked CSP for every NON-page response (api/json, assets, redirects, the 429, unknown HTML). A
 *  JSON/asset/redirect response is not a document, so it should load nothing; if such a response is
 *  ever navigated to directly (e.g. an SVG or a stray HTML), default-src 'none' neutralizes it. */
export const LOCKED_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

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

// --------------------------------------------------------------------------- page classification

/** Studio app page routes (mirror STUDIO_PAGE_ASSETS in index.ts) + the SPA root + direct .html hits.
 *  ONLY these HTML responses get the permissive studio CSP; every other response is locked down. */
const STUDIO_PAGE_PATHS = new Set([
  "/", "/index.html",
  "/planner", "/planner/", "/planner.html",
  "/cast", "/cast/", "/cast.html",
  "/modules", "/modules/", "/modules.html",
  "/settings", "/settings/", "/settings.html",
]);

type PageClass = "studio" | null;
function pageClass(pathname: string): PageClass {
  if (STUDIO_PAGE_PATHS.has(pathname)) return "studio";
  return null;
}

function rebuild(res: Response, headers: Headers, body: BodyInit | null): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

// --------------------------------------------------------------------------- the chokepoint

/** Stamp the correct security headers on a response by its class. Called ONCE on every response that
 *  leaves fetch(), so the worker is the complete header authority with CF's managed transforms off. */
export function applyResponseSecurity(res: Response, request: Request, env?: Env): Response {
  const ct = res.headers.get("content-type") || "";
  const cls = ct.includes("text/html") ? pageClass(new URL(request.url).pathname) : null;

  if (cls === "studio") {
    // Demo deploys (#625) get the one-directive-wider policy so the showcase films play; everyone
    // else gets STUDIO_CSP byte-identical to before (env omitted -> never demo). #631: a demo render
    // clip is served from the isolated demo artifact origin -- enumerate it on the SAME media-src
    // directive (it is the last directive in STUDIO_DEMO_CSP), never a wildcard, and only when it is a
    // distinct origin from the showcase host.
    let csp = STUDIO_CSP;
    if (env && isDemoMode(env)) {
      csp = STUDIO_DEMO_CSP;
      const artifact = env.DEMO_ARTIFACT_ORIGIN?.trim();
      if (artifact && artifact !== DEMO_MEDIA_ORIGIN) csp = STUDIO_DEMO_CSP + " " + artifact;
    }
    return rebuild(res, pageHeaders(new Headers(res.headers), csp), res.body);
  }
  // Non-page: api/json, non-HTML assets, redirects (incl. the /welcome 301), the 429, or any HTML
  // that is NOT a known studio page route (locked down -- never the permissive page CSP).
  return rebuild(res, baselineHeaders(new Headers(res.headers)), res.body);
}
