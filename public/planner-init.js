// Planner UI -- browser notifications, status/formatting helpers, and DOMContentLoaded init wiring.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Browser notifications (v0.37.0) ----------
//
// Fires an OS-level notification when a render hits a terminal status, so
// the user can walk away from a 10-to-30 minute Wan render and let the
// browser ping them when it lands. Asked-for once at first-submit time
// (delaying the permission prompt until the value is obvious; nothing
// asks on page load); afterwards the per-job dedupe in
// `notifyState.alreadyNotified` keeps a stream-retry from double-firing.
// Silently no-ops on unsupported browsers and on denied permission.

function initNotifications() {
  if (typeof Notification === "undefined") {
    notifyState.permission = "unsupported";
    return;
  }
  notifyState.permission = Notification.permission;
  // Reveal the "enable notifications" header button only when the user
  // has not made a choice yet. Granted + denied both leave it hidden.
  const btn = $("#planner-notify-toggle");
  if (btn) btn.hidden = notifyState.permission !== "default";
}

async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return;
  try {
    const result = await Notification.requestPermission();
    notifyState.permission = result;
    const btn = $("#planner-notify-toggle");
    if (btn) btn.hidden = true;
    if (result === "granted") {
      // Tiny confirmation toast so the user sees the wiring works.
      try {
        const n = new Notification("Notifications enabled", {
          body: "You will be pinged when each render finishes.",
          icon: "/icon-192.png",
        });
        setTimeout(() => n.close(), 4000);
      } catch {
        // ignore: some browsers throw on Notification with no service worker
      }
    }
  } catch (err) {
    console.error("notification permission request failed:", err);
  }
}

