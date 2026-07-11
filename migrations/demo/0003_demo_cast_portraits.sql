-- Vivijure Studio -- PUBLIC DEMO STUDIO cast portraits (backfill). DEMO D1 ONLY. NEVER prod.
--
-- Lives under migrations/demo/ ON PURPOSE: a subdirectory `wrangler d1 migrations apply` does NOT scan,
-- so it can NEVER auto-apply to the production DB. The demo deploy applies it EXPLICITLY, AFTER 0001/0002:
--   wrangler d1 execute <demo-db> --file=migrations/demo/0003_demo_cast_portraits.sql
--
-- Why a separate file: 0001 now seeds portrait_key on a FRESH install, but the LIVE demo D1 already has
-- the four cast rows (9101-9104) from the earlier 0001 apply, and 0001 is INSERT OR IGNORE -- a re-apply
-- of 0001 will NOT touch an existing row. This UPDATE backfills the standing rows so the live demo picks
-- up the portraits without a reseed. The portrait_key is an ABSOLUTE assets.skyphusion.net URL (the demo
-- binds NO R2; cast.js artifactUrl returns an absolute key verbatim); portrait_mime is image/jpeg.
--
-- Idempotent + safe: guarded by `portrait_key IS NULL`, so a re-apply is a no-op and it never clobbers a
-- portrait an operator may have set by hand.
UPDATE cast_members SET portrait_key = 'https://assets.skyphusion.net/vivijure/showcase/cast/kesh.jpg',            portrait_mime = 'image/jpeg' WHERE id = 9101 AND portrait_key IS NULL;
UPDATE cast_members SET portrait_key = 'https://assets.skyphusion.net/vivijure/showcase/cast/the-broker.jpg',      portrait_mime = 'image/jpeg' WHERE id = 9102 AND portrait_key IS NULL;
UPDATE cast_members SET portrait_key = 'https://assets.skyphusion.net/vivijure/showcase/cast/salvage-robot.jpg',   portrait_mime = 'image/jpeg' WHERE id = 9103 AND portrait_key IS NULL;
UPDATE cast_members SET portrait_key = 'https://assets.skyphusion.net/vivijure/showcase/cast/companion-robot.jpg', portrait_mime = 'image/jpeg' WHERE id = 9104 AND portrait_key IS NULL;
