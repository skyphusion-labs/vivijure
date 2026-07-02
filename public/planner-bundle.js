// Planner UI -- bundle stage: keyframes, per-slot reference uploads, assemble the .tar.gz.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Bundle stage ----------

function showBundleStage(storyboard, characters, initialUploads, initialSceneStartImages) {
  planState.storyboard = storyboard;
  planState.cast = characters;
  bundleState.perSlotUploads = initialUploads ? { ...initialUploads } : {};
  // v0.149.0 (Phase 4b): reset (or restore) the per-scene start keyframes.
  bundleState.sceneStartImages = initialSceneStartImages ? { ...initialSceneStartImages } : {};
  bundleState.bundleKey = null;
  bundleState.sizeBytes = 0;
  bundleState.fileCount = 0;

  const useChars =
    Array.isArray(storyboard.use_characters) && storyboard.use_characters.length > 0
      ? storyboard.use_characters
      : [];

  const root = $("#planner-bundle-cast");
  root.innerHTML = "";

  if (useChars.length === 0) {
    // No slots loaded in the storyboard. The bundle is still legal (the
    // GPU side will skip identity-lock for empty-cast renders), but
    // assemble.py needs at least the storyboard.yaml. Show a note and
    // enable the bundle button immediately.
    const note = document.createElement("p");
    note.className = "planner-stage-hint";
    note.textContent =
      "this storyboard has no character slots loaded (use_characters is empty). "
      + "the bundle will ship just the storyboard; the GPU worker renders "
      + "without identity lock.";
    root.appendChild(note);
  } else {
    for (const slot of useChars) {
      // v0.48.0: if this slot is bound to a persisted cast member,
      // synthesize the perSlotUploads entries from the cast's portrait
      // + ref_keys and overwrite any inline uploads from a prior pass.
      // This makes the bundle-assembly code (which reads keys from
      // perSlotUploads) work without any change.
      const boundId = planState.castBindings[slot];
      const bound = boundId ? findCastById(boundId) : null;
      if (bound) {
        bundleState.perSlotUploads[slot] = synthesizeUploadsFromCast(bound);
      } else if (!bundleState.perSlotUploads[slot]) {
        // v0.38.0: only initialize an empty array when we did not get
        // pre-populated uploads from restoration. Otherwise the existing
        // entries are preserved.
        bundleState.perSlotUploads[slot] = [];
      }
      const ch = characters.find((c) => c.slot === slot) || {
        name: "Character " + slot,
        bible: "",
      };
      root.appendChild(buildSlotUploadRow(slot, ch, bound));
      // Hydrate the file list from any pre-existing entries (typically
      // staged-to-R2 keys from before a tab close, or v0.48.0
      // synthesized from a bound cast).
      if (bundleState.perSlotUploads[slot].length > 0) {
        renderSlotList(slot);
      }
    }
  }

  // v0.149.0 (Phase 4b): per-scene start-keyframe pickers (rehydrate from any
  // keys passed in via initialSceneStartImages, set above).
  renderSceneKeyframes(storyboard);

  const stage = $("#planner-bundle");
  stage.hidden = false;
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#planner-bundle-result").hidden = true;
  setBundleStatus("", "");
  setBundleMeta("");
}

// v0.149.0 (Phase 4b): resolve a scene's id the same way the validator + pod do
// (explicit id, else shot_NN by 1-based index).
function sceneIdAt(scene, index) {
  return (scene && typeof scene.id === "string" && scene.id.trim())
    ? scene.id.trim()
    : "shot_" + String(index + 1).padStart(2, "0");
}

/** Scenes for POST /api/storyboard/render module path (film orchestrator). */
function buildFilmScenes(storyboard) {
  const scenes = Array.isArray(storyboard && storyboard.scenes) ? storyboard.scenes : [];
  const clipSec =
    storyboard && typeof storyboard.clip_seconds === "number" && storyboard.clip_seconds > 0
      ? storyboard.clip_seconds
      : 4;
  return scenes
    .map((scene, i) => {
      const prompt = typeof scene.prompt === "string" ? scene.prompt.trim() : "";
      if (!prompt) return null;
      const seconds =
        typeof scene.target_seconds === "number" && scene.target_seconds > 0
          ? scene.target_seconds
          : clipSec;
      return { shot_id: sceneIdAt(scene, i), prompt, seconds };
    })
    .filter(Boolean);
}

