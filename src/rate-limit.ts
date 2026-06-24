// Rate limiting for the GPU/spend endpoints (security finding F3): denial-of-wallet protection.
//
// The studio's render/train/generate routes each submit a RunPod GPU job or paid AI work. With no
// limit, a compromised or abused session can hammer them and burn the operator's balance (Conrad
// self-funds). This caps the submission rate.
//
// Posture: FAIL OPEN. Rate limiting is availability-protective, NOT an auth gate -- a limiter blip
// (binding unbound or `.limit()` throws) must never block a legitimate render. We allow + warn in
// that case; the wallet exposure during a brief limiter outage is bounded. (This is the deliberate
// OPPOSITE of the F2 auth backstop, which fails closed.)
//
// Backend: the Cloudflare native Rate Limiting binding (`env.SPEND_RATE_LIMITER.limit({ key })`),
// zero-storage and per-colo. The binding is added to wrangler.toml by infra (Strummer); this module
// authors the Worker-side logic + the `Env` shape. The backend is swappable for a Durable Object
// token bucket later if cross-colo (global) accuracy is ever required.

// The native Rate Limiting binding's shape (a single fixed {limit, period} policy per binding).
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface SpendLimitEnv {
  SPEND_RATE_LIMITER?: RateLimitBinding;
}

// Retry-After (seconds) advertised on a 429. Matches the binding's configured period (Strummer sets
// the real period on the binding; this is the client hint).
export const SPEND_RETRY_AFTER_SECONDS = 60;

// The POST routes that submit GPU jobs or paid AI work. Kept as explicit regexes (not a dependency on
// the router) so the spend surface is auditable in one place; :id / child segments are wildcarded.
const SPEND_PATTERNS: RegExp[] = [
  /^\/api\/storyboard\/render$/,
  /^\/api\/render\/clips$/,
  /^\/api\/render\/film$/,
  /^\/api\/storyboard\/render\/scatter$/,
  /^\/api\/storyboard\/render-from-keyframes$/,
  /^\/api\/storyboard\/renders\/[^/]+\/animate-cloud$/,
  /^\/api\/storyboard\/renders\/[^/]+\/animate-hybrid$/,
  /^\/api\/cast\/[^/]+\/train-lora$/,
  /^\/api\/cast\/[^/]+\/generate-refs$/,
  /^\/api\/storyboard\/score-bed$/,
  /^\/api\/storyboard\/music-generate$/,
];

// True for a request that triggers GPU/paid spend and so must pass the limiter.
export function isSpendRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return SPEND_PATTERNS.some((re) => re.test(pathname));
}

export type SpendLimitResult = { ok: true } | { ok: false; retryAfter: number };

let warnedUnbound = false;

// Enforce the spend limit for a request already known to be a spend route. Fails OPEN on an unbound
// or throwing limiter (warns once per isolate); denies only on an explicit over-limit verdict.
export async function enforceSpendLimit(request: Request, env: SpendLimitEnv): Promise<SpendLimitResult> {
  const limiter = env.SPEND_RATE_LIMITER;
  if (!limiter) {
    if (!warnedUnbound) {
      warnedUnbound = true;
      console.warn("rate-limit: SPEND_RATE_LIMITER unbound -> spend endpoints are NOT rate-limited (fail open). Bind it in wrangler.toml.");
    }
    return { ok: true };
  }
  // Key by client IP so one abusive source is throttled without starving others. (Single-operator
  // today; IP keying is the right primitive if this is ever fronted for multiple users.)
  const key = request.headers.get("cf-connecting-ip") || "global";
  try {
    const { success } = await limiter.limit({ key });
    return success ? { ok: true } : { ok: false, retryAfter: SPEND_RETRY_AFTER_SECONDS };
  } catch (e) {
    console.warn(`rate-limit: limiter errored (${(e as Error).message}) -> allowing (fail open)`);
    return { ok: true };
  }
}

// Test-only: reset the one-time unbound warning latch.
export function __resetRateLimitWarnForTest(): void {
  warnedUnbound = false;
}
