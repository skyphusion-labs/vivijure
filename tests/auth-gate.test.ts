import { describe, it, expect, beforeEach } from "vitest";
import { gateApi, verifyTokenRequest, constantTimeEqual, sha256Hex, isDemoMode, catalogForDeploy, TOKEN_COOKIE } from "../src/auth-gate";
import worker from "../src/index";
import type { Env } from "../src/env";
import { __resetJwksCacheForTest, type CertsFetcher } from "../src/access-auth";

// ---- shared fixtures -----------------------------------------------------------------------

const SECRET = "a".repeat(32) + "b".repeat(32); // 64 hex chars, the deploy.sh mint shape
const NOW = 1_750_000_000_000;
const nowSec = Math.floor(NOW / 1000);
const TEAM = "test.cloudflareaccess.com";
const AUD = "AUD-423";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://studio/api/cast", { headers });
}

function bearer(token: string): Request {
  return req({ authorization: `Bearer ${token}` });
}

// Minimal RS256 kit (same shape as tests/access-auth.test.ts) so the access-mode legs of the
// matrix verify REAL signatures, not stubs.
function b64url(input: Uint8Array | string): string {
  const u8 = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeKit(kid = "kid-1") {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as unknown as Record<string, unknown>;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  const certs: CertsFetcher = async () => ({ keys: [jwk as any] });
  return { priv: kp.privateKey, certs, kid };
}

async function signJwt(priv: CryptoKey, header: object, payload: object): Promise<string> {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, priv, new TextEncoder().encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

function accessReq(token: string | null): Request {
  return token === null ? req() : req({ "cf-access-jwt-assertion": token });
}

// ---- mode dispatch (the gate matrix) ---------------------------------------------------------

describe("gateApi -- AUTH_MODE dispatch, fail closed", () => {
  beforeEach(() => __resetJwksCacheForTest());

  it("NO MODE, nothing configured -> DENY (legacy fail-closed default, unchanged)", async () => {
    const d = await gateApi(req(), {} as any);
    expect(d).toMatchObject({ ok: false, status: 503, reason: expect.stringMatching(/auth not configured/) });
  });

  it("NO MODE + ALLOW_UNAUTHENTICATED=true -> allow (dev-only escape hatch, unchanged)", async () => {
    const d = await gateApi(req(), { ALLOW_UNAUTHENTICATED: "true" } as any);
    expect(d.ok).toBe(true);
  });

  it("NO MODE + Access vars set -> verifies the Access JWT exactly as before (prod regression)", async () => {
    const { priv, certs, kid } = await makeKit();
    const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as any;
    const token = await signJwt(priv, { alg: "RS256", kid }, { iss: `https://${TEAM}`, aud: AUD, exp: nowSec + 3600, sub: "u" });
    const ok = await gateApi(accessReq(token), env, { certsFetcher: certs, nowMs: NOW });
    expect(ok.ok).toBe(true);
    const denied = await gateApi(accessReq(null), env, { certsFetcher: certs, nowMs: NOW });
    expect(denied).toMatchObject({ ok: false, status: 403 });
  });

  it("AUTH_MODE=access -> the same Access path (good JWT admits, bad JWT denies)", async () => {
    const { priv, certs, kid } = await makeKit();
    const env = { AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as any;
    const good = await signJwt(priv, { alg: "RS256", kid }, { iss: `https://${TEAM}`, aud: AUD, exp: nowSec + 3600 });
    expect((await gateApi(accessReq(good), env, { certsFetcher: certs, nowMs: NOW })).ok).toBe(true);
    const wrongAud = await signJwt(priv, { alg: "RS256", kid }, { iss: `https://${TEAM}`, aud: "OTHER", exp: nowSec + 3600 });
    expect(await gateApi(accessReq(wrongAud), env, { certsFetcher: certs, nowMs: NOW })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("AUTH_MODE=token -> bearer gate (good admits, bad denies)", async () => {
    const env = { AUTH_MODE: "token", STUDIO_API_TOKEN: SECRET } as any;
    expect((await gateApi(bearer(SECRET), env)).ok).toBe(true);
    expect(await gateApi(bearer("wrong-" + SECRET), env)).toMatchObject({ ok: false, status: 403 });
  });

  it("UNKNOWN mode -> DENY 403 (a typo never opens the API)", async () => {
    const env = { AUTH_MODE: "tokn", STUDIO_API_TOKEN: SECRET } as any;
    const d = await gateApi(bearer(SECRET), env);
    expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/unknown AUTH_MODE/) });
  });

  it("AUTH_MODE=token IGNORES ALLOW_UNAUTHENTICATED (the hatch stays scoped to the legacy path)", async () => {
    const env = { AUTH_MODE: "token", ALLOW_UNAUTHENTICATED: "true" } as any; // note: no secret either
    const d = await gateApi(req(), env);
    expect(d).toMatchObject({ ok: false, status: 403 });
  });
});

// ---- demo mode (#625: the public demo studio) --------------------------------------------------

function demoReq(method: string, headers: Record<string, string> = {}): Request {
  return new Request("https://studio/api/cast", { method, headers });
}

describe("AUTH_MODE=demo -- reads open to everyone, writes closed to everyone", () => {
  const env = { AUTH_MODE: "demo" } as any;

  it("GET and HEAD are allowed unauthenticated", async () => {
    for (const method of ["GET", "HEAD"]) {
      const d = await gateApi(demoReq(method), env);
      expect(d).toMatchObject({ ok: true, sub: "demo-visitor" });
    }
  });

  it("every mutating method denies 403", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const d = await gateApi(demoReq(method), env);
      expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/read-only/) });
    }
  });

  it("a valid bearer token does NOT unlock mutations (no operator path into a demo deploy)", async () => {
    const withSecret = { AUTH_MODE: "demo", STUDIO_API_TOKEN: SECRET } as any;
    const d = await gateApi(demoReq("POST", { authorization: `Bearer ${SECRET}` }), withSecret);
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("ALLOW_UNAUTHENTICATED does not unlock mutations either (hatch stays scoped to the legacy path)", async () => {
    const hatch = { AUTH_MODE: "demo", ALLOW_UNAUTHENTICATED: "true" } as any;
    const d = await gateApi(demoReq("DELETE"), hatch);
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("OPTIONS is not a read: it denies (only GET/HEAD are open)", async () => {
    const d = await gateApi(demoReq("OPTIONS"), env);
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("isDemoMode normalizes exactly like the gate (trim; anything else is not demo)", () => {
    expect(isDemoMode({ AUTH_MODE: " demo " } as any)).toBe(true);
    expect(isDemoMode({ AUTH_MODE: "demo" } as any)).toBe(true);
    expect(isDemoMode({ AUTH_MODE: "token" } as any)).toBe(false);
    expect(isDemoMode({} as any)).toBe(false);
  });
});

// ---- token mode ------------------------------------------------------------------------------

describe("verifyTokenRequest -- fail-closed bearer token gate", () => {
  const env = { AUTH_MODE: "token", STUDIO_API_TOKEN: SECRET } as any;

  it("accepts the exact token", async () => {
    const d = await verifyTokenRequest(bearer(SECRET), env);
    expect(d.ok).toBe(true);
  });

  it("accepts a case-insensitive Bearer scheme (bearer/BEARER)", async () => {
    expect((await verifyTokenRequest(req({ authorization: `bearer ${SECRET}` }), env)).ok).toBe(true);
    expect((await verifyTokenRequest(req({ authorization: `BEARER ${SECRET}` }), env)).ok).toBe(true);
  });

  it("accepts the token via the vivijure_token cookie on GET (media-element transport)", async () => {
    const d = await verifyTokenRequest(req({ cookie: `other=1; ${TOKEN_COOKIE}=${SECRET}; more=2` }), env);
    expect(d.ok).toBe(true);
  });

  it("accepts the cookie on HEAD too (safe method)", async () => {
    const r = new Request("https://studio/api/artifact/renders/x.mp4", {
      method: "HEAD",
      headers: { cookie: `${TOKEN_COOKIE}=${SECRET}` },
    });
    expect((await verifyTokenRequest(r, env)).ok).toBe(true);
  });

  it("REJECTS a cookie-only mutation: the cookie transport is GET/HEAD-only (403, documented -- the credential is insufficient, not the method)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = new Request("https://studio/api/cast", {
        method,
        headers: { cookie: `${TOKEN_COOKIE}=${SECRET}` },
      });
      const d = await verifyTokenRequest(r, env);
      expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/Bearer/) });
    }
  });

  it("a mutation WITH the bearer header still authenticates (header covers every method)", async () => {
    const r = new Request("https://studio/api/cast", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect((await verifyTokenRequest(r, env)).ok).toBe(true);
  });

  it("header wins over cookie: a BAD bearer denies even with a good cookie present", async () => {
    const d = await verifyTokenRequest(
      req({ authorization: "Bearer nope", cookie: `${TOKEN_COOKIE}=${SECRET}` }),
      env,
    );
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("DENIES a missing Authorization header", async () => {
    const d = await verifyTokenRequest(req(), env);
    expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/token/i) });
  });

  it("DENIES a wrong token", async () => {
    const d = await verifyTokenRequest(bearer(SECRET.slice(0, -1) + "X"), env);
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("DENIES a non-Bearer scheme", async () => {
    const d = await verifyTokenRequest(req({ authorization: `Basic ${btoa("u:" + SECRET)}` }), env);
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("DENIES a prefix and a superstring of the real token", async () => {
    expect((await verifyTokenRequest(bearer(SECRET.slice(0, 32)), env)).ok).toBe(false);
    expect((await verifyTokenRequest(bearer(SECRET + "0"), env)).ok).toBe(false);
  });

  it("DENIES an empty cookie value", async () => {
    const d = await verifyTokenRequest(req({ cookie: `${TOKEN_COOKIE}=` }), env);
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("DENIES a cookie value that does not percent-decode (clean 403, no throw)", async () => {
    for (const bad of ["%zz", "%", "%E0%A4%A"]) {
      const d = await verifyTokenRequest(req({ cookie: `${TOKEN_COOKIE}=${bad}` }), env);
      expect(d, bad).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("FAIL CLOSED: no STUDIO_API_TOKEN secret bound -> 403 everything, even a would-be match", async () => {
    const bare = { AUTH_MODE: "token" } as any;
    const d = await verifyTokenRequest(bearer(SECRET), bare);
    expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/STUDIO_API_TOKEN/) });
    const empty = { AUTH_MODE: "token", STUDIO_API_TOKEN: "   " } as any;
    expect(await verifyTokenRequest(bearer(SECRET), empty)).toMatchObject({ ok: false, status: 403 });
  });
});

// ---- constant-time compare ---------------------------------------------------------------------

describe("constantTimeEqual -- digest-compare properties", () => {
  it("equal strings compare true; any difference compares false", async () => {
    expect(await constantTimeEqual(SECRET, SECRET)).toBe(true);
    expect(await constantTimeEqual(SECRET, SECRET.slice(0, -1) + "X")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
    expect(await constantTimeEqual("", SECRET)).toBe(false);
  });

  it("compares differing-length inputs without throwing (digests are fixed-length)", async () => {
    // The timing property itself is structural: both sides are SHA-256 digested to 32 bytes and the
    // XOR fold always scans all 32, so input length / first-mismatch position cannot modulate the
    // comparison time. This case pins the API contract that makes that structure reachable.
    expect(await constantTimeEqual("short", SECRET)).toBe(false);
    expect(await constantTimeEqual(SECRET + SECRET, SECRET)).toBe(false);
  });
});

// ---- integration: the index.ts wiring (routeRequest -> gateApi) --------------------------------

describe("worker.fetch in token mode -- the wiring the frontend shim depends on", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  function makeEnv(): Env {
    return {
      AUTH_MODE: "token",
      STUDIO_API_TOKEN: SECRET,
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
  }

  const apiReq = (headers: Record<string, string> = {}) =>
    new Request("https://studio.example/api/modules", { headers });

  it("/api/* without a token -> 403 with a token-shaped JSON error (the shim prompt trigger)", async () => {
    const res = await worker.fetch(apiReq(), makeEnv(), ctx);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/api token/i);
  });

  it("/api/* with the bearer token -> served (200 modules projection)", async () => {
    const res = await worker.fetch(apiReq({ authorization: `Bearer ${SECRET}` }), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modules?: unknown[] };
    expect(Array.isArray(body.modules)).toBe(true);
  });

  it("/api/* with the cookie transport -> served (media-element path)", async () => {
    const res = await worker.fetch(apiReq({ cookie: `${TOKEN_COOKIE}=${SECRET}` }), makeEnv(), ctx);
    expect(res.status).toBe(200);
  });

  it("/api/* with a WRONG bearer -> 403", async () => {
    const res = await worker.fetch(apiReq({ authorization: "Bearer nope" }), makeEnv(), ctx);
    expect(res.status).toBe(403);
  });

  it("/api/* with a malformed cookie value -> 403, not a 500", async () => {
    const res = await worker.fetch(apiReq({ cookie: `${TOKEN_COOKIE}=%zz` }), makeEnv(), ctx);
    expect(res.status).toBe(403);
  });

  it("/health and the static pages stay open in token mode (the auth gate covers /api/* only)", async () => {
    const env = makeEnv();
    expect((await worker.fetch(new Request("https://studio.example/health"), env, ctx)).status).toBe(200);
    const page = await worker.fetch(new Request("https://studio.example/planner"), env, ctx);
    expect(await page.text()).toBe("ASSET");
  });
});

// ---- named per-consumer tokens (#445) --------------------------------------------------------

describe("verifyTokenRequest -- named per-consumer tokens (#445)", () => {
  const NAMED = "c".repeat(64); // a consumer's minted token
  let namedHash: string;
  beforeEach(async () => {
    namedHash = await sha256Hex(NAMED);
  });

  // Emulates the api_tokens lookup: hash -> live row (the SQL filters revoked_at IS NULL, so the
  // fake returns null for a revoked row exactly as D1 would).
  function fakeDb(rows: Array<{ hash: string; name: string; revoked?: boolean }>) {
    return {
      prepare: (_sql: string) => ({
        bind: (hash: string) => ({
          first: async () => {
            const r = rows.find((x) => x.hash === hash && !x.revoked);
            return r ? { name: r.name } : null;
          },
        }),
      }),
    } as any;
  }

  function env(db: any): any {
    return { AUTH_MODE: "token", STUDIO_API_TOKEN: SECRET, DB: db };
  }

  it("a live named token admits, with the consumer identity in sub", async () => {
    const e = env(fakeDb([{ hash: namedHash, name: "slate-bot" }]));
    const d = await verifyTokenRequest(bearer(NAMED), e);
    expect(d).toMatchObject({ ok: true, sub: "api-token:slate-bot" });
  });

  it("a REVOKED named token denies with the same reason as any bad token (no oracle)", async () => {
    const e = env(fakeDb([{ hash: namedHash, name: "slate-bot", revoked: true }]));
    const d = await verifyTokenRequest(bearer(NAMED), e);
    expect(d).toMatchObject({ ok: false, status: 403, reason: "bad API token" });
  });

  it("an unknown token still denies with the identical reason", async () => {
    const e = env(fakeDb([]));
    const d = await verifyTokenRequest(bearer("d".repeat(64)), e);
    expect(d).toMatchObject({ ok: false, status: 403, reason: "bad API token" });
  });

  it("the operator token is checked FIRST and never touches D1", async () => {
    const exploding = { prepare: () => { throw new Error("must not be called"); } } as any;
    const d = await verifyTokenRequest(bearer(SECRET), env(exploding));
    expect(d).toMatchObject({ ok: true, sub: "studio-api-token" });
  });

  it("a D1 failure FAILS CLOSED for named tokens and leaves the operator path intact", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as any;
    const named = await verifyTokenRequest(bearer(NAMED), env(broken));
    expect(named).toMatchObject({ ok: false, status: 403 });
    const operator = await verifyTokenRequest(bearer(SECRET), env(broken));
    expect(operator.ok).toBe(true);
  });

  it("no DB binding -> named tokens deny (fail closed), operator unaffected", async () => {
    const e: any = { AUTH_MODE: "token", STUDIO_API_TOKEN: SECRET };
    expect((await verifyTokenRequest(bearer(NAMED), e)).ok).toBe(false);
    expect((await verifyTokenRequest(bearer(SECRET), e)).ok).toBe(true);
  });

  it("named tokens ride the same transport rules: cookie admits on GET, denied on a mutation", async () => {
    const e = env(fakeDb([{ hash: namedHash, name: "slate-bot" }]));
    const get = new Request("https://studio/api/cast", { headers: { cookie: `${TOKEN_COOKIE}=${NAMED}` } });
    expect((await verifyTokenRequest(get, e)).ok).toBe(true);
    const post = new Request("https://studio/api/cast", { method: "POST", headers: { cookie: `${TOKEN_COOKIE}=${NAMED}` } });
    expect((await verifyTokenRequest(post, e)).ok).toBe(false);
  });
});

// ---- demo mode Phase B (#631): the two-route write allowlist ----------------------------------
describe("AUTH_MODE=demo Phase B -- exactly two demo write routes are allowed", () => {
  const env = { AUTH_MODE: "demo" } as any;
  const at = (method: string, path: string) => gateApi(new Request("https://studio" + path, { method }), env);

  it("POST /api/demo/render and /api/demo/chat are allowed (demo-visitor)", async () => {
    for (const path of ["/api/demo/render", "/api/demo/chat"]) {
      const d = await at("POST", path);
      expect(d).toMatchObject({ ok: true, sub: "demo-visitor" });
    }
  });

  it("the demo poll (GET /api/demo/render/:id) is allowed like any read", async () => {
    const d = await at("GET", "/api/demo/render/job-123");
    expect(d).toMatchObject({ ok: true, sub: "demo-visitor" });
  });

  it("every OTHER write stays denied -- the prod render/plan/chat routes included", async () => {
    for (const path of ["/api/render/film", "/api/storyboard/plan", "/api/chat", "/api/demo/render/anything-else", "/api/cast"]) {
      const d = await at("POST", path);
      expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/read-only/) });
    }
  });

  it("a non-POST method on an allowlisted demo write route is NOT unlocked (POST-only)", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const d = await at(method, "/api/demo/render");
      expect(d).toMatchObject({ ok: false, status: 403 });
    }
  });
});

