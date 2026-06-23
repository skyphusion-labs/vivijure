// Registry-driven render module config panel for the planner Render step. The hook list is a
// projection of the live catalog (GET /api/modules `catalog`); it renders each installed module's
// config_schema for keyframe, motion.backend, speech, finish, master, and film.finish.
(function (global) {
  // The render-config panel is a PROJECTION of the live hook catalog (GET /api/modules `catalog`),
  // not a hardcoded hook list. Every catalog hook renders here EXCEPT the ones intentionally
  // projected on their own bespoke planner / cast surfaces (so they are never double-rendered):
  //   plan.enhance -> the "auto-direct shots" toolbar button (scene editor)
  //   score        -> the audio-bed stage (music / narration / beat-sync)
  //   dialogue     -> per-shot dialogue lines (scene editor) + per-cast-member voice (cast page)
  //   cast.image   -> the cast-prep page
  //   notify       -> the "enable notifications" render-step toggle
  // Net panel hooks: keyframe, motion.backend, speech, finish, master, film.finish -- all six
  // projected from the catalog, none hardcoded. A new backend chain / pick_one hook outside the
  // skip set surfaces here automatically (no frontend change needed).
  const PANEL_SKIP_HOOKS = new Set([
    "plan.enhance",
    "score",
    "dialogue",
    "cast.image",
    "notify",
  ]);

  // Display order for the panel only (pipeline order: keyframe -> motion -> dialogue -> speech ->
  // finish, then the film-level audio master and the post-mux film.finish cards). This is a
  // presentation preference; the SET of hooks and their cardinality come from the catalog, and any
  // catalog hook not named here still renders (appended in catalog order) so nothing silently drops.
  const PANEL_ORDER = ["keyframe", "motion.backend", "speech", "finish", "master", "film.finish"];

  function panelHooks(catalog) {
    const rank = (name) => {
      const i = PANEL_ORDER.indexOf(name);
      return i === -1 ? PANEL_ORDER.length : i;
    };
    return (Array.isArray(catalog) ? catalog : [])
      .filter((h) => h && h.name && !PANEL_SKIP_HOOKS.has(h.name))
      .map((h, i) => ({ hook: h.name, pickOne: h.cardinality === "pick_one", _i: i }))
      .sort((a, b) => rank(a.hook) - rank(b.hook) || a._i - b._i)
      .map(({ hook, pickOne }) => ({ hook, pickOne }));
  }

  function moduleLabel(mod) {
    if (!mod) return "";
    const l = mod.provides && mod.provides[0] && mod.provides[0].label;
    return (l && String(l).trim()) || mod.name;
  }

  function hookModules(hook) {
    if (!global.plannerRegistry) return [];
    const load = global.plannerRegistry.load();
    return load.then(() => {
      const cache = global.plannerRegistry._cacheForRenderConfig;
      if (cache) return cache[hook] || [];
      return [];
    });
  }

  function fieldId(moduleName, fieldKey) {
    return "planner-mcfg-" + moduleName.replace(/[^a-z0-9_-]+/gi, "_") + "-" + fieldKey;
  }

  function controlForField(mod, key, field) {
    const id = fieldId(mod.name, key);
    const label = document.createElement("label");
    label.className = "planner-field";
    const span = document.createElement("span");
    span.textContent = field.label || key;
    label.appendChild(span);

    let input;
    const defHint = field.default !== undefined && field.default !== null
      ? String(field.default)
      : "";

    if (field.type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!field.default;
      label.classList.add("planner-field-check");
      label.insertBefore(input, span);
      input.dataset.module = mod.name;
      input.dataset.field = key;
      input.dataset.fieldType = "bool";
      return label;
    }

    if (field.type === "enum") {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = defHint ? "default (" + defHint + ")" : "default";
      input.appendChild(blank);
      for (const v of field.values || []) {
        const opt = document.createElement("option");
        opt.value = v;
        const el = field.enum_labels && field.enum_labels[v];
        opt.textContent = el ? el + " (" + v + ")" : v;
        input.appendChild(opt);
      }
    } else if (field.type === "int" || field.type === "float") {
      input = document.createElement("input");
      input.type = "number";
      input.step = field.type === "float" ? "any" : "1";
      if (typeof field.min === "number") input.min = String(field.min);
      if (typeof field.max === "number") input.max = String(field.max);
      input.placeholder = defHint ? "default: " + defHint : "default";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.placeholder = defHint ? "default: " + defHint : "default";
    }

    input.id = id;
    input.dataset.module = mod.name;
    input.dataset.field = key;
    input.dataset.fieldType = field.type;
    if (field.default !== undefined) input.dataset.default = String(field.default);
    label.appendChild(input);
    return label;
  }

  function renderModuleSection(mod) {
    const details = document.createElement("details");
    details.className = "planner-overrides-domain";
    details.open = mod.hooks && mod.hooks[0] === "keyframe";
    const summary = document.createElement("summary");
    summary.className = "planner-overrides-summary";
    summary.textContent = moduleLabel(mod);
    details.appendChild(summary);
    const fields = document.createElement("div");
    fields.className = "planner-overrides-fields";
    const schema = mod.config_schema || {};
    // quality_tier / quality are the core-owned render tier (set by the tier picker above), and
    // scope:"install" fields are operator-set-once knobs that live on the Settings page (GET/PATCH
    // /api/modules/:name/config), NOT per-render config. Skip both here so an install field never
    // double-renders: it belongs only on Settings, the render panel only shows per-render knobs.
    const keys = Object.keys(schema).filter(
      (k) => k !== "quality_tier" && k !== "quality" && schema[k] && schema[k].scope !== "install",
    );
    if (!keys.length) {
      const p = document.createElement("p");
      p.className = "planner-overrides-hint";
      p.textContent = "no configurable knobs (quality tier is set above).";
      fields.appendChild(p);
    } else {
      for (const key of keys) {
        fields.appendChild(controlForField(mod, key, schema[key]));
      }
    }
    details.appendChild(fields);
    return details;
  }

  // Populate the quality-tier <select> from the core-owned render projection
  // (GET /api/modules `render`), so the options + blurbs are not hand-authored in
  // markup. Preserves the current selection across re-renders; falls back to the
  // server-declared default tier. The element itself stays in planner.html (it is a
  // core-render control, not module config); we only fill its <option>s here.
  // Last-resort fallback if GET /api/modules failed to return a render block, so the
  // tier picker is never empty (the core is the source of truth; this just keeps the
  // page usable offline / on a transient registry error).
  var FALLBACK_RENDER = {
    quality_tiers: [
      { value: "draft", label: "draft", blurb: "fastest, lowest quality" },
      { value: "standard", label: "standard", blurb: "balanced" },
      { value: "final", label: "final", blurb: "production quality" },
    ],
    default_tier: "final",
  };

  function renderTierPicker(render) {
    const sel = document.getElementById("planner-quality-tier");
    if (!sel) return;
    if (!render || !Array.isArray(render.quality_tiers) || !render.quality_tiers.length) {
      render = FALLBACK_RENDER;
    }
    // Desired value, in priority order: a restore that ran before the options existed
    // (data-pending-value, set by the planner's session restore), then the current
    // selection (preserved across re-renders), then the server default. Because the
    // <option>s are now projected (not in markup), a pre-population restore would
    // otherwise be silently dropped -- data-pending-value is what makes restore survive
    // regardless of init ordering.
    const pending = sel.dataset.pendingValue || "";
    const prev = sel.value;
    sel.innerHTML = "";
    for (const t of render.quality_tiers) {
      const opt = document.createElement("option");
      opt.value = t.value;
      opt.textContent = t.blurb ? t.label + " (" + t.blurb + ")" : t.label;
      sel.appendChild(opt);
    }
    const has = (v) => v && render.quality_tiers.some((t) => t.value === v);
    const want = has(pending) ? pending : has(prev) ? prev : render.default_tier;
    if (has(want)) sel.value = want;
    delete sel.dataset.pendingValue;
  }

  // Select a quality tier robustly regardless of whether the projected <option>s
  // exist yet: set .value (effective if the options are built) AND stash the desired
  // value so renderTierPicker honors it once they are. The planner's restore/prefs/
  // re-render paths call this instead of touching the <select> directly.
  function selectTier(value) {
    const sel = document.getElementById("planner-quality-tier");
    if (!sel || !value) return;
    sel.dataset.pendingValue = value;
    sel.value = value;
  }

  function renderMotionPicker(mods, selected) {
    if (mods.length <= 1) return null;
    const wrap = document.createElement("label");
    wrap.className = "planner-field";
    const span = document.createElement("span");
    span.textContent = "motion backend";
    wrap.appendChild(span);
    const sel = document.createElement("select");
    sel.id = "planner-motion-backend";
    for (const m of mods) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = moduleLabel(m);
      sel.appendChild(opt);
    }
    if (selected && mods.some((m) => m.name === selected)) sel.value = selected;
    wrap.appendChild(sel);
    return wrap;
  }

  async function renderPanel() {
    const root = document.getElementById("planner-module-config");
    const motionWrap = document.getElementById("planner-motion-backend-wrap");
    if (!root || !global.plannerRegistry) return;

    await global.plannerRegistry.load();
    const resp = await fetch("/api/modules");
    const data = resp.ok ? await resp.json() : { modules: [], hooks: {}, catalog: [] };
    renderTierPicker(data.render);

    const byName = Object.fromEntries((data.modules || []).map((m) => [m.name, m]));
    const hooks = panelHooks(data.catalog);

    // Per-hook module lists come from data.hooks, which the core already sorted by ui.order then
    // name (registry.indexByHook). We consume that order VERBATIM rather than re-sorting here, so
    // the panel's chain order is byte-identical to the backend fold order (a client-side
    // localeCompare could diverge by browser locale; the server sort is the single source of truth).
    const cache = {};
    for (const h of hooks) {
      const order = (data.hooks && data.hooks[h.hook]) || [];
      cache[h.hook] = order.map((n) => byName[n]).filter(Boolean);
    }
    global.plannerRegistry._cacheForRenderConfig = cache;

    root.innerHTML = "";
    if (motionWrap) {
      motionWrap.innerHTML = "";
      motionWrap.hidden = false;
    }

    if (!(cache.keyframe || []).length) {
      root.textContent = "no keyframe module installed; bind MODULE_KEYFRAME to render.";
      if (motionWrap) motionWrap.hidden = true;
      return;
    }

    // Render every panel hook's module config sections in PANEL_ORDER. motion.backend additionally
    // gets a backend <select> (own-GPU vs cloud) in its own slot above the sections. master and
    // film.finish now render here because the hook list is the catalog, not a fixed array.
    let motionShown = false;
    for (const h of hooks) {
      const mods = cache[h.hook] || [];
      if (h.hook === "motion.backend") {
        const picker = renderMotionPicker(mods, mods[0] && mods[0].name);
        if (picker && motionWrap) {
          motionWrap.appendChild(picker);
          motionShown = true;
        }
      }
      for (const mod of mods) root.appendChild(renderModuleSection(mod));
    }
    if (motionWrap && !motionShown) motionWrap.hidden = true;
  }

  function readFieldValue(el) {
    const t = el.dataset.fieldType;
    if (t === "bool") return el.checked;
    const raw = el.value;
    if (raw === "" || raw == null) return undefined;
    if (t === "int") {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    if (t === "float") {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    return raw;
  }

  function collect() {
    const config = {};
    const inputs = document.querySelectorAll("#planner-module-config [data-module][data-field], #planner-motion-backend");
    for (const el of inputs) {
      if (el.id === "planner-motion-backend") continue;
      const mod = el.dataset.module;
      const field = el.dataset.field;
      if (!mod || !field) continue;
      const val = readFieldValue(el);
      if (val === undefined) continue;
      if (!config[mod]) config[mod] = {};
      config[mod][field] = val;
    }
    const out = {};
    if (Object.keys(config).length) out.config = config;
    const motionSel = document.getElementById("planner-motion-backend");
    if (motionSel && motionSel.value) out.motion_backend = motionSel.value;
    return out;
  }

  function restore(overrides) {
    if (!overrides || typeof overrides !== "object") return;
    const cfg = overrides.config && typeof overrides.config === "object" ? overrides.config : {};
    for (const [mod, fields] of Object.entries(cfg)) {
      if (!fields || typeof fields !== "object") continue;
      for (const [key, val] of Object.entries(fields)) {
        const el = document.querySelector(
          '[data-module="' + mod + '"][data-field="' + key + '"]',
        );
        if (!el) continue;
        if (el.dataset.fieldType === "bool") el.checked = !!val;
        else el.value = val == null ? "" : String(val);
      }
    }
    const motionSel = document.getElementById("planner-motion-backend");
    if (motionSel && typeof overrides.motion_backend === "string") {
      motionSel.value = overrides.motion_backend;
    }
  }

  function mergeExpert(base, expert) {
    const out = { ...base, ...expert };
    if (base.config || expert.config) {
      out.config = { ...(base.config || {}) };
      for (const [name, cfg] of Object.entries(expert.config || {})) {
        out.config[name] = { ...(out.config[name] || {}), ...(cfg || {}) };
      }
    }
    return out;
  }

  function collectForSubmit(expertText) {
    let overrides = collect();
    const raw = (expertText || "").trim();
    if (raw) {
      let expert;
      try {
        expert = JSON.parse(raw);
      } catch (e) {
        throw new Error("expert JSON: " + e.message);
      }
      overrides = mergeExpert(overrides, expert);
    }
    if (!overrides.config && !overrides.motion_backend) return undefined;
    return overrides;
  }

  global.plannerRenderConfig = {
    renderPanel,
    collect,
    collectForSubmit,
    restore,
    mergeExpert,
    selectTier,
  };
})(window);