// Called from both the SSE message handler and the poll fallback when a
// terminal status arrives. Reads project / label from renderState (set
// at submit / resume / rerun time) so the notification title carries the
// human-readable identity instead of just the jobId.
function maybeNotifyTerminal(payload) {
  if (notifyState.permission !== "granted") return;
  if (!payload || !payload.jobId) return;
  if (notifyState.alreadyNotified.has(payload.jobId)) return;
  notifyState.alreadyNotified.add(payload.jobId);

  const identity =
    renderState.currentLabel
    || renderState.currentProject
    || payload.jobId;
  const status = payload.status || "FINISHED";

  let prefix;
  if (status === "COMPLETED") prefix = "✓";
  else if (status === "FAILED") prefix = "✗";
  else if (status === "CANCELLED") prefix = "○";
  else if (status === "TIMED_OUT") prefix = "⏱";
  else prefix = "·";

  const title = prefix + " " + status.toLowerCase().replace(/_/g, " ") + ": " + identity;
  let body = "job " + payload.jobId;
  if (payload.executionTimeMs) {
    body += " · ran " + formatDuration(payload.executionTimeMs);
  }

  try {
    const n = new Notification(title, {
      body: body,
      icon: "/icon-192.png",
      // `tag` lets the OS dedupe within its notification list so the
      // same jobId never appears twice even if a different code path
      // tries to re-notify.
      tag: payload.jobId,
      requireInteraction: false,
    });
    n.onclick = () => {
      window.focus();
      n.close();
      const sec = document.getElementById("planner-render");
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  } catch (err) {
    console.error("notification fire failed:", err);
  }
}

// ---------- Status / formatting helpers ----------

function setStatus(text, kind) {
  const el = $("#planner-status");
  el.textContent = text;
  el.className = "planner-status planner-status-" + (kind || "");
}

function setBundleStatus(text, kind) {
  const el = $("#planner-bundle-status");
  el.textContent = text;
  el.className = "planner-status planner-status-" + (kind || "");
}

function setBundleMeta(text) {
  $("#planner-bundle-meta").textContent = text;
}

function setRenderStatus(text, kind) {
  const el = $("#planner-render-status");
  el.textContent = text;
  el.className = "planner-status planner-status-" + (kind || "");
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatDuration(ms) {
  if (ms < 1000) return ms + " ms";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + " s";
  const min = Math.floor(sec / 60);
  const remSec = sec - min * 60;
  return min + "m " + remSec + "s";
}

// ---------- Init ----------

document.addEventListener("DOMContentLoaded", () => {
  renderCast();
  const stash = loadPersistedState();
  let appliedStash = null;
  if (stash && hasPersistedWork(stash)) {
    if (isSameTabReload()) {
      appliedStash = applyPersistedStash(stash);
    } else {
      showResumeBanner(stash);
    }
  } else if (stash) {
    clearPersistedStorage();
  }

  buildStepper();
  stepState.unlocked = computeStepUnlocked();
  showStep("plan");
  attachFieldHelp();

  if (appliedStash) {
    afterPersistedStashApplied(appliedStash);
  } else {
    loadModels();
    loadCast().then(() => {
      renderCastPickerOptions();
      applyRestoredCastBindings();
    });
    loadProjects();
  }

  const resumeBtn = $("#planner-resume-btn");
  if (resumeBtn) resumeBtn.addEventListener("click", resumePendingSession);
  const discardBtn = $("#planner-discard-btn");
  if (discardBtn) discardBtn.addEventListener("click", () => startNewSession({ skipConfirm: true }));
  const newSessionBtn = $("#planner-new-session");
  if (newSessionBtn) newSessionBtn.addEventListener("click", () => startNewSession());

  loadHistory();
  initNotifications();
  // v0.49.0: scene editor discard button. The button itself is in
  // the markup at all times; toggled disabled based on dirty state by
  // refreshSceneDirtyBadge after every edit.
  const scenesDiscardBtn = $("#planner-scenes-discard");
  if (scenesDiscardBtn) scenesDiscardBtn.addEventListener("click", discardSceneEdits);
  // v0.50.0: refinement chat send button + Cmd/Ctrl+Enter in the textarea.
  const refineSend = $("#planner-refine-send");
  if (refineSend) refineSend.addEventListener("click", sendRefine);
  // v0.133.3 / v0.161.1: "new / reset" button -- full session reset. Clears
  // the brief, storyboard, audio, bundle, render, and persisted snapshot so
  // the next plan starts with a clean slate and no prior project bleeds in.
  const briefClear = $("#planner-brief-clear");
  if (briefClear) briefClear.addEventListener("click", () => startNewSession({ skipConfirm: true }));
  const refineInput = $("#planner-refine-input");
  if (refineInput) {
    refineInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      sendRefine();
    });
  }
  // v0.51.0: audio bed + beat timing.
  if (window.plannerRegistry) {
    initScoreModulesFromRegistry();
  } else {
    initScoreMusicFromRegistry();
  }
  const musicGen = $("#planner-music-gen");
  if (musicGen) musicGen.addEventListener("click", generateMusic);
  const narrationGen = $("#planner-narration-gen");
  if (narrationGen) narrationGen.addEventListener("click", generateNarration);
  // v0.137.6: "suggest from video" forces a fresh AI-drafted music prompt.
  const musicSuggest = $("#planner-music-suggest");
  if (musicSuggest) musicSuggest.addEventListener("click", () => suggestMusicPrompt({ force: true }));
  const audioFile = $("#planner-audio-file");
  if (audioFile) {
    audioFile.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadAudioFile(f);
      e.target.value = "";
    });
  }
  const audioClear = $("#planner-audio-clear");
  if (audioClear) audioClear.addEventListener("click", clearAudio);
  const snapBtn = $("#planner-snap-btn");
  if (snapBtn) snapBtn.addEventListener("click", snapAllScenes);
  const analyzeBtn = $("#planner-analyze-beats");
  if (analyzeBtn) analyzeBtn.addEventListener("click", analyzeBeats);
  const beatApply = $("#planner-beat-apply");
  if (beatApply) beatApply.addEventListener("click", applyBeatPlan);
  // v0.53.0: project picker + markers export.
  const projPick = $("#planner-project-picker");
  if (projPick) projPick.addEventListener("change", () => {
    const v = projPick.value;
    // S9 (F13): the option value is the project's opaque public id (UUID
    // string); pass it through verbatim, never Number()-coerce it.
    selectProject(v || null);
  });
  const projNew = $("#planner-project-new");
  if (projNew) projNew.addEventListener("click", newProject);
  const projSave = $("#planner-project-save");
  if (projSave) projSave.addEventListener("click", saveStoryboardToProject);
  const projDel = $("#planner-project-delete");
  if (projDel) projDel.addEventListener("click", deleteActiveProject);
  const markersBtn = $("#planner-markers-export");
  if (markersBtn) markersBtn.addEventListener("click", exportMarkers);
  // v0.54.0: preflight run button.
  const preflightBtn = $("#planner-preflight-run");
  if (preflightBtn) preflightBtn.addEventListener("click", runPreflight);
  // v0.56.0: auto-preflight toggle. Persists via the form stash.
  const preflightAuto = $("#planner-preflight-auto");
  if (preflightAuto) preflightAuto.addEventListener("change", () => {
    preflightAutoEnabled = !!preflightAuto.checked;
    persistSoon();
    // Turn-on triggers an immediate run so the panel catches up to any
    // edits the user made while auto was off.
    if (preflightAutoEnabled) schedulePreflight();
  });
  // #707: re-run preflight when the motion backend or quality tier changes, so the
  // duration-grid clamp warning stays in sync with the render selection. Delegated
  // on document because #planner-motion-backend is created dynamically by
  // renderBackendSelector (a static listener bound at init would miss it).
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t && (t.id === "planner-quality-tier" || t.id === "planner-motion-backend")) {
      schedulePreflight();
    }
  });
  const bpmEl = $("#planner-bpm");
  if (bpmEl) bpmEl.addEventListener("change", () => {
    const v = Number(bpmEl.value);
    if (Number.isFinite(v) && v > 0) planState.bpm = v;
    persistSoon();
  });
  const beatsEl = $("#planner-beats-per-shot");
  if (beatsEl) beatsEl.addEventListener("change", () => {
    const v = Number(beatsEl.value);
    if (Number.isFinite(v) && v > 0) planState.beatsPerShot = v;
    persistSoon();
  });
  // v0.38.0: persist on brief / model picker change so the planner's
  // long-form input survives a tab close. Cast field listeners are
  // wired in renderCast().
  $("#planner-brief").addEventListener("input", persistSoon);
  $("#planner-model").addEventListener("change", persistSoon);
  $("#planner-quality-tier").addEventListener("change", persistSoon);
  $("#planner-render-overrides").addEventListener("input", persistSoon);
  // v0.40.0: persist the keyframes-only checkbox alongside the other
  // render-stage form fields.
  const kfOnlyEl = $("#planner-keyframes-only");
  if (kfOnlyEl) kfOnlyEl.addEventListener("change", persistSoon);
  // vivijure#546: keyframes-only exempts the motion-backend pick, so re-gate the render
  // button whenever it toggles; and re-gate when the backend door choice changes.
  if (kfOnlyEl) kfOnlyEl.addEventListener("change", updateRenderGate);
  document.addEventListener("planner:backend-change", updateRenderGate);
  // v0.43.0: persist the structured render-settings fields. Each
  // listens for the appropriate event (input on text + number,
  // change on selects).
  $("#planner-plan").addEventListener("click", plan);
  $("#planner-reprompt").addEventListener("click", repromptWithErrors);
  $("#planner-bundle-btn").addEventListener("click", bundleNow);
  // v0.162.0: dispatch to submitScatterRender when the scatter checkbox is
  // checked; fall through to submitRender for all other cases.
  $("#planner-render-btn").addEventListener("click", async () => {
    // v0.221.0: LoRA training preflight runs first for BOTH the normal and the
    // scatter submit paths (each reuses buildCastLoraSubmit, so each can trip
    // the inline-retrain fail-safe). The gate fetches fresh cast state, so
    // disable the button while it runs to avoid a double-submit.
    const btn = $("#planner-render-btn");
    btn.disabled = true;
    // vivijure#552: mark the whole submit sequence in-flight so updateRenderGate
    // cannot re-enable the button if a form control (e.g. keyframes-only) is
    // toggled during the preflight or the pre-jobId fetch window. The submit
    // paths clear it on jobId handoff or on any error; the pause path below
    // clears it and re-gates.
    renderState.submitting = true;
    let proceed = false;
    try {
      proceed = await loraPreflightGate();
    } finally {
      // submitRender / submitScatterRender re-take ownership of the disabled
      // state from here; on a pause (proceed === false) the button stays usable.
      btn.disabled = false;
    }
    if (!proceed) {
      // Paused on a freshly-shown warning; hand the button back to the gate.
      renderState.submitting = false;
      updateRenderGate();
      return;
    }
    const scatter = $("#planner-scatter");
    if (scatter && scatter.checked && !scatter.disabled) {
      submitScatterRender();
    } else {
      submitRender();
    }
  });
  // Scatter checkbox: toggle the shard-count row visibility + re-gate.
  const scatterChk = $("#planner-scatter");
  if (scatterChk) {
    scatterChk.addEventListener("change", () => {
      const wrap = $("#planner-scatter-shard-wrap");
      if (wrap) wrap.hidden = !scatterChk.checked || scatterChk.disabled;
    });
  }
  $("#planner-render-cancel").addEventListener("click", cancelRender);
  const dismissBtn = $("#planner-render-dismiss");
  if (dismissBtn) dismissBtn.addEventListener("click", dismissRenderResult);
  $("#planner-notify-toggle").addEventListener("click", requestNotificationPermission);
  $("#planner-history-refresh").addEventListener("click", loadHistory);
  $("#planner-history-custom").addEventListener("click", promptCustomBundle);

  // v0.37.1: client-side filter inputs. No fetch on change; just re-render
  // the already-loaded rows through the new filter state. v0.38.0 also
  // persists the filter state so reload restores the user's view.
  $("#planner-history-search").addEventListener("input", (ev) => {
    historyState.filters.text = ev.target.value;
    applyHistoryFilters();
    persistSoon();
  });
  $("#planner-filter-inflight").addEventListener("change", (ev) => {
    historyState.filters.showInFlight = ev.target.checked;
    applyHistoryFilters();
    savePersistedState();
  });
  $("#planner-filter-done").addEventListener("change", (ev) => {
    historyState.filters.showDone = ev.target.checked;
    applyHistoryFilters();
    savePersistedState();
  });
  $("#planner-filter-failed").addEventListener("change", (ev) => {
    historyState.filters.showFailed = ev.target.checked;
    applyHistoryFilters();
    savePersistedState();
  });
  // v0.127.0: folder filter (session-only; not persisted). Tag filters are
  // wired on the pills themselves in rebuildHistoryFacets.
  const folderFilter = $("#planner-history-folder");
  if (folderFilter) {
    folderFilter.addEventListener("change", (ev) => {
      historyState.filters.folderPath = ev.target.value;
      applyHistoryFilters();
    });
  }

  // v0.35.2: pause auto-refresh while the tab is backgrounded; resume on
  // return with an immediate refresh so the list catches up after a long
  // hidden interval (which the auto-refresh loop intentionally skips).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (historyRefreshTimer) {
        clearTimeout(historyRefreshTimer);
        historyRefreshTimer = null;
      }
    } else {
      loadHistory();
    }
  });

  // v0.168.0 (#47): mirrors the Screenwriter assistant's existing Enter-to-send
  // pattern (planner-refine-input, line ~6813). Enter submits the plan;
  // Shift+Enter inserts a newline so multi-line briefs still work;
  // isComposing guard keeps IME (CJK) input safe.
  $("#planner-brief").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
    ev.preventDefault();
    plan();
  });

  // v0.162.0: gate the scatter checkbox on page load (no storyboard yet,
  // so it starts disabled with a reason).
  updateScatterGate();
});

