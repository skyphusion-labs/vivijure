// The /api/* auth gate -- mode dispatch between CF Access JWT verification and the built-in
// bearer-token mode (#423), so CF Access becomes optional hardening instead of a deploy
// prerequisite (the cold-deploy dry run's trust-killer: a fresh account had to enable Zero Trust
// in the dashboard before deploy.sh could run).
//
// AUTH_MODE (worker var, wrangler.toml [vars]):
//   "token"  -> Authorization: Bearer <token> checked against the STUDIO_API_TOKEN worker secret
//               with a constant-time compare. deploy.sh mints the token and stores the secret.
//               ALSO accepted (#445): named per-consumer tokens from the D1 api_tokens table
//               (scripts/studio-consumer-token.sh mints/revokes), so a bot or satellite gets its
//               own independently revocable credential instead of reusing the operator login.
//   "access" -> the existing fail-closed Access JWT path (src/access-auth.ts), byte-for-byte.
//   "demo"   -> the public demo studio (#625): GET/HEAD allowed for EVERYONE, unauthenticated;
//               every mutating method (POST/PUT/PATCH/DELETE/anything else) denies 403 for
//               everyone -- a bearer token does not unlock writes, because a demo deploy has no
//               writes to unlock. Zero-spend is primarily enforced by ABSENT bindings in the demo
//               deploy; this mode is the independent second barrier at the gate.
//   unset/"" -> legacy resolution, unchanged: ACCESS_TEAM_DOMAIN + ACCESS_AUD set -> verify the
//               JWT; else ALLOW_UNAUTHENTICATED==="true" -> conscious dev-only opt-out; else DENY.
//               An existing deploy that predates AUTH_MODE keeps working with zero config change.
//   any other value -> DENY 403. A typo never opens the API.
//
// FAIL CLOSED everywhere: token mode with no secret bound denies everything (403); the
// ALLOW_UNAUTHENTICATED escape hatch does NOT apply once a mode is explicitly selected -- it stays
// scoped to the legacy unconfigured path exactly as before.
//
// Token transport: the Authorization: Bearer header is canonical and authenticates EVERY method.
// Token mode ALSO accepts the same token in a `vivijure_token` cookie -- but for GET/HEAD ONLY.
// The cookie exists because the studio loads artifacts through media elements (img.src /
// video.src / audio.src on /api/artifact/*, the #416 Range paths) and a media element cannot
// attach a header; media elements only ever issue GETs, so scoping the cookie's authority to
// safe methods costs zero call sites while making the cookie useless for anything state-changing
// even in a SameSite-bypass scenario (defense in depth). Every mutation (POST/PUT/PATCH/DELETE)
// requires the explicit bearer header, which all fetch() call sites attach via the shim. The
// frontend token shim (public/auth-token.js) sets the cookie (Secure; SameSite=Strict;
// Path=/api/) alongside localStorage. Same secret, same constant-time compare; SameSite=Strict
// stops cross-site auto-send. One credential; the second transport is read-only.

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

