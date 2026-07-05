// Planner UI -- module-scope pipeline state, localStorage persistence, and state collectors.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- State (held in module scope across stages) ----------

const planState = {
  storyboard: null,         // StoryboardValidated from POST /api/storyboard/plan
  cast: [],                 // PlannerCharacter[] from the cast form at plan time
  // v0.48.0: persisted cast wiring. castCatalog is the user's cast members
  // fetched from /api/cast (one fetch per page load). castBindings maps
  // a slot id ("A"/"B"/"C"/"D") to a cast member id; a bound slot pulls
  // name + bible from the cast member at plan time and pulls portrait +
  // ref keys into bundleState.perSlotUploads at bundle stage (instead of
  // showing the file-picker).
  castCatalog: [],
  castBindings: {},
  // v0.49.0: snapshot of the storyboard as it came off the /api/storyboard/plan
  // response, kept so the scene editor's "discard all edits" can roll back.
  // null until a plan resolves.
  originalStoryboard: null,
  // v0.50.0: refinement chat history. Each entry is {role: "user"|"assistant",
  // content: string, ts: number}. Display-only; not replayed to the model.
  refineHistory: [],
  // v0.51.0: audio bed + beat timing. audioKey is the R2 key (under
  // audio/ for BYO uploads or out/ for score-module-generated tracks).
  audioKey: null,
  audioMime: null,
  audioSourceLabel: null,
  bpm: 120,
  beatsPerShot: 4,
  // In-flight score-bed job (poll token + module name from registry).
  pendingMusicChatId: null,
  pendingMusicModule: null,
  pendingScoreBedKind: null,
  pendingScoreBedLabel: null,
  // v0.53.0: persisted storyboard projects. projectCatalog is the
  // user's project list fetched from /api/storyboard/projects on page
  // load. activeProjectId is the picker's current selection (null =
  // transient mode, the pre-v0.53 default).
  projectCatalog: [],
  activeProjectId: null,
};

const bundleState = {
  // perSlotUploads[slot] = [{filename, size, mime, key, status, error}]
  perSlotUploads: {},
  // v0.149.0 (Phase 4b): sceneStartImages[sceneId] = { key, filename } for
  // authored per-scene start keyframes. Sent to /api/storyboard/bundle, which
  // writes each to clips/<id>_keyframe.png so the pod drives that scene's Wan
  // motion from it. Staged keys (like character refs) so they survive a reload.
  sceneStartImages: {},
  bundleKey: null,
  // v0.135.1: remember the assembled bundle's gzipped size + entry count so a
  // page reload restores the real numbers instead of showing "0 B / 0 files".
  sizeBytes: 0,
  fileCount: 0,
};

const renderState = {
  jobId: null,
  pollTimer: null,
  // vivijure#552: true from the render click through the whole submit sequence
  // (LoRA preflight + the pre-jobId fetch) until jobId handoff or an error/pause
  // path. Widens the updateRenderGate active-render guard to cover the pre-jobId
  // window so a mid-submit form toggle (e.g. keyframes-only) cannot re-enable the
  // button and let a second submit fire.
  submitting: false,
  currentProject: null,     // v0.37.0: display name for notifications
  currentLabel: null,       // v0.37.0: user-authored label, preferred over project
  // v0.44.0: ms since epoch when the first IN_PROGRESS observation
  // landed. Used to compute elapsed + ETA. Set lazily on the first
  // non-IN_QUEUE status update so a long queue wait does not anchor
  // the ETA computation against the wrong start time. Persisted via
  // the v0.38.0 localStorage stash so a refresh-mid-render keeps the
  // same baseline; cleared on terminal status.
  startedAt: null,
  // v0.44.0: ms timer that re-renders the elapsed + ETA text on a
  // 1s cadence between SSE / poll updates. Without it the elapsed
  // counter only advances when a new status snapshot lands (every
  // ~3s under SSE), which feels frozen.
  tickTimer: null,
};

// v0.37.0: browser notification state. `permission` mirrors Notification.
// permission ("default" | "granted" | "denied" | "unsupported");
// `alreadyNotified` dedupes per session so a stream that re-fires a
// terminal event does not double-ping the OS.
const notifyState = {
  permission: "default",
  alreadyNotified: new Set(),
};

// ---------- localStorage persistence (v0.38.0) ----------
//
// Snapshots every meaningful state-changing event (brief edit, cast field
// change, plan success, image upload completion, bundle assembly, render
// submit, filter toggle) to localStorage under STORAGE_KEY. On page load,
// restorePersistedState() rebuilds the plan / bundle / render panels and
// reattaches a live SSE stream when the persisted render is in-flight.
// Corrupted stash silently clears and proceeds with fresh state; quota
// exceeded silently no-ops (the planner still works, persistence just
// stops until next reload).