// ---------- Screenwriter's Assistant dock (v0.164.0) ----------
// The storyboard-refinement chat lives in a fixed right-rail dock (#sw-dock
// in planner.html) so it never reflows the page. Toggle via the edge tab or
// the dock's close button; body.sw-open reserves the column. Auto-opens once,
// the first time the refine section becomes usable (a storyboard exists), so
// the assistant is discoverable without hunting for it.
(function initScreenwriterDock() {
  const dock = document.getElementById("sw-dock");
  const tab = document.getElementById("sw-tab");
  if (!dock || !tab) return;
  const closeBtn = document.getElementById("sw-dock-close");
  const refine = document.getElementById("planner-refine");
  function setOpen(open) {
    document.body.classList.toggle("sw-open", open);
    tab.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && refine && !refine.hidden) {
      const inp = document.getElementById("planner-refine-input");
      if (inp) inp.focus();
    }
  }
  tab.addEventListener("click", function () {
    setOpen(!document.body.classList.contains("sw-open"));
  });
  if (closeBtn) closeBtn.addEventListener("click", function () { setOpen(false); });
  if (refine) {
    let autoOpened = false;
    const obs = new MutationObserver(function () {
      if (!autoOpened && !refine.hidden) { autoOpened = true; setOpen(true); }
    });
    obs.observe(refine, { attributes: true, attributeFilter: ["hidden"] });
  }
})();