// v0.149.0 (Phase 4b): build the optional per-scene start-keyframe section. One
// row per scene: id + prompt snippet + a file input (or, once staged, a thumb +
// clear). A staged image lands in bundleState.sceneStartImages[id] = {key,
// filename}; bundleNow ships it as clips/<id>_keyframe.png.
function renderSceneKeyframes(storyboard) {
  const wrap = $("#planner-bundle-scenes-wrap");
  const host = $("#planner-bundle-scenes");
  if (!wrap || !host) return;
  host.innerHTML = "";
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  if (scenes.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  scenes.forEach((scene, i) => {
    const id = sceneIdAt(scene, i);
    const row = document.createElement("div");
    row.className = "planner-bundle-scene-row";
    row.dataset.sceneId = id;

    const label = document.createElement("div");
    label.className = "planner-bundle-scene-label";
    const idEl = document.createElement("strong");
    idEl.textContent = id;
    label.appendChild(idEl);
    const prompt = typeof scene.prompt === "string" ? scene.prompt : "";
    if (prompt) {
      const snip = document.createElement("span");
      snip.className = "planner-bundle-scene-prompt";
      snip.textContent = prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
      label.appendChild(snip);
    }
    row.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "planner-bundle-scene-controls";

    const status = document.createElement("span");
    status.className = "planner-bundle-scene-status";

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";
    input.className = "planner-bundle-scene-file";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "planner-bundle-scene-clear";
    clearBtn.textContent = "clear";
    clearBtn.hidden = true;

    const applyStaged = (filename) => {
      status.textContent = "✓ " + filename;
      status.classList.add("planner-bundle-scene-status-done");
      input.hidden = true;
      clearBtn.hidden = false;
    };
    const applyEmpty = () => {
      status.textContent = "";
      status.classList.remove("planner-bundle-scene-status-done");
      input.hidden = false;
      input.value = "";
      clearBtn.hidden = true;
    };

    // Rehydrate a restored key.
    const existing = bundleState.sceneStartImages[id];
    if (existing && existing.key) applyStaged(existing.filename || "keyframe");

    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      status.textContent = "staging…";
      status.classList.remove("planner-bundle-scene-status-done");
      input.disabled = true;
      try {
        const key = await uploadOneRef(file);
        bundleState.sceneStartImages[id] = { key, filename: file.name };
        applyStaged(file.name);
      } catch (err) {
        status.textContent = "failed: " + err.message;
      } finally {
        input.disabled = false;
      }
    });

    clearBtn.addEventListener("click", () => {
      delete bundleState.sceneStartImages[id];
      applyEmpty();
    });

    controls.appendChild(status);
    controls.appendChild(input);
    controls.appendChild(clearBtn);
    row.appendChild(controls);
    host.appendChild(row);
  });
}

// v0.48.0: synthesize bundleState.perSlotUploads[slot] entries from a
// persisted cast member's portrait + ref_keys. The bundle assembler
// reads keys from these entries and does not care whether the file was
// uploaded inline (staged ephemerally) or pulled from a persisted cast
// member; matching the same {key, status: "done"} shape keeps the
// downstream code path unchanged.
function synthesizeUploadsFromCast(cast) {
  const entries = [];
  if (cast.portrait_key) {
    entries.push({
      filename: "portrait",
      size: 0,
      mime: cast.portrait_mime || "image/png",
      key: cast.portrait_key,
      status: "done",
      fromCast: true,
    });
  }
  for (let i = 0; i < (cast.ref_keys || []).length; i++) {
    const r = cast.ref_keys[i];
    entries.push({
      filename: "ref-" + (i + 1),
      size: 0,
      mime: r.mime || "image/png",
      key: r.key,
      status: "done",
      fromCast: true,
    });
  }
  return entries;
}

