// Pure render-progress + ETA helpers for the planner render page (#115).
//
// These have NO DOM access on purpose: they unit-test under plain Node
// (tests/render-eta.test.ts) and also load as a classic <script> on
// planner.html, exposing `window.renderEta`. The UMD-ish wrapper picks
// CommonJS when `module` exists (the test harness) and a global otherwise
// (the browser), so the same file serves both with no build step (mirrors
// lora-preflight.js).
//
// Why this exists: the render-status poll envelope (filmJobToPollView ->
// phaseProgress in src/film-render-bridge.ts) only carries a `progress`
// float during the i2v (clips) phase. The keyframe phase pins scene_index
// to 1 (so the old scene-count fraction was 0 the whole phase), and the
// finish / assemble / mux phases carry no per-unit signal at all -- so the
// old computeProgressFraction returned null for big stretches and the UI sat
// at "?%  eta computing..." for the whole render (issue #115, screenshot).
//
// The fix maps the known pipeline phases onto cumulative progress BANDS so the
// overall fraction is defined (never null) for every in-flight phase and never
// runs backwards: the bar reads overall pipeline completion, not just the
// current phase, and the ETA can extrapolate from it. Within a band we use the
// best signal the envelope offers (a real `progress` float, else completed-
// scene count); when a phase has no sub-signal we sit at the band floor, which
// is honest about "phase N of 5 underway" without fabricating motion.
//
// KNOWN LIMITATION (flagged to backend): the keyframe phase emits no per-
// keyframe progress, so its band cannot subdivide -- the bar holds at the band
// floor and the ETA stays "computing..." until i2v starts. Real keyframe-phase
// granularity needs the backend to advance scene_index during keyframe (or the
// already-written-but-unwired render-progress.ts snapshot channel: counts
// keyframe_done/i2v_done) folded into the poll view. That is a backend change.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.renderEta = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Cumulative progress bands, in pipeline order. start + span per phase; the
  // spans sum to 1. i2v (video generation) is the heaviest GPU phase, so it
  // owns the widest band; finish / assemble / mux are comparatively cheap. The
  // phase keys match the `phase` strings the backend poll view emits
  // (src/film-render-bridge.ts phaseProgress: keyframe / i2v / finish /
  // assemble / mux).
  const PIPELINE_PHASES = [
    { key: "keyframe", start: 0.0, span: 0.35 },
    { key: "i2v", start: 0.35, span: 0.5 },
    { key: "finish", start: 0.85, span: 0.08 },
    { key: "assemble", start: 0.93, span: 0.05 },
    { key: "mux", start: 0.98, span: 0.02 },
  ];

  // ETA confidence floors: below this much overall progress, or this little
  // elapsed wall time, a linear extrapolation is dominated by one-time model-
  // load cost and produces wild over-estimates, so we withhold a number and let
  // the caller show "computing..." instead of scaring the user.
  const MIN_FRACTION_FOR_ETA = 0.03;
  const MIN_ELAPSED_MS_FOR_ETA = 10000;

  function clamp01(x) {
    if (typeof x !== "number" || Number.isNaN(x)) return 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  // Best within-phase fraction (0..1) from whatever the envelope carries: a
  // real `progress` float wins; else completed-scene count ((scene_index - 1) /
  // scene_total, scene_index is 1-based from the GPU); else 0 (band floor).
  function subFraction(out) {
    if (typeof out.progress === "number" && out.progress >= 0 && out.progress <= 1) {
      return out.progress;
    }
    if (
      typeof out.scene_index === "number" &&
      typeof out.scene_total === "number" &&
      out.scene_total > 0
    ) {
      return clamp01(Math.max(0, out.scene_index - 1) / out.scene_total);
    }
    return 0;
  }

  // Scan an out.log array from the end for the most recent "Scene N/M" counter
  // and return (N-1)/M. Legacy fallback for envelopes that stream progress as
  // log text rather than structured fields. Returns null when none is found.
  function fractionFromLog(out) {
    if (!Array.isArray(out.log)) return null;
    for (let i = out.log.length - 1; i >= 0; i--) {
      const m = String(out.log[i]).match(/Scene\s+(\d+)\s*\/\s*(\d+)/i);
      if (m) {
        const tot = parseInt(m[2], 10);
        if (tot > 0) return clamp01((parseInt(m[1], 10) - 1) / tot);
        return null;
      }
    }
    return null;
  }

  // Overall pipeline completion fraction (0..1) for a status-poll output
  // envelope, or null when no signal at all is available (the caller then shows
  // "?%" / an indeterminate bar). Phase-aware first (the film pipeline), with a
  // graceful fallback to the raw progress / scene-count / log signals for non-
  // film envelopes (e.g. scatter or a bare RunPod view).
  function progressFraction(out) {
    if (!out || typeof out !== "object") return null;
    const phase = typeof out.phase === "string" ? out.phase.toLowerCase() : null;
    if (phase) {
      const band = PIPELINE_PHASES.find((p) => p.key === phase);
      if (band) return clamp01(band.start + band.span * subFraction(out));
      // Unknown phase string -> fall through to the legacy signals below.
    }
    if (typeof out.progress === "number" && out.progress >= 0 && out.progress <= 1) {
      return out.progress;
    }
    if (
      typeof out.scene_index === "number" &&
      typeof out.scene_total === "number" &&
      out.scene_total > 0
    ) {
      return clamp01(Math.max(0, out.scene_index - 1) / out.scene_total);
    }
    return fractionFromLog(out);
  }

  // Estimated remaining time in ms via linear extrapolation from elapsed wall
  // time and the overall fraction, or null when we are not confident enough to
  // show a number yet (fraction/elapsed below the floors, or a non-positive
  // fraction). totalEst = elapsed / fraction; remaining = totalEst - elapsed.
  function remainingMs(fraction, elapsedMs) {
    if (typeof fraction !== "number" || Number.isNaN(fraction) || fraction <= 0) return null;
    if (typeof elapsedMs !== "number" || Number.isNaN(elapsedMs) || elapsedMs < 0) return null;
    if (fraction < MIN_FRACTION_FOR_ETA || elapsedMs < MIN_ELAPSED_MS_FOR_ETA) return null;
    const totalEstMs = elapsedMs / fraction;
    return Math.max(0, totalEstMs - elapsedMs);
  }

  return {
    PIPELINE_PHASES,
    MIN_FRACTION_FOR_ETA,
    MIN_ELAPSED_MS_FOR_ETA,
    progressFraction,
    remainingMs,
  };
});