// ---- demo mode serves EMPTY capability catalogs (honesty: no advertised backend it cannot run) ----

describe("capability catalogs on a demo deploy -- /api/storyboard/models + /api/voices", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const demoEnv = {
    AUTH_MODE: "demo",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
  } as unknown as Env;
  const tokenEnv = {
    AUTH_MODE: "token",
    STUDIO_API_TOKEN: SECRET,
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
  } as unknown as Env;

  function get(path: string, headers: Record<string, string> = {}): Request {
    return new Request("https://demo.vivijure.com" + path, { headers });
  }

  it("catalogForDeploy scrubs only demo mode", () => {
    const cat = [{ id: "x" }];
    expect(catalogForDeploy({ AUTH_MODE: "demo" } as any, cat)).toEqual([]);
    expect(catalogForDeploy({ AUTH_MODE: " demo " } as any, cat)).toEqual([]);
    expect(catalogForDeploy({ AUTH_MODE: "token" } as any, cat)).toBe(cat);
    expect(catalogForDeploy({} as any, cat)).toBe(cat);
  });

  it("demo serves models: [] -- the picker must not list frontier models the deploy cannot invoke", async () => {
    const res = await worker.fetch(get("/api/storyboard/models"), demoEnv, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [] });
  });

  it("demo serves voices: [] -- same rule for the TTS voice catalog", async () => {
    const res = await worker.fetch(get("/api/voices"), demoEnv, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voices: [] });
  });

  it("token mode still serves the full catalogs (no over-scrub outside demo)", async () => {
    const auth = { authorization: `Bearer ${SECRET}` };
    const models = (await (await worker.fetch(get("/api/storyboard/models", auth), tokenEnv, ctx)).json()) as any;
    expect(models.models.length).toBeGreaterThan(0);
    const voices = (await (await worker.fetch(get("/api/voices", auth), tokenEnv, ctx)).json()) as any;
    expect(voices.voices.length).toBeGreaterThan(0);
  });
});

