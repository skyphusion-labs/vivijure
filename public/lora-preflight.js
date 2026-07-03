// Pure helpers for the render-page LoRA training preflight (v0.221.0).
//
// These have NO DOM access on purpose: they unit-test under plain Node
// (tests/lora-preflight.test.ts) and also load as a classic <script> on
// planner.html, exposing `window.loraPreflight`. The UMD-ish wrapper picks
// CommonJS when `module` exists (the test harness) and a global otherwise
// (the browser), so the same file serves both with no build step.
//
// Why this exists: a bound character whose LoRA is not trained-and-ready gets
// its LoRA RETRAINED inline (~20 min) on EVERY render via the server fail-safe.
// That used to fire silently. The preflight reads FRESH cast state right before
// submit and warns when any bound slot will trigger the retrain tax.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.loraPreflight = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // A cast member's LoRA is reusable (the GPU skips training) only when the
  // canonical training finished: lora_status === 'ready' AND a loras/ key
  // exists. This mirrors the server's reuse gate (resolveCastLoras); anything
  // short of it means the fail-safe inline retrain fires for that slot.
  function isCastLoraReady(cast) {
    return !!(cast && cast.lora_status === "ready" && cast.lora_key);
  }

  // Given the planner's {slot: cast_id} bindings and the current cast catalog
  // (rows from /api/cast, incl. lora_status + lora_key), return the bound slots
  // whose LoRA is NOT ready -- i.e. the ones that will be retrained inline.
  // Each entry is { slot, castId, name }, sorted by slot for a stable warning.
  // Unknown cast ids (not in the catalog) are skipped: a deleted member is
  // reconciled out of the bindings elsewhere, so flagging it here would be noise.
  //
  // S9 (F13): a cast id is an opaque public id (UUID string), never a number.
  // Keys and binding values are compared as verbatim strings -- no Number()
  // coercion, which would map every UUID to NaN and silently empty the warning.
  function unreadyBoundLoraSlots(bindings, catalog) {
    const byId = new Map();
    for (const c of catalog || []) {
      if (c && c.id != null) byId.set(String(c.id), c);
    }
    const out = [];
    for (const slot of Object.keys(bindings || {})) {
      if (typeof slot !== "string" || slot.length === 0) continue;
      const id = bindings[slot];
      if (typeof id !== "string" || id.length === 0) continue;
      const cast = byId.get(id);
      if (!cast) continue;
      if (!isCastLoraReady(cast)) {
        out.push({ slot, castId: id, name: (cast.name && String(cast.name)) || ("slot " + slot) });
      }
    }
    out.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    return out;
  }

  // Stable identity for a set of unready slots, so the UI can tell whether the
  // user is re-clicking render against the SAME warning (proceed) or a changed
  // one (warn again).
  function loraSlotSignature(unready) {
    return (unready || [])
      .map((u) => u.slot + ":" + u.castId)
      .sort()
      .join("|");
  }

  return { isCastLoraReady, unreadyBoundLoraSlots, loraSlotSignature };
});