function buildSlotUploadRow(slot, char, bound) {
  const row = document.createElement("div");
  row.className = "planner-slot-upload";
  if (bound) row.classList.add("planner-slot-upload-bound");
  row.dataset.slot = slot;

  const head = document.createElement("div");
  head.className = "planner-slot-head";
  const headTitle = document.createElement("strong");
  headTitle.textContent = "slot " + slot + (char.name ? " · " + char.name : "");
  head.appendChild(headTitle);
  if (char.bible) {
    const bible = document.createElement("span");
    bible.className = "planner-slot-bible";
    bible.textContent = char.bible;
    head.appendChild(bible);
  }
  row.appendChild(head);

  // v0.48.0: bound to a persisted cast member. Hide the file picker
  // and show a small badge instead; the perSlotUploads array was
  // already populated with the cast's portrait + refs. Manage at
  // /cast.html instead.
  if (bound) {
    const linked = document.createElement("div");
    linked.className = "planner-slot-linked";
    const portraitCount = bound.portrait_key ? 1 : 0;
    const refCount = (bound.ref_keys || []).length;
    linked.textContent =
      "linked to cast member: " + bound.name
      + " (" + portraitCount + " portrait, " + refCount + " refs). "
      + "manage at /cast.";
    row.appendChild(linked);
    const list = document.createElement("ul");
    list.className = "planner-slot-list";
    list.id = "planner-list-" + slot;
    row.appendChild(list);
    const summary = document.createElement("div");
    summary.className = "planner-slot-summary";
    summary.id = "planner-summary-" + slot;
    row.appendChild(summary);
    return row;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "image/png,image/jpeg,image/webp";
  input.id = "planner-files-" + slot;
  input.className = "planner-slot-input";

  const label = document.createElement("label");
  label.htmlFor = input.id;
  label.className = "planner-slot-pick";
  label.textContent = "+ select PNG / JPEG / WEBP files (8 or more recommended)";

  row.appendChild(label);
  row.appendChild(input);

  const list = document.createElement("ul");
  list.className = "planner-slot-list";
  list.id = "planner-list-" + slot;
  row.appendChild(list);

  const summary = document.createElement("div");
  summary.className = "planner-slot-summary";
  summary.id = "planner-summary-" + slot;
  row.appendChild(summary);

  input.addEventListener("change", () => {
    handleSlotFiles(slot, input.files);
    // Reset the input so re-selecting the same file fires `change`.
    input.value = "";
  });

  return row;
}

async function handleSlotFiles(slot, fileList) {
  if (!fileList || fileList.length === 0) return;
  for (const file of fileList) {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      bundleState.perSlotUploads[slot].push({
        filename: file.name,
        size: file.size,
        mime: file.type || "(unknown)",
        key: null,
        status: "error",
        error: "unsupported type: " + (file.type || "(none)"),
      });
      renderSlotList(slot);
      continue;
    }
    const entry = {
      filename: file.name,
      size: file.size,
      mime: file.type,
      key: null,
      status: "uploading",
      error: null,
    };
    bundleState.perSlotUploads[slot].push(entry);
    renderSlotList(slot);
    try {
      const key = await uploadOneRef(file);
      entry.key = key;
      entry.status = "done";
    } catch (err) {
      entry.status = "error";
      entry.error = err.message || String(err);
    }
    renderSlotList(slot);
    // v0.38.0: persist after every status transition so a tab close in the
    // middle of a multi-file upload preserves what already landed on R2.
    savePersistedState();
  }
}

async function uploadOneRef(file) {
  const resp = await fetch("/api/storyboard/character-ref", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!resp.ok) {
    let errMsg = "HTTP " + resp.status;
    try {
      const data = await resp.json();
      if (data && data.error) errMsg = data.error;
    } catch {
      // non-JSON error body; keep the HTTP status
    }
    throw new Error(errMsg);
  }
  const data = await resp.json();
  if (!data.key) throw new Error("response missing `key`");
  return data.key;
}

function renderSlotList(slot) {
  const list = $("#planner-list-" + slot);
  list.innerHTML = "";
  for (const entry of bundleState.perSlotUploads[slot]) {
    const li = document.createElement("li");
    li.className = "planner-slot-entry";

    const filename = document.createElement("span");
    filename.className = "planner-slot-filename";
    filename.textContent = entry.filename;
    li.appendChild(filename);

    const size = document.createElement("span");
    size.className = "planner-slot-size";
    // v0.134.2: cast-pulled / reloaded rows carry no client-side byte size
    // (refs are stored as {key, mime}), so don't render a misleading "0 B" that
    // reads as an empty file. Inline uploads still show their real size.
    size.textContent = entry.size ? formatBytes(entry.size) : "";
    li.appendChild(size);

    const status = document.createElement("span");
    if (entry.status === "uploading") {
      status.className = "planner-slot-uploading";
      status.textContent = "uploading...";
    } else if (entry.status === "done") {
      status.className = "planner-slot-done";
      status.textContent = "staged";
    } else {
      status.className = "planner-slot-error";
      status.textContent = "failed: " + (entry.error || "unknown");
    }
    li.appendChild(status);

    list.appendChild(li);
  }
  const summary = $("#planner-summary-" + slot);
  const total = bundleState.perSlotUploads[slot].reduce((a, e) => a + e.size, 0);
  const staged = bundleState.perSlotUploads[slot].filter((e) => e.status === "done").length;
  const errored = bundleState.perSlotUploads[slot].filter((e) => e.status === "error").length;
  summary.textContent =
    bundleState.perSlotUploads[slot].length
      + " selected, " + staged + " staged"
      + (errored ? ", " + errored + " failed" : "")
      + (total ? " · " + formatBytes(total) : "");
}

