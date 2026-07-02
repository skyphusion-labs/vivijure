// Planner module registry: one fetch of GET /api/modules, shared helpers for every
// self-assembling control in the planner. No feature names or providers are
// hardcoded here -- only hook names from the vivijure-module/2 contract.
(function (global) {
  let cache = null;
  let loadPromise = null;

  function load() {
    if (cache) return Promise.resolve(cache);
    if (!loadPromise) {
      loadPromise = fetch("/api/modules")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          cache = d || { modules: [], hooks: {}, catalog: [] };
          return cache;
        })
        .catch(() => {
          cache = { modules: [], hooks: {}, catalog: [] };
          return cache;
        });
    }
    return loadPromise;
  }

  function byName(data) {
    return Object.fromEntries((data.modules || []).map((m) => [m.name, m]));
  }

  function moduleLabel(mod) {
    if (!mod) return "";
    const l = mod.provides && mod.provides[0] && mod.provides[0].label;
    return (l && String(l).trim()) || mod.name;
  }

  function hookModules(hook, filter) {
    if (!cache) return [];
    const order = cache.hooks && Array.isArray(cache.hooks[hook]) ? cache.hooks[hook] : [];
    const named = byName(cache);
    const mods = order.map((n) => named[n]).filter(Boolean);
    return filter ? mods.filter(filter) : mods;
  }

  function musicScoreModules() {
    return hookModules("score", (m) => m.config_schema && m.config_schema.prompt);
  }

  function narrationScoreModules() {
    return hookModules("score", (m) => m.config_schema && m.config_schema.text);
  }

  function beatSyncScoreModules() {
    return hookModules("score", (m) => m.config_schema && m.config_schema.clip_seconds);
  }

  function motionBackendModules() {
    return hookModules("motion.backend");
  }

  // Classify a motion.backend module's locality from its manifest ui.locality hint. Three values:
  //   "local" -- a genuinely local consumer GPU (a homelab card).
  //   "byo"   -- your-own-RunPod-endpoint (BYO keys); the own-gpu module, which backs the
  //              server-side CONTRACT-2.27 finalize route. NOT a homelab card -- badging it
  //              "Local (your GPU)" would be dishonest.
  //   "cloud" -- a rented datacenter i2v model.
  // Prefer the manifest hint (a projection of the registry, the right source of truth); FALL BACK
  // to the legacy name check ("own-gpu" was the BYO default door) -> "byo" ONLY when a module does
  // not declare ui.locality, so classification is byte-identical during the rollout window while
  // the motion.backend manifests gain ui.locality. The "datacenter" alias maps to cloud.
  // REMOVE the name-check fallback once every motion.backend manifest carries ui.locality
  // (final cleanup -- a later follow-up).
  function motionLocality(mod) {
    const loc = mod && mod.ui && typeof mod.ui.locality === "string"
      ? mod.ui.locality.trim().toLowerCase()
      : "";
    if (loc === "local") return "local";
    if (loc === "byo") return "byo";
    if (loc === "cloud" || loc === "datacenter") return "cloud";
    return mod && mod.name === "own-gpu" ? "byo" : "cloud"; // legacy fallback (removable)
  }

  // The GPU-finalize door: bound to the BYO module (own-gpu) SPECIFICALLY, because it gates the
  // server-side CONTRACT-2.27 finalize route, which is hardcoded to motion backend own-gpu. Keying
  // on "byo" (NOT generic "local") means a new homelab "local" door is fully selectable for motion
  // yet can never hijack the own-gpu finalize route. Name kept ownGpuModule for caller compat.
  function ownGpuModule() {
    return motionBackendModules().find((m) => motionLocality(m) === "byo") || null;
  }

  // Cloud i2v doors (the animate-cloud / hybrid model picker): datacenter-rented backends only.
  // Excludes byo (the own-gpu finalize door) and local (the homelab door, which the main render
  // backend selector surfaces directly, not via this cloud picker).
  function cloudMotionModules() {
    return motionBackendModules().filter((m) => motionLocality(m) === "cloud");
  }

  function planEnhanceInstalled() {
    return hookModules("plan.enhance").length > 0;
  }

  function cloudModelLabel(id) {
    const hit = motionBackendModules().find((m) => m.name === id);
    if (hit) return moduleLabel(hit);
    // legacy rows may still carry Workers-AI-style model ids from the monolith era
    if (id && String(id).includes("/")) return String(id).split("/").pop();
    return id ? String(id) : "";
  }

  function cloudModelOptions() {
    return cloudMotionModules().map((m) => [m.name, moduleLabel(m)]);
  }

  function gpuMotionLabel() {
    const m = ownGpuModule();
    return m ? moduleLabel(m) : "GPU i2v";
  }

  // The keyframe hook is pick_one; the planner default is the ui.order-first serving module. Its
  // manifest keyframe_label is the compact display token for the keyframe-stage backend/model (e.g.
  // "SDXL"), which the planner projects inline instead of hardcoding the model name. First serving
  // module that declares one wins; fall back to "SDXL" (the GPU keyframe default) when none is
  // declared, so the copy is never blank.
  function keyframeLabel() {
    for (const m of hookModules("keyframe")) {
      const l = m && typeof m.keyframe_label === "string" && m.keyframe_label.trim();
      if (l) return l;
    }
    return "SDXL";
  }

  global.plannerRegistry = {
    load,
    moduleLabel,
    musicScoreModules,
    narrationScoreModules,
    beatSyncScoreModules,
    motionBackendModules,
    ownGpuModule,
    cloudMotionModules,
    planEnhanceInstalled,
    cloudModelLabel,
    cloudModelOptions,
    gpuMotionLabel,
    keyframeLabel,
  };
})(window);