describe("worker.fetch root routing -- demo lands on the planner (S30 item g)", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  // ASSETS stub that records which asset path the worker asked for.
  function makeEnv(overrides: Record<string, unknown>): { env: Env; asked: () => string | null } {
    let last: string | null = null;
    const env = {
      ASSETS: {
        fetch: async (req: Request) => {
          last = new URL(req.url).pathname;
          return new Response("ASSET", { status: 200, headers: { "content-type": "text/html" } });
        },
      },
      ...overrides,
    } as unknown as Env;
    return { env, asked: () => last };
  }

  const get = (path: string) => new Request("https://studio.example" + path);

  it("demo mode: GET / serves the planner asset (not the module host)", async () => {
    const { env, asked } = makeEnv({ AUTH_MODE: "demo" });
    const res = await worker.fetch(get("/"), env, ctx);
    expect(res.status).toBe(200);
    expect(asked()).toBe("/planner.html");
  });

  it("demo mode: GET /index.html also remaps to the planner", async () => {
    const { env, asked } = makeEnv({ AUTH_MODE: "demo" });
    await worker.fetch(get("/index.html"), env, ctx);
    expect(asked()).toBe("/planner.html");
  });

  it("demo mode: the module host stays reachable at /modules (nav unchanged)", async () => {
    const { env, asked } = makeEnv({ AUTH_MODE: "demo" });
    await worker.fetch(get("/modules"), env, ctx);
    expect(asked()).toBe("/modules.html");
  });

  it("token mode: GET / serves the module host unchanged (byte-identical)", async () => {
    const { env, asked } = makeEnv({ AUTH_MODE: "token", STUDIO_API_TOKEN: SECRET });
    await worker.fetch(get("/"), env, ctx);
    expect(asked()).toBe("/modules.html");
  });

  it("normal (no AUTH_MODE) mode: GET / serves the module host unchanged", async () => {
    const { env, asked } = makeEnv({});
    await worker.fetch(get("/"), env, ctx);
    expect(asked()).toBe("/modules.html");
  });
});