// ---------- Auto-direct: the plan.enhance hook in the UI (v0.167.0) ----------
(function initAutoDirect() {
  const btn = document.getElementById("planner-autodirect");
  const sel = document.getElementById("planner-autodirect-intensity");
  if (!btn) return;

  function revealAutoDirect() {
    if (window.plannerRegistry && window.plannerRegistry.planEnhanceInstalled()) {
      btn.hidden = false;
      if (sel) sel.hidden = false;
    }
  }
  if (window.plannerRegistry) {
    window.plannerRegistry.load().then(() => {
      revealAutoDirect();
      if (window.plannerRenderConfig) window.plannerRenderConfig.renderPanel();
    }).catch(() => {});
  }

  btn.addEventListener("click", async () => {
    const sb = planState.storyboard;
    if (!sb || !Array.isArray(sb.scenes) || !sb.scenes.length) {
      setSceneStatus("plan or load a storyboard first", "error");
      return;
    }
    const intensity = sel ? sel.value : "medium";
    btn.disabled = true;
    setSceneStatus("auto-directing shots...", "loading");
    let data;
    try {
      const resp = await fetch("/api/storyboard/enhance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyboard: sb, config: { intensity } }),
      });
      data = await resp.json();
      if (!resp.ok || !data || data.ok !== true || !data.storyboard) {
        throw new Error((data && data.error) || "enhance failed (" + resp.status + ")");
      }
    } catch (err) {
      setSceneStatus("auto-direct failed: " + err.message, "error");
      btn.disabled = false;
      return;
    }
    planState.storyboard = data.storyboard;
    const jsonPane = document.getElementById("planner-json");
    if (jsonPane) jsonPane.textContent = JSON.stringify(data.storyboard, null, 2);
    renderSceneEditor(data.storyboard);
    refreshYamlPreview();
    persistSoon();
    schedulePreflight();
    const applied = Array.isArray(data.applied) && data.applied.length ? data.applied.join(", ") : "";
    const note = Array.isArray(data.notes) && data.notes.length ? data.notes[0] : "";
    setSceneStatus(
      "auto-directed" + (applied ? " via " + applied : "") + (note ? " -- " + note : ""),
      "success",
    );
    btn.disabled = false;
  });
})();
