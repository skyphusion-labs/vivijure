import { describe, it, expect } from "vitest";
import { injectWelcomeBeacon } from "../src/asset-response";

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
