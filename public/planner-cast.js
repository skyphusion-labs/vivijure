// Planner UI -- cast editor (plan stage): bind storyboard slots to saved cast members.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Cast editor (plan stage) ----------

// v0.48.0: fetch the user's persisted cast catalog. One call per page
// load; failures are non-fatal (planner still works with inline-only
// cast slots, the "from cast" dropdown just shows the inline option).
async function loadCast() {
  try {
    const resp = await fetch("/api/cast");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    planState.castCatalog = Array.isArray(data.cast) ? data.cast : [];
  } catch (err) {
    console.warn("loadCast failed; planner cast picker will show inline-only:", err);
    planState.castCatalog = [];
  }
}

// Pure helper: given a bindings map and a current catalog, return the
// filtered bindings (with cast-ids that no longer exist removed) and a
// list of the slots that lost their binding. Used after loadCast on
// page restore so a deleted cast member does not leave a slot stuck.
function reconcileCastBindings(bindings, catalog) {
  const live = new Set((catalog || []).map((c) => c.id));
  const kept = {};
  const dropped = [];
  for (const slot of Object.keys(bindings || {})) {
    const id = bindings[slot];
    if (live.has(id)) {
      kept[slot] = id;
    } else {
      dropped.push(slot);
    }
  }
  return { kept, dropped };
}

function findCastById(id) {
  return planState.castCatalog.find((c) => c.id === id) || null;
}

// v0.58.0: build the {slot: cast_id} map the render/finalize routes accept
// as `castLoras`. Only includes bindings whose cast member has a trained-
// and-ready LoRA; non-ready bindings are dropped client-side so the Worker
// does not need to round-trip a "skipped" diagnostic back for them. The
// Worker still re-validates server-side (ownership + ready check), so this
// is purely a wire-bandwidth optimization for the common case.
function buildCastLoraSubmit() {
  // v0.135.6: send every validly-bound slot -> cast_id and let the render /
  // finalize route be the single authority on readiness. The route re-loads
  // each cast row from D1 (fresh, ownership-scoped) and forwards only rows
  // whose lora_status is 'ready' with a loras/ key, dropping the rest into
  // castLoraSkipped. Earlier versions gated here on the browser's CACHED
  // lora_status, so a LoRA that finished training after the page loaded was
  // silently dropped and the GPU retrained it from scratch (the worse case
  // when no per-project state.tar.gz exists yet, e.g. a new project). Gating
  // server-side removes the dependency on cache freshness entirely.
  // S9 (F13): a cast id is an opaque public id (UUID string); pass it through
  // verbatim. Number() coercion would map every UUID to NaN and send an empty
  // castLoras, and the render/scatter route now rejects a bare integer.
  const out = {};
  for (const [slot, raw] of Object.entries(planState.castBindings || {})) {
    if (typeof slot !== "string" || slot.length === 0) continue;
    if (typeof raw !== "string" || raw.length === 0) continue;
    out[slot] = raw;
  }
  return out;
}

function bindSlotToCast(slot, castId) {
  const cast = findCastById(castId);
  if (!cast) return;
  planState.castBindings[slot] = castId;
  const row = document.querySelector('.planner-cast-row[data-slot="' + slot + '"]');
  if (!row) return;
  const checkInput = row.querySelector("[data-cast-include]");
  const name = row.querySelector(".planner-cast-name");
  const bible = row.querySelector(".planner-cast-bible");
  checkInput.checked = true;
  name.value = cast.name;
  bible.value = cast.bible || "";
  // Lock the fields so the user does not edit a copy out of sync with
  // the persisted cast member. The bible can still be edited by going
  // to /cast.
  name.disabled = true;
  bible.disabled = true;
  name.readOnly = true;
  bible.readOnly = true;
  row.classList.add("planner-cast-row-bound");
  persistSoon();
  // v0.56.0: binding changes affect preflight (a slot's readiness
  // check resolves through the cast catalog).
  schedulePreflight();
}

function unbindSlot(slot) {
  delete planState.castBindings[slot];
  const row = document.querySelector('.planner-cast-row[data-slot="' + slot + '"]');
  if (!row) return;
  const checkInput = row.querySelector("[data-cast-include]");
  const name = row.querySelector(".planner-cast-name");
  const bible = row.querySelector(".planner-cast-bible");
  name.readOnly = false;
  bible.readOnly = false;
  name.disabled = !checkInput.checked;
  bible.disabled = !checkInput.checked;
  row.classList.remove("planner-cast-row-bound");
  persistSoon();
  schedulePreflight();
}

