// Planner UI -- restorers that rehydrate the DOM + module state from a persisted stash.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Restorers ----------

function applyPersistedStash(stash) {
  if (!stash) return null;

  // Filters first so loadHistory's first render uses the restored view.
  if (stash.historyFilters) restoreHistoryFilters(stash.historyFilters);

  // Plan form fields. Model picker value is set later (after loadModels).
  if (stash.planForm) restorePlanForm(stash.planForm);

  // Plan result panel (storyboard JSON + YAML side-by-side view).
  if (stash.planResult) restorePlanResultPanel(stash.planResult);

  // Bundle stage (per-slot upload widgets with already-staged R2 keys).
  if (stash.bundleStage && stash.planResult) {
    restoreBundleStagePanel(stash.bundleStage, stash.planResult);
  }

  // Render stage + reattach an SSE stream for in-flight renders.
  if (stash.renderStage) restoreRenderStagePanel(stash.renderStage);

  // v0.41.1: restore in-flight regen jobs and resume polling. Drop
  // entries older than the cap so a regen abandoned across a long
  // gap (or one whose RunPod job TTL has expired) does not keep
  // polling forever.
  if (Array.isArray(stash.regenJobs)) restoreRegenJobs(stash.regenJobs);

  return stash;
}

function restorePersistedState() {
  return applyPersistedStash(loadPersistedState());
}

function afterPersistedStashApplied(stash) {
  buildStepper();
  stepState.unlocked = computeStepUnlocked();
  refreshSteps();
  loadModels().then(() => {
    if (stash && stash.planForm && stash.planForm.modelId) {
      const select = $("#planner-model");
      if (select) {
        const found = Array.from(select.options).some(
          (o) => o.value === stash.planForm.modelId,
        );
        if (found) select.value = stash.planForm.modelId;
      }
    }
  });
  loadCast().then(() => {
    renderCastPickerOptions();
    applyRestoredCastBindings();
  });
  loadProjects().then(() => {
    if (planState.activeProjectId) {
      const sel = $("#planner-project-picker");
      if (sel) sel.value = String(planState.activeProjectId);
      const p = findProject(planState.activeProjectId);
      if (p) applyProjectPrefs(p.prefs);
      refreshProjectButtonGates();
    }
  });
}

// v0.41.1: rebuild historyState.regenJobs from the persisted entries
// array, then kick off polling for each surviving entry. Entries older
// than REGEN_RESTORE_MAX_AGE_MS are dropped (matches the rough upper
// bound on a render's wall-clock duration; RunPod's job TTL is 24h but
// a regen specifically is supposed to be a 30-60s operation, so any
// entry older than ~6h is almost certainly abandoned).
const REGEN_RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function restoreRegenJobs(saved) {
  const now = Date.now();
  historyState.regenJobs.clear();
  for (const entry of saved) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, state] = entry;
    if (typeof key !== "string" || !state || typeof state !== "object") continue;
    if (typeof state.jobId !== "string" || state.jobId.length === 0) continue;
    if (typeof state.kfKey !== "string" || state.kfKey.length === 0) continue;
    if (typeof state.shotId !== "string" || state.shotId.length === 0) continue;
    const startedAt = typeof state.startedAt === "number" ? state.startedAt : 0;
    if (startedAt && now - startedAt > REGEN_RESTORE_MAX_AGE_MS) continue;
    historyState.regenJobs.set(key, {
      jobId: state.jobId,
      kfKey: state.kfKey,
      shotId: state.shotId,
      rowId: state.rowId,
      startedAt: startedAt || now,
    });
    // Resume polling. pollRegenJob reads the latest state from the
    // Map each tick, so a race with a subsequent set / delete is
    // resolved at next poll boundary.
    pollRegenJob(key);
  }
}

function restoreHistoryFilters(saved) {
  historyState.filters.text = typeof saved.text === "string" ? saved.text : "";
  historyState.filters.showInFlight = saved.showInFlight !== false;
  historyState.filters.showDone = saved.showDone !== false;
  historyState.filters.showFailed = saved.showFailed !== false;
  // Mirror to the form controls so the visible state matches the
  // persisted state. applyHistoryFilters runs when loadHistory completes.
  $("#planner-history-search").value = historyState.filters.text;
  $("#planner-filter-inflight").checked = historyState.filters.showInFlight;
  $("#planner-filter-done").checked = historyState.filters.showDone;
  $("#planner-filter-failed").checked = historyState.filters.showFailed;
}

