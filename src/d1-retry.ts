// Transient-D1 retry for the render-advance hot path.
//
// The every-60s cron sweep (sweepUnresolvedJobs -> advanceScatterJob / advanceFilmJob ->
// updateRenderFromView) IS the self-heal for client-less renders. But a transient
// `D1_ERROR: internal error` (a Cloudflare D1 platform blip -- intermittent, clears in seconds)
// thrown by any D1 op aborts the whole advance: render-sweep catches it, warns, and skips, so the
// shard never progresses and every 60s retry re-fails the same way through the flaky window. A
// proven failure mode: two full scatter renders wedged with one shard stuck polling RIFE and the
// other at keyframe, GPU idle, until the ~30-min dead-shard watchdog failed them.
//
// withD1Retry transparently retries ONLY transient D1 errors a few times with short backoff, so a
// blip self-heals inside the tick. Constraint / SQL / logic errors are re-thrown immediately --
// those are real and must fail fast, never spin. The wrapped ops are all keyed on job_id/id and
// write absolute values (terminal-guarded), so they are idempotent under retry.

/** Errors that are real and must NOT be retried (a constraint violation, bad SQL, schema mismatch).
 *  Checked first so a `D1_ERROR: UNIQUE constraint failed` fails fast even though it says D1_ERROR. */
const D1_FATAL =
  /(constraint failed|no such (table|column|index)|syntax error|datatype mismatch|not null|unique|readonly|malformed|ambiguous column|too many|foreign key)/i;

/** Transient signatures worth retrying: D1 platform blips and dropped connections. */
const D1_TRANSIENT =
  /(d1_error[\s\S]*?(internal error|transient|temporar|overloaded|try again|reset|timed? ?out|unavailable))|(network connection lost)|(storage (caused|operation)[\s\S]*?(reset|lost|error))|(\b50[02-4]\b)/i;

export function isTransientD1Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (!msg) return false;
  if (D1_FATAL.test(msg)) return false; // a real error -- fail fast
  return D1_TRANSIENT.test(msg);
}

/** A short, queryable signature for a D1 error -- the first line, truncated. Goes into the
 *  structured d1.retry / d1.exhausted / d1.error log lines so a blip is greppable in
 *  observability rather than a multi-line stack buried in a console.warn. */
export function d1ErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (msg.split("\n")[0] || "unknown").slice(0, 120);
}

export interface D1RetryOptions {
  /** Total attempts including the first (default 4: initial + 3 retries). */
  attempts?: number;
  /** Base backoff in ms; delay before retry i is base * 2^i (+ jitter): ~50, 100, 200. */
  baseDelayMs?: number;
  /** Injectable sleep so tests don't wait on the wall clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Short op name for the structured d1.retry / d1.exhausted log lines (observability). */
  label?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying ONLY transient D1 errors with short exponential backoff. Re-throws a
 *  non-transient error (or the last transient one after exhausting attempts) so the caller's
 *  existing failure handling still runs. */
export async function withD1Retry<T>(fn: () => Promise<T>, opts: D1RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const base = Math.max(1, opts.baseDelayMs ?? 50);
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = isTransientD1Error(err);
      if (i === attempts - 1 || !transient) {
        // A non-transient error fails fast; an EXHAUSTED transient blip is logged so a recurring
        // D1 flaky window shows up as a queryable d1.exhausted count, not a silent throw.
        if (transient) {
          console.log(JSON.stringify({ ev: "d1.exhausted", op: opts.label, attempts: i + 1, code: d1ErrorCode(err) }));
        }
        throw err;
      }
      console.log(JSON.stringify({ ev: "d1.retry", op: opts.label, attempt: i + 1, code: d1ErrorCode(err) }));
      const jitter = Math.floor(Math.random() * base);
      await sleep(base * 2 ** i + jitter);
    }
  }
  throw lastErr;
}
