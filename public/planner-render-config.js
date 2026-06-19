// Registry-driven render module config panel for the planner Render step.
// Renders controls from installed modules' config_schema (keyframe, motion.backend, finish).
(function (global) {
  const HOOKS = [
    { hook: "keyframe", title: "Keyframe", pickOne: true },
    { hook: "motion.backend", title: "Motion", pickOne: true },
    { hook: "finish", title: "Finish", chain: true },
  ];

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
    const keys = Object.keys(schema).filter((k) => k !== "quality_tier" && k !== "quality");
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
    const data = resp.ok ? await resp.json() : { modules: [], hooks: {} };
    const byName = Object.fromEntries((data.modules || []).map((m) => [m.name, m]));
    const cache = {};
    for (const h of HOOKS) {
      const order = (data.hooks && data.hooks[h.hook]) || [];
      cache[h.hook] = order.map((n) => byName[n]).filter(Boolean);
    }
    global.plannerRegistry._cacheForRenderConfig = cache;

    root.innerHTML = "";
    if (motionWrap) motionWrap.innerHTML = "";

    const keyframeMods = cache.keyframe || [];
    const motionMods = cache["motion.backend"] || [];
    const finishMods = cache.finish || [];

    if (!keyframeMods.length) {
      root.textContent = "no keyframe module installed; bind MODULE_KEYFRAME to render.";
      return;
    }

    for (const mod of keyframeMods) root.appendChild(renderModuleSection(mod));

    const picker = renderMotionPicker(motionMods, motionMods[0] && motionMods[0].name);
    if (picker && motionWrap) motionWrap.appendChild(picker);
    else if (motionWrap) motionWrap.hidden = true;

    for (const mod of motionMods) root.appendChild(renderModuleSection(mod));
    for (const mod of finishMods) root.appendChild(renderModuleSection(mod));
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
  };
})(window);
