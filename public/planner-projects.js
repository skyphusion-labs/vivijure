// Planner UI -- project picker + markers export.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Project picker + markers export (v0.53.0) ----------

async function loadProjects() {
  try {
    const resp = await fetch("/api/storyboard/projects");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    planState.projectCatalog = Array.isArray(data.projects) ? data.projects : [];
  } catch (err) {
    console.warn("loadProjects failed; planner project picker stays empty:", err);
    planState.projectCatalog = [];
  }
  renderProjectPicker();
}

function findProject(id) {
  if (!id) return null;
  return planState.projectCatalog.find((p) => p.id === id) || null;
}

function setProjectStatus(text, kind) {
  const el = $("#planner-project-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

function renderProjectPicker() {
  const sel = $("#planner-project-picker");
  if (!sel) return;
  const current = planState.activeProjectId ? String(planState.activeProjectId) : "";
  sel.innerHTML = "";
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "(no project - transient)";
  sel.appendChild(optNone);
  for (const p of planState.projectCatalog) {
    const opt = document.createElement("option");
    opt.value = String(p.id);
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = current;
  refreshProjectButtonGates();
}

function refreshProjectButtonGates() {
  const hasActive = !!planState.activeProjectId;
  const hasStoryboard = !!planState.storyboard;
  const saveBtn = $("#planner-project-save");
  if (saveBtn) saveBtn.disabled = !(hasActive && hasStoryboard);
  const delBtn = $("#planner-project-delete");
  if (delBtn) delBtn.disabled = !hasActive;
}

function applyProjectPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  // Selectively pull known fields from the prefs object. The Worker
  // accepts arbitrary keys so the planner can add more here without a
  // schema change. v0.54.0 expanded "dial-in" to include the render
  // form fields (quality tier, structured overrides, keyframes-only)
  // so picking a project also restores the render preset.
  const setVal = (sel, v) => {
    if (v === undefined || v === null) return;
    const el = $(sel);
    if (el) el.value = String(v);
  };
  const setCheck = (sel, v) => {
    if (typeof v !== "boolean") return;
    const el = $(sel);
    if (el) el.checked = v;
  };
  setVal("#planner-model", prefs.modelId);
  setVal("#planner-brief", prefs.brief);
  if (typeof prefs.bpm === "number" && prefs.bpm > 0) {
    planState.bpm = prefs.bpm;
    setVal("#planner-bpm", prefs.bpm);
  }
  if (typeof prefs.beatsPerShot === "number" && prefs.beatsPerShot > 0) {
    planState.beatsPerShot = prefs.beatsPerShot;
    setVal("#planner-beats-per-shot", prefs.beatsPerShot);
  }
  // v0.54.0 dial-in: render-form fields.
  setVal("#planner-quality-tier", prefs.qualityTier);
  setCheck("#planner-keyframes-only", prefs.keyframesOnly);
  setVal("#planner-seed", prefs.seed);
  setVal("#planner-face-lock-mode", prefs.faceLockMode);
  if (typeof prefs.renderOverridesText === "string") {
    setVal("#planner-render-overrides", prefs.renderOverridesText);
  }
  setVal("#planner-film-title", prefs.filmTitle);
  setVal("#planner-film-subtitle", prefs.filmSubtitle);
  setVal("#planner-film-credits", prefs.filmCredits);
}

function gatherProjectPrefs() {
  const readVal = (sel) => {
    const el = $(sel);
    return el ? el.value : undefined;
  };
  const readCheck = (sel) => {
    const el = $(sel);
    return el ? !!el.checked : undefined;
  };
  return {
    modelId: readVal("#planner-model"),
    brief: readVal("#planner-brief"),
    bpm: planState.bpm,
    beatsPerShot: planState.beatsPerShot,
    // v0.54.0 dial-in additions: full render preset.
    qualityTier: readVal("#planner-quality-tier"),
    keyframesOnly: readCheck("#planner-keyframes-only"),
    seed: readVal("#planner-seed"),
    faceLockMode: readVal("#planner-face-lock-mode"),
    renderOverridesText: readVal("#planner-render-overrides"),
    filmTitle: readVal("#planner-film-title"),
    filmSubtitle: readVal("#planner-film-subtitle"),
    filmCredits: readVal("#planner-film-credits"),
  };
}

async function selectProject(id) {
  planState.activeProjectId = id || null;
  // Keep the picker <select> in sync with the active project. newProject() renders
  // the picker BEFORE this runs, so without this the dropdown stays on the empty
  // "(no project - transient)" option after a create (#740).
  {
    const picker = $("#planner-project-picker");
    if (picker) picker.value = planState.activeProjectId ? String(planState.activeProjectId) : "";
  }
  // v0.55.0: re-fetch history with the new active project so the list
  // scopes to the selected project (or back to all rows when (none)).
  loadHistory();
  const p = findProject(id);
  if (p) {
    setProjectStatus("loaded " + p.name, "success");
    applyProjectPrefs(p.prefs);
    if (p.last_storyboard) {
      planState.storyboard = p.last_storyboard;
      planState.originalStoryboard = JSON.parse(JSON.stringify(p.last_storyboard));
      planState.refineHistory = [];
      $("#planner-output").hidden = false;
      $("#planner-output-state").textContent = "ok";
      $("#planner-output-state").className = "planner-output-state planner-success";
      $("#planner-errors").hidden = true;
      $("#planner-result").hidden = false;
      $("#planner-raw").hidden = true;
      $("#planner-json").textContent = JSON.stringify(p.last_storyboard, null, 2);
      try {
        const r = await fetch("/api/storyboard/yaml", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ storyboard: p.last_storyboard }),
        });
        const d = await r.json();
        if (r.ok && d.yaml) $("#planner-yaml").textContent = d.yaml;
      } catch { /* yaml refresh is best-effort */ }
      renderSceneEditor(p.last_storyboard);
      showRefineSection();
      showAudioSection();
    }
  } else {
    setProjectStatus("", "");
  }
  refreshProjectButtonGates();
  persistSoon();
}

