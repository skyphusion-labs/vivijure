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
    // vivijure#544: surface the schema bounds ("range X to Y") next to a bounded numeric
    // override, matching the same hint on /modules (app.js) so the valid range is visible
    // BEFORE entry, not only when the core clamps at render time. Registry-projected from
    // config_schema min/max; presentation only.
    if ((field.type === "int" || field.type === "float") &&
        (typeof field.min === "number" || typeof field.max === "number")) {
      const lo = typeof field.min === "number" ? field.min : null;
      const hi = typeof field.max === "number" ? field.max : null;
      const hint = document.createElement("span");
      hint.className = "mod-field-hint";
      hint.textContent = lo !== null && hi !== null
        ? "range " + lo + " to " + hi
        : lo !== null ? "min " + lo : "max " + hi;
      label.appendChild(hint);
    }
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

  // ---------------------------------------------------------------------------
  // Backend selector ("one studio, two honest doors"). The motion.backend hook is
  // pick_one: each installed motion.backend module (local consumer GPU, RunPod
  // datacenter, any cloud i2v) is one DOOR. The choice rides the EXISTING wire field
  // `motion_backend` (collect/restore below); this is presentation only, no new wire
  // field. Everything shown is a PROJECTION of the registry -- nothing per-backend is
  // hardcoded here, so a new backend door appears the instant its module is bound.
  //
  // Honest framing wants per-door positioning copy (locality, cost model, capability
  // ceiling). The manifest does not yet carry those, so they are read OPTIONALLY from
  // ui.{locality,cost,blurb,limits} and simply omitted when absent (never fabricated).
  // Until those manifest fields land (flagged to the lead/Rollins), each door still
  // shows registry truth: its provides[].label capabilities and the numeric ranges of
  // its own config_schema knobs. See the run-log for the recommended manifest fields.

  // Read an optional ui hint without assuming the field exists.
  function uiHint(mod, key) {
    return mod && mod.ui && mod.ui[key] != null ? mod.ui[key] : undefined;
  }

  // A short, human "locality" tag derived from the OPTIONAL manifest hint ui.locality.
  // Returns null when the manifest does not declare it (so we never guess local vs cloud
  // from a module name -- that is exactly the brittle coupling this replaces).
  function localityTag(mod) {
    const loc = uiHint(mod, "locality");
    if (typeof loc !== "string") return null;
    const v = loc.trim().toLowerCase();
    if (v === "local") return { text: "Local (your GPU)", kind: "local" };
    if (v === "byo") return { text: "Your own RunPod (BYO keys)", kind: "byo" };
    if (v === "cloud" || v === "datacenter") return { text: "Datacenter", kind: "cloud" };
    return { text: loc.trim(), kind: "other" };
  }

  // Registry-truth capability bullets: provides[1..].label (the first label is the door
  // title). Always real, no new fields needed.
  function extraCapabilities(mod) {
    const provs = Array.isArray(mod.provides) ? mod.provides : [];
    return provs
      .slice(1)
      .map((p) => p && p.label && String(p.label).trim())
      .filter(Boolean);
  }

  // Registry-truth "what you can tune" summary: each numeric (int/float) config knob with
  // a declared range, e.g. "fps 8-30, motion (flow shift) 1-12". Skips the core-owned
  // quality knobs and operator-only install fields. This is a quick at-a-glance ceiling
  // hint; the full controls still render in the module's own config block below.
  function knobRanges(mod) {
    const schema = mod.config_schema || {};
    const parts = [];
    for (const key of Object.keys(schema)) {
      const f = schema[key];
      if (!f || (f.type !== "int" && f.type !== "float")) continue;
      if (key === "quality" || key === "quality_tier" || f.scope === "install") continue;
      const hasMin = typeof f.min === "number";
      const hasMax = typeof f.max === "number";
      if (!hasMin && !hasMax) continue;
      const name = (f.label || key).replace(/\s*\([^)]*\)\s*/g, " ").trim();
      let range;
      if (hasMin && hasMax) range = f.min + "-" + f.max;
      else if (hasMax) range = "up to " + f.max;
      else range = "from " + f.min;
      parts.push(name + " " + range);
    }
    return parts;
  }

  function bulletList(items) {
    const ul = document.createElement("ul");
    ul.className = "planner-backend-caps";
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.appendChild(li);
    }
    return ul;
  }

  // Build one door card for a motion.backend module. `selectable` adds the radio that
  // drives the authoritative #planner-motion-backend value; a lone backend renders as a
  // purely informational card (no radio, no value forced -- the core resolves the only
  // installed backend, matching prior behavior).
  function backendDoor(mod, selectable, selected) {
    const card = document.createElement("label");
    card.className = "planner-backend-door";
    card.dataset.module = mod.name;

    const head = document.createElement("div");
    head.className = "planner-backend-door-head";

    if (selectable) {
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "planner-backend-door";
      radio.value = mod.name;
      radio.className = "planner-backend-radio";
      radio.checked = !!selected;
      radio.addEventListener("change", function () {
        if (radio.checked) selectBackend(mod.name);
      });
      head.appendChild(radio);
    }

    const titleWrap = document.createElement("div");
    titleWrap.className = "planner-backend-title-wrap";
    const title = document.createElement("span");
    title.className = "planner-backend-title";
    title.textContent = moduleLabel(mod);
    titleWrap.appendChild(title);

    const tags = document.createElement("span");
    tags.className = "planner-backend-tags";
    const loc = localityTag(mod);
    if (loc) {
      const t = document.createElement("span");
      t.className = "planner-backend-tag is-" + loc.kind;
      t.textContent = loc.text;
      tags.appendChild(t);
    }
    const cost = uiHint(mod, "cost");
    if (typeof cost === "string" && cost.trim()) {
      const c = document.createElement("span");
      c.className = "planner-backend-tag is-cost";
      c.textContent = cost.trim();
      tags.appendChild(c);
    }
    if (tags.childNodes.length) titleWrap.appendChild(tags);
    head.appendChild(titleWrap);
    card.appendChild(head);

    const blurb = uiHint(mod, "blurb");
    if (typeof blurb === "string" && blurb.trim()) {
      const p = document.createElement("p");
      p.className = "planner-backend-blurb";
      p.textContent = blurb.trim();
      card.appendChild(p);
    }

    const caps = extraCapabilities(mod);
    if (caps.length) card.appendChild(bulletList(caps));

    // Honest capability ceiling: prefer the manifest's declared limits (when present),
    // else fall back to the registry-truth knob ranges so the door is never silent.
    const limits = uiHint(mod, "limits");
    if (Array.isArray(limits) && limits.length) {
      const lim = bulletList(limits.map((x) => String(x)).filter(Boolean));
      lim.classList.add("planner-backend-limits");
      card.appendChild(lim);
    } else {
      const ranges = knobRanges(mod);
      if (ranges.length) {
        const r = document.createElement("p");
        r.className = "planner-backend-ranges";
        r.textContent = "Tunable: " + ranges.join(", ") + ".";
        card.appendChild(r);
      }
    }

    return card;
  }

  // Set the chosen backend on the authoritative hidden <select> AND reflect the choice in
  // the door cards. Tolerant of being called before the cards exist.
  function selectBackend(name) {
    const sel = document.getElementById("planner-motion-backend");
    if (sel && name && Array.from(sel.options).some((o) => o.value === name)) {
      sel.value = name;
    }
    syncBackendDoors();
  }

  // Reflect #planner-motion-backend's current value into the door radios + the selected
  // card highlight. Called after render and from restore() so a restored choice shows.
  function syncBackendDoors() {
    const sel = document.getElementById("planner-motion-backend");
    const wrap = document.getElementById("planner-motion-backend-wrap");
    if (!wrap) return;
    const value = sel ? sel.value : "";
    const cards = wrap.querySelectorAll(".planner-backend-door");
    cards.forEach((card) => {
      const isSel = card.dataset.module === value;
      card.classList.toggle("is-selected", isSel);
      const radio = card.querySelector(".planner-backend-radio");
      if (radio) radio.checked = isSel;
    });
    // vivijure#501: with 2+ doors, surface the obligation in the caption so a novice sees
    // "required" BEFORE hitting the submit-time block; it clears the moment a door is
    // picked. No new element -- just the existing caption hint's text.
    if (cards.length > 1) {
      const hint = wrap.querySelector(".planner-backend-caption-hint");
      if (hint) {
        hint.textContent = value
          ? "Pick which backend renders the motion (image-to-video) step."
          : "Required: pick which backend renders the motion (image-to-video) step.";
      }
    }
    // vivijure#546: notify the render gate whenever the backend choice changes so the
    // primary button can reflect a required-but-unmade pick as a disabled affordance.
    document.dispatchEvent(new CustomEvent("planner:backend-change"));
  }

  // Render the backend selector into motionWrap. Returns true if a real CHOICE (>= 2
  // backends) was rendered (so the caller can mark the motion slot shown). One backend
  // renders an informational door; zero renders nothing.
  function renderBackendSelector(mods, motionWrap) {
    if (!motionWrap || !mods || !mods.length) return false;

    const section = document.createElement("div");
    section.className = "planner-backend-selector";

    const cap = document.createElement("div");
    cap.className = "planner-backend-caption";
    const capTitle = document.createElement("span");
    capTitle.className = "planner-backend-caption-title";
    capTitle.textContent = "Render backend";
    cap.appendChild(capTitle);
    const capHint = document.createElement("span");
    capHint.className = "planner-backend-caption-hint";
    capHint.textContent = mods.length > 1
      ? "Pick which backend renders the motion (image-to-video) step."
      : "This backend renders the motion (image-to-video) step.";
    cap.appendChild(capHint);
    section.appendChild(cap);

    // Authoritative value element: a hidden <select> that ALWAYS carries the chosen
    // motion_backend whenever at least one serving backend is installed, so collect()
    // emits an EXPLICIT motion_backend for every full render (closes vivijure#500 caller
    // side: a full render can no longer be submitted with an unresolved motion leg, and
    // the core never has to resolve an omitted backend). The <option>s and the default
    // are a projection of the registry (mods = GET /api/modules hooks["motion.backend"],
    // server-sorted by ui.order then name); nothing per-backend is hardcoded. Default =
    // mods[0] for the single-backend case; for 2+ doors that default is CLEARED below
    // (vivijure#501) so a locality-blind mods[0] is never auto-picked. Keeps the
    // collect()/restore() contract (#planner-motion-backend) byte-identical to the prior
    // dropdown.
    const sel = document.createElement("select");
    sel.id = "planner-motion-backend";
    sel.hidden = true;
    sel.setAttribute("aria-hidden", "true");
    sel.tabIndex = -1;
    for (const m of mods) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = moduleLabel(m);
      sel.appendChild(opt);
    }
    sel.value = mods[0].name;
    section.appendChild(sel);

    const doors = document.createElement("div");
    doors.className = "planner-backend-doors";

    if (mods.length > 1) {
      // Multiple doors (vivijure#501): the registry order (ui.order then name) is
      // locality-blind, so mods[0] can be a bound-but-non-operational door that would
      // sail through the #500 submit preflight and then die deep in the render. Clear the
      // default so NO door is preselected; every radio starts unchecked and
      // collectForSubmit() blocks submit until the novice picks one deliberately (or
      // supplies motion_backend via expert JSON). The single-backend case above keeps its
      // explicit default (only one serving backend -- nothing to get wrong).
      sel.selectedIndex = -1;
      mods.forEach((m) => doors.appendChild(backendDoor(m, true, false)));
      section.appendChild(doors);
      motionWrap.appendChild(section);
      syncBackendDoors();
      return true;
    }

    // Single backend: informational door (no radio) -- there is nothing to pick -- but the
    // hidden select above still carries its value, so collect() emits an explicit
    // motion_backend and this door is never a silent default. Returns false (no CHOICE was
    // offered); motionWrap stays visible via the .planner-backend-selector guard in
    // renderPanel because a door WAS rendered.
    doors.appendChild(backendDoor(mods[0], false, false));
    section.appendChild(doors);
    motionWrap.appendChild(section);
    return false;
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
    // gets the backend selector (the two-door chooser) in its own slot above the sections. master
    // and film.finish now render here because the hook list is the catalog, not a fixed array.
    let motionShown = false;
    for (const h of hooks) {
      const mods = cache[h.hook] || [];
      if (h.hook === "motion.backend") {
        if (renderBackendSelector(mods, motionWrap)) motionShown = true;
      }
      for (const mod of mods) root.appendChild(renderModuleSection(mod));
    }
    if (motionWrap && !motionShown && !motionWrap.querySelector(".planner-backend-selector")) {
      motionWrap.hidden = true;
    }
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
      syncBackendDoors();
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

  function collectForSubmit(expertText, opts) {
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
    // vivijure#501: with 2+ motion.backend doors the selector renders the hidden
    // #planner-motion-backend select with NO default (see renderBackendSelector). A
    // deliberate choice is mandatory before a FULL render -- block here (all three submit
    // paths surface this thrown message and abort) until the novice picks a door, or
    // supplies motion_backend via the expert JSON. The single-backend case carries an
    // explicit default, so its select always has a value and this never fires; zero
    // backends render no select, so it never fires there either. keyframes-only submits
    // run NO motion leg, so the #500 core preflight exempts them; mirror that exactly via
    // opts.keyframesOnly so a keyframes-only preview is never falsely blocked here.
    const keyframesOnly = !!(opts && opts.keyframesOnly);
    const backendSel = document.getElementById("planner-motion-backend");
    if (!keyframesOnly && backendSel && !overrides.motion_backend) {
      const names = Array.from(backendSel.options || [])
        .map((o) => (o.textContent || o.value || "").trim())
        .filter(Boolean);
      throw new Error(
        "pick a render backend before rendering" +
          (names.length ? " (" + names.join(", ") + ")" : ""),
      );
    }
    if (!overrides.config && !overrides.motion_backend) return undefined;
    return overrides;
  }

  // vivijure#501/#546: true when a motion-backend choice is REQUIRED but unmade -- 2+
  // installed backends (doors) with none selected. Registry-projected: reads the hidden
  // authoritative <select> the doors write to, so no per-backend knowledge lives here.
  // The render gate uses it to disable submit (with a reason) until a door is picked,
  // making the obligation a visible affordance rather than a click-time-only block.
  function backendChoicePending() {
    const sel = document.getElementById("planner-motion-backend");
    if (!sel || !sel.options || sel.options.length < 2) return false;
    return !sel.value;
  }

  global.plannerRenderConfig = {
    renderPanel,
    renderBackendSelector,
    collect,
    collectForSubmit,
    restore,
    mergeExpert,
    selectTier,
    backendChoicePending,
  };
})(window);
