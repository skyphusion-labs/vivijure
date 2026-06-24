// Studio Settings page: render the operator install-scope module config as live controls.
//
// This is a PROJECTION of the live module registry, exactly like the planner render-config panel.
// Nothing per-module is hardcoded: we read each installed module's config_schema from GET
// /api/modules, keep only the fields marked `scope: "install"` (the operator-set-once knobs, e.g.
// notify-email's notify_email recipient), and render each field's control from its type. A new
// install field on any module appears here automatically with no change to this file.
//
// Values live behind Access (never on the unauthenticated /api/modules projection): we load the
// current value per module from GET /api/modules/:name/config and save with PATCH. Vanilla JS, no
// build, no framework (house style).

(function () {
  "use strict";

  var ROOT_ID = "settings-modules";
  var META_ID = "settings-meta";
  var STATUS_ID = "status";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setStatus(text, on) {
    var s = document.getElementById(STATUS_ID);
    if (!s) return;
    s.textContent = text;
    s.classList.toggle("status-on", !!on);
  }

  // Project a module's config_schema down to its install-scope fields (mirrors the core's
  // installSubschema). A field with no scope, or scope "render", is a per-render knob and is skipped.
  function installFields(schema) {
    var out = {};
    if (!schema || typeof schema !== "object") return out;
    for (var key in schema) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) continue;
      var f = schema[key];
      if (f && f.scope === "install") out[key] = f;
    }
    return out;
  }

  // One labeled control bound by data-module / data-field, type mirroring the ConfigField union
  // (same control mapping as the planner render-config panel). Seeded from `value` when provided,
  // else the field default.
  function controlForField(moduleName, key, field, value) {
    var label = el("label", "settings-field");
    var span = el("span", "settings-field-label", field.label || key);

    var has = value !== undefined && value !== null;
    var input;

    if (field.type === "bool") {
      input = el("input");
      input.type = "checkbox";
      input.checked = has ? !!value : !!field.default;
      label.classList.add("settings-field-check");
      label.appendChild(input);
      label.appendChild(span);
      input.dataset.module = moduleName;
      input.dataset.field = key;
      input.dataset.fieldType = "bool";
      return label;
    }

    label.appendChild(span);

    if (field.type === "enum") {
      input = el("select");
      var values = Array.isArray(field.values) ? field.values : [];
      for (var i = 0; i < values.length; i++) {
        var v = values[i];
        var opt = el("option", null, (field.enum_labels && field.enum_labels[v]) || v);
        opt.value = v;
        input.appendChild(opt);
      }
      input.value = has ? String(value) : String(field.default != null ? field.default : "");
    } else if (field.type === "int" || field.type === "float") {
      input = el("input");
      input.type = "number";
      input.step = field.type === "float" ? "any" : "1";
      if (typeof field.min === "number") input.min = String(field.min);
      if (typeof field.max === "number") input.max = String(field.max);
      input.value = has ? String(value) : (field.default != null ? String(field.default) : "");
    } else {
      input = el("input");
      input.type = "text";
      input.value = has ? String(value) : (field.default != null ? String(field.default) : "");
      var dh = field.default != null && field.default !== "" ? String(field.default) : "";
      if (dh) input.placeholder = "default: " + dh;
    }

    input.dataset.module = moduleName;
    input.dataset.field = key;
    input.dataset.fieldType = field.type;
    label.appendChild(input);
    return label;
  }

  // Read one control's value back in the field's native type. A blank text/number returns undefined
  // (left at the stored default) rather than forcing an empty string / NaN onto the wire.
  function readControl(input) {
    var t = input.dataset.fieldType;
    if (t === "bool") return input.checked;
    var raw = input.value;
    if (raw === "" || raw == null) return undefined;
    if (t === "int") {
      var n = parseInt(raw, 10);
      return isFinite(n) ? n : undefined;
    }
    if (t === "float") {
      var f = Number(raw);
      return isFinite(f) ? f : undefined;
    }
    return raw;
  }

  // Collect the patch for one module section (data-field controls under it).
  function collectModule(section) {
    var patch = {};
    var inputs = section.querySelectorAll("[data-module][data-field]");
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var val = readControl(input);
      if (val === undefined) continue;
      patch[input.dataset.field] = val;
    }
    return patch;
  }

  function saveModule(moduleName, section, statusEl, btn) {
    var patch = collectModule(section);
    btn.disabled = true;
    statusEl.textContent = "saving...";
    statusEl.classList.remove("settings-status-error", "settings-status-ok");
    fetch("/api/modules/" + encodeURIComponent(moduleName) + "/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then(function (r) {
        return r.ok ? r.json() : r.text().then(function (t) {
          throw new Error("HTTP " + r.status + (t ? ": " + t.slice(0, 160) : ""));
        });
      })
      .then(function (data) {
        // Re-seed controls from the authoritative saved config so what is shown matches what is stored.
        var cfg = (data && data.config) || {};
        var inputs = section.querySelectorAll("[data-module][data-field]");
        for (var i = 0; i < inputs.length; i++) {
          var input = inputs[i];
          var key = input.dataset.field;
          if (!Object.prototype.hasOwnProperty.call(cfg, key)) continue;
          if (input.dataset.fieldType === "bool") input.checked = !!cfg[key];
          else input.value = cfg[key] == null ? "" : String(cfg[key]);
        }
        statusEl.textContent = "saved";
        statusEl.classList.add("settings-status-ok");
      })
      .catch(function (e) {
        statusEl.textContent = "save failed (" + e.message + ")";
        statusEl.classList.add("settings-status-error");
      })
      .finally(function () {
        btn.disabled = false;
      });
  }

  // Render one module's install settings as a section, loading its current values from the
  // Access-gated per-module config endpoint.
  function renderModuleSection(root, mod, fields) {
    var section = el("section", "settings-module");
    section.dataset.module = mod.name;

    var head = el("div", "settings-module-head");
    var title = el("h3", "settings-module-name", moduleTitle(mod));
    head.appendChild(title);
    head.appendChild(el("span", "settings-module-id", mod.name));
    section.appendChild(head);

    var fieldsHost = el("div", "settings-fields");
    fieldsHost.textContent = "loading current values...";
    section.appendChild(fieldsHost);

    var foot = el("div", "settings-module-foot");
    var btn = el("button", "btn settings-save", "Save");
    btn.type = "button";
    var statusEl = el("span", "settings-status");
    foot.appendChild(btn);
    foot.appendChild(statusEl);
    section.appendChild(foot);

    root.appendChild(section);

    fetch("/api/modules/" + encodeURIComponent(mod.name) + "/config", {
      headers: { accept: "application/json" },
    })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status));
      })
      .then(function (data) {
        var values = (data && data.config) || {};
        fieldsHost.replaceChildren();
        var keys = Object.keys(fields);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          fieldsHost.appendChild(controlForField(mod.name, k, fields[k], values[k]));
        }
        btn.addEventListener("click", function () {
          saveModule(mod.name, section, statusEl, btn);
        });
      })
      .catch(function (e) {
        // Could not load current values: still render the controls from defaults so the operator can
        // set them (a first-time install has no stored row yet); show why the load was partial.
        fieldsHost.replaceChildren();
        var keys = Object.keys(fields);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          fieldsHost.appendChild(controlForField(mod.name, k, fields[k], undefined));
        }
        statusEl.textContent = "(showing defaults; could not load saved values: " + e.message + ")";
        statusEl.classList.add("settings-status-error");
        btn.addEventListener("click", function () {
          saveModule(mod.name, section, statusEl, btn);
        });
      });
  }

  function moduleTitle(mod) {
    var l = mod.provides && mod.provides[0] && mod.provides[0].label;
    return (l && String(l).trim()) || mod.name;
  }

  function boot() {
    var root = document.getElementById(ROOT_ID);
    var meta = document.getElementById(META_ID);
    if (!root) return;

    fetch("/api/modules", { headers: { accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error("/api/modules -> " + r.status));
      })
      .then(function (data) {
        var modules = (data && data.modules) || [];
        var withInstall = [];
        for (var i = 0; i < modules.length; i++) {
          var fields = installFields(modules[i].config_schema);
          if (Object.keys(fields).length) withInstall.push({ mod: modules[i], fields: fields });
        }

        root.replaceChildren();
        if (!withInstall.length) {
          root.appendChild(el(
            "p",
            "settings-empty",
            "No installed module exposes an operator setting. Bind a module with an install-scope " +
              "config field (for example notify-email) and it will appear here."
          ));
          setStatus("live", true);
          return;
        }

        for (var j = 0; j < withInstall.length; j++) {
          renderModuleSection(root, withInstall[j].mod, withInstall[j].fields);
        }

        if (meta) {
          meta.hidden = false;
          var n = withInstall.length;
          meta.textContent = n + " module" + (n === 1 ? "" : "s") + " with operator settings" +
            (data.api ? " (contract " + data.api + ")" : "");
        }
        setStatus("live", true);
      })
      .catch(function (e) {
        setStatus("offline", false);
        root.replaceChildren();
        root.appendChild(el("p", "settings-empty", "Could not reach the registry: " + e.message));
      });
  }

  boot();
})();
