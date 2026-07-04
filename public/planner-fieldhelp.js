// Planner UI -- per-option help affordance (the "?" popovers on render-override controls).
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Per-option help affordance (v0.124.0) ----------
//
// Each render-override control (common row + advanced settings) gets a small
// "?" button next to its label. Clicking it shows a popover describing the
// option. The prose lives in FIELD_HELP keyed by control id and is filled in
// over time; until an entry exists, the popover still shows useful auto-
// derived facts: allowed values (a <select>'s option list), the numeric range
// (a number input's min / max / step), and the pod default (the input's
// placeholder). So the affordance reserves the space now and is already
// useful, and documenting an option later is just adding a FIELD_HELP entry.
// v0.130.0: descriptions sourced from vivijure-serverless/CONFIG-REFERENCE.md
// (every pod config knob: default, range, behavior), expanded into plain
// language. The popover auto-derives values/range/default, so each entry only
// needs `what`. Empty on a control still means "use the bundle/pod default".
function collectRenderOverrides(opts) {
  if (!window.plannerRenderConfig) return undefined;
  return window.plannerRenderConfig.collectForSubmit(readVal("#planner-render-overrides"), opts);
}

// Film title + credit-card TEXT for the film.finish chain. Shapes FilmTitleSpec{text,subtitle?} +
// FilmCreditSpec{lines}: the title rides only with a non-empty text (a subtitle alone is dropped --
// FilmTitleSpec requires text), and credits are the non-blank textarea lines. Returns undefined when
// nothing is set, so an empty section never widens the submit body (the core then sets no cards).
function collectFilmTitles() {
  const title = readVal("#planner-film-title").trim();
  const subtitle = readVal("#planner-film-subtitle").trim();
  const lines = readVal("#planner-film-credits")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const out = {};
  if (title) out.title = subtitle ? { text: title, subtitle } : { text: title };
  if (lines.length) out.credits = { lines };
  return Object.keys(out).length ? out : undefined;
}

const FIELD_HELP = {};

let _fieldHelpPop = null;
let _fieldHelpWired = false;

function fieldHelpRow(label, val) {
  const d = document.createElement("div");
  d.className = "field-help-row";
  const b = document.createElement("b");
  b.textContent = label + ": ";
  d.appendChild(b);
  d.appendChild(document.createTextNode(val));
  return d;
}

function buildFieldHelpContent(field, id) {
  const frag = document.createDocumentFragment();
  const h = FIELD_HELP[id] || {};
  const ctrl = field.querySelector("input, select, textarea");
  if (h.what) {
    const p = document.createElement("p");
    p.className = "field-help-what";
    p.textContent = h.what;
    frag.appendChild(p);
  }
  let valuesText = h.values || "";
  if (!valuesText && ctrl && ctrl.tagName === "SELECT") {
    const opts = Array.from(ctrl.options)
      .map((o) => o.value)
      .filter((v) => v !== "");
    if (opts.length) valuesText = opts.join(", ");
  }
  let rangeText = h.range || "";
  if (!rangeText && ctrl && ctrl.tagName === "INPUT" && ctrl.type === "number") {
    const parts = [];
    if (ctrl.min !== "") parts.push("min " + ctrl.min);
    if (ctrl.max !== "") parts.push("max " + ctrl.max);
    if (ctrl.step && ctrl.step !== "" && ctrl.step !== "any") parts.push("step " + ctrl.step);
    if (parts.length) rangeText = parts.join(", ");
  }
  let defText = h.default || "";
  if (!defText && ctrl && ctrl.placeholder) defText = ctrl.placeholder;
  if (valuesText) frag.appendChild(fieldHelpRow("values", valuesText));
  if (rangeText) frag.appendChild(fieldHelpRow("range", rangeText));
  if (defText) frag.appendChild(fieldHelpRow("default", defText));
  if (!frag.childNodes.length) {
    const p = document.createElement("p");
    p.className = "field-help-empty";
    p.textContent = "not documented yet";
    frag.appendChild(p);
  }
  return frag;
}

function hideFieldHelp() {
  if (_fieldHelpPop) {
    _fieldHelpPop.hidden = true;
    _fieldHelpPop._owner = null;
  }
}

function toggleFieldHelp(btn, field) {
  if (!_fieldHelpPop) {
    _fieldHelpPop = document.createElement("div");
    _fieldHelpPop.className = "field-help-pop";
    _fieldHelpPop.hidden = true;
    document.body.appendChild(_fieldHelpPop);
  }
  const pop = _fieldHelpPop;
  if (!pop.hidden && pop._owner === btn) {
    hideFieldHelp();
    return;
  }
  pop.innerHTML = "";
  pop.appendChild(buildFieldHelpContent(field, btn.dataset.helpId || ""));
  pop._owner = btn;
  pop.hidden = false;
  // Position under the button, clamped to the viewport's right edge.
  const r = btn.getBoundingClientRect();
  const maxLeft = document.documentElement.clientWidth - 320;
  pop.style.top = window.scrollY + r.bottom + 6 + "px";
  pop.style.left = window.scrollX + Math.max(8, Math.min(r.left, maxLeft)) + "px";
}

// Inject a "?" button into every render-override field's label. Runs once at
// init; the controls exist in the DOM from page load (inside collapsed
// <details>), so attaching while hidden is fine.
function attachFieldHelp() {
  const fields = document.querySelectorAll(
    "#planner-render .planner-overrides-common .planner-field, " +
      "#planner-render .planner-overrides-details .planner-field",
  );
  fields.forEach((field) => {
    const labelSpan = field.querySelector(":scope > span");
    if (!labelSpan || labelSpan.querySelector(".field-help")) return;
    const ctrl = field.querySelector("input, select, textarea");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "field-help";
    btn.textContent = "?";
    btn.setAttribute("aria-label", "what is this option?");
    btn.dataset.helpId = ctrl ? ctrl.id : "";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFieldHelp(btn, field);
    });
    labelSpan.classList.add("has-help");
    labelSpan.appendChild(btn);
  });
  if (_fieldHelpWired) return;
  _fieldHelpWired = true;
  document.addEventListener("click", (e) => {
    if (!_fieldHelpPop || _fieldHelpPop.hidden) return;
    if (_fieldHelpPop.contains(e.target)) return;
    if (e.target.classList && e.target.classList.contains("field-help")) return;
    hideFieldHelp();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideFieldHelp();
  });
}

