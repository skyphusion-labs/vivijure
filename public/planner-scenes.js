// Planner UI -- scene editor + live YAML preview.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Scene editor (v0.49.0) ----------
//
// Mutates planState.storyboard.scenes[i] in place; the bundle stage
// already POSTs planState.storyboard to /api/storyboard/bundle, so
// edits flow through with no extra wiring. The YAML preview refreshes
// via a debounced POST to /api/storyboard/yaml after each change.
// Validation errors from that route surface inline so the user sees
// why their edit broke the schema (e.g. blank prompt, missing slot).

const SCENE_YAML_REFRESH_MS = 500;

let sceneYamlRefreshTimer = null;
let sceneYamlInflight = false;

// Pure helper: produce a deep-clone of an array of scene objects.
// Vitest covers this via the cast-db test file (the planner-side
// scene editor depends on it for the discard-edits flow).
function cloneScenes(scenes) {
  return JSON.parse(JSON.stringify(scenes || []));
}

function setSceneStatus(text, kind) {
  const el = $("#planner-scenes-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

function scenesAreDirty() {
  if (!planState.storyboard || !planState.originalStoryboard) return false;
  return (
    JSON.stringify(planState.storyboard.scenes)
    !== JSON.stringify(planState.originalStoryboard.scenes)
  );
}

function refreshSceneDirtyBadge() {
  const dirty = scenesAreDirty();
  $("#planner-scenes-dirty-badge").hidden = !dirty;
  $("#planner-scenes-discard").disabled = !dirty;
}

async function refreshYamlPreview() {
  if (!planState.storyboard) return;
  if (sceneYamlInflight) return;
  sceneYamlInflight = true;
  setSceneStatus("refreshing yaml preview...", "loading");
  try {
    const resp = await fetch("/api/storyboard/yaml", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storyboard: planState.storyboard }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok && typeof data.yaml === "string") {
      $("#planner-yaml").textContent = data.yaml;
      $("#planner-json").textContent = JSON.stringify(planState.storyboard, null, 2);
      setSceneStatus("yaml in sync", "success");
    } else {
      const errs = Array.isArray(data.errors) ? data.errors.join(" · ") : (data.error || "validation failed");
      setSceneStatus("edit breaks the schema: " + errs, "error");
    }
  } catch (err) {
    setSceneStatus("yaml refresh failed: " + err.message, "error");
  } finally {
    sceneYamlInflight = false;
  }
}

function scheduleYamlRefresh() {
  if (sceneYamlRefreshTimer) clearTimeout(sceneYamlRefreshTimer);
  sceneYamlRefreshTimer = setTimeout(refreshYamlPreview, SCENE_YAML_REFRESH_MS);
}

function onSceneChanged() {
  refreshSceneDirtyBadge();
  scheduleYamlRefresh();
  persistSoon();
  // v0.56.0: auto-preflight on edit. Debounced; in-flight runs get
  // a re-queue so the panel stays current as the user keeps editing.
  schedulePreflight();
}

function deleteScene(idx) {
  if (!planState.storyboard) return;
  const scenes = planState.storyboard.scenes || [];
  if (idx < 0 || idx >= scenes.length) return;
  const scene = scenes[idx];
  const label = scene.id ? scene.id : "scene " + (idx + 1);
  if (!window.confirm("delete " + label + "? this cannot be undone (but discard all edits will restore it).")) return;
  scenes.splice(idx, 1);
  renderSceneEditor(planState.storyboard);
  onSceneChanged();
}

function discardSceneEdits() {
  if (!planState.originalStoryboard) return;
  if (!window.confirm("discard all scene edits and restore the original plan output?")) return;
  planState.storyboard.scenes = cloneScenes(planState.originalStoryboard.scenes);
  renderSceneEditor(planState.storyboard);
  onSceneChanged();
}

function buildSceneRow(scene, idx, useChars) {
  const li = document.createElement("li");
  li.className = "planner-scene-row";
  li.dataset.idx = String(idx);

  const head = document.createElement("div");
  head.className = "planner-scene-head";
  const idLabel = document.createElement("strong");
  idLabel.textContent = scene.id || "scene " + (idx + 1);
  head.appendChild(idLabel);
  if (scene.act) {
    const act = document.createElement("span");
    act.className = "planner-scene-act";
    act.textContent = "act: " + scene.act;
    head.appendChild(act);
  }
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "planner-scene-delete";
  delBtn.textContent = "delete";
  delBtn.title = "remove this scene from the storyboard";
  delBtn.addEventListener("click", () => deleteScene(idx));
  head.appendChild(delBtn);
  li.appendChild(head);

  const promptField = document.createElement("label");
  promptField.className = "planner-field";
  const promptLabel = document.createElement("span");
  promptLabel.textContent = "prompt";
  promptField.appendChild(promptLabel);
  const promptInput = document.createElement("textarea");
  promptInput.rows = 3;
  promptInput.value = scene.prompt || "";
  promptInput.addEventListener("input", () => {
    scene.prompt = promptInput.value;
    onSceneChanged();
  });
  promptField.appendChild(promptInput);
  li.appendChild(promptField);

  const meta = document.createElement("div");
  meta.className = "planner-scene-meta";

  const secField = document.createElement("label");
  secField.className = "planner-field";
  const secLabel = document.createElement("span");
  secLabel.textContent = "target seconds";
  secField.appendChild(secLabel);
  const secInput = document.createElement("input");
  secInput.type = "number";
  secInput.min = "0";
  secInput.step = "0.5";
  secInput.value = scene.target_seconds != null ? String(scene.target_seconds) : "";
  secInput.addEventListener("input", () => {
    const v = secInput.value.trim();
    if (v === "") {
      delete scene.target_seconds;
    } else {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) scene.target_seconds = n;
    }
    onSceneChanged();
  });
  secField.appendChild(secInput);
  meta.appendChild(secField);

  const actField = document.createElement("label");
  actField.className = "planner-field";
  const actLabel = document.createElement("span");
  actLabel.textContent = "act";
  actField.appendChild(actLabel);
  const actInput = document.createElement("input");
  actInput.type = "text";
  actInput.value = scene.act || "";
  actInput.placeholder = "(optional)";
  actInput.addEventListener("input", () => {
    const v = actInput.value.trim();
    if (v === "") delete scene.act;
    else scene.act = v;
    onSceneChanged();
  });
  actField.appendChild(actInput);
  meta.appendChild(actField);

  li.appendChild(meta);

  // character_slots: render a checkbox per loaded slot. Editing toggles
  // the scene's character_slots array; empty list means "narration shot",
  // and the validator allows that.
  if (Array.isArray(useChars) && useChars.length > 0) {
    const slotsField = document.createElement("div");
    slotsField.className = "planner-field";
    const slotsLabel = document.createElement("span");
    slotsLabel.textContent = "character_slots (in this shot)";
    slotsField.appendChild(slotsLabel);
    const slotsRow = document.createElement("div");
    slotsRow.className = "planner-scene-slots";
    const sceneSlots = new Set(Array.isArray(scene.character_slots) ? scene.character_slots : []);

    // dialogue: an optional spoken line for the shot. The speaker must be one of the shot's
    // character_slots, so the speaker dropdown is driven by the checkboxes below and refreshed when
    // they change. Blank text = a silent shot (scene.dialogue removed). The voice each speaker uses
    // is set per cast member on the /cast page; here we author the line + who says it.
    const dlgSpeaker = document.createElement("select");
    dlgSpeaker.className = "planner-scene-dialogue-slot";
    const dlgText = document.createElement("input");
    dlgText.type = "text";
    dlgText.className = "planner-scene-dialogue-text";
    dlgText.maxLength = 300;
    dlgText.value = (scene.dialogue && scene.dialogue.text) || "";

    const syncDialogue = () => {
      const text = dlgText.value.trim();
      const slot = dlgSpeaker.value;
      if (!text || !slot) delete scene.dialogue;
      else scene.dialogue = { slot: slot, text: text };
      onSceneChanged();
    };
    const refreshSpeakerOptions = () => {
      const slots = Array.from(sceneSlots);
      const want = dlgSpeaker.value || (scene.dialogue && scene.dialogue.slot) || slots[0] || "";
      dlgSpeaker.innerHTML = "";
      for (const s of slots) {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        dlgSpeaker.appendChild(opt);
      }
      if (slots.indexOf(want) >= 0) dlgSpeaker.value = want;
      const none = slots.length === 0;
      dlgSpeaker.disabled = none;
      dlgText.disabled = none;
      dlgText.placeholder = none
        ? "add a character to this shot to give it a line"
        : "what they say (blank = silent shot)";
    };

    for (const slot of useChars) {
      const lbl = document.createElement("label");
      lbl.className = "planner-scene-slot-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = sceneSlots.has(slot);
      cb.addEventListener("change", () => {
        if (cb.checked) sceneSlots.add(slot);
        else sceneSlots.delete(slot);
        const list = Array.from(sceneSlots);
        if (list.length === 0) delete scene.character_slots;
        else scene.character_slots = list;
        // Keep the dialogue speaker in sync: a removed slot can no longer speak.
        refreshSpeakerOptions();
        syncDialogue();
        onSceneChanged();
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(" " + slot));
      slotsRow.appendChild(lbl);
    }
    slotsField.appendChild(slotsRow);
    li.appendChild(slotsField);

    const dlgField = document.createElement("div");
    dlgField.className = "planner-field";
    const dlgLabel = document.createElement("span");
    dlgLabel.textContent = "dialogue (spoken line, optional)";
    dlgField.appendChild(dlgLabel);
    const dlgRow = document.createElement("div");
    dlgRow.className = "planner-scene-dialogue";
    dlgSpeaker.addEventListener("change", syncDialogue);
    dlgText.addEventListener("input", syncDialogue);
    refreshSpeakerOptions();
    dlgRow.appendChild(dlgSpeaker);
    dlgRow.appendChild(dlgText);
    dlgField.appendChild(dlgRow);
    li.appendChild(dlgField);
  }

  return li;
}

// v0.135.2: client-side mirror of the server's storyboard-validate backfill
// (src/storyboard-validate.ts). The server populates target_seconds at
// plan/refine time, but a storyboard that arrives any other way -- restored
// from saved state, an older project planned before the backfill shipped, or a
// model that omitted clip_seconds/duration -- renders straight to the scene
// editor with no backfill and shows blank "target seconds" boxes. Run the same
// priority here (explicit start/end span, else clip_seconds, else an even split
// of duration_seconds) so the boxes are never unexpectedly empty. Mutates the
// storyboard in place so the filled value persists + flows downstream to bundle
// / render, matching the server. No-op when target_seconds is already set.
function backfillTargetSeconds(storyboard) {
  if (!storyboard || !Array.isArray(storyboard.scenes)) return;
  const clip = storyboard.clip_seconds;
  const dur = storyboard.duration_seconds;
  const n = storyboard.scenes.length;
  let perShot;
  if (typeof clip === "number" && clip > 0) {
    perShot = clip;
  } else if (typeof dur === "number" && dur > 0 && n > 0) {
    perShot = Math.round((dur / n) * 100) / 100;
  }
  for (const s of storyboard.scenes) {
    if (typeof s.target_seconds === "number") continue;
    if (typeof s.start === "number" && typeof s.end === "number" && s.end > s.start) {
      s.target_seconds = Math.round((s.end - s.start) * 100) / 100;
    } else if (perShot !== undefined) {
      s.target_seconds = perShot;
    }
  }
}

function renderSceneEditor(storyboard) {
  const section = $("#planner-scenes");
  const list = $("#planner-scenes-list");
  if (!section || !list) return;
  list.innerHTML = "";
  if (!storyboard || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
    section.hidden = true;
    return;
  }
  backfillTargetSeconds(storyboard);
  const useChars = Array.isArray(storyboard.use_characters) ? storyboard.use_characters : [];
  storyboard.scenes.forEach((scene, idx) => {
    list.appendChild(buildSceneRow(scene, idx, useChars));
  });
  section.hidden = false;
  refreshSceneDirtyBadge();
  setSceneStatus("", "");
}