// Pull the presented token off the request: Authorization: Bearer (canonical, any method) first,
// then the vivijure_token cookie -- honored for GET/HEAD ONLY (media-element transport, see the
// header comment). A cookie on a mutating method is IGNORED, so the request reads as
// unauthenticated and denies with the bearer-required reason. Returns null when nothing usable
// carries a token.
function presentedToken(request: Request): string | null {
  const authz = (request.headers.get("authorization") || "").trim();
  const m = /^Bearer\s+(\S+)$/i.exec(authz);
  if (m) return m[1];
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null; // cookie authority is read-only
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === TOKEN_COOKIE) {
      const v = part.slice(eq + 1).trim();
      if (v.length === 0) return null;
      // A value that does not percent-decode is not a usable token: treat it as no token
      // presented so the request lands in the normal deny path instead of throwing.
      try {
        return decodeURIComponent(v);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// SHA-256 hex of a string; the storage form of a named token (#445). The plaintext token never
// touches D1 -- mint hashes it, the gate hashes the presented value and looks the hash up.
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Named per-consumer tokens (#445): a D1 row per consumer (api_tokens, migration 0009), issued and
// revoked independently of the operator login. Lookup is by hash equality on a random 256-bit
// value, so index-lookup timing leaks nothing useful (there is no partial-match progression an
// attacker can climb). Returns the consumer name on a live match, null otherwise. FAIL CLOSED for
// this credential class: no DB binding or a D1 error just means no named token matches -- the
// operator secret path is untouched either way.
async function namedTokenConsumer(presented: string, env: Env): Promise<string | null> {
  if (!env.DB) return null;
  try {
    const hash = await sha256Hex(presented);
    const row = await env.DB.prepare(
      "SELECT name FROM api_tokens WHERE token_hash = ?1 AND revoked_at IS NULL",
    )
      .bind(hash)
      .first<{ name: string }>();
    return row?.name ?? null;
  } catch {
    return null; // table missing (migration not applied) or D1 down -> named tokens deny
  }
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
    // 403 (not 405) by design: the method is fine, the CREDENTIAL is missing/insufficient. This
    // is also the branch a cookie-only mutation lands in (the cookie transport is GET/HEAD-only).
    return { ok: false, status: 403, reason: "missing API token: send Authorization: Bearer <your studio API token>" };
  }
  if (await constantTimeEqual(presented, secret)) {
    return { ok: true, sub: "studio-api-token", email: null };
  }
  // Not the operator token: try the named per-consumer tokens (#445). Same transport rules
  // (bearer any method, cookie GET/HEAD only) because both ride presentedToken above. The deny
  // reason is IDENTICAL to the operator miss so a probe cannot tell which class it failed.
  const consumer = await namedTokenConsumer(presented, env);
  if (consumer !== null) {
    return { ok: true, sub: `api-token:${consumer}`, email: null };
  }
  return { ok: false, status: 403, reason: "bad API token" };
}

// True when this deployment is the public demo studio (#625). Exported so the /api/modules route
// can project `host.readonly` from the SAME normalization the gate dispatches on -- one definition
// of "demo mode", two consumers. CANONICAL: src/modules/registry.ts carries a structural twin
// (isDemoEnv) because the registry stays import-free of Env by rule; change both together.
export function isDemoMode(env: Env): boolean {
  return (env.AUTH_MODE || "").trim() === "demo";
}

// Capability catalogs (planning models, TTS voices) name backends a DEMO deploy cannot invoke: no
// gateway/provider credential is bound, and the routes that would use them are denied at the gate.
// Serving the full list there advertises capability the deployment does not have (a picker of
// frontier models that can never run), so a demo serves the EMPTY list; both pickers have an
// authored empty state. Every other mode serves the catalog untouched.
export function catalogForDeploy<T>(env: Env, catalog: readonly T[]): readonly T[] {
  return isDemoMode(env) ? [] : catalog;
}

// Demo-mode gate (#625): reads open to everyone, writes closed to everyone. Deliberately ignores
// any presented credential -- there is no operator path into a demo deploy through the API, so a
// leaked/guessed token is worth nothing here. The deny reason names the demo so a visitor poking
// the API understands what they hit.
// #631 Phase B: the ONLY write routes a demo deploy allows -- the seeded-menu render + the capped OSS
// assistant. Every OTHER mutation (incl. the prod render/plan/chat routes) stays denied. One allowlist,
// auditable in one place; the demo's entire write surface is these two routes.
export const DEMO_WRITE_ROUTES: ReadonlySet<string> = new Set(["/api/demo/render", "/api/demo/chat"]);

export function verifyDemoRequest(request: Request): AccessDecision {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { ok: true, sub: "demo-visitor", email: null };
  }
  if (method === "POST" && DEMO_WRITE_ROUTES.has(new URL(request.url).pathname)) {
    return { ok: true, sub: "demo-visitor", email: null };
  }
  return {
    ok: false,
    status: 403,
    reason: "demo studio is read-only: mutations are disabled on this deployment. Run your own studio to render.",
  };
}

// The single auth chokepoint routeRequest calls for every /api/* request.
export async function gateApi(request: Request, env: Env, opts: VerifyOpts = {}): Promise<AccessDecision> {
  const mode = (env.AUTH_MODE || "").trim();
  if (mode === "token") return verifyTokenRequest(request, env);
  if (mode === "demo") return verifyDemoRequest(request);
  // "access" and unset both take the existing path unchanged: explicit access mode IS that path,
  // and unset preserves the pre-#423 behavior for deploys that never heard of AUTH_MODE.
  if (mode === "access" || mode === "") return gateApiRequest(request, env, opts);
  return {
    ok: false,
    status: 403,
    reason: `unknown AUTH_MODE ${JSON.stringify(mode)} (expected "access", "token", or "demo") -- denying (fail closed)`,
  };
}
