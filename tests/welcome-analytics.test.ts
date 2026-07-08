import { describe, it, expect } from "vitest";
import {
  injectWelcomeUmami,
  applyResponseSecurity,
  LOCKED_CSP,
  STUDIO_CSP,
  welcomeCsp,
  umamiWebsiteIdValid,
  UMAMI_ANALYTICS_HOST,
} from "../src/asset-response";
import type { Env } from "../src/env";

const HEAD = `<!doctype html><html><head><title>x</title></head><body></body></html>`;
const WEBSITE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("injectWelcomeUmami", () => {
  it("injects the Umami script before </head> when a website id is set", () => {
    const out = injectWelcomeUmami(HEAD, WEBSITE_ID);
    expect(out).toContain(`${UMAMI_ANALYTICS_HOST}/script.js`);
    expect(out).toContain(`data-website-id="${WEBSITE_ID}"`);
    expect(out.indexOf("script.js")).toBeLessThan(out.indexOf("</head>"));
    expect(out.indexOf("</body>")).toBeGreaterThan(out.indexOf("</head>"));
  });

  it("is a NO-OP for an empty / blank website id (default self-host: zero analytics)", () => {
    expect(injectWelcomeUmami(HEAD, "")).toBe(HEAD);
    expect(injectWelcomeUmami(HEAD, "   ")).toBe(HEAD);
  });

  it("trims surrounding whitespace from the website id", () => {
    expect(injectWelcomeUmami(HEAD, `  ${WEBSITE_ID}  `)).toContain(`data-website-id="${WEBSITE_ID}"`);
  });

  it("is idempotent: does not inject a second script if one is already present", () => {
    const once = injectWelcomeUmami(HEAD, WEBSITE_ID);
    const twice = injectWelcomeUmami(once, "b2c3d4e5-f6a7-8901-bcde-f12345678901");
    expect(twice).toBe(once);
    expect(twice.match(/script\.js/g)?.length).toBe(1);
  });

  it("is a NO-OP for a malformed website id (fail-safe: only a well-formed UUID injects)", () => {
    expect(injectWelcomeUmami(HEAD, "not-a-uuid")).toBe(HEAD);
    expect(injectWelcomeUmami(HEAD, '"></script><script>alert(1)//')).toBe(HEAD);
    expect(injectWelcomeUmami(HEAD, "a1b2c3d4-e5f6-7890-abcd")).toBe(HEAD);
  });

  it("leaves a document with no </head> untouched", () => {
    const noHead = "<html><body>hi</body></html>";
    expect(injectWelcomeUmami(noHead, WEBSITE_ID)).toBe(noHead);
  });
});

const WELCOME_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https://assets.skyphusion.net; media-src 'self' https://assets.skyphusion.net; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";

function envWith(websiteId?: string): Env {
  return { UMAMI_WEBSITE_ID: websiteId } as unknown as Env;
}
function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
function req(path: string): Request {
  return new Request("https://vivijure.skyphusion.org" + path);
}

