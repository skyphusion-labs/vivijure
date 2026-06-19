// Planner module registry: one fetch of GET /api/modules, shared helpers for every
// self-assembling control in the planner. No feature names or providers are
// hardcoded here -- only hook names from the vivijure-module/1 contract.
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

  function ownGpuModule() {
    return motionBackendModules().find((m) => m.name === "own-gpu") || null;
  }

  function cloudMotionModules() {
    return motionBackendModules().filter((m) => m.name !== "own-gpu");
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
  };
})(window);