async function newProject() {
  const name = window.prompt("project name?");
  if (!name || !name.trim()) return;
  try {
    const resp = await fetch("/api/storyboard/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), prefs: gatherProjectPrefs() }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
    planState.projectCatalog.unshift(data.project);
    renderProjectPicker();
    await selectProject(data.project.id);
  } catch (err) {
    window.alert("create failed: " + err.message);
  }
}

async function saveStoryboardToProject() {
  const id = planState.activeProjectId;
  if (!id || !planState.storyboard) return;
  try {
    setProjectStatus("saving...", "loading");
    // Update prefs first (so a re-load picks up the current form
    // settings), then save the storyboard snapshot.
    await fetch("/api/storyboard/projects/" + id, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefs: gatherProjectPrefs() }),
    });
    const resp = await fetch("/api/storyboard/projects/" + id + "/storyboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storyboard: planState.storyboard }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
    const idx = planState.projectCatalog.findIndex((p) => p.id === id);
    if (idx >= 0) planState.projectCatalog[idx] = data.project;
    setProjectStatus("saved", "success");
  } catch (err) {
    setProjectStatus("save failed: " + err.message, "error");
  }
}

async function deleteActiveProject() {
  const id = planState.activeProjectId;
  if (!id) return;
  const p = findProject(id);
  if (!p) return;
  if (!window.confirm("delete project '" + p.name + "'? this does not delete render history.")) return;
  try {
    const resp = await fetch("/api/storyboard/projects/" + id, { method: "DELETE" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    planState.projectCatalog = planState.projectCatalog.filter((x) => x.id !== id);
    planState.activeProjectId = null;
    renderProjectPicker();
    setProjectStatus("deleted", "success");
  } catch (err) {
    setProjectStatus("delete failed: " + err.message, "error");
  }
}

async function exportMarkers() {
  if (!planState.storyboard) {
    window.alert("plan a storyboard first");
    return;
  }
  const fmtEl = $("#planner-markers-format");
  const format = fmtEl ? fmtEl.value : "premiere_csv";
  try {
    const resp = await fetch("/api/storyboard/markers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storyboard: planState.storyboard, format }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || "HTTP " + resp.status);
    }
    const blob = await resp.blob();
    const cd = resp.headers.get("content-disposition") || "";
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = m ? m[1] : "markers.csv";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    window.alert("export failed: " + err.message);
  }
}

// Expose pure helpers for vitest.
if (typeof window !== "undefined") {
  window.__plannerHelpers = window.__plannerHelpers || {};
  window.__plannerHelpers.gatherProjectPrefs = gatherProjectPrefs;
}

