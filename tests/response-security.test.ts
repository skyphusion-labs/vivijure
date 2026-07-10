import { describe, it, expect } from "vitest";
import {
  applyResponseSecurity,
  LOCKED_CSP,
  STUDIO_CSP,
} from "../src/asset-response";

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
function req(path: string): Request {
  return new Request("https://vivijure.skyphusion.org" + path);
}

describe("applyResponseSecurity (the single header chokepoint)", () => {
  it("studio page: strict CSP + companions, body unchanged", async () => {
    const body = "<!doctype html><html><head></head><body>planner</body></html>";
    const out = applyResponseSecurity(htmlResponse(body), req("/planner"));
    expect(out.headers.get("content-security-policy")).toBe(STUDIO_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("x-frame-options")).toBe("DENY");
    expect(out.headers.get("referrer-policy")).toBe("same-origin");
    expect(out.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(await out.text()).toBe(body);
  });

  it("SPA root (/) is treated as a studio page", async () => {
    const out = applyResponseSecurity(htmlResponse("<html><head></head></html>"), req("/"));
    expect(out.headers.get("content-security-policy")).toBe(STUDIO_CSP);
  });

  it("#617: /welcome is no longer a studio page -- HTML there gets the LOCKED csp, never a page policy", async () => {
    const out = applyResponseSecurity(
      htmlResponse("<!doctype html><html><head></head><body>welcome</body></html>"), req("/welcome"));
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
    expect(out.headers.get("permissions-policy")).toBeNull();
  });

  it("the /welcome 301 redirect: companions + LOCKED csp, Location + status preserved", async () => {
    const redir = Response.redirect("https://vivijure.com/", 301);
    const out = applyResponseSecurity(redir, req("/welcome"));
    expect(out.status).toBe(301);
    expect(out.headers.get("location")).toBe("https://vivijure.com/");
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("API JSON: companions + LOCKED csp (default-src none), NOT a page CSP", async () => {
    const j = new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    const out = applyResponseSecurity(j, req("/api/modules"));
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("x-frame-options")).toBe("DENY");
    expect(out.headers.get("referrer-policy")).toBe("same-origin");
    expect(out.headers.get("permissions-policy")).toBeNull();
    expect(await out.text()).toBe('{"ok":true}');
  });

  it("non-HTML asset (stylesheet): companions + LOCKED csp, body unchanged", async () => {
    const css = new Response("body{}", { status: 200, headers: { "content-type": "text/css" } });
    const out = applyResponseSecurity(css, req("/app.css"));
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await out.text()).toBe("body{}");
  });

  it("UNKNOWN-path HTML gets the LOCKED csp, never the permissive page policy", async () => {
    const out = applyResponseSecurity(
      htmlResponse("<html><body>artifact</body></html>"), req("/api/artifact/x.html"));
    expect(out.headers.get("content-security-policy")).toBe(LOCKED_CSP);
  });

  it("preserves status + redirect Location while stamping companions", async () => {
    const redir = new Response(null, { status: 302, headers: { location: "https://r2.example/obj" } });
    const out = applyResponseSecurity(redir, req("/api/artifact/x"));
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("https://r2.example/obj");
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("API JSON with no Cache-Control defaults to no-store", async () => {
    const j = new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    const out = applyResponseSecurity(j, req("/api/modules"));
    expect(out.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves a route's own Cache-Control (artifact private, max-age=300) -- set-if-absent", async () => {
    const art = new Response("bytes", {
      status: 200, headers: { "content-type": "video/mp4", "cache-control": "private, max-age=300" } });
    const out = applyResponseSecurity(art, req("/api/artifact/renders/x.mp4"));
    expect(out.headers.get("cache-control")).toBe("private, max-age=300");
  });

  it("does NOT force no-store on a studio page: keeps the ASSETS binding Cache-Control", async () => {
    const page = new Response("<html><head></head><body>planner</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" } });
    const out = applyResponseSecurity(page, req("/planner"));
    expect(out.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("leaves a static asset's own Cache-Control intact (ASSETS stays cacheable)", async () => {
    const css = new Response("body{}", {
      status: 200, headers: { "content-type": "text/css", "cache-control": "public, max-age=0, must-revalidate" } });
    const out = applyResponseSecurity(css, req("/app.css"));
    expect(out.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });
});