function restorePlanForm(saved) {
  if (typeof saved.brief === "string") $("#planner-brief").value = saved.brief;
  // v0.56.0: restore the auto-preflight toggle. Default-on for users
  // who pre-date the toggle (no field in their stash).
  if (typeof saved.preflightAutoEnabled === "boolean") {
    preflightAutoEnabled = saved.preflightAutoEnabled;
    const el = $("#planner-preflight-auto");
    if (el) el.checked = preflightAutoEnabled;
  }
  if (Array.isArray(saved.cast)) {
    for (const entry of saved.cast) {
      const row = document.querySelector('.planner-cast-row[data-slot="' + entry.slot + '"]');
      if (!row) continue;
      const check = row.querySelector("[data-cast-include]");
      const name = row.querySelector(".planner-cast-name");
      const bible = row.querySelector(".planner-cast-bible");
      check.checked = !!entry.checked;
      name.disabled = !entry.checked;
      bible.disabled = !entry.checked;
      name.value = entry.name || "";
      bible.value = entry.bible || "";
    }
  }
  // v0.48.0: restore slot->cast bindings AFTER the cast catalog has
  // been fetched (or reconciled to drop dead bindings). The restore
  // flow defers re-applying bindings until loadCast() resolves; see
  // applyRestoredCastBindings.
  if (saved.castBindings && typeof saved.castBindings === "object") {
    planState.castBindings = { ...saved.castBindings };
  }
}

function restorePlanResultPanel(saved) {
  if (!saved.storyboard) return;
  planState.storyboard = saved.storyboard;
  planState.cast = saved.cast || [];
  // v0.49.0: restore the discard-edits snapshot. Older stashes that
  // predate this field fall back to the current storyboard, which means
  // "discard" becomes a no-op until the next plan; harmless.
  planState.originalStoryboard = saved.originalStoryboard
    ? JSON.parse(JSON.stringify(saved.originalStoryboard))
    : JSON.parse(JSON.stringify(saved.storyboard));

  $("#planner-output").hidden = false;
  $("#planner-output-meta").textContent = "(restored from previous session)";
  $("#planner-output-state").textContent = "ok";
  $("#planner-output-state").className = "planner-output-state planner-success";
  $("#planner-errors").hidden = true;
  $("#planner-result").hidden = false;
  $("#planner-raw").hidden = true;
  $("#planner-json").textContent = JSON.stringify(saved.storyboard, null, 2);
  $("#planner-yaml").textContent = saved.yaml || "";
  renderSceneEditor(saved.storyboard);
  // v0.50.0: restore the refinement chat history. Older stashes that
  // predate the field fall back to an empty log.
  planState.refineHistory = Array.isArray(saved.refineHistory) ? saved.refineHistory : [];
  showRefineSection();
  // v0.51.0: restore audio bed key + BPM + snap settings + in-flight
  // music-gen chat id. The audio section becomes visible whenever a
  // plan resolves, regardless of whether audio is set.
  planState.audioKey = typeof saved.audioKey === "string" ? saved.audioKey : null;
  planState.audioMime = typeof saved.audioMime === "string" ? saved.audioMime : null;
  planState.audioSourceLabel = typeof saved.audioSourceLabel === "string" ? saved.audioSourceLabel : null;
  planState.bpm = typeof saved.bpm === "number" && saved.bpm > 0 ? saved.bpm : 120;
  planState.beatsPerShot = typeof saved.beatsPerShot === "number" && saved.beatsPerShot > 0
    ? saved.beatsPerShot : 4;
  planState.pendingMusicChatId = typeof saved.pendingMusicChatId === "string"
    ? saved.pendingMusicChatId : null;
  planState.pendingMusicModule = typeof saved.pendingMusicModule === "string"
    ? saved.pendingMusicModule : null;
  planState.pendingScoreBedKind = saved.pendingScoreBedKind === "music" || saved.pendingScoreBedKind === "narration"
    ? saved.pendingScoreBedKind : null;
  planState.pendingScoreBedLabel = typeof saved.pendingScoreBedLabel === "string"
    ? saved.pendingScoreBedLabel : null;
  showAudioSection();
  if (planState.pendingMusicChatId) resumeMusicPolling();
  // v0.53.0: stash the active project id; the picker's options are
  // populated after loadProjects resolves, and we reselect there.
  // S9 (F13): activeProjectId is an opaque public id (UUID string).
  planState.activeProjectId = typeof saved.activeProjectId === "string"
    ? saved.activeProjectId : null;
}

