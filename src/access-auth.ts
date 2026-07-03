// Cloudflare Access JWT verification -- a fail-CLOSED in-Worker auth backstop (security finding F2).
//
// The studio Worker has no per-request auth of its own; safety rests entirely on a Cloudflare Access
// application at the edge. A single edge-config gap (e.g. F1: a workers.dev hostname the Access app
// does not cover) reopens the whole API. This module makes that un-reopenable: it verifies the Access
// JWT (the `Cf-Access-Jwt-Assertion` header Access injects) INSIDE the Worker, so the data plane never
// depends solely on the edge gate.
//
// Posture (the bar): FAIL CLOSED. Deny if the assertion is absent, malformed, expired, not yet valid,
// has the wrong audience/issuer, or is cryptographically UNVERIFIABLE (unknown key, bad signature,
// JWKS unreachable with no usable cached key). We verify the RS256 signature against the team's JWKS
// (`https://<team-domain>/cdn-cgi/access/certs`), never just the presence of a token.
//
// No runtime dependency: parsing + verification use WebCrypto (crypto.subtle) and the standard
// atob/TextEncoder, which the Workers runtime provides.

import type { Env } from "./env";

export interface AccessConfig {
  teamDomain: string; // e.g. "skyphusion.cloudflareaccess.com"
  aud: string; // the Access application AUD tag
}

export type AccessDecision =
  | { ok: true; sub: string | null; email: string | null }
  | { ok: false; status: number; reason: string };

// Read the (deploy-specific, non-secret) Access config from env. Returns null when unconfigured so
// the caller can apply the fail-closed-with-escape-hatch policy.
export function accessConfig(env: Env): AccessConfig | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN || "").trim();
  const aud = (env.ACCESS_AUD || "").trim();
  if (!teamDomain || !aud) return null;
  return { teamDomain, aud };
}

// The header Access injects on every request that passed the edge gate. (Access also sets a
// `CF_Authorization` cookie; the header is the canonical service-side assertion.)
const ASSERTION_HEADER = "cf-access-jwt-assertion";

// ---- base64url + JSON helpers -------------------------------------------------------------------

function base64UrlToBytes(s: string): Uint8Array {
  // JWT segments are base64url with no padding.
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJsonSegment(seg: string): Record<string, unknown> {
  const json = new TextDecoder().decode(base64UrlToBytes(seg));
  const obj = JSON.parse(json);
  if (!obj || typeof obj !== "object") throw new Error("segment is not a JSON object");
  return obj as Record<string, unknown>;
}

// ---- JWKS fetch + per-isolate cache -------------------------------------------------------------

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface CachedKeys {
  byKid: Map<string, CryptoKey>;
  fetchedAt: number;
}

// Per-isolate cache keyed by team domain. Stale keys are kept and reused if a refetch fails (Access
// signing keys rotate slowly), so a transient certs-endpoint blip does not brick the API; but with NO
// usable key we deny (fail closed), never admit an unverified token.
const jwksCache = new Map<string, CachedKeys>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

// Injectable for tests; defaults to the global fetch against the team's certs endpoint.
export type CertsFetcher = (teamDomain: string) => Promise<{ keys?: Jwk[] }>;

const defaultCertsFetcher: CertsFetcher = async (teamDomain) => {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`certs endpoint -> ${res.status}`);
  return (await res.json()) as { keys?: Jwk[] };
};

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function loadKeys(teamDomain: string, fetcher: CertsFetcher, nowMs: number): Promise<CachedKeys> {
  const cached = jwksCache.get(teamDomain);
  if (cached && nowMs - cached.fetchedAt < JWKS_TTL_MS) return cached;

  try {
    const doc = await fetcher(teamDomain);
    const byKid = new Map<string, CryptoKey>();
    for (const jwk of doc.keys ?? []) {
      if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
      byKid.set(jwk.kid, await importRsaKey(jwk));
    }
    if (byKid.size === 0) throw new Error("certs document had no usable RSA keys");
    const fresh: CachedKeys = { byKid, fetchedAt: nowMs };
    jwksCache.set(teamDomain, fresh);
    return fresh;
  } catch (e) {
    // Refetch failed: reuse stale keys if we have any (slow rotation makes this safe + available).
    if (cached) {
      console.warn(`access: JWKS refetch failed (${(e as Error).message}); using cached keys`);
      return cached;
    }
    throw e; // no usable key at all -> caller denies (fail closed)
  }
}

// ---- verification -------------------------------------------------------------------------------

export interface VerifyOpts {
  certsFetcher?: CertsFetcher;
  nowMs?: number;
}