let persistTimer = null;

function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(savePersistedState, PERSIST_DEBOUNCE_MS);
}

function savePersistedState() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    const snapshot = {
      planForm: collectPlanFormState(),
      planResult: collectPlanResultState(),
      bundleStage: collectBundleStageState(),
      renderStage: collectRenderStageState(),
      historyFilters: { ...historyState.filters },
      // v0.41.1: persist in-flight regen jobs so a page refresh resumes
      // polling instead of stranding the regen + leaving the button
      // disabled. Map serialization is Array.from(entries); the value
      // is already a plain object (jobId, kfKey, shotId, rowId,
      // startedAt) so JSON.stringify round-trips it cleanly.
      regenJobs: collectRegenJobs(),
      savedAt: Math.floor(Date.now() / 1000),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    // QuotaExceededError on private mode, etc. Persistence is best-effort;
    // a save failure does not block the user's planning flow.
    console.warn("savePersistedState failed:", err);
  }
}

// v0.41.1: serialize historyState.regenJobs to an array of [key, value]
// pairs. JSON does not preserve Map identity, so we round-trip via the
// canonical entries representation. Pure for testability.
function collectRegenJobs() {
  return Array.from(historyState.regenJobs.entries());
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn("loadPersistedState failed; clearing:", err);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    return null;
  }
}

function clearPersistedStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// True when the stash has planner work worth offering to resume.
function hasPersistedWork(stash) {
  if (!stash) return false;
  if (stash.planResult && stash.planResult.storyboard) return true;
  if (stash.bundleStage && stash.bundleStage.bundleKey) return true;
  if (stash.renderStage && (stash.renderStage.jobId || stash.renderStage.bundleKey)) return true;
  const brief = stash.planForm && typeof stash.planForm.brief === "string"
    ? stash.planForm.brief.trim() : "";
  if (brief) return true;
  const cast = stash.planForm && Array.isArray(stash.planForm.cast) ? stash.planForm.cast : [];
  if (cast.some((c) => c && c.checked && (c.name || c.bible))) return true;
  const bindings = stash.planForm && stash.planForm.castBindings;
  if (bindings && Object.keys(bindings).length > 0) return true;
  return false;
}

// Reload / back-forward keeps the in-tab failsafe; cross-page navigation does not.
function isSameTabReload() {
  const nav = performance.getEntriesByType("navigation")[0];
  return !!(nav && (nav.type === "reload" || nav.type === "back_forward"));
}

let pendingResumeStash = null;

function hideResumeBanner() {
  const banner = $("#planner-resume-banner");
  if (banner) banner.hidden = true;
  pendingResumeStash = null;
}

function formatResumeWhen(savedAt) {
  if (!savedAt) return "a previous visit";
  const d = new Date(savedAt * 1000);
  if (Number.isNaN(d.getTime())) return "a previous visit";
  return d.toLocaleString();
}

function showResumeBanner(stash) {
  const banner = $("#planner-resume-banner");
  const text = $("#planner-resume-text");
  if (!banner || !text) return;
  pendingResumeStash = stash;
  text.textContent =
    "You have a saved planner session from " + formatResumeWhen(stash.savedAt) +
    ". Resume it, or start with a blank page.";
  banner.hidden = false;
}

function resumePendingSession() {
  if (!pendingResumeStash) return;
  const stash = pendingResumeStash;
  hideResumeBanner();
  applyPersistedStash(stash);
  afterPersistedStashApplied(stash);
}

function startNewSession(opts) {
  const focusBrief = !opts || opts.focusBrief !== false;
  if (!opts || !opts.skipConfirm) {
    const hasWork = planState.storyboard || $("#planner-brief").value.trim() ||
      bundleState.bundleKey || renderState.jobId;
    if (hasWork && !window.confirm("Start a new session? Unsaved work on this page will be cleared.")) {
      return;
    }
  }
  clearPersistedStorage();
  hideResumeBanner();
  planState.storyboard = null;
  planState.originalStoryboard = null;
  planState.refineHistory = [];
  planState.castBindings = {};
  planState.audioKey = null;
  planState.audioMime = null;
  planState.audioSourceLabel = null;
  planState.bpm = 120;
  planState.beatsPerShot = 4;
  planState.pendingMusicChatId = null;
  planState.activeProjectId = null;
  musicPromptAutoTried = false;
  const briefEl = $("#planner-brief");
  if (briefEl) briefEl.value = "";
  const picker = $("#planner-project-picker");
  if (picker) picker.value = "";
  $("#planner-output").hidden = true;
  $("#planner-scenes").hidden = true;
  $("#planner-audio").hidden = true;
  resetBundleStage();
  resetRenderStage();
  renderCast();
  renderRefineTurns();
  showAudioSection();
  refreshProjectButtonGates();
  refreshSteps();
  showStep("plan");
  savePersistedState();
  if (focusBrief && briefEl) briefEl.focus();
}

