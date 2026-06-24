// Pure cast-selection helper for the cast page (#146).
//
// No DOM access: unit-tests under plain Node (tests/cast-select.test.ts) and
// loads as a classic <script> on cast.html, exposing `window.castSelect`. The
// UMD-ish wrapper picks CommonJS when `module` exists (the test harness) and a
// global otherwise (the browser), so one file serves both with no build step
// (mirrors lora-preflight.js / render-eta.js).
//
// Why this exists: on a fresh load the cast list rendered but nothing was
// selected and the detail pane stayed on "pick a character", even when
// characters existed -- the visual list and the detail pane were out of sync.
// pickInitialCastId decides which character to open on load: the most recently
// viewed one if it still exists, else the first in the list, else null (empty
// cast). The caller then runs the normal select path so highlight + detail
// populate together.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.castSelect = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Choose the cast id to open on initial load. `lastViewedId` is the
  // persisted most-recently-viewed id (may be null, or stale after a delete).
  // Returns the lastViewed id when it still exists in the catalog, else the
  // first character's id, else null when the catalog is empty.
  function pickInitialCastId(cast, lastViewedId) {
    if (!Array.isArray(cast) || cast.length === 0) return null;
    if (lastViewedId != null && cast.some((c) => c && c.id === lastViewedId)) {
      return lastViewedId;
    }
    return cast[0].id;
  }

  return { pickInitialCastId };
});