// Verify the Access assertion on a request. ALWAYS fail closed: any uncertainty is a denial.
export async function verifyAccessRequest(
  request: Request,
  cfg: AccessConfig,
  opts: VerifyOpts = {},
): Promise<AccessDecision> {
  const token = request.headers.get(ASSERTION_HEADER);
  if (!token) return { ok: false, status: 403, reason: "missing Cf-Access-Jwt-Assertion" };
  const nowMs = opts.nowMs ?? Date.now();
  const fetcher = opts.certsFetcher ?? defaultCertsFetcher;

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 403, reason: "malformed JWT" };
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJsonSegment(headerSeg);
    payload = decodeJsonSegment(payloadSeg);
  } catch {
    return { ok: false, status: 403, reason: "undecodable JWT segments" };
  }

  if (header.alg !== "RS256") return { ok: false, status: 403, reason: `unsupported alg ${String(header.alg)}` };
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) return { ok: false, status: 403, reason: "JWT header missing kid" };

  let keys: CachedKeys;
  try {
    keys = await loadKeys(cfg.teamDomain, fetcher, nowMs);
  } catch (e) {
    // Unverifiable (no keys) -> deny. 503 because it is an availability/config fault, not the
    // caller's: it signals "we cannot verify right now", distinct from a 403 bad token.
    return { ok: false, status: 503, reason: `cannot load Access keys: ${(e as Error).message}` };
  }
  const key = keys.byKid.get(kid);
  if (!key) return { ok: false, status: 403, reason: `unknown signing key (kid ${kid})` };

  const signed = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  let sig: Uint8Array;
  try {
    sig = base64UrlToBytes(signatureSeg);
  } catch {
    return { ok: false, status: 403, reason: "undecodable signature" };
  }
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    sig,
    signed,
  );
  if (!valid) return { ok: false, status: 403, reason: "bad signature" };

  // Claim checks (all enforced; any miss denies).
  const nowSec = Math.floor(nowMs / 1000);
  const skew = 60; // small clock-skew tolerance
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : null;
  if (exp === null || nowSec > exp + skew) return { ok: false, status: 403, reason: "token expired" };
  if (nbf !== null && nowSec + skew < nbf) return { ok: false, status: 403, reason: "token not yet valid" };

  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (iss !== `https://${cfg.teamDomain}`) return { ok: false, status: 403, reason: "wrong issuer" };

  const audClaim = payload.aud;
  const auds = Array.isArray(audClaim) ? audClaim : typeof audClaim === "string" ? [audClaim] : [];
  if (!auds.includes(cfg.aud)) return { ok: false, status: 403, reason: "wrong audience" };

  return {
    ok: true,
    sub: typeof payload.sub === "string" ? payload.sub : null,
    email: typeof payload.email === "string" ? payload.email : null,
  };
}

// Gate decision for an incoming request to a protected path (the caller uses this for /api/*).
//   - configured (ACCESS_TEAM_DOMAIN + ACCESS_AUD set) -> VERIFY the JWT, fail CLOSED on any problem.
//   - unconfigured + ALLOW_UNAUTHENTICATED==="true" -> allow (the conscious, documented opt-out for
//     local/dev/test or a deployer fronting the Worker with their own auth proxy); warn once.
//   - unconfigured otherwise -> DENY (503), fail CLOSED by default. A downstream deployer who has not
//     established an auth boundary is never silently served. Armed deploys take the configured path
//     above, so this default does not affect them. See docs/SECURITY.md.
let warnedOptOut = false;
export async function gateApiRequest(
  request: Request,
  env: Env,
  opts: VerifyOpts = {},
): Promise<AccessDecision> {
  const cfg = accessConfig(env);
  if (cfg) return verifyAccessRequest(request, cfg, opts);
  if ((env.ALLOW_UNAUTHENTICATED || "").trim() === "true") {
    if (!warnedOptOut) {
      warnedOptOut = true;
      // Structured event for the tail/Loki channel (docs/observability.md): queryable as
      // ev="auth.allow_unauthenticated" so an accidentally-OPEN deploy is VISIBLE in tail logs,
      // not just buried in a prose warn line. Once per isolate (the warnedOptOut guard).
      console.log(
        JSON.stringify({
          ev: "auth.allow_unauthenticated",
          msg: "in-Worker auth verification DISABLED (ALLOW_UNAUTHENTICATED=true; edge gate / own proxy only)",
        }),
      );
      console.warn(
        "access: ALLOW_UNAUTHENTICATED=true -> in-Worker Access verification DISABLED (edge gate only). NOT for a public/multi-tenant deploy; arm ACCESS_TEAM_DOMAIN + ACCESS_AUD instead.",
      );
    }
    return { ok: true, sub: null, email: null };
  }
  return {
    ok: false,
    status: 503,
    reason: "auth not configured: set ACCESS_TEAM_DOMAIN + ACCESS_AUD to arm the backstop, or ALLOW_UNAUTHENTICATED=true to consciously opt out (dev/own-proxy only)",
  };
}

// Test-only: reset the per-isolate JWKS cache so cases do not bleed into each other.
export function __resetJwksCacheForTest(): void {
  jwksCache.clear();
}
