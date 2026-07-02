-- Daily spend-submission counter (S4 denial-of-wallet floor). One row per UTC day; the spend
-- routes atomically increment it and deny past SPEND_DAILY_CEILING (src/rate-limit.ts). Counting
-- SUBMISSIONS, not dollars: the studio cannot see RunPod pricing, but every spend route is one
-- bounded GPU/paid-AI job, so a per-day submission cap is an honest ceiling the operator can size.
CREATE TABLE IF NOT EXISTS spend_counter (
  day TEXT PRIMARY KEY, -- UTC date, YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0
);
