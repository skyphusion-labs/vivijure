import { describe, it, expect, beforeEach } from "vitest";
import {
  verifyAccessRequest,
  gateApiRequest,
  accessConfig,
  __resetJwksCacheForTest,
  type AccessConfig,
  type CertsFetcher,
} from "../src/access-auth";

const CFG: AccessConfig = { teamDomain: "test.cloudflareaccess.com", aud: "AUD-123" };
const NOW = 1_750_000_000_000; // fixed ms
const nowSec = Math.floor(NOW / 1000);

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
  const data = new TextEncoder().encode(`${h}.${p}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, priv, data));
  return `${h}.${p}.${b64url(sig)}`;
}

function goodPayload(over: Record<string, unknown> = {}) {
  return { iss: `https://${CFG.teamDomain}`, aud: CFG.aud, exp: nowSec + 3600, sub: "user-1", email: "a@b.c", ...over };
}

function reqWith(token: string | null): Request {
  const headers = new Headers();
  if (token !== null) headers.set("cf-access-jwt-assertion", token);
  return new Request("https://studio/api/cast", { headers });
}

describe("verifyAccessRequest -- fail-closed CF Access JWT verification (F2)", () => {
  beforeEach(() => __resetJwksCacheForTest());

  it("accepts a correctly-signed token with the right aud/iss/exp", async () => {
    const { priv, certs, kid } = await makeKit();
    const token = await signJwt(priv, { alg: "RS256", kid }, goodPayload());
    const d = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.sub).toBe("user-1");
      expect(d.email).toBe("a@b.c");
    }
  });

  it("DENIES a missing assertion header (403)", async () => {
    const { certs } = await makeKit();
    const d = await verifyAccessRequest(reqWith(null), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("DENIES a tampered payload (signature no longer matches)", async () => {
    const { priv, certs, kid } = await makeKit();
    const token = await signJwt(priv, { alg: "RS256", kid }, goodPayload());
    const [h, , s] = token.split(".");
    const forged = b64url(JSON.stringify(goodPayload({ sub: "attacker" })));
    const d = await verifyAccessRequest(reqWith(`${h}.${forged}.${s}`), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("DENIES a token signed by an unrelated key (wrong issuer's signature)", async () => {
    const attacker = await makeKit("kid-1"); // same kid, different key
    const legit = await makeKit("kid-1");
    const token = await signJwt(attacker.priv, { alg: "RS256", kid: "kid-1" }, goodPayload());
    // verify against the LEGIT JWKS -> signature must fail
    const d = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: legit.certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("DENIES the wrong audience", async () => {
    const { priv, certs, kid } = await makeKit();
    const token = await signJwt(priv, { alg: "RS256", kid }, goodPayload({ aud: "SOME-OTHER-APP" }));
    const d = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/audience/) });
  });

  it("DENIES the wrong issuer", async () => {
    const { priv, certs, kid } = await makeKit();
    const token = await signJwt(priv, { alg: "RS256", kid }, goodPayload({ iss: "https://evil.cloudflareaccess.com" }));
    const d = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/issuer/) });
  });

  it("DENIES an expired token", async () => {
    const { priv, certs, kid } = await makeKit();
    const token = await signJwt(priv, { alg: "RS256", kid }, goodPayload({ exp: nowSec - 3600 }));
    const d = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/expired/) });
  });

  it("DENIES a token whose kid is not in the JWKS", async () => {
    const { priv, certs } = await makeKit("kid-1");
    const token = await signJwt(priv, { alg: "RS256", kid: "unknown-kid" }, goodPayload());
    const d = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/unknown signing key/) });
  });

  it("DENIES the 'alg: none' downgrade", async () => {
    const { certs } = await makeKit();
    const token = `${b64url(JSON.stringify({ alg: "none", kid: "kid-1" }))}.${b64url(JSON.stringify(goodPayload()))}.`;
    const d = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/unsupported alg/) });
  });

  it("DENIES a malformed JWT (not three segments)", async () => {
    const { certs } = await makeKit();
    const d = await verifyAccessRequest(reqWith("not-a-jwt"), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 403 });
  });

  it("DENIES (503) when the JWKS is unreachable and there is no cached key", async () => {
    const { priv, kid } = await makeKit();
    const token = await signJwt(priv, { alg: "RS256", kid }, goodPayload());
    const failing: CertsFetcher = async () => {
      throw new Error("certs endpoint -> 502");
    };
    const d = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: failing, nowMs: NOW });
    expect(d).toMatchObject({ ok: false, status: 503 });
  });

  it("reuses STALE cached keys (still admits valid tokens) when a refetch fails after TTL", async () => {
    const { priv, certs, kid } = await makeKit();
    const token = await signJwt(priv, { alg: "RS256", kid }, goodPayload({ exp: nowSec + 100_000 }));
    // 1) prime the cache
    const first = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: certs, nowMs: NOW });
    expect(first.ok).toBe(true);
    // 2) >1h later, refetch throws -> stale keys reused, token still verifies
    const failing: CertsFetcher = async () => {
      throw new Error("down");
    };
    const later = await verifyAccessRequest(reqWith(token), CFG, { certsFetcher: failing, nowMs: NOW + 2 * 60 * 60 * 1000 });
    expect(later.ok).toBe(true);
  });
});

describe("gateApiRequest -- fail-closed-with-escape-hatch policy", () => {
  beforeEach(() => __resetJwksCacheForTest());

  it("DENIES (503) when unconfigured and not opted out (fail closed by default)", async () => {
    const d = await gateApiRequest(reqWith(null), {} as any);
    expect(d).toMatchObject({ ok: false, status: 503, reason: expect.stringMatching(/auth not configured/) });
  });

  it("ALLOWS when unconfigured but ALLOW_UNAUTHENTICATED=true (conscious opt-out)", async () => {
    const d = await gateApiRequest(reqWith(null), { ALLOW_UNAUTHENTICATED: "true" } as any);
    expect(d.ok).toBe(true);
  });

  it("ENFORCES verification when configured", async () => {
    const { priv, certs, kid } = await makeKit();
    const token = await signJwt(priv, { alg: "RS256", kid }, goodPayload());
    const env = { ACCESS_TEAM_DOMAIN: CFG.teamDomain, ACCESS_AUD: CFG.aud } as any;
    const ok = await gateApiRequest(reqWith(token), env, { certsFetcher: certs, nowMs: NOW });
    expect(ok.ok).toBe(true);
    const denied = await gateApiRequest(reqWith(null), env, { certsFetcher: certs, nowMs: NOW });
    expect(denied).toMatchObject({ ok: false, status: 403 });
  });

  it("accessConfig returns null unless BOTH vars are set", async () => {
    expect(accessConfig({} as any)).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: "x" } as any)).toBeNull();
    expect(accessConfig({ ACCESS_AUD: "y" } as any)).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "y" } as any)).toEqual({ teamDomain: "x", aud: "y" });
  });
});
