import { describe, it, expect } from "vitest";
import {
  injectWelcomeBeacon,
  finalizeAssetResponse,
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

describe("CSP policies", () => {
  it("studio CSP is strict: script-src 'self' with no 'unsafe-inline' anywhere on script", () => {
    expect(STUDIO_CSP).toContain("script-src 'self';");
    expect(STUDIO_CSP).not.toContain("'unsafe-inline'");
    expect(STUDIO_CSP).toContain("frame-ancestors 'none'");
    expect(STUDIO_CSP).toContain("object-src 'none'");
  });

  it("welcomeCsp(false) equals Joan's verified BASE literal byte-for-byte", () => {
    expect(welcomeCsp(false)).toBe(WELCOME_BASE);
  });

  it("welcomeCsp(true) adds EXACTLY the two analytics origins over BASE", () => {
    const on = welcomeCsp(true);
    expect(on).toContain("script-src 'self' https://static.cloudflareinsights.com;");
    expect(on).toContain("connect-src 'self' https://cloudflareinsights.com;");
    // style-src still allows inline (welcome has inline styles); scripts otherwise strict
    expect(on).toContain("style-src 'self' 'unsafe-inline'");
  });
});

describe("analyticsTokenValid", () => {
  const TOK = "cc55ea5bbe1d44a48423f59f8e5a6cc3";
  it("accepts a 32-hex token, rejects empty/malformed", () => {
    expect(analyticsTokenValid(TOK)).toBe(true);
    expect(analyticsTokenValid("  " + TOK + "  ")).toBe(true);
    expect(analyticsTokenValid(undefined)).toBe(false);
    expect(analyticsTokenValid("")).toBe(false);
    expect(analyticsTokenValid("not-a-token")).toBe(false);
    expect(analyticsTokenValid(TOK.slice(0, 31))).toBe(false);
  });
});

describe("finalizeAssetResponse", () => {
  const TOK = "cc55ea5bbe1d44a48423f59f8e5a6cc3";

  it("stamps the strict CSP + companion headers on a studio page, body unchanged", async () => {
    const body = "<!doctype html><html><head></head><body>planner</body></html>";
    const out = await finalizeAssetResponse(htmlResponse(body), envWith(), "/planner.html");
    expect(out.headers.get("content-security-policy")).toBe(STUDIO_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("x-frame-options")).toBe("DENY");
    expect(out.headers.get("referrer-policy")).toBe("same-origin");
    expect(out.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(await out.text()).toBe(body); // no body rewrite on non-welcome
  });

  it("welcome with NO token: BASE CSP, no beacon injected", async () => {
    const body = "<!doctype html><html><head></head><body>welcome</body></html>";
    const out = await finalizeAssetResponse(htmlResponse(body), envWith(), "/welcome.html");
    expect(out.headers.get("content-security-policy")).toBe(WELCOME_BASE);
    const text = await out.text();
    expect(text).not.toContain("beacon.min.js");
  });

  it("welcome with a valid token: analytics CSP delta AND beacon, gated by the SAME check", async () => {
    const body = "<!doctype html><html><head></head><body>welcome</body></html>";
    const out = await finalizeAssetResponse(htmlResponse(body), envWith(TOK), "/welcome.html");
    const csp = out.headers.get("content-security-policy") || "";
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(csp).toContain("https://cloudflareinsights.com");
    const text = await out.text();
    expect(text).toContain("beacon.min.js");
    expect(text).toContain(`"token":"${TOK}"`);
    expect(out.headers.get("content-length")).toBeNull(); // dropped: body changed
  });

  it("welcome with a MALFORMED token: BASE CSP + no beacon (fail-safe, never disagree)", async () => {
    const body = "<!doctype html><html><head></head><body>welcome</body></html>";
    const out = await finalizeAssetResponse(htmlResponse(body), envWith("garbage"), "/welcome.html");
    expect(out.headers.get("content-security-policy")).toBe(WELCOME_BASE);
    expect(await out.text()).not.toContain("beacon.min.js");
  });

  it("non-HTML assets pass through untouched (no CSP on a stylesheet)", async () => {
    const css = new Response("body{}", { status: 200, headers: { "content-type": "text/css" } });
    const out = await finalizeAssetResponse(css, envWith(TOK), "/app.css");
    expect(out.headers.get("content-security-policy")).toBeNull();
    expect(await out.text()).toBe("body{}");
  });
});