describe("applyResponseSecurity (the single header chokepoint)", () => {
  const ID = WEBSITE_ID;

  it("studio page: strict CSP + companions, body unchanged", async () => {
    const body = "<!doctype html><html><head></head><body>planner</body></html>";
    const out = await applyResponseSecurity(htmlResponse(body), req("/planner"), envWith());
    expect(out.headers.get("content-security-policy")).toBe(STUDIO_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("x-frame-options")).toBe("DENY");
    expect(out.headers.get("referrer-policy")).toBe("same-origin");
    expect(out.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(await out.text()).toBe(body);
  });

  it("SPA root (/) is treated as a studio page", async () => {
    const out = await applyResponseSecurity(htmlResponse("<html><head></head></html>"), req("/"), envWith());
    expect(out.headers.get("content-security-policy")).toBe(STUDIO_CSP);
  });

  it("welcome with NO website id: BASE CSP, no Umami script", async () => {
    const out = await applyResponseSecurity(
      htmlResponse("<!doctype html><html><head></head><body>welcome</body></html>"), req("/welcome"), envWith());
    expect(out.headers.get("content-security-policy")).toBe(welcomeCsp(false));
    expect(await out.text()).not.toContain("script.js");
  });

  it("welcome with a valid website id: analytics CSP delta AND Umami script, one shared gate", async () => {
    const out = await applyResponseSecurity(
      htmlResponse("<!doctype html><html><head></head><body>welcome</body></html>"), req("/welcome"), envWith(ID));
    const csp = out.headers.get("content-security-policy") || "";
    expect(csp).toContain(UMAMI_ANALYTICS_HOST);
    const text = await out.text();
    expect(text).toContain("script.js");
    expect(text).toContain(`data-website-id="${ID}"`);
    expect(out.headers.get("content-length")).toBeNull();
  });

  it("welcome with a MALFORMED website id: BASE CSP + no Umami script (fail-safe)", async () => {
    const out = await applyResponseSecurity(
      htmlResponse("<!doctype html><html><head></head><body>welcome</body></html>"), req("/welcome"), envWith("garbage"));
    expect(out.headers.get("content-security-policy")).toBe(welcomeCsp(false));
    expect(await out.text()).not.toContain("script.js");
  });

  it("API JSON: companions + LOCKED csp (default-src none), NOT a page CSP", async () => {
    const j = new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    const out = await applyResponseSecurity(j, req("/api/modules"), envWith(ID));
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("x-frame-options")).toBe("DENY");
    expect(out.headers.get("referrer-policy")).toBe("same-origin");
    expect(out.headers.get("permissions-policy")).toBeNull();
    expect(await out.text()).toBe('{"ok":true}');
  });

  it("non-HTML asset (stylesheet): companions + LOCKED csp, body unchanged", async () => {
    const css = new Response("body{}", { status: 200, headers: { "content-type": "text/css" } });
    const out = await applyResponseSecurity(css, req("/app.css"), envWith(ID));
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await out.text()).toBe("body{}");
  });

  it("UNKNOWN-path HTML gets the LOCKED csp, never the permissive page policy", async () => {
    const out = await applyResponseSecurity(
      htmlResponse("<html><body>artifact</body></html>"), req("/api/artifact/x.html"), envWith());
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
  });

  it("preserves status + redirect Location while stamping companions", async () => {
    const redir = new Response(null, { status: 302, headers: { location: "https://r2.example/obj" } });
    const out = await applyResponseSecurity(redir, req("/api/artifact/x"), envWith());
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("https://r2.example/obj");
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("API JSON with no Cache-Control defaults to no-store", async () => {
    const j = new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    const out = await applyResponseSecurity(j, req("/api/modules"), envWith());
    expect(out.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves a route's own Cache-Control (artifact private, max-age=300) -- set-if-absent", async () => {
    const art = new Response("bytes", {
      status: 200, headers: { "content-type": "video/mp4", "cache-control": "private, max-age=300" } });
    const out = await applyResponseSecurity(art, req("/api/artifact/renders/x.mp4"), envWith());
    expect(out.headers.get("cache-control")).toBe("private, max-age=300");
  });

  it("does NOT force no-store on a page: welcome keeps the ASSETS binding Cache-Control", async () => {
    const page = new Response("<html><head></head><body>welcome</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" } });
    const out = await applyResponseSecurity(page, req("/welcome"), envWith());
    expect(out.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("leaves a static asset's own Cache-Control intact (ASSETS stays cacheable)", async () => {
    const css = new Response("body{}", {
      status: 200, headers: { "content-type": "text/css", "cache-control": "public, max-age=0, must-revalidate" } });
    const out = await applyResponseSecurity(css, req("/app.css"), envWith());
    expect(out.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });
});

describe("umamiWebsiteIdValid", () => {
  it("accepts a canonical UUID", () => {
    expect(umamiWebsiteIdValid(WEBSITE_ID)).toBe(true);
  });
  it("rejects empty and garbage", () => {
    expect(umamiWebsiteIdValid("")).toBe(false);
    expect(umamiWebsiteIdValid("nope")).toBe(false);
  });
});