// Apply restored bindings after the cast catalog is available. Called
// from the init flow after loadCast() resolves; the localStorage
// restore path stashes bindings into planState.castBindings as soon as
// the persisted blob is read, then this function re-renders the slot
// fields against the freshly-fetched catalog.
function applyRestoredCastBindings() {
  const { kept, dropped } = reconcileCastBindings(planState.castBindings, planState.castCatalog);
  planState.castBindings = kept;
  for (const slot of Object.keys(kept)) {
    bindSlotToCast(slot, kept[slot]);
  }
  // Re-render each row's dropdown so the bound state shows in the UI.
  for (const slot of SLOT_IDS) {
    const sel = document.querySelector('.planner-cast-row[data-slot="' + slot + '"] .planner-cast-pick');
    if (sel) sel.value = kept[slot] ? String(kept[slot]) : "";
  }
  if (dropped.length > 0) {
    console.info("planner: dropped cast bindings for slots (cast deleted):", dropped);
  }
}

// Build (or rebuild) the "from cast" dropdown's options. Called on
// initial render and after a fresh loadCast (e.g. user opened /cast,
// added a character, then came back). Idempotent.
function renderCastPickerOptions() {
  for (const slot of SLOT_IDS) {
    const sel = document.querySelector('.planner-cast-row[data-slot="' + slot + '"] .planner-cast-pick');
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = "";
    const inlineOpt = document.createElement("option");
    inlineOpt.value = "";
    inlineOpt.textContent = "inline (type here)";
    sel.appendChild(inlineOpt);
    for (const c of planState.castCatalog) {
      const opt = document.createElement("option");
      opt.value = String(c.id);
      const refsCount = Array.isArray(c.ref_keys) ? c.ref_keys.length : 0;
      const portraitNote = c.portrait_key ? "portrait" : "no portrait";
      opt.textContent = c.name + " (" + portraitNote + ", " + refsCount + " refs)";
      sel.appendChild(opt);
    }
    sel.value = current;
  }
}

function renderCast() {
  const root = $("#planner-cast");
  root.innerHTML = "";
  for (const slot of SLOT_IDS) {
    const row = document.createElement("div");
    row.className = "planner-cast-row";
    row.dataset.slot = slot;

    const check = document.createElement("label");
    check.className = "planner-cast-check";
    const checkInput = document.createElement("input");
    checkInput.type = "checkbox";
    checkInput.dataset.castInclude = "";
    check.appendChild(checkInput);
    check.appendChild(document.createTextNode(" slot " + slot));

    // v0.48.0: pick-from-cast dropdown. Empty value = inline; any
    // non-empty value = a cast_id bound to this slot.
    const pick = document.createElement("select");
    pick.className = "planner-cast-pick";
    pick.title = "load a persisted cast member (manage at /cast)";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "planner-cast-name";
    name.placeholder = "name (e.g. Elena)";
    name.disabled = true;

    const bible = document.createElement("textarea");
    bible.className = "planner-cast-bible";
    bible.rows = 2;
    bible.placeholder = "bible: condensed appearance description";
    bible.disabled = true;

    checkInput.addEventListener("change", () => {
      const enabled = checkInput.checked;
      // If the slot is bound, do not let manual edit re-enable; the
      // user must explicitly unbind via the dropdown.
      if (!planState.castBindings[slot]) {
        name.disabled = !enabled;
        bible.disabled = !enabled;
        if (enabled) name.focus();
      }
      persistSoon();
    });
    pick.addEventListener("change", () => {
      const v = pick.value;
      if (!v) {
        unbindSlot(slot);
        return;
      }
      // S9 (F13): the option value is the cast's opaque public id (UUID
      // string); bind it verbatim, never Number()-coerce it.
      bindSlotToCast(slot, v);
    });
    // v0.38.0: persist cast field changes so the brief + names + bibles
    // survive a tab close.
    name.addEventListener("input", persistSoon);
    bible.addEventListener("input", persistSoon);

    row.appendChild(check);
    row.appendChild(pick);
    row.appendChild(name);
    row.appendChild(bible);
    root.appendChild(row);
  }
  renderCastPickerOptions();
}

function collectCast() {
  const characters = [];
  for (const row of document.querySelectorAll(".planner-cast-row")) {
    const include = row.querySelector("[data-cast-include]").checked;
    if (!include) continue;
    const slot = row.dataset.slot;
    const name = row.querySelector(".planner-cast-name").value.trim();
    const bible = row.querySelector(".planner-cast-bible").value.trim();
    if (!name) continue;
    characters.push({ slot, name, bible });
  }
  return characters;
}

