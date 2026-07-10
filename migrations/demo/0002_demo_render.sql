-- Vivijure Studio -- PUBLIC DEMO STUDIO, Phase B render + assistant (#631). DEMO D1 ONLY. NEVER prod.
--
-- Applied EXPLICITLY on the demo D1, AFTER the base schema + the 0001 catalog/content seed:
--   wrangler d1 execute <demo-db> --file=migrations/demo/0002_demo_render.sql
--
-- Phase B turns the read-only demo into a CLICK-TO-RENDER demo, bounded by construction:
--   * demo_renderable -- the SEEDED render menu (constraint 2): one row per renderable shot. The visitor
--     picks an id; that id is the ENTIRE input surface (no free text, no uploads). Every prompt + keyframe
--     is curator-vetted, so the CSAM bright line is satisfied BY CONSTRUCTION (constraint 4). keyframe_key
--     is the R2 key the box reads from the ISOLATED demo prefix; keyframe_url is a fetchable URL for a
--     backend that pulls over the net (the LTX door reads by key). prompt/seconds/quality drive the i2v.
--   * demo_render_queue -- one global box, SERIAL (constraint 3): concurrency 1 via an atomic conditional
--     claim, honest FIFO position, a depth cap (queue-is-full), and a stale-TTL release for a box crash.
--   * demo_counter -- per-IP + global DAILY caps for BOTH render (constraint 4) and chat (constraints 6-7),
--     atomic INSERT..ON CONFLICT..RETURNING (the spend_counter pattern). Bucket key = <kind>:<scope>:<day>.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE. A re-apply is a no-op.

-- ---------------------------------------------------------------------------
-- The seeded render menu (constraint 2). keyframe_key / keyframe_url are PLACEHOLDERS here: the real
-- values are wired after the lead provisions the isolated demo R2 prefix + uploads the curator keyframes
-- (rider 2: values wired, never minted here). A row with an unresolved placeholder key simply fails the
-- render honestly on the box until wired; it is never a silent success.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demo_renderable (
  id            TEXT PRIMARY KEY,            -- stable menu id (referenced by /api/demo/render)
  title         TEXT NOT NULL,               -- menu label
  description   TEXT NOT NULL DEFAULT '',    -- one-line menu blurb
  keyframe_key  TEXT NOT NULL,               -- R2 key the box reads (isolated demo prefix)
  keyframe_url  TEXT NOT NULL,               -- fetchable keyframe URL (motion.backend keyframe_url)
  prompt        TEXT NOT NULL,               -- curator-vetted i2v prompt
  seconds       REAL NOT NULL DEFAULT 5,
  quality       TEXT NOT NULL DEFAULT 'standard',
  ordr          INTEGER NOT NULL DEFAULT 0,  -- menu display order
  enabled       INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO demo_renderable (id, title, description, keyframe_key, keyframe_url, prompt, seconds, quality, ordr, enabled) VALUES
  ('demo-scene-neon-street', 'Neon street, slow push-in',
   'A lone figure under rain-slicked neon; the camera pushes in as the sign flickers.',
   'REPLACE_WITH_DEMO_KEYFRAME_KEY/neon-street.png', 'REPLACE_WITH_DEMO_ARTIFACT_ORIGIN/kf/neon-street.png',
   'cinematic slow push-in on a lone figure under rain-slicked neon signage, volumetric light, shallow depth of field', 5, 'standard', 10, 1),
  ('demo-scene-desert-ride', 'Desert ride at golden hour',
   'A rider crests a dune as dust catches the low sun.',
   'REPLACE_WITH_DEMO_KEYFRAME_KEY/desert-ride.png', 'REPLACE_WITH_DEMO_ARTIFACT_ORIGIN/kf/desert-ride.png',
   'a rider cresting a sand dune at golden hour, blowing dust catching low warm sunlight, wide cinematic shot', 5, 'standard', 20, 1),
  ('demo-scene-harbor-dawn', 'Harbor at dawn, gentle drift',
   'Fishing boats rock in still water as the sky warms.',
   'REPLACE_WITH_DEMO_KEYFRAME_KEY/harbor-dawn.png', 'REPLACE_WITH_DEMO_ARTIFACT_ORIGIN/kf/harbor-dawn.png',
   'fishing boats gently drifting in a calm harbor at dawn, soft mist, warm sky, slow gentle camera drift', 5, 'standard', 30, 1);

-- ---------------------------------------------------------------------------
-- The render queue (constraint 3). One row per submitted render; concurrency 1 across all rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demo_render_queue (
  id            TEXT PRIMARY KEY,            -- job id
  renderable_id TEXT NOT NULL,               -- which seeded menu item
  ip            TEXT NOT NULL,               -- cf-connecting-ip (per-IP accounting + display scoping)
  status        TEXT NOT NULL,               -- 'queued' | 'running' | 'done' | 'failed'
  poll_token    TEXT,                        -- the local-gpu module poll token (set when running)
  clip_url      TEXT,                        -- the public artifact URL (set when done)
  error         TEXT,                        -- honest failure reason (set when failed)
  created_at    INTEGER NOT NULL,            -- enqueue ms; FIFO order + honest position
  claimed_at    INTEGER,                     -- promotion-to-running ms; stale-TTL base
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_queue_status ON demo_render_queue(status, created_at);

-- ---------------------------------------------------------------------------
-- Daily caps (constraints 4, 6-7). bucket = '<kind>:<scope>:<day>', e.g. 'render:ip:1.2.3.4:2026-07-10',
-- 'chat:global:2026-07-10'. Atomic bump returns the post-increment count; the caller compares to the cap.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demo_counter (
  bucket   TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  day      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_counter_day ON demo_counter(day);
