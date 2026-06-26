import { describe, it, expect } from "vitest";
import {
  injectWelcomeBeacon,
  applyResponseSecurity,
  LOCKED_CSP,
  STUDIO_CSP,
  welcomeCsp,
  analyticsTokenValid,
} from "../src/asset-response";
import type { Env } from "../src/env";

const HEAD = `<!doctype html><html><head><title>x</title></head><body></body></html>`;
const TOKEN = "cc55ea5bbe1d44a48423f59f8e5a6cc3"; // 32-hex CF Web Analytics token shape

describe("injectWelcomeBeacon", () => {
  it("injects the beacon before </head> when a token is set", () => {
    const out = injectWelcomeBeacon(HEAD, TOKEN);
    expect(out).toContain("static.cloudflareinsights.com/beacon.min.js");
    expect(out).toContain(`data-cf-beacon='{"token":"${TOKEN}"}'`);
    // injected inside head, before </head>
    expect(out.indexOf("beacon.min.js")).toBeLessThan(out.indexOf("</head>"));
    expect(out.indexOf("</body>")).toBeGreaterThan(out.indexOf("</head>"));
  });

  it("is a NO-OP for an empty / blank token (default self-host: zero analytics)", () => {
    expect(injectWelcomeBeacon(HEAD, "")).toBe(HEAD);
    expect(injectWelcomeBeacon(HEAD, "   ")).toBe(HEAD);
  });

  it("trims surrounding whitespace from the token", () => {
    expect(injectWelcomeBeacon(HEAD, `  ${TOKEN}  `)).toContain(`{"token":"${TOKEN}"}`);
  });

  it("is idempotent: does not inject a second beacon if one is already present", () => {
    const once = injectWelcomeBeacon(HEAD, TOKEN);
    const twice = injectWelcomeBeacon(once, "abc123");
    expect(twice).toBe(once);
    expect(twice.match(/beacon\.min\.js/g)?.length).toBe(1);
  });

  it("is a NO-OP for a malformed token (fail-safe: only a well-formed 32-hex token injects)", () => {
    expect(injectWelcomeBeacon(HEAD, "not-a-token")).toBe(HEAD);
    expect(injectWelcomeBeacon(HEAD, '"></script><script>alert(1)//')).toBe(HEAD);
    expect(injectWelcomeBeacon(HEAD, "cc55ea5bbe1d44a48423f59f8e5a6cc")).toBe(HEAD); // 31 chars
  });

  it("leaves a document with no </head> untouched", () => {
    const noHead = "<html><body>hi</body></html>";
    expect(injectWelcomeBeacon(noHead, "abc123")).toBe(noHead);
  });
});


// Joan's verified literal welcome BASE policy (self-hoster, no analytics). welcomeCsp(false) MUST
// equal this byte-for-byte; the analytics-on variant adds exactly the two analytics origins.
const WELCOME_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https://assets.skyphusion.net; media-src 'self' https://assets.skyphusion.net; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";

function envWith(token?: string): Env {
  return { WEB_ANALYTICS_TOKEN: token } as unknown as Env;
}
function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
function req(path: string): Request {
  return new Request("https://vivijure.skyphusion.org" + path);
}

describe("applyResponseSecurity (the single header chokepoint)", () => {
  const TOK = "cc55ea5bbe1d44a48423f59f8e5a6cc3";

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

  it("welcome with NO token: BASE CSP, no beacon", async () => {
    const out = await applyResponseSecurity(
      htmlResponse("<!doctype html><html><head></head><body>welcome</body></html>"), req("/welcome"), envWith());
    expect(out.headers.get("content-security-policy")).toBe(welcomeCsp(false));
    expect(await out.text()).not.toContain("beacon.min.js");
  });

  it("welcome with a valid token: analytics CSP delta AND beacon, one shared gate", async () => {
    const out = await applyResponseSecurity(
      htmlResponse("<!doctype html><html><head></head><body>welcome</body></html>"), req("/welcome"), envWith(TOK));
    const csp = out.headers.get("content-security-policy") || "";
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(csp).toContain("https://cloudflareinsights.com");
    const text = await out.text();
    expect(text).toContain("beacon.min.js");
    expect(text).toContain(`"token":"${TOK}"`);
    expect(out.headers.get("content-length")).toBeNull();
  });

  it("welcome with a MALFORMED token: BASE CSP + no beacon (fail-safe)", async () => {
    const out = await applyResponseSecurity(
      htmlResponse("<!doctype html><html><head></head><body>welcome</body></html>"), req("/welcome"), envWith("garbage"));
    expect(out.headers.get("content-security-policy")).toBe(welcomeCsp(false));
    expect(await out.text()).not.toContain("beacon.min.js");
  });

  it("API JSON: companions + LOCKED csp (default-src none), NOT a page CSP", async () => {
    const j = new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    const out = await applyResponseSecurity(j, req("/api/modules"), envWith(TOK));
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("x-frame-options")).toBe("DENY");
    expect(out.headers.get("referrer-policy")).toBe("same-origin");
    expect(out.headers.get("permissions-policy")).toBeNull(); // page-only
    expect(await out.text()).toBe('{"ok":true}');
  });

  it("non-HTML asset (stylesheet): companions + LOCKED csp, body unchanged", async () => {
    const css = new Response("body{}", { status: 200, headers: { "content-type": "text/css" } });
    const out = await applyResponseSecurity(css, req("/app.css"), envWith(TOK));
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await out.text()).toBe("body{}");
  });

  it("UNKNOWN-path HTML gets the LOCKED csp, never the permissive page policy", async () => {
    // a mislabeled/stray text/html response on a non-page route must not get studio/welcome CSP
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
});
