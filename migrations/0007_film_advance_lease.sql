-- Vivijure Studio -- film-advance lease (migration 0007, S4 race fix).
--
-- advanceFilmJob does an unlocked read-modify-write on the R2 film-job doc and is driven
-- CONCURRENTLY by the 1-minute cron sweep (render-sweep.ts) and every client status poll
-- (hPollRender / hPollFilm). Two drivers in the same tick can each observe phase N incomplete
-- and BOTH submit the next phase's external work (clip start, dialogue batch, per-shot
-- finish/speech/master steps, mux, notify) -- duplicated GPU spend -- and clobber each other's
-- doc writes (a lost poll token orphans a RunPod job).
--
-- The fix is the house claimFinish pattern (renders-db.ts): a conditional-UPDATE lease on the
-- film's renders row, checked via meta.changes, so exactly ONE driver advances a film per tick.
-- The losing driver reads the doc read-only. `advance_lease` holds the winner's lease expiry
-- (unix ms); NULL = unleased. Expiry-bounded so a crashed winner never wedges the job: the next
-- driver past the expiry claims it fresh (the re-grant / retry discipline).
--
-- Additive (ALTER TABLE ADD COLUMN only) -> rides the normal auto-apply; no manual gate.

ALTER TABLE renders ADD COLUMN advance_lease INTEGER;