async function bundleNow() {
  if (!planState.storyboard) {
    setBundleStatus("no validated storyboard; run 'plan' first", "error");
    return;
  }

  const useChars = planState.storyboard.use_characters || [];
  const characterRefs = {};
  const errors = [];

  for (const slot of useChars) {
    const uploads = bundleState.perSlotUploads[slot] || [];
    const stillUploading = uploads.some((e) => e.status === "uploading");
    if (stillUploading) {
      errors.push("slot " + slot + " has uploads still in progress");
      continue;
    }
    const staged = uploads.filter((e) => e.status === "done" && e.key);
    if (staged.length === 0) {
      errors.push("slot " + slot + " has no staged training images");
      continue;
    }
    const ch = planState.cast.find((c) => c.slot === slot) || {
      name: "Character " + slot,
      bible: "",
    };
    characterRefs[slot] = {
      name: ch.name,
      prompt: ch.bible || "",
      trainingImages: staged.map((e) => ({ key: e.key })),
    };
  }

  if (errors.length > 0) {
    setBundleStatus(errors.join(" · "), "error");
    return;
  }

  // v0.149.0 (Phase 4b): collect any staged per-scene start keyframes into the
  // { sceneId: { key } } shape the bundle endpoint expects. Omitted when none.
  const sceneStartImages = {};
  for (const [sceneId, entry] of Object.entries(bundleState.sceneStartImages || {})) {
    if (entry && entry.key) sceneStartImages[sceneId] = { key: entry.key };
  }
  const hasSceneStarts = Object.keys(sceneStartImages).length > 0;

  setBundleStatus("assembling .tar.gz on the worker...", "loading");
  $("#planner-bundle-btn").disabled = true;

  let resp = null;
  let data = null;
  try {
    const reqBody = {
      storyboard: planState.storyboard,
      characterRefs,
    };
    if (hasSceneStarts) reqBody.sceneStartImages = sceneStartImages;
    resp = await fetch("/api/storyboard/bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    data = await resp.json();
  } catch (err) {
    setBundleStatus("network error: " + err.message, "error");
    $("#planner-bundle-btn").disabled = false;
    return;
  } finally {
    $("#planner-bundle-btn").disabled = false;
  }

  if (!resp.ok && data && data.error) {
    setBundleStatus("bundle rejected (" + resp.status + ")", "error");
    showBundleResult({ ok: false, errors: [data.error] });
    return;
  }

  if (data && data.ok === false) {
    setBundleStatus("bundle assembly failed", "error");
    showBundleResult(data);
    return;
  }

  if (data && data.ok === true && data.bundleKey) {
    bundleState.bundleKey = data.bundleKey;
    // v0.135.1: stash the real size/count so they survive a reload (persisted
    // via collectBundleStageState, rehydrated in restoreBundleStagePanel).
    bundleState.sizeBytes = data.sizeBytes || 0;
    bundleState.fileCount = data.fileCount || 0;
    setBundleStatus("staged", "success");
    showBundleResult(data);
    showRenderStage();
    // v0.137.6: a staged bundle unlocks BOTH Audio and Render. Advance to Audio
    // (the next step in order), NOT straight to Render. Jumping to Render skipped
    // the Audio step entirely, and because bundle assembly is async that late
    // showStep("render") yanked the user off Audio if they had already navigated
    // there ("bundle, go to audio, it skips to render"). Render stays unlocked,
    // so the user can still jump ahead when they are ready.
    refreshSteps();
    showStep("audio");
    savePersistedState();
    return;
  }

  setBundleStatus("unexpected response shape", "error");
}

function showBundleResult(data) {
  const root = $("#planner-bundle-result");
  root.hidden = false;
  root.innerHTML = "";

  if (data.ok === false) {
    const h = document.createElement("h3");
    h.textContent = "bundle errors";
    root.appendChild(h);
    const ul = document.createElement("ul");
    for (const e of data.errors || []) {
      const li = document.createElement("li");
      li.textContent = e;
      ul.appendChild(li);
    }
    root.appendChild(ul);
    return;
  }

  const h = document.createElement("h3");
  h.textContent = "bundle staged";
  root.appendChild(h);

  const keyLine = document.createElement("div");
  const keyLabel = document.createElement("span");
  keyLabel.className = "planner-render-label";
  keyLabel.textContent = "key:";
  const keyCode = document.createElement("code");
  keyCode.textContent = data.bundleKey || "";
  keyLine.appendChild(keyLabel);
  keyLine.appendChild(document.createTextNode(" "));
  keyLine.appendChild(keyCode);
  root.appendChild(keyLine);

  const sizeLine = document.createElement("div");
  const sizeLabel = document.createElement("span");
  sizeLabel.className = "planner-render-label";
  sizeLabel.textContent = "size:";
  sizeLine.appendChild(sizeLabel);
  sizeLine.appendChild(
    document.createTextNode(
      " " + formatBytes(data.sizeBytes || 0)
        + " gzipped, " + (data.fileCount || 0) + " files inside",
    ),
  );
  root.appendChild(sizeLine);

  // v0.150.0 (Phase 4b): if this bundle carries per-scene start keyframes, offer
  // to render them directly on the GPU via Wan i2v (skipping the SDXL keyframe
  // pass) -- the reverse-bridge loop, driven from the planner.
  const injectedCount = Object.keys(bundleState.sceneStartImages || {}).length;
  if (data.bundleKey && injectedCount > 0) {
    const wrap = document.createElement("div");
    wrap.className = "planner-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "planner-primary";
    btn.textContent = "render from keyframes (GPU i2v)";
    btn.title = injectedCount + " injected keyframe" + (injectedCount === 1 ? "" : "s")
      + ": animate them with " + gpuMotionLabel() + " on the GPU, no " + keyframeLabel() + " keyframe pass";
    const status = document.createElement("span");
    status.className = "planner-status";
    btn.addEventListener("click", () => renderFromKeyframes(data.bundleKey, btn, status));
    wrap.appendChild(btn);
    wrap.appendChild(status);
    root.appendChild(wrap);
  }
}

// v0.150.0 (Phase 4b): submit a GPU i2v render DIRECTLY against the bundle's
// injected per-scene keyframes (POST /api/storyboard/render-from-keyframes). The
// pod's finalize/i2v_only pass reuses clips/<id>_keyframe.png with no fresh SDXL
// pass. The new render row polls in History via the existing auto-refresh
// (mirrors animateCloudRender's submit + reload flow).
async function renderFromKeyframes(bundleKey, btn, status) {
  const project = planState.storyboard && planState.storyboard.projectName;
  if (!project) { status.textContent = "no project"; return; }
  if (!window.confirm(
    "render this bundle's " + Object.keys(bundleState.sceneStartImages || {}).length
    + " injected keyframe(s) with " + gpuMotionLabel() + " (no " + keyframeLabel() + " keyframe pass)?\n\ncontinue?"
  )) return;
  const tierEl = $("#planner-quality-tier");
  const qualityTier = tierEl && tierEl.value ? tierEl.value : "final";
  let renderOverrides;
  try {
    renderOverrides = collectRenderOverrides();
  } catch (err) {
    btn.disabled = false;
    status.textContent = err.message;
    return;
  }
  const body = { project: project, bundleKey: bundleKey, qualityTier: qualityTier };
  if (renderOverrides) body.renderOverrides = renderOverrides;
  if (planState.audioKey) body.audioKey = planState.audioKey;
  btn.disabled = true;
  status.textContent = "submitting i2v render...";
  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render-from-keyframes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await resp.json();
  } catch (err) {
    btn.disabled = false;
    status.textContent = "network error: " + err.message;
    return;
  }
  if (!resp.ok || !data || data.ok === false) {
    btn.disabled = false;
    const msg = (data && (data.error || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    status.textContent = "failed: " + msg;
    return;
  }
  status.textContent = "submitted" + (data.jobId ? " (" + data.jobId + ")" : "");
  loadHistory();
}

function resetBundleStage() {
  bundleState.perSlotUploads = {};
  // v0.161.1: also clear scene start images so keyframe slots from a prior
  // plan never leak into a new one.
  bundleState.sceneStartImages = {};
  bundleState.bundleKey = null;
  bundleState.sizeBytes = 0;
  bundleState.fileCount = 0;
  $("#planner-bundle").hidden = true;
  $("#planner-bundle-result").hidden = true;
  setBundleStatus("", "");
  setBundleMeta("");
}

