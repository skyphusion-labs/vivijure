// The /api/* auth gate -- mode dispatch between CF Access JWT verification and the built-in
// bearer-token mode (#423), so CF Access becomes optional hardening instead of a deploy
// prerequisite (the cold-deploy dry run's trust-killer: a fresh account had to enable Zero Trust
// in the dashboard before deploy.sh could run).
//
// AUTH_MODE (worker var, wrangler.toml [vars]):
//   "token"  -> Authorization: Bearer <token> checked against the STUDIO_API_TOKEN worker secret
//               with a constant-time compare. deploy.sh mints the token and stores the secret.
//   "access" -> the existing fail-closed Access JWT path (src/access-auth.ts), byte-for-byte.
//   unset/"" -> legacy resolution, unchanged: ACCESS_TEAM_DOMAIN + ACCESS_AUD set -> verify the
//               JWT; else ALLOW_UNAUTHENTICATED==="true" -> conscious dev-only opt-out; else DENY.
//               An existing deploy that predates AUTH_MODE keeps working with zero config change.
//   any other value -> DENY 403. A typo never opens the API.
//
// FAIL CLOSED everywhere: token mode with no secret bound denies everything (403); the
// ALLOW_UNAUTHENTICATED escape hatch does NOT apply once a mode is explicitly selected -- it stays
// scoped to the legacy unconfigured path exactly as before.
//
// Token transport: the Authorization: Bearer header is canonical. Token mode ALSO accepts the
// same token in a `vivijure_token` cookie, because the studio loads artifacts through media
// elements (img.src / video.src / audio.src on /api/artifact/*, the #416 Range paths) and a media
// element cannot attach a header. The frontend token shim (public/auth-token.js) sets the cookie
// (Secure; SameSite=Strict; Path=/api/) alongside localStorage. Same secret, same constant-time
// compare; SameSite=Strict stops cross-site auto-send. This is a transport variant of the one
// token, not a second credential.

import type { Env } from "./env";
import { gateApiRequest, type AccessDecision, type VerifyOpts } from "./access-auth";

export const TOKEN_COOKIE = "vivijure_token";

// Constant-time string compare via SHA-256 digest-compare: hash both sides, then XOR-fold the two
// fixed-length digests. The scan always covers all 32 digest bytes, so neither the length of the
// presented token nor the position of the first mismatch leaks through timing. No runtime
// dependency: crypto.subtle is the Workers runtime (and Node's webcrypto in vitest).
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// Pull the presented token off the request: Authorization: Bearer (canonical) first, then the
// vivijure_token cookie (media-element transport, see the header comment). Returns null when
// neither carries one.
function presentedToken(request: Request): string | null {
  const authz = (request.headers.get("authorization") || "").trim();
  const m = /^Bearer\s+(\S+)$/i.exec(authz);
  if (m) return m[1];
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === TOKEN_COOKIE) {
      const v = part.slice(eq + 1).trim();
      return v.length > 0 ? decodeURIComponent(v) : null;
    }
  }
  return null;
}

// Token-mode gate. FAIL CLOSED: no secret bound, no/empty/bad presented token -> 403. The reasons
// mention "token" on purpose -- the frontend shim keys its paste-a-token prompt on that word, and
// an operator reading the JSON error knows which knob to turn.
export async function verifyTokenRequest(request: Request, env: Env): Promise<AccessDecision> {
  const secret = (env.STUDIO_API_TOKEN || "").trim();
  if (!secret) {
    return {
      ok: false,
      status: 403,
      reason:
        "token mode: STUDIO_API_TOKEN secret is not set -- denying everything (fail closed). " +
        "Set it: openssl rand -hex 32 | npx wrangler secret put STUDIO_API_TOKEN",
    };
  }
  const presented = presentedToken(request);
  if (presented === null) {
    return { ok: false, status: 403, reason: "missing API token: send Authorization: Bearer <your studio API token>" };
  }
  if (!(await constantTimeEqual(presented, secret))) {
    return { ok: false, status: 403, reason: "bad API token" };
  }
  return { ok: true, sub: "studio-api-token", email: null };
}

// The single auth chokepoint routeRequest calls for every /api/* request.
export async function gateApi(request: Request, env: Env, opts: VerifyOpts = {}): Promise<AccessDecision> {
  const mode = (env.AUTH_MODE || "").trim();
  if (mode === "token") return verifyTokenRequest(request, env);
  // "access" and unset both take the existing path unchanged: explicit access mode IS that path,
  // and unset preserves the pre-#423 behavior for deploys that never heard of AUTH_MODE.
  if (mode === "access" || mode === "") return gateApiRequest(request, env, opts);
  return {
    ok: false,
    status: 403,
    reason: `unknown AUTH_MODE ${JSON.stringify(mode)} (expected "access" or "token") -- denying (fail closed)`,
  };
}