// ---------- State collectors (read DOM + module state) ----------

function collectPlanFormState() {
  const modelEl = $("#planner-model");
  return {
    modelId: modelEl ? modelEl.value : "",
    brief: $("#planner-brief").value,
    // v0.56.0: persist the auto-preflight toggle so a user who turned
    // it off keeps it off across sessions.
    preflightAutoEnabled,
    cast: SLOT_IDS.map((slot) => {
      const row = document.querySelector('.planner-cast-row[data-slot="' + slot + '"]');
      if (!row) return { slot, checked: false, name: "", bible: "" };
      return {
        slot,
        checked: row.querySelector("[data-cast-include]").checked,
        name: row.querySelector(".planner-cast-name").value,
        bible: row.querySelector(".planner-cast-bible").value,
      };
    }),
    // v0.48.0: persist slot->cast_id bindings so a tab reopen keeps
    // each slot linked to the right persisted cast member.
    castBindings: { ...planState.castBindings },
  };
}

function collectPlanResultState() {
  if (!planState.storyboard) return null;
  return {
    storyboard: planState.storyboard,
    cast: planState.cast,
    yaml: $("#planner-yaml").textContent,
    // v0.49.0: persist the pre-edit snapshot so "discard all edits" can
    // roll back across a tab close.
    originalStoryboard: planState.originalStoryboard,
    // v0.50.0: persist the refinement chat history so the user does not
    // lose the conversation log on a tab close.
    refineHistory: planState.refineHistory,
    // v0.51.0: persist the audio bed key + BPM + snap settings + any
    // in-flight music-gen chat id so a refresh restores the audio
    // workflow.
    audioKey: planState.audioKey,
    audioMime: planState.audioMime,
    audioSourceLabel: planState.audioSourceLabel,
    bpm: planState.bpm,
    beatsPerShot: planState.beatsPerShot,
    pendingMusicChatId: planState.pendingMusicChatId,
    pendingMusicModule: planState.pendingMusicModule,
    pendingScoreBedKind: planState.pendingScoreBedKind,
    pendingScoreBedLabel: planState.pendingScoreBedLabel,
    // v0.53.0: persist the active project id so a tab reopen reselects.
    activeProjectId: planState.activeProjectId,
  };
}

function collectBundleStageState() {
  const stage = $("#planner-bundle");
  if (!stage || stage.hidden) return null;
  return {
    perSlotUploads: { ...bundleState.perSlotUploads },
    // v0.149.0 (Phase 4b): persist staged per-scene start keyframes (R2 keys)
    // so a tab reopen restores them like the character refs.
    sceneStartImages: { ...bundleState.sceneStartImages },
    bundleKey: bundleState.bundleKey,
    sizeBytes: bundleState.sizeBytes,
    fileCount: bundleState.fileCount,
  };
}

function collectRenderStageState() {
  const stage = $("#planner-render");
  if (!stage || stage.hidden) return null;
  if (!renderState.jobId && !bundleState.bundleKey) return null;
  const tierEl = $("#planner-quality-tier");
  const overridesEl = $("#planner-render-overrides");
  const kfOnlyEl = $("#planner-keyframes-only");
  return {
    jobId: renderState.jobId,
    bundleKey: bundleState.bundleKey,
    qualityTier: tierEl ? tierEl.value : "final",
    renderOverridesText: overridesEl ? overridesEl.value : "",
    moduleOverrides: window.plannerRenderConfig ? window.plannerRenderConfig.collect() : null,
    keyframesOnly: kfOnlyEl ? kfOnlyEl.checked : false,
    filmTitle: readVal("#planner-film-title"),
    filmSubtitle: readVal("#planner-film-subtitle"),
    filmCredits: readVal("#planner-film-credits"),
    // v0.44.0: persist the render start timestamp so an elapsed +
    // ETA computation survives a page refresh. null means "no in-
    // flight render observed yet"; the updater anchors it lazily.
    startedAt: renderState.startedAt,
    currentProject: renderState.currentProject,
    currentLabel: renderState.currentLabel,
    lastKnownStatus: lastKnownStatusFromPanel(),
  };
}

// Tiny helper used by both the collector and the restorer for the
// v0.43.0 structured render-settings fields. Centralized so adding a
// new field is a single edit instead of three.
function readVal(selector) {
  const el = $(selector);
  return el ? el.value : "";
}

function lastKnownStatusFromPanel() {
  const el = $("#planner-render-job-status");
  return el ? el.textContent || null : null;
}

