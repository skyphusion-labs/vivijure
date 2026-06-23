// The studio frontend: render the studio as a PROJECTION of the live module
// registry (GET /api/modules). Nothing per-feature is hardcoded -- the render
// pipeline below is built from the hook catalog, and each installed module
// slots into the hook(s) it serves and renders its OWN config_schema as live
// controls. Bind a module, its stage lights up and brings its settings; bind
// none and you get an honest, empty pipeline. Vanilla JS, no build (house style).

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// Logical render order (independent of HOOK_NAMES in the contract). Hooks without an installed
// module render as empty stages; any catalog hook not listed here is appended at the end.
const HOOK_ORDER = [
  "plan.enhance",
  "cast.image",
  "keyframe",
  "motion.backend",
  "finish",
  "score",
  "notify",
];

const CARDINALITY_LABEL = { pick_one: "single module", chain: "chain" };

// In-memory pipeline state: the pick_one choice per hook and the per-module
// config the user has set. Kept here so a later increment can submit it with a
// render. Exposed for debugging / wiring (window.__pipeline).
const pipeline = { choice: {}, config: {} };
window.__pipeline = pipeline;

// --- config_schema -> live controls --------------------------------------

// One labeled control bound to pipeline.config[moduleName][key]. The control
// type mirrors the contract's ConfigField union. Values are seeded from each
// field's default so the state is complete before the user touches anything.
function controlFor(moduleName, key, field) {
  const cfg = (pipeline.config[moduleName] ||= {});
  cfg[key] = field.default;

  const wrap = el("label", "mod-field mod-field-" + field.type);
  const labelText = field.label || key;

  if (field.type === "bool") {
    const input = el("input");
    input.type = "checkbox";
    input.checked = !!field.default;
    input.addEventListener("change", () => { cfg[key] = input.checked; });
    wrap.append(input, el("span", "mod-field-label", labelText));
    return wrap;
  }

  wrap.append(el("span", "mod-field-label", labelText));
  let input;
  if (field.type === "enum") {
    input = el("select");
    for (const v of field.values) {
      const o = el("option", null, (field.enum_labels && field.enum_labels[v]) || v);
      o.value = v;
      if (v === field.default) o.selected = true;
      input.append(o);
    }
    input.addEventListener("change", () => { cfg[key] = input.value; });
  } else if (field.type === "int" || field.type === "float") {
    input = el("input");
    input.type = "number";
    if (typeof field.min === "number") input.min = String(field.min);
    if (typeof field.max === "number") input.max = String(field.max);
    input.step = field.type === "int" ? "1" : "any";
    input.value = String(field.default);
    input.addEventListener("input", () => {
      const n = Number(input.value);
      cfg[key] = field.type === "int" ? Math.round(n) : n;
    });
  } else {
    input = el("input");
    input.type = "text";
    input.value = field.default || "";
    input.addEventListener("input", () => { cfg[key] = input.value; });
  }
  wrap.append(input);
  if ((field.type === "int" || field.type === "float") &&
      (typeof field.min === "number" || typeof field.max === "number")) {
    const lo = typeof field.min === "number" ? field.min : null;
    const hi = typeof field.max === "number" ? field.max : null;
    const hint = lo !== null && hi !== null ? `range ${lo} to ${hi}` : lo !== null ? `min ${lo}` : `max ${hi}`;
    wrap.append(el("span", "mod-field-hint", hint));
  }
  return wrap;
}

// A module's config_schema rendered into `host` (cleared first), or a muted
// "no settings" note when the module exposes none.
function renderModuleConfig(host, mod) {
  host.replaceChildren();
  const schema = mod && mod.config_schema;
  // scope:"install" fields are operator-set-once knobs that live on the Settings page
  // (GET/PATCH /api/modules/:name/config), not per-render config. This pipeline overview shows
  // per-render stage knobs only; an install field would be a dead control here (nothing submits it),
  // so skip it -- install config is presented in exactly one place, Settings.
  const keys = schema
    ? Object.keys(schema).filter((k) => schema[k] && schema[k].scope !== "install")
    : [];
  if (!keys.length) {
    host.append(el("p", "mod-nosettings", "No settings exposed"));
    return;
  }
  const grid = el("div", "mod-fields");
  for (const key of keys) grid.append(controlFor(mod.name, key, schema[key]));
  host.append(grid);
}

// --- pipeline stages (the projection) ------------------------------------