function restoreBundleStagePanel(savedBundle, savedPlanResult) {
  // Filter out "uploading" entries: those were interrupted by the reload
  // and would mislead the user about state. The R2 ingest never finished
  // for them, so they would not be in the bundle anyway.
  const filteredUploads = {};
  for (const slot of Object.keys(savedBundle.perSlotUploads || {})) {
    filteredUploads[slot] = (savedBundle.perSlotUploads[slot] || []).filter(
      (e) => e.status !== "uploading",
    );
  }

  // showBundleStage rebuilds the widgets; pass the filtered uploads + restored
  // per-scene keyframes so the freshly-built rows hydrate with their R2 keys.
  showBundleStage(
    savedPlanResult.storyboard,
    savedPlanResult.cast || [],
    filteredUploads,
    savedBundle.sceneStartImages || {},
  );

  // If the bundle was already assembled, restore the result panel + bundle
  // key + open the render stage (without yet activating it).
  if (savedBundle.bundleKey) {
    bundleState.bundleKey = savedBundle.bundleKey;
    // v0.135.1: rehydrate the persisted size/count so the restored panel shows
    // the real bundle stats instead of a misleading "0 B / 0 files inside".
    bundleState.sizeBytes = savedBundle.sizeBytes || 0;
    bundleState.fileCount = savedBundle.fileCount || 0;
    showBundleResult({
      ok: true,
      bundleKey: savedBundle.bundleKey,
      sizeBytes: bundleState.sizeBytes,
      fileCount: bundleState.fileCount,
    });
    setBundleStatus("restored from previous session", "loading");
  }
}

function restoreRenderStagePanel(saved) {
  if (!saved.jobId && !saved.bundleKey) return;

  bundleState.bundleKey = saved.bundleKey || bundleState.bundleKey;

  // Restore form fields first so the user sees the chosen tier and any
  // overrides text even if there is no live render to attach to.
  if (saved.qualityTier) $("#planner-quality-tier").value = saved.qualityTier;
  if (typeof saved.renderOverridesText === "string") {
    $("#planner-render-overrides").value = saved.renderOverridesText;
    if (saved.renderOverridesText.trim().length > 0) {
      const expert = $(".planner-overrides-expert");
      if (expert) expert.open = true;
    }
  }
  if (saved.moduleOverrides && window.plannerRenderConfig) {
    window.plannerRenderConfig.restore(saved.moduleOverrides);
    const details = $(".planner-overrides-details");
    if (details) details.open = true;
  }
  const kfOnlyEl = $("#planner-keyframes-only");
  if (kfOnlyEl) kfOnlyEl.checked = !!saved.keyframesOnly;
  // Restore the title / credit-card text, and open the section if any was set so the
  // restored values are visible rather than hidden behind a collapsed <details>.
  const setFilmField = (sel, v) => {
    if (typeof v !== "string") return;
    const el = $(sel);
    if (el) el.value = v;
  };
  setFilmField("#planner-film-title", saved.filmTitle);
  setFilmField("#planner-film-subtitle", saved.filmSubtitle);
  setFilmField("#planner-film-credits", saved.filmCredits);
  if ((saved.filmTitle || saved.filmSubtitle || saved.filmCredits || "").toString().trim().length > 0) {
    const ft = $(".planner-film-titles");
    if (ft) ft.open = true;
  }
  if (typeof saved.startedAt === "number" && saved.startedAt > 0) {
    renderState.startedAt = saved.startedAt;
  }

  if (!saved.jobId) {
    // Render stage was open but no submit happened. Reveal the stage and
    // let the user click "render" when ready.
    $("#planner-render").hidden = false;
    setRenderStatus("restored from previous session", "loading");
    return;
  }

  // Active render. Reuse resumeRender's wiring by building a synthetic
  // row from the persisted state; the function reattaches the SSE stream
  // when the status is non-terminal.
  resumeRender({
    job_id: saved.jobId,
    project: saved.currentProject || "(restored)",
    label: saved.currentLabel || null,
    bundle_key: saved.bundleKey,
    quality_tier: saved.qualityTier || "final",
    status: saved.lastKnownStatus || "IN_PROGRESS",
    output_key: null,
    output: null,
    error: null,
  });
}