function stageCard(hook, step, servingNames, byName) {
  const card = el("article", "stage");
  card.dataset.hook = hook.name;

  const head = el("div", "stage-head");
  head.append(el("span", "stage-step", String(step)));
  const titles = el("div", "stage-titles");
  titles.append(el("h3", "stage-title", hook.blurb));
  titles.append(el("span", "stage-name", hook.name));
  head.append(titles);
  head.append(el("span", "stage-badge", CARDINALITY_LABEL[hook.cardinality] || hook.cardinality));
  card.append(head);

  if (!servingNames.length) {
    card.classList.add("stage-off");
    card.append(el("p", "stage-empty", hook.cardinality === "pick_one"
      ? "No module installed; the core default runs."
      : "No module installed; this stage is skipped."));
    return card;
  }

  card.classList.add("stage-on");

  if (hook.cardinality === "pick_one") {
    pipeline.choice[hook.name] = servingNames[0];
    const cfgHost = el("div", "stage-config");
    if (servingNames.length > 1) {
      const pick = el("label", "stage-pick-wrap");
      pick.append(el("span", "mod-field-label", "Module"));
      const sel = el("select", "stage-pick");
      for (const name of servingNames) {
        const o = el("option", null, name);
        o.value = name;
        sel.append(o);
      }
      sel.addEventListener("change", () => {
        pipeline.choice[hook.name] = sel.value;
        renderModuleConfig(cfgHost, byName[sel.value]);
      });
      pick.append(sel);
      card.append(pick);
    } else {
      card.append(el("div", "stage-single", servingNames[0]));
    }
    renderModuleConfig(cfgHost, byName[servingNames[0]]);
    card.append(cfgHost);
  } else {
    const list = el("ol", "stage-chain");
    servingNames.forEach((name) => {
      const li = el("li", "chain-item");
      li.append(el("span", "chain-mod-name", name));
      const cfgHost = el("div", "stage-config");
      renderModuleConfig(cfgHost, byName[name]);
      li.append(cfgHost);
      list.append(li);
    });
    card.append(list);
  }
  return card;
}

function renderPipeline(catalog, serving, modules) {
  const root = document.getElementById("pipeline");
  root.replaceChildren();
  const byHook = Object.fromEntries(catalog.map((h) => [h.name, h]));
  const byName = Object.fromEntries(modules.map((m) => [m.name, m]));
  const order = [...HOOK_ORDER.filter((n) => byHook[n]),
    ...catalog.map((h) => h.name).filter((n) => !HOOK_ORDER.includes(n))];
  order.forEach((name, i) => {
    root.append(stageCard(byHook[name], i + 1, serving[name] || [], byName));
  });
}

// --- installed-modules summary -------------------------------------------

function renderModules(modules) {
  const root = document.getElementById("modules");
  root.replaceChildren();
  if (!modules.length) {
    root.append(el("p", "empty", "No modules installed. The studio is a clean slate."));
    return;
  }
  for (const m of modules) {
    const card = el("div", "module module-compact");
    const head = el("div", "module-head");
    head.append(el("span", "module-name", m.name), el("span", "module-ver", "v" + m.version));
    card.append(head);
    const hooks = el("div", "module-hooks");
    for (const h of m.hooks) hooks.append(el("span", "module-hook-tag", h));
    card.append(hooks);
    if (m.provides && m.provides.length) {
      const caps = el("p", "module-caps", m.provides.map((p) => p.label).join(" · "));
      card.append(caps);
    }
    root.append(card);
  }
}

function setMeta(api, count) {
  const meta = document.getElementById("studio-meta");
  if (!meta) return;
  meta.hidden = false;
  meta.textContent = count + " module" + (count === 1 ? "" : "s") + " · contract " + api;
}

// --- boot ----------------------------------------------------------------

async function boot() {
  const status = document.getElementById("status");
  try {
    const res = await fetch("/api/modules");
    if (!res.ok) throw new Error("/api/modules -> " + res.status);
    const data = await res.json();
    const modules = data.modules || [];
    renderPipeline(data.catalog || [], data.hooks || {}, modules);
    renderModules(modules);
    const n = modules.length;
    status.textContent = n ? "live" : "no modules";
    status.classList.toggle("status-on", n > 0);
    setMeta(data.api, n);
  } catch (e) {
    status.textContent = "offline";
    status.classList.remove("status-on");
    const p = document.getElementById("pipeline");
    if (p) p.textContent = "Could not reach the registry: " + e.message;
  }
}

boot();
