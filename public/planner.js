// Storyboard planner UI (v0.33.0).
//
// Hydrates the model picker from GET /api/storyboard/models, takes a brief
// plus up to four character entries (slots A through D), and walks the
// three-stage pipeline:
//
//   1. plan    POST /api/storyboard/plan
//                  -> validated storyboard JSON + bundle-ready YAML, or
//                  -> validator errors + raw model output (re-prompt path).
//   2. bundle  POST /api/storyboard/character-ref (per training image),
//              then POST /api/storyboard/bundle (assemble the .tar.gz).
//   3. render  POST /api/storyboard/render (submit job to RunPod), then
//              GET /api/storyboard/render/<jobId> on an 8-second poll
//              loop until the job hits a terminal status.
//
// Vanilla JS, no framework. Reuses the chat UI's CSS tokens from styles.css.

const SLOT_IDS = ["A", "B", "C", "D"];
const POLL_INTERVAL_MS = 8000;
const HISTORY_LIMIT = 25;
const HISTORY_AUTO_REFRESH_MS = 30000;
// v0.38.0: localStorage key for the persisted planner state. Bumped when
// the shape changes incompatibly so a stale stash never crashes restore.
const STORAGE_KEY = "skyphusion.planner.state.v1";
// v0.38.0: debounce form-input saves so a typed brief does not write to
// localStorage on every keystroke.
const PERSIST_DEBOUNCE_MS = 500;

const $ = (sel) => document.querySelector(sel);

// ---------- Guided stepper (v0.120.0) ----------
//
// The planner is one long pipeline. The stepper shows a single step at a
// time: every top-level <section> carries a data-step, and showStep()
// collapses every section whose data-step is not the active step (the
// .step-hidden class sits on top of each section's own progressive-reveal
// `hidden`, so the in-step reveal logic is untouched). Steps unlock as
// prerequisites are met so the user cannot jump to Render before a bundle
// exists. The state lives in module scope alongside the pipeline state below.

const PLANNER_STEPS = [
  { id: "plan", label: "Plan" },
  { id: "cast", label: "Cast & Bundle" },
  { id: "audio", label: "Audio" },
  { id: "render", label: "Render" },
  { id: "history", label: "History" },
];
const PLANNER_STEP_ORDER = PLANNER_STEPS.map((s) => s.id);

const stepState = {
  current: "plan",
  unlocked: { plan: true, cast: false, audio: false, render: false, history: true },
};

// Recompute which steps are reachable from the live pipeline state. Plan +
// History are always open; Cast/Audio open once a storyboard exists; Render
// opens once a bundle is staged (or a render is already in flight / loaded
// from history).
function computeStepUnlocked() {
  const hasPlan = !!(planState && planState.storyboard);
  const hasBundle =
    !!(bundleState && bundleState.bundleKey) || !!(renderState && renderState.jobId);
  return { plan: true, cast: hasPlan, audio: hasPlan, render: hasBundle, history: true };
}

function buildStepper() {
  const rail = $("#planner-steps");
  if (!rail) return;
  rail.innerHTML = "";
  PLANNER_STEPS.forEach((step, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "planner-step";
    btn.dataset.stepId = step.id;
    const num = document.createElement("span");
    num.className = "planner-step-num";
    num.textContent = String(i + 1);
    const lbl = document.createElement("span");
    lbl.className = "planner-step-label-long";
    lbl.textContent = step.label;
    btn.appendChild(num);
    btn.appendChild(lbl);
    btn.addEventListener("click", () => showStep(step.id));
    rail.appendChild(btn);
  });
  const back = $("#planner-step-back");
  if (back) back.addEventListener("click", () => stepDelta(-1));
  const next = $("#planner-step-next");
  if (next) next.addEventListener("click", () => stepDelta(1));
}

// Reflect unlock state on the rail without changing the active step. If the
// active step just became locked (e.g. a reset cleared the plan), fall back
// to the furthest still-unlocked step at or before it.
function refreshSteps() {
  stepState.unlocked = computeStepUnlocked();
  if (!stepState.unlocked[stepState.current]) {
    const idx = PLANNER_STEP_ORDER.indexOf(stepState.current);
    let fallback = "plan";
    for (let i = idx; i >= 0; i--) {
      if (stepState.unlocked[PLANNER_STEP_ORDER[i]]) {
        fallback = PLANNER_STEP_ORDER[i];
        break;
      }
    }
    showStep(fallback);
    return;
  }
  paintStepper();
}

// Switch the active step: collapse non-active sections, repaint the rail +
// the back/next buttons, scroll to the top of the column.
function showStep(id) {
  if (!stepState.unlocked[id]) return;
  stepState.current = id;
  document.querySelectorAll("[data-step]").forEach((el) => {
    el.classList.toggle("step-hidden", el.dataset.step !== id);
  });
  // v0.132.0: the audio section gates its own content on storyboard state, so
  // re-evaluate it on entry; otherwise landing on the Audio step with no
  // storyboard left it blank (the hidden attr was never cleared).
  if (id === "audio") {
    showAudioSection();
    // v0.137.6: the first time the user opens Audio for a plan, auto-suggest an
    // ideal music prompt from the video (only when the field is empty, only once
    // per plan; the suggest button re-runs it on demand).
    if (!musicPromptAutoTried && planState.storyboard) {
      const mp = $("#planner-music-prompt");
      if (mp && !mp.value.trim()) {
        musicPromptAutoTried = true;
        suggestMusicPrompt({ force: false });
      }
    }
  }
  paintStepper();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function paintStepper() {
  const curIdx = PLANNER_STEP_ORDER.indexOf(stepState.current);
  document.querySelectorAll("#planner-steps .planner-step").forEach((btn) => {
    const sid = btn.dataset.stepId;
    const sIdx = PLANNER_STEP_ORDER.indexOf(sid);
    btn.classList.toggle("is-active", sid === stepState.current);
    // a step before the current one that is unlocked reads as "done"
    btn.classList.toggle("is-done", sIdx < curIdx && !!stepState.unlocked[sid]);
    btn.disabled = !stepState.unlocked[sid];
  });
  const back = $("#planner-step-back");
  if (back) back.disabled = curIdx <= 0;
  const next = $("#planner-step-next");
  if (next) {
    const nextId = PLANNER_STEP_ORDER[curIdx + 1];
    next.disabled = !nextId || !stepState.unlocked[nextId];
  }
}

// Move relative to the current step, skipping locked steps in the direction
// of travel.
function stepDelta(dir) {
  let i = PLANNER_STEP_ORDER.indexOf(stepState.current) + dir;
  while (i >= 0 && i < PLANNER_STEP_ORDER.length && !stepState.unlocked[PLANNER_STEP_ORDER[i]]) {
    i += dir;
  }
  if (i >= 0 && i < PLANNER_STEP_ORDER.length) showStep(PLANNER_STEP_ORDER[i]);
}

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
const FIELD_HELP = {
  // keyframe (render_overrides.keyframe)
  "planner-ld-keyframe-model-id": { what: "SDXL base that renders each keyframe (the still Wan animates), so it sets the whole look. Blank = tier default." },
  "planner-seed": { what: "Fixed RNG seed; the same seed + settings reproduces a render. Blank = fresh random." },
  "planner-keyframe-sdxl-size": { what: "Keyframe render size as WxH, e.g. 1216x832. Blank = tier default." },
  "planner-ld-keyframe-guidance-scale": { what: "Keyframe CFG (0-30); needs >1 for negative prompts to bite. Higher = more literal." },
  "planner-ld-keyframe-steps": { what: "Keyframe denoise steps (1-128). More = cleaner, slower." },
  "planner-face-lock-mode": { what: "How a face is pinned: ip_adapter (default), instantid (stronger, single-character), or both." },
  "planner-fl-ip-scale": { what: "IP-Adapter identity strength (0-1). Higher = more on-model; too high looks pasted-on." },
  "planner-fl-iid-cn-scale": { what: "InstantID face-ControlNet strength (0-1.5): how tightly structure follows the portrait." },
  "planner-fl-iid-ip-scale": { what: "InstantID face image-prompt strength (0-1.5): how strongly the face resembles the portrait." },
  // keyframe.multi_char (2+ characters in one frame)
  "planner-mc-engine": { what: "Regional engine (one SDXL pass, per-region masks) vs composite_legacy (older panels + grabcut). Regional is the default." },
  "planner-mc-pose": { what: "OpenPose conditioning that draws one body per skeleton so 2+ characters sit apart instead of merging." },
  "planner-mc-lora-scale": { what: "Per-character LoRA strength in a shared frame (0-2); ~0.3 keeps identities from bleeding." },
  "planner-mc-ip-scale": { what: "Per-character IP-Adapter strength in a shared frame (0-1); ~0.7 routes identities cleanly." },
  "planner-mc-max-slots": { what: "Max characters composited into one keyframe (1-4); more is harder to keep distinct." },
  "planner-mc-cn-scale": { what: "How firmly bodies follow the pose skeleton (0-1.5); ~0.55 places them without overriding the action." },
  // i2v (render_overrides.i2v)
  "planner-wd-i2v-model-id": { what: "Wan image-to-video model that animates each keyframe. Blank = tier default." },
  "planner-wan-num-frames": { what: "Frames per Wan shot (1-256). More = longer clip, slower." },
  "planner-wan-inference-steps": { what: "Wan denoise steps per shot (1-64). More = smoother motion, slower." },
  "planner-wan-guidance-scale": { what: "Wan CFG (0-30). Low = freer motion, high = more literal to the prompt." },
  "planner-fps": { what: "Wan output frame rate (1-120)." },
  "planner-wd-flow-shift": { what: "Wan flow-matching shift (0-20); tunes motion timing and smoothness." },
  // lora (render_overrides.lora; fresh Stage 1 training only)
  "planner-lora-rank": { what: "Character LoRA rank (1-128). Higher captures more detail, bigger file, risks overfit." },
  "planner-lora-steps": { what: "Character LoRA training steps (1-5000). More = better likeness, diminishing past ~1000." },
  "planner-lora-lr": { what: "Character LoRA learning rate. Higher learns faster but can overfit." },
  "planner-lora-resolution": { what: "LoRA training image resolution (512-1536). Higher = finer detail, slower." },
};

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
  // v0.131.0: freeform "ask the model" chat thread, independent of any
  // storyboard. chatHistory is the display log ({role, content, ts}); the
  // model's memory is server-side via chatConversationId, which we pass back
  // to /api/chat each turn so the worker replays prior turns from D1.
  chatHistory: [],
  chatConversationId: null,
  // v0.51.0: audio bed + beat timing. audioKey is the R2 key (under
  // audio/ for BYO uploads or out/ for MiniMax-generated tracks
  // copied across buckets via the cast-style {from_chat_artifact}
  // path). bpm + beatsPerShot drive the snap-to-beat math.
  audioKey: null,
  audioMime: null,
  audioSourceLabel: null,
  bpm: 120,
  beatsPerShot: 4,
  // Workflow tracking for an in-flight MiniMax Music job.
  pendingMusicChatId: null,
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
  eventSource: null,        // v0.35.0: live SSE connection when streaming
  streamFallbackHit: false, // set after one failed stream attempt to skip retries
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
      // v0.131.0: freeform planner chat. Top-level (not under planResult) so it
      // survives a tab close even when no storyboard has been planned yet.
      chat: { history: planState.chatHistory, conversationId: planState.chatConversationId },
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
    // v0.40.0: persist the checkbox so a refresh-mid-flow does not
    // silently flip an in-progress preview into a full render.
    keyframesOnly: kfOnlyEl ? kfOnlyEl.checked : false,
    // v0.43.0: persist the structured render-settings fields so a
    // refresh does not silently flip them back to defaults mid-flow.
    // Each field stores its raw input string; the restorer writes
    // them back verbatim, and the submit-time merge re-reads them.
    seedText: readVal("#planner-seed"),
    // v0.135.0: persist the promoted keyframe SDXL base (art-style picker)
    // alongside the other common per-render controls.
    keyframeBase: readVal("#planner-ld-keyframe-model-id"),
    // v0.59.0: persist the named knobs migrated from the legacy "Make"
    // panel. Same raw-string round-trip as the structured fields above;
    // empty string == "use bundle default" and never lands on the wire.
    faceLockMode: readVal("#planner-face-lock-mode"),
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

// ---------- Restorers ----------

function restorePersistedState() {
  const stash = loadPersistedState();
  if (!stash) return null;

  // Filters first so loadHistory's first render uses the restored view.
  if (stash.historyFilters) restoreHistoryFilters(stash.historyFilters);

  // Plan form fields. Model picker value is set later (after loadModels).
  if (stash.planForm) restorePlanForm(stash.planForm);

  // v0.131.0: freeform chat thread restores independently of any storyboard
  // (older stashes that predate the field fall back to an empty log).
  planState.chatHistory = Array.isArray(stash.chat?.history) ? stash.chat.history : [];
  planState.chatConversationId =
    typeof stash.chat?.conversationId === "string" ? stash.chat.conversationId : null;
  renderChatTurns();

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
  planState.pendingMusicChatId = typeof saved.pendingMusicChatId === "number"
    ? saved.pendingMusicChatId : null;
  showAudioSection();
  if (planState.pendingMusicChatId) resumeMusicPolling();
  // v0.53.0: stash the active project id; the picker's options are
  // populated after loadProjects resolves, and we reselect there.
  planState.activeProjectId = typeof saved.activeProjectId === "number"
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
      // v0.123.0: the raw-overrides textarea now lives in the "expert: raw
      // JSON" disclosure (was nested in "advanced settings"); open that one
      // so restored raw text is visible on reload.
      const expert = $(".planner-overrides-expert");
      if (expert) expert.open = true;
    }
  }
  // v0.40.0: restore the keyframes-only checkbox.
  const kfOnlyEl = $("#planner-keyframes-only");
  if (kfOnlyEl) kfOnlyEl.checked = !!saved.keyframesOnly;
  // v0.44.0: restore the elapsed/ETA anchor. If a render was in
  // flight at save time, the next updateRenderProgress will paint
  // the bar against this baseline + start the tick timer; no
  // dedicated kickoff needed here.
  if (typeof saved.startedAt === "number" && saved.startedAt > 0) {
    renderState.startedAt = saved.startedAt;
  }
  // v0.43.0: restore the structured render-settings fields. Any
  // non-empty field also opens the outer details panel so the user
  // can see what was carried across the reload.
  const restored = [
    ["#planner-seed", saved.seedText],
    ["#planner-ld-keyframe-model-id", saved.keyframeBase],
    ["#planner-face-lock-mode", saved.faceLockMode],
  ];
  let anyRestored = false;
  for (const [sel, val] of restored) {
    const el = $(sel);
    if (!el) continue;
    if (typeof val === "string" && val.length > 0) {
      el.value = val;
      anyRestored = true;
    }
  }
  if (anyRestored) {
    const details = $(".planner-overrides-details");
    if (details) details.open = true;
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
  const out = {};
  for (const [slot, raw] of Object.entries(planState.castBindings || {})) {
    if (typeof slot !== "string" || slot.length === 0) continue;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) continue;
    out[slot] = id;
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
    name.placeholder = "name (e.g. Kira)";
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
      const id = Number(v);
      if (!Number.isFinite(id)) return;
      bindSlotToCast(slot, id);
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

// ---------- Preflight (v0.54.0) ----------
//
// Runs the storyboard through /api/storyboard/preflight and renders
// the resulting issue list. Errors gate the bundle button; warnings
// just warn. Auto-runs once when a fresh plan or refine lands; the
// user can re-run via the "run preflight" button after any edit.

let preflightLastResult = null;
let preflightRunning = false;
// v0.56.0: debounce + in-flight rerun queue. schedulePreflight is
// called from every edit hook (scene editor, refine success, snap,
// audio bed change). The debounce coalesces rapid edits; the
// rerunQueued flag handles "user kept editing while preflight was
// in flight" by re-firing on the current run's completion.
let preflightDebounceTimer = null;
let preflightRerunQueued = false;
const PREFLIGHT_DEBOUNCE_MS = 600;
let preflightAutoEnabled = true;

function setPreflightStatus(text, kind) {
  const el = $("#planner-preflight-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

function setPreflightCounts(text) {
  const el = $("#planner-preflight-counts");
  if (!el) return;
  el.textContent = text || "";
}

function renderPreflightIssues(result) {
  const list = $("#planner-preflight-issues");
  if (!list) return;
  list.innerHTML = "";
  if (!result || !Array.isArray(result.issues) || result.issues.length === 0) {
    setPreflightCounts(result ? "all clear (0 issues)" : "");
    return;
  }
  setPreflightCounts(
    "errors: " + (result.counts.error || 0)
    + " · warnings: " + (result.counts.warning || 0)
    + " · info: " + (result.counts.info || 0)
  );
  for (const issue of result.issues) {
    const li = document.createElement("li");
    li.className = "planner-preflight-issue planner-preflight-issue-" + issue.level;
    const badge = document.createElement("span");
    badge.className = "planner-preflight-badge";
    badge.textContent = issue.level;
    li.appendChild(badge);
    const scope = document.createElement("span");
    scope.className = "planner-preflight-scope";
    scope.textContent = issue.scope;
    li.appendChild(scope);
    const msg = document.createElement("span");
    msg.className = "planner-preflight-msg";
    msg.textContent = issue.message;
    li.appendChild(msg);
    list.appendChild(li);
  }
}

function showPreflightSection() {
  const section = $("#planner-preflight");
  if (!section) return;
  section.hidden = !planState.storyboard;
}

function preflightBlocksBundle() {
  return !!(preflightLastResult && preflightLastResult.counts && preflightLastResult.counts.error > 0);
}

function schedulePreflight() {
  if (!preflightAutoEnabled) return;
  if (!planState.storyboard) return;
  if (preflightDebounceTimer) clearTimeout(preflightDebounceTimer);
  preflightDebounceTimer = setTimeout(() => {
    preflightDebounceTimer = null;
    // If a run is in flight, queue a re-run; the current one will
    // pick up the queued flag on completion and fire again.
    if (preflightRunning) {
      preflightRerunQueued = true;
      return;
    }
    runPreflight();
  }, PREFLIGHT_DEBOUNCE_MS);
}

async function runPreflight() {
  if (!planState.storyboard) return;
  if (preflightRunning) {
    // Caller is bypassing the debounce; mark rerun and bail so the
    // current invocation finishes cleanly.
    preflightRerunQueued = true;
    return;
  }
  preflightRunning = true;
  $("#planner-preflight-run").disabled = true;
  setPreflightStatus("running...", "loading");
  try {
    const body = {
      storyboard: planState.storyboard,
    };
    if (bundleState.bundleKey) body.bundleKey = bundleState.bundleKey;
    if (planState.audioKey) body.audioKey = planState.audioKey;
    if (planState.castBindings && Object.keys(planState.castBindings).length > 0) {
      body.castBindings = planState.castBindings;
    }
    const resp = await fetch("/api/storyboard/preflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
    preflightLastResult = data;
    renderPreflightIssues(data);
    if (data.ok) {
      setPreflightStatus(
        data.counts.warning > 0
          ? "ok with " + data.counts.warning + " warning(s); bundle is unblocked"
          : "all clear",
        "success",
      );
    } else {
      setPreflightStatus(
        data.counts.error + " error(s); bundle is blocked",
        "error",
      );
    }
    // The bundle button is in the existing bundle stage; toggle disabled
    // based on preflight outcome so the user cannot bypass an error.
    const bundleBtn = $("#planner-bundle-btn");
    if (bundleBtn) bundleBtn.disabled = preflightBlocksBundle();
  } catch (err) {
    setPreflightStatus("preflight failed: " + err.message, "error");
  } finally {
    preflightRunning = false;
    $("#planner-preflight-run").disabled = false;
    // v0.56.0: if more edits arrived while we were running, fire
    // one more pass so the panel reflects the latest state.
    if (preflightRerunQueued) {
      preflightRerunQueued = false;
      schedulePreflight();
    }
  }
}

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
  };
}

async function selectProject(id) {
  planState.activeProjectId = id || null;
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

// ---------- Refinement chat (v0.50.0) ----------
//
// Iterative refinement on the in-flight storyboard. Each turn POSTs
// {model, storyboard, message} to /api/storyboard/refine; the returned
// validated storyboard replaces planState.storyboard, the YAML pane and
// scene editor re-render. The chat history is display-only: not replayed
// to the model (the storyboard already reflects all accepted changes),
// just shown to the user as a log of the conversation.

let refineInflight = false;

function setRefineStatus(text, kind) {
  const el = $("#planner-refine-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

function showRefineSection() {
  const section = $("#planner-refine");
  if (!section) return;
  if (!planState.storyboard) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  renderRefineTurns();
}

function renderRefineTurns() {
  const list = $("#planner-refine-turns");
  if (!list) return;
  list.innerHTML = "";
  for (const turn of planState.refineHistory || []) {
    const li = document.createElement("li");
    li.className = "planner-refine-turn planner-refine-turn-" + turn.role;
    const role = document.createElement("span");
    role.className = "planner-refine-role";
    role.textContent = turn.role === "user" ? "you" : "assistant";
    li.appendChild(role);
    const body = document.createElement("div");
    body.className = "planner-refine-body";
    body.textContent = turn.content || "";
    li.appendChild(body);
    list.appendChild(li);
  }
  // Scroll the list to the latest turn so a refreshed view does not bury
  // the most recent exchange.
  list.scrollTop = list.scrollHeight;
}

async function sendRefine() {
  if (refineInflight) return;
  if (!planState.storyboard) {
    setRefineStatus("plan a storyboard first", "error");
    return;
  }
  const input = $("#planner-refine-input");
  const message = (input.value || "").trim();
  if (!message) return;
  const modelEl = $("#planner-model");
  const model = modelEl ? modelEl.value : "";
  if (!model) {
    setRefineStatus("pick a planning model in the brief above", "error");
    return;
  }

  refineInflight = true;
  $("#planner-refine-send").disabled = true;
  setRefineStatus("refining...", "loading");

  // Optimistically append the user turn so the log shows what was just
  // sent even before the response lands.
  planState.refineHistory.push({ role: "user", content: message, ts: Date.now() });
  renderRefineTurns();
  input.value = "";
  persistSoon();

  let resp;
  let data;
  try {
    resp = await fetch("/api/storyboard/refine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, storyboard: planState.storyboard, message }),
    });
    data = await resp.json();
  } catch (err) {
    setRefineStatus("network error: " + err.message, "error");
    planState.refineHistory.push({
      role: "assistant",
      content: "(network error: " + err.message + ")",
      ts: Date.now(),
    });
    renderRefineTurns();
    persistSoon();
    refineInflight = false;
    $("#planner-refine-send").disabled = false;
    return;
  }

  if (!resp.ok && data && data.error) {
    setRefineStatus("refine rejected (" + resp.status + ")", "error");
    planState.refineHistory.push({
      role: "assistant",
      content: "(error " + resp.status + ": " + data.error + ")",
      ts: Date.now(),
    });
    renderRefineTurns();
    persistSoon();
    refineInflight = false;
    $("#planner-refine-send").disabled = false;
    return;
  }

  if (data && data.ok === false) {
    const errs = Array.isArray(data.errors) ? data.errors.join(" · ") : "validation failed";
    setRefineStatus(errs, "error");
    planState.refineHistory.push({
      role: "assistant",
      content: "(could not apply: " + errs + ")",
      ts: Date.now(),
    });
    renderRefineTurns();
    persistSoon();
    refineInflight = false;
    $("#planner-refine-send").disabled = false;
    return;
  }

  if (data && data.ok === true && data.storyboard) {
    planState.storyboard = data.storyboard;
    $("#planner-json").textContent = JSON.stringify(data.storyboard, null, 2);
    $("#planner-yaml").textContent = data.yaml || "";
    renderSceneEditor(data.storyboard);
    planState.refineHistory.push({
      role: "assistant",
      content: "updated storyboard ("
        + (Array.isArray(data.storyboard.scenes) ? data.storyboard.scenes.length : 0)
        + " scenes)",
      ts: Date.now(),
    });
    renderRefineTurns();
    setRefineStatus("ok", "success");
    persistSoon();
    // v0.56.0: refinement rewrites the storyboard; rerun preflight so
    // the panel reflects the new shape without the user clicking.
    schedulePreflight();
  } else {
    setRefineStatus("unexpected response shape", "error");
  }

  refineInflight = false;
  $("#planner-refine-send").disabled = false;
  input.focus();
}

// ---------- v0.131.0: freeform "ask the model" chat thread ----------
//
// Multi-turn freeform chat with the selected planning model, independent of
// any storyboard. Each turn POSTs {model, user_input, conversation_id} to
// /api/chat; the worker replays prior turns from that conversation_id, so the
// model's memory lives server-side and the client keeps only a display log +
// the id. The planning models are all chat-type, so /api/chat returns
// synchronously with {output, conversation_id} (the pending shape is for
// async music/video models only). Reuses the .planner-refine-* styling.

let chatInflight = false;

function setChatStatus(text, kind) {
  const el = $("#planner-chat-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

function renderChatTurns() {
  const list = $("#planner-chat-turns");
  if (!list) return;
  list.innerHTML = "";
  for (const turn of planState.chatHistory || []) {
    const li = document.createElement("li");
    li.className = "planner-refine-turn planner-refine-turn-" + turn.role;
    const role = document.createElement("span");
    role.className = "planner-refine-role";
    role.textContent = turn.role === "user" ? "you" : "assistant";
    li.appendChild(role);
    const body = document.createElement("div");
    body.className = "planner-refine-body";
    body.textContent = turn.content || "";
    li.appendChild(body);
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

function clearChat() {
  planState.chatHistory = [];
  planState.chatConversationId = null;
  renderChatTurns();
  setChatStatus("new conversation", "");
  persistSoon();
}

async function sendChat() {
  if (chatInflight) return;
  const input = $("#planner-chat-input");
  const message = (input.value || "").trim();
  if (!message) return;
  const modelEl = $("#planner-model");
  const model = modelEl ? modelEl.value : "";
  if (!model) {
    setChatStatus("pick a planning model in the brief above", "error");
    return;
  }

  chatInflight = true;
  $("#planner-chat-send").disabled = true;
  setChatStatus("thinking...", "loading");

  // Optimistically append the user turn so the log shows what was just sent.
  planState.chatHistory.push({ role: "user", content: message, ts: Date.now() });
  renderChatTurns();
  input.value = "";
  persistSoon();

  let resp;
  let data;
  try {
    resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        user_input: message,
        // Continue the same server-side conversation when we have one.
        conversation_id: planState.chatConversationId || undefined,
      }),
    });
    data = await resp.json();
  } catch (err) {
    setChatStatus("network error: " + err.message, "error");
    planState.chatHistory.push({ role: "assistant", content: "(network error: " + err.message + ")", ts: Date.now() });
    renderChatTurns();
    persistSoon();
    chatInflight = false;
    $("#planner-chat-send").disabled = false;
    return;
  }

  if (!resp.ok) {
    const msg = data && data.error ? data.error : "HTTP " + resp.status;
    setChatStatus("error (" + resp.status + ")", "error");
    planState.chatHistory.push({ role: "assistant", content: "(error " + resp.status + ": " + msg + ")", ts: Date.now() });
    renderChatTurns();
    persistSoon();
    chatInflight = false;
    $("#planner-chat-send").disabled = false;
    return;
  }

  const reply = data && typeof data.output === "string" ? data.output : "";
  if (data && data.conversation_id) planState.chatConversationId = data.conversation_id;
  planState.chatHistory.push({ role: "assistant", content: reply || "(empty response)", ts: Date.now() });
  renderChatTurns();
  setChatStatus("", "");
  persistSoon();

  chatInflight = false;
  $("#planner-chat-send").disabled = false;
  input.focus();
}

// v0.134.0: "script my plan" -- synthesize the brainstorm chat into a single
// production brief and drop it in the brief box (which the Plan step then feeds
// to the storyboard model). Replaces the old v0.132.0 auto-fill that dumped raw
// per-turn replies into the brief. Summarizes via a one-shot /api/chat on the
// selected planning model with NO conversation_id (so it does not pollute the
// chat thread), passing the whole transcript as context.
async function scriptMyPlan() {
  if (chatInflight) return;
  const turns = planState.chatHistory || [];
  if (!turns.length) {
    setChatStatus("chat with the model first, then script the plan", "error");
    return;
  }
  const modelEl = $("#planner-model");
  const model = modelEl ? modelEl.value : "";
  if (!model) {
    setChatStatus("pick a planning model above", "error");
    return;
  }
  const transcript = turns
    .map((t) => (t.role === "user" ? "User: " : "Assistant: ") + (t.content || ""))
    .join("\n\n");
  const instruction =
    "The following is a brainstorming conversation between a user and you about a short film. "
    + "Synthesize it into a single concise production brief for a storyboard planner: the setting "
    + "and mood, the approximate length, the key beats in order, and which characters appear and when. "
    + "Write the brief itself in plain prose with no preamble (do not say 'here is' or address the user).\n\n"
    + "Conversation:\n\n" + transcript;

  chatInflight = true;
  const btn = $("#planner-chat-script");
  if (btn) btn.disabled = true;
  setChatStatus("scripting your plan...", "loading");

  let resp;
  let data;
  try {
    resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, user_input: instruction }),
    });
    data = await resp.json();
  } catch (err) {
    setChatStatus("network error: " + err.message, "error");
    chatInflight = false;
    if (btn) btn.disabled = false;
    return;
  }

  if (!resp.ok || !data || typeof data.output !== "string" || !data.output.trim()) {
    const msg = data && data.error ? data.error : "HTTP " + (resp ? resp.status : "?");
    setChatStatus("could not script the plan (" + msg + ")", "error");
    chatInflight = false;
    if (btn) btn.disabled = false;
    return;
  }

  const briefEl = $("#planner-brief");
  if (briefEl) {
    briefEl.value = data.output.trim();
    persistSoon();
    briefEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  setChatStatus("plan scripted into the brief; review it, then hit plan", "success");
  chatInflight = false;
  if (btn) btn.disabled = false;
}

// ---------- Audio bed + beat timing (v0.51.0) ----------
//
// Two paths to set planState.audioKey: generate via MiniMax Music 2.6
// through the existing /api/chat music dispatcher (async via the
// LongRunWorkflow; we poll /api/job/:id), or upload a BYO mp3/wav/aac/
// m4a/ogg via POST /api/storyboard/audio-upload (binary, returns the
// R2 key directly). Once set, BPM + beats-per-shot drive a pure-JS
// snap that rounds each scene's target_seconds to a musical-phrase
// multiple. Each snap goes through onSceneChanged so the YAML pane
// refresh + dirty badge stay correct.

const MUSIC_MODEL_ID = "minimax/music-2.6";
const MUSIC_POLL_MS = 5000;
let musicPollTimer = null;

// Pure helper. Given a duration in seconds, a BPM, and a beat count,
// returns the duration rounded to the nearest multiple of
// (60 / BPM) * beatsPerShot, floored at one phrase so a 0.4s scene at
// 4-beat snap does not collapse to zero. Vitest covers this.
function snapToBeats(seconds, bpm, beatsPerShot) {
  const safeBpm = Number(bpm);
  const safeBeats = Number(beatsPerShot);
  if (!Number.isFinite(safeBpm) || safeBpm <= 0) return seconds;
  if (!Number.isFinite(safeBeats) || safeBeats <= 0) return seconds;
  const phraseSeconds = (60 / safeBpm) * safeBeats;
  const snapped = Math.round((Number(seconds) || 0) / phraseSeconds) * phraseSeconds;
  return Math.max(phraseSeconds, Number.parseFloat(snapped.toFixed(3)));
}

function setMusicGenStatus(text, kind) {
  const el = $("#planner-music-gen-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

function setSnapStatus(text, kind) {
  const el = $("#planner-snap-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

function showAudioSection() {
  const section = $("#planner-audio");
  if (!section) return;
  // v0.132.0: never leave the Audio step blank. Previously this set the
  // section's `hidden` attribute true whenever there was no storyboard, and
  // since showStep only toggles the step-hidden class (not the hidden attr),
  // landing on the Audio step without a storyboard showed nothing at all.
  // Always reveal the section (step-hidden still handles cross-step hiding);
  // gate the functional blocks vs the "plan first" placeholder on storyboard.
  section.hidden = false;
  const hasSb = !!planState.storyboard;
  const locked = $("#planner-audio-locked");
  if (locked) locked.hidden = hasSb;
  section.querySelectorAll(".planner-audio-block, .planner-audio-timing").forEach((b) => {
    b.hidden = !hasSb;
  });
  if (!hasSb) {
    const cur = $("#planner-audio-current");
    if (cur) cur.hidden = true;
    return;
  }
  // Hydrate inputs from current state.
  const bpmEl = $("#planner-bpm");
  if (bpmEl) bpmEl.value = String(planState.bpm || 120);
  const beatsEl = $("#planner-beats-per-shot");
  if (beatsEl) beatsEl.value = String(planState.beatsPerShot || 4);
  renderAudioCurrent();
}

function renderAudioCurrent() {
  const wrap = $("#planner-audio-current");
  if (!wrap) return;
  if (!planState.audioKey) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  $("#planner-audio-meta").textContent =
    (planState.audioSourceLabel || "audio") + " · " + planState.audioKey;
  const audio = $("#planner-audio-player");
  if (audio) audio.src = "/api/artifact/" + planState.audioKey;
}

function clearAudio() {
  if (!planState.audioKey) return;
  if (!window.confirm("clear the audio bed? the file stays in R2; this just unlinks it from this plan.")) return;
  planState.audioKey = null;
  planState.audioMime = null;
  planState.audioSourceLabel = null;
  renderAudioCurrent();
  persistSoon();
  // v0.56.0: audio key state affects preflight's audio HEAD warning.
  schedulePreflight();
}

async function uploadAudioFile(file) {
  if (!file) return;
  try {
    const resp = await fetch("/api/storyboard/audio-upload", {
      method: "POST",
      headers: { "content-type": file.type || "audio/mpeg" },
      body: file,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
    planState.audioKey = data.key;
    planState.audioMime = data.mime;
    planState.audioSourceLabel = "uploaded " + file.name;
    renderAudioCurrent();
    persistSoon();
    schedulePreflight();
  } catch (err) {
    window.alert("audio upload failed: " + err.message);
  }
}

// v0.137.6: suggest an "ideal" MiniMax Music prompt that matches the planned
// video, so the generated track fits the mood/tempo/energy instead of being a
// blind guess. One-shot /api/chat (mirrors scriptMyPlan): feeds the storyboard's
// concept + visual style + shot arc + duration (and the original brief, which
// often names the genre/BPM) to the selected planning model and asks for a
// single concise INSTRUMENTAL music prompt. Prefills #planner-music-prompt;
// non-destructive unless force=true (the button), so it never clobbers a prompt
// the user already typed. Auto-fires once when the Audio step is opened.
let musicPromptSuggesting = false;
let musicPromptAutoTried = false;

async function suggestMusicPrompt(opts) {
  const force = !!(opts && opts.force);
  if (musicPromptSuggesting) return;
  const sb = planState.storyboard;
  if (!sb) {
    if (force) setMusicGenStatus("plan a storyboard first, then suggest a track.", "error");
    return;
  }
  const promptEl = $("#planner-music-prompt");
  if (!promptEl) return;
  // Never overwrite a prompt the user has already written unless they asked.
  if (!force && promptEl.value.trim()) return;
  const modelEl = $("#planner-model");
  const model = modelEl ? modelEl.value : "";
  if (!model) {
    if (force) setMusicGenStatus("pick a planning model on the Plan step first.", "error");
    return;
  }

  const brief = (($("#planner-brief") || {}).value || "").trim();
  const scenes = Array.isArray(sb.scenes) ? sb.scenes : [];
  const arc = scenes
    .map((s, i) => (i + 1) + ". [" + (s.act || "?") + "] " + String(s.prompt || "").slice(0, 80))
    .join("\n");
  const dur = Math.round(
    Number(sb.duration_seconds) || scenes.length * (Number(sb.clip_seconds) || 4),
  );
  const instruction =
    "You are writing the single best text prompt for an AI music generator "
    + "(MiniMax Music 2.6) to SCORE a short cinematic/anime video. Output ONE "
    + "concise INSTRUMENTAL music prompt only: 2 to 4 sentences, no preamble, no "
    + "quotes, do not address me. Describe the MUSIC ONLY (genre/style, tempo in "
    + "BPM if the material implies one, mood, the key instruments, and how the "
    + "energy should build and hit across roughly " + dur + " seconds so it lands "
    + "with the on-screen action). Do not mention characters, the camera, or "
    + "visuals; translate them into musical terms.\n\n"
    + "Video concept: " + (sb.full_prompt || "(none)") + "\n"
    + "Visual style: " + (sb.style_prefix || "(none)") + "\n"
    + (brief ? "Original brief: " + brief + "\n" : "")
    + "Shot arc (act + gist):\n" + (arc || "(none)");

  musicPromptSuggesting = true;
  const btn = $("#planner-music-suggest");
  if (btn) btn.disabled = true;
  setMusicGenStatus("composing an ideal music prompt from your video...", "loading");

  let resp;
  let data;
  try {
    resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, user_input: instruction }),
    });
    data = await resp.json();
  } catch (err) {
    setMusicGenStatus("network error suggesting a prompt: " + err.message, "error");
    musicPromptSuggesting = false;
    if (btn) btn.disabled = false;
    return;
  }

  if (!resp.ok || !data || typeof data.output !== "string" || !data.output.trim()) {
    const msg = data && data.error ? data.error : "HTTP " + (resp ? resp.status : "?");
    setMusicGenStatus("could not suggest a prompt (" + msg + ")", "error");
    musicPromptSuggesting = false;
    if (btn) btn.disabled = false;
    return;
  }

  promptEl.value = data.output.trim();
  persistSoon();
  setMusicGenStatus("prompt suggested from your video; edit it or hit generate.", "success");
  musicPromptSuggesting = false;
  if (btn) btn.disabled = false;
}

async function generateMusic() {
  if (planState.pendingMusicChatId) {
    setMusicGenStatus("a music job is already in flight; wait or refresh.", "error");
    return;
  }
  const prompt = ($("#planner-music-prompt").value || "").trim();
  if (!prompt) {
    setMusicGenStatus("describe the track first.", "error");
    return;
  }
  $("#planner-music-gen").disabled = true;
  setMusicGenStatus("submitting to MiniMax Music 2.6...", "loading");
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MUSIC_MODEL_ID, user_input: prompt }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setMusicGenStatus("submit failed: " + (data.error || "HTTP " + resp.status), "error");
      $("#planner-music-gen").disabled = false;
      return;
    }
    if (data.status !== "pending" || !data.id) {
      setMusicGenStatus("unexpected response shape", "error");
      $("#planner-music-gen").disabled = false;
      return;
    }
    planState.pendingMusicChatId = data.id;
    persistSoon();
    setMusicGenStatus("generating (this is async; ~30-90s)...", "loading");
    pollMusicJob();
  } catch (err) {
    setMusicGenStatus("network error: " + err.message, "error");
    $("#planner-music-gen").disabled = false;
  }
}

function resumeMusicPolling() {
  if (!planState.pendingMusicChatId) return;
  setMusicGenStatus("resuming poll on prior MiniMax Music job...", "loading");
  $("#planner-music-gen").disabled = true;
  pollMusicJob();
}

async function pollMusicJob() {
  if (!planState.pendingMusicChatId) return;
  try {
    const resp = await fetch("/api/job/" + planState.pendingMusicChatId);
    const data = await resp.json();
    if (data.status === "done" && data.output_artifact && data.output_artifact.key) {
      // Adopt the music artifact as the audio bed. The artifact lives in
      // env.R2 (out/<uuid>.<ext>) since /api/chat writes there; the
      // artifact route handles cross-bucket reads via isRendersKey so
      // <audio src="/api/artifact/out/..."> resolves correctly.
      planState.audioKey = data.output_artifact.key;
      planState.audioMime = data.output_artifact.mime || "audio/mpeg";
      planState.audioSourceLabel = "MiniMax Music 2.6";
      planState.pendingMusicChatId = null;
      renderAudioCurrent();
      setMusicGenStatus("done.", "success");
      $("#planner-music-gen").disabled = false;
      persistSoon();
      // v0.56.0: audio bed change triggers preflight HEAD re-check.
      schedulePreflight();
      return;
    }
    if (data.status === "failed") {
      planState.pendingMusicChatId = null;
      setMusicGenStatus("model failed: " + (data.job_error || "(no detail)"), "error");
      $("#planner-music-gen").disabled = false;
      persistSoon();
      return;
    }
    // Still pending. Re-arm.
    musicPollTimer = setTimeout(pollMusicJob, MUSIC_POLL_MS);
  } catch (err) {
    setMusicGenStatus("poll error: " + err.message + " (retrying)", "error");
    musicPollTimer = setTimeout(pollMusicJob, MUSIC_POLL_MS);
  }
}

function snapAllScenes() {
  if (!planState.storyboard || !Array.isArray(planState.storyboard.scenes)) {
    setSnapStatus("no storyboard to snap.", "error");
    return;
  }
  const bpm = Number($("#planner-bpm").value);
  const beats = Number($("#planner-beats-per-shot").value);
  if (!Number.isFinite(bpm) || bpm <= 0) { setSnapStatus("invalid BPM.", "error"); return; }
  if (!Number.isFinite(beats) || beats <= 0) { setSnapStatus("invalid beats per shot.", "error"); return; }
  planState.bpm = bpm;
  planState.beatsPerShot = beats;
  let changed = 0;
  for (const scene of planState.storyboard.scenes) {
    const before = scene.target_seconds || 0;
    const after = snapToBeats(before || ((60 / bpm) * beats), bpm, beats);
    if (Math.abs((before || 0) - after) > 0.001) {
      scene.target_seconds = after;
      changed++;
    }
  }
  renderSceneEditor(planState.storyboard);
  onSceneChanged();
  setSnapStatus(
    "snapped " + changed + " of " + planState.storyboard.scenes.length + " scenes "
    + "(phrase = " + ((60 / bpm) * beats).toFixed(3) + "s).",
    "success",
  );
}

// Expose pure helper for vitest. window assignment is a no-op in Node
// (the unit test imports the mirror at the bottom of cast-db.test.ts),
// but lets the browser console inspect the function.
if (typeof window !== "undefined") window.__plannerHelpers = { snapToBeats };

// ---------- Beat-sync (v0.106.0) ----------
//
// Server-side beat analysis: POST /api/audio/analyze runs librosa on the
// AUDIO_BEAT_SYNC Cloudflare Container and returns the beat plan inline (one
// synchronous request, no jobId/poll), then we apply its per-scene beat-aligned
// target_seconds. See docs/audio-beat-sync-container.md.
const PLANNER_MAX_SCENES = 50; // mirrors STORYBOARD_MAX_SCENES in src/storyboard-validate.ts
let lastBeatPlan = null;

function setBeatStatus(text, kind) {
  const el = $("#planner-beat-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (kind ? " planner-" + kind : "");
}

async function analyzeBeats() {
  if (!planState.audioKey) { setBeatStatus("attach or generate an audio bed first.", "error"); return; }
  const clip = Number($("#planner-beat-clip").value);
  if (!Number.isFinite(clip) || clip <= 0) { setBeatStatus("seconds per shot must be a positive number.", "error"); return; }
  $("#planner-analyze-beats").disabled = true;
  $("#planner-beat-result").hidden = true;
  setBeatStatus("analyzing (beat detection)...", "loading");
  try {
    // Single synchronous call: the container returns the plan inline.
    const resp = await fetch("/api/audio/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioKey: planState.audioKey, clipSeconds: clip, mode: "beat" }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok || !data.output) {
      setBeatStatus("analysis failed: " + (data.error || "HTTP " + resp.status), "error");
      return;
    }
    renderBeatPlan(data.output);
  } catch (err) {
    setBeatStatus("network error: " + err.message, "error");
  } finally {
    $("#planner-analyze-beats").disabled = false;
  }
}

function renderBeatPlan(plan) {
  lastBeatPlan = plan;
  const parts = [];
  if (typeof plan.bpm === "number") parts.push(plan.bpm.toFixed(1) + " BPM");
  parts.push((plan.suggestedShots || 0) + " shots");
  if (typeof plan.durationSeconds === "number") parts.push(plan.durationSeconds.toFixed(1) + "s");
  let summary = parts.join(" · ");
  if (plan.note) summary += ": " + plan.note;
  if ((plan.suggestedShots || 0) > PLANNER_MAX_SCENES) {
    summary += "  (exceeds the " + PLANNER_MAX_SCENES + "-scene cap; apply will clamp)";
  }
  $("#planner-beat-summary").textContent = summary;
  const canApply = Array.isArray(plan.timedScenes) && plan.timedScenes.length > 0;
  const applyBtn = $("#planner-beat-apply");
  applyBtn.disabled = !canApply;
  applyBtn.title = canApply ? "" : "no per-scene cuts in this mode; use the shot count to replan instead";
  $("#planner-beat-result").hidden = false;
  setBeatStatus(canApply ? "ready" : "ready (no per-scene cuts in this mode)", "success");
}

function applyBeatPlan() {
  if (!lastBeatPlan || !Array.isArray(lastBeatPlan.timedScenes) || lastBeatPlan.timedScenes.length === 0) {
    setBeatStatus("no beat plan to apply.", "error");
    return;
  }
  if (!planState.storyboard || !Array.isArray(planState.storyboard.scenes) || planState.storyboard.scenes.length === 0) {
    setBeatStatus("plan a storyboard first, then apply beats.", "error");
    return;
  }
  const scenes = planState.storyboard.scenes;
  // Clamp to the scene cap; apply to the overlapping range only (non-
  // destructive: we never add or delete scenes here). target_seconds is the
  // field the renderer consumes; consecutive durations summing across scenes
  // is what lands the cuts on the beat.
  const timed = lastBeatPlan.timedScenes.slice(0, PLANNER_MAX_SCENES);
  const n = Math.min(scenes.length, timed.length);
  for (let i = 0; i < n; i++) {
    scenes[i].target_seconds = Number(timed[i].targetSeconds.toFixed(2));
  }
  renderSceneEditor(planState.storyboard);
  onSceneChanged();
  let msg = "applied beat timing to " + n + " scene" + (n === 1 ? "" : "s") + ".";
  if (timed.length > scenes.length) {
    // v0.134.4: timed.length is how many shots the TRACK fits (musical phrases),
    // NOT the storyboard's shot count. The old wording ("plan has N shots vs M
    // scenes") read as if the storyboard had N shots, which confused users whose
    // plan had M. Name the source explicitly.
    const extra = timed.length - scenes.length;
    msg += " the track fits " + timed.length + " shots but the storyboard has "
        + scenes.length + "; " + extra + " musical phrase" + (extra === 1 ? "" : "s")
        + " unused -- add " + (extra === 1 ? "a scene" : "scenes") + " (or replan) to use the rest.";
  } else if (scenes.length > timed.length) {
    msg += " " + (scenes.length - timed.length) + " trailing scene(s) left unchanged (the track is shorter than the storyboard).";
  }
  setBeatStatus(msg, "success");
}

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
        onSceneChanged();
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(" " + slot));
      slotsRow.appendChild(lbl);
    }
    slotsField.appendChild(slotsRow);
    li.appendChild(slotsField);
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

// ---------- Model picker hydration ----------

async function loadModels() {
  const select = $("#planner-model");
  select.disabled = true;
  select.innerHTML = '<option>loading models...</option>';
  try {
    const resp = await fetch("/api/storyboard/models");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    select.innerHTML = "";
    if (!Array.isArray(data.models) || data.models.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "no planning models available";
      select.appendChild(opt);
      return;
    }
    for (const model of data.models) {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = model.label || model.id;
      select.appendChild(opt);
    }
    select.disabled = false;
  } catch (err) {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.textContent = "failed to load models: " + err.message;
    select.appendChild(opt);
  }
}

// ---------- Plan stage dispatcher ----------

async function plan() {
  const briefEl = $("#planner-brief");
  const model = $("#planner-model").value;
  const brief = briefEl.value.trim();

  if (!brief) {
    setStatus("brief is required", "error");
    briefEl.focus();
    return;
  }
  if (!model) {
    setStatus("select a model first", "error");
    return;
  }

  const characters = collectCast();

  // v0.161.1: evict the prior storyboard from both memory and the persisted
  // snapshot BEFORE the fetch so the YAML view never shows a previous project
  // during the in-flight window (brief->YAML stale-state bug, issue #4).
  planState.storyboard = null;
  planState.originalStoryboard = null;
  planState.refineHistory = [];
  $("#planner-output").hidden = true;
  $("#planner-output-state").textContent = "";
  // Reset any prior bundle / render state when re-planning.
  resetBundleStage();
  resetRenderStage();
  savePersistedState();

  setStatus("planning, this can take 5 to 30 seconds...", "loading");
  $("#planner-plan").disabled = true;

  let httpStatus = 0;
  let data = null;
  try {
    const resp = await fetch("/api/storyboard/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief, characters, model }),
    });
    httpStatus = resp.status;
    try {
      data = await resp.json();
    } catch {
      data = { error: "non-JSON response from server" };
    }
  } catch (err) {
    setStatus("network error: " + err.message, "error");
    $("#planner-plan").disabled = false;
    return;
  } finally {
    $("#planner-plan").disabled = false;
  }

  renderPlanResult(httpStatus, data, model, characters);
}

function renderPlanResult(httpStatus, data, model, characters) {
  $("#planner-output").hidden = false;
  $("#planner-output-meta").textContent =
    "model: " + model + " · HTTP " + httpStatus;
  const state = $("#planner-output-state");
  const errorsPanel = $("#planner-errors");
  const resultPanel = $("#planner-result");
  const rawPanel = $("#planner-raw");

  if (httpStatus === 400) {
    state.textContent = "request rejected";
    state.className = "planner-output-state planner-error";
    errorsPanel.hidden = false;
    resultPanel.hidden = true;
    rawPanel.hidden = true;
    renderErrors([data && data.error ? data.error : "unknown 400 error"]);
    setStatus("400: " + (data && data.error ? data.error : "request rejected"), "error");
    return;
  }

  if (httpStatus === 502 || (data && data.ok === false)) {
    const isUpstream = httpStatus === 502;
    state.textContent = isUpstream ? "upstream error" : "model output invalid";
    state.className = "planner-output-state planner-error";
    errorsPanel.hidden = false;
    renderErrors((data && data.errors) || ["unknown error"]);
    resultPanel.hidden = true;
    if (data && data.raw) {
      rawPanel.hidden = false;
      $("#planner-raw-content").textContent = data.raw;
    } else {
      rawPanel.hidden = true;
    }
    setStatus(
      isUpstream ? "upstream call failed (502)" : "model output did not validate",
      "error",
    );
    return;
  }

  if (data && data.ok === true) {
    state.textContent = "ok";
    state.className = "planner-output-state planner-success";
    errorsPanel.hidden = true;
    rawPanel.hidden = true;
    resultPanel.hidden = false;
    $("#planner-json").textContent = JSON.stringify(data.storyboard, null, 2);
    $("#planner-yaml").textContent = data.yaml || "";
    const sceneCount =
      data.storyboard && data.storyboard.scenes ? data.storyboard.scenes.length : 0;
    setStatus("planned successfully (" + sceneCount + " scenes)", "success");
    // Set storyboard before any showXxxSection() calls so they see a
    // non-null storyboard and unhide correctly. showBundleStage() will
    // also set it (same value); this just ensures the order is safe. (v0.162.2)
    planState.storyboard = data.storyboard;
    // v0.49.0: snapshot the freshly-planned storyboard so a "discard
    // edits" button can roll back any subsequent scene-editor mutations.
    planState.originalStoryboard = JSON.parse(JSON.stringify(data.storyboard));
    // v0.50.0: fresh plan resets the refinement chat history (a new
    // storyboard is a new conversation).
    planState.refineHistory = [];
    showRefineSection();
    // v0.51.0: a fresh plan keeps the audio bed + BPM (those are about
    // the music + tempo, not the storyboard structure) but resets the
    // pending music-gen chat id and re-renders the section so the
    // controls reflect the new storyboard's scene set.
    planState.pendingMusicChatId = null;
    // v0.137.6: a fresh storyboard is a new soundtrack target, so let the
    // music-prompt auto-suggestion fire again the next time Audio is opened.
    musicPromptAutoTried = false;
    showAudioSection();
    renderSceneEditor(data.storyboard);
    // v0.54.0: show the preflight section and auto-run a first check
    // so the user sees the panel's state immediately.
    showPreflightSection();
    runPreflight();
    showBundleStage(data.storyboard, characters);
    // v0.120.0: a fresh plan unlocks Cast & Bundle + Audio. Stay on the Plan
    // step so the user can review the output / refine; the rail lights up.
    refreshSteps();
    savePersistedState();
    return;
  }

  state.textContent = "unexpected response shape";
  state.className = "planner-output-state planner-error";
  errorsPanel.hidden = false;
  resultPanel.hidden = true;
  rawPanel.hidden = true;
  renderErrors(["unexpected response shape; see network tab"]);
  setStatus("unexpected response shape", "error");
}

function renderErrors(errors) {
  const list = $("#planner-errors-list");
  list.innerHTML = "";
  for (const err of errors) {
    const li = document.createElement("li");
    li.textContent = err;
    list.appendChild(li);
  }
}

function repromptWithErrors() {
  const items = document.querySelectorAll("#planner-errors-list li");
  if (items.length === 0) return;
  const errors = Array.from(items).map((li) => li.textContent);
  const briefEl = $("#planner-brief");
  const current = briefEl.value.trim();
  const block = [
    "",
    "",
    "PREVIOUS ATTEMPT FAILED VALIDATION. Please retry, fixing these issues:",
    ...errors.map((e) => "- " + e),
  ].join("\n");
  briefEl.value = current + block;
  briefEl.focus();
  briefEl.scrollIntoView({ behavior: "smooth", block: "start" });
  setStatus("brief updated with errors; click 'plan' to retry", "loading");
}

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
      + ": animate them with Wan i2v on the GPU, no SDXL keyframe pass";
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
    + " injected keyframe(s) with GPU Wan i2v (no SDXL keyframe pass)?\n\ncontinue?"
  )) return;
  const tierEl = $("#planner-quality-tier");
  const qualityTier = tierEl && tierEl.value ? tierEl.value : "final";
  btn.disabled = true;
  status.textContent = "submitting i2v render...";
  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render-from-keyframes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: project, bundleKey: bundleKey, qualityTier: qualityTier }),
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

// ---------- Render stage ----------

function showRenderStage() {
  const stage = $("#planner-render");
  stage.hidden = false;
  $("#planner-render-result").hidden = true;
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
  setRenderStatus("", "");
  updateScatterGate();
}

async function submitRender() {
  if (!bundleState.bundleKey) {
    setRenderStatus("no bundleKey; run 'bundle' first", "error");
    return;
  }
  // v0.35.3 + v0.43.0: build render_overrides from BOTH the structured
  // fields (seed / adetailer / lora_scale / consistency_mode) and the
  // raw JSON textarea. Either source can supply any field; on a key
  // conflict the textarea wins (it is the explicit power-user escape
  // hatch). buildRenderOverrides throws on a malformed textarea so a
  // bad JSON does not leave the UI mid-flow.
  let renderOverrides;
  try {
    renderOverrides = buildRenderOverrides({
      // keyframe
      seedText: readVal("#planner-seed"),
      keyframeSdxlSize: readVal("#planner-keyframe-sdxl-size"),
      keyframeModelId: readVal("#planner-ld-keyframe-model-id"),
      keyframeGuidanceText: readVal("#planner-ld-keyframe-guidance-scale"),
      keyframeStepsText: readVal("#planner-ld-keyframe-steps"),
      identityMethod: readVal("#planner-face-lock-mode"),
      ipScaleText: readVal("#planner-fl-ip-scale"),
      iidCnScaleText: readVal("#planner-fl-iid-cn-scale"),
      iidIpScaleText: readVal("#planner-fl-iid-ip-scale"),
      // keyframe.multi_char
      mcEngine: readVal("#planner-mc-engine"),
      mcPose: readVal("#planner-mc-pose"),
      mcLoraScaleText: readVal("#planner-mc-lora-scale"),
      mcIpScaleText: readVal("#planner-mc-ip-scale"),
      mcMaxSlotsText: readVal("#planner-mc-max-slots"),
      mcCnScaleText: readVal("#planner-mc-cn-scale"),
      // i2v
      i2vModelId: readVal("#planner-wd-i2v-model-id"),
      numFramesText: readVal("#planner-wan-num-frames"),
      i2vStepsText: readVal("#planner-wan-inference-steps"),
      i2vGuidanceText: readVal("#planner-wan-guidance-scale"),
      fpsText: readVal("#planner-fps"),
      flowShiftText: readVal("#planner-wd-flow-shift"),
      // lora
      loraRankText: readVal("#planner-lora-rank"),
      loraStepsText: readVal("#planner-lora-steps"),
      loraLrText: readVal("#planner-lora-lr"),
      loraResolutionText: readVal("#planner-lora-resolution"),
      // power-user escape hatch (raw namespaced JSON)
      textareaText: readVal("#planner-render-overrides"),
    });
  } catch (err) {
    setRenderStatus(err.message, "error");
    if (/JSON|textarea/i.test(err.message)) {
      const ta = $("#planner-render-overrides");
      if (ta) ta.focus();
    }
    return;
  }
  // Stop any prior poll loop before starting a new render.
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  const qualityTier = $("#planner-quality-tier").value;
  // v0.40.0: the checkbox is the source of truth for the next submission.
  // The Worker merges this into render_overrides.keyframes_only=true on
  // the wire; the GPU side (vivijure-serverless 0.4.2+) short-circuits
  // the orchestrator after the SDXL pass when it is set.
  const kfOnlyEl = $("#planner-keyframes-only");
  const keyframesOnly = !!(kfOnlyEl && kfOnlyEl.checked);
  setRenderStatus(
    keyframesOnly ? "submitting keyframes-only preview..." : "submitting to RunPod...",
    "loading",
  );
  $("#planner-render-btn").disabled = true;

  const reqBody = {
    bundleKey: bundleState.bundleKey,
    qualityTier,
  };
  // v0.43.0: buildRenderOverrides returns {} when nothing is set, so
  // gate on key count rather than truthiness; an empty object would
  // otherwise round-trip as `render_overrides: {}` and the Worker
  // would drop it anyway, but skipping it here keeps the wire clean.
  if (renderOverrides && Object.keys(renderOverrides).length > 0) {
    reqBody.renderOverrides = renderOverrides;
  }
  if (keyframesOnly) reqBody.keyframesOnly = true;
  // v0.52.0: forward the audio bed R2 key when one is set. The Worker
  // cross-bucket-copies MiniMax-generated keys (out/<uuid>.<ext>) into
  // env.R2_RENDERS at submit time; uploaded BYO audio (audio/<...>)
  // passes through. The GPU side (vivijure-serverless 0.4.11+) reads
  // audio_key from the job input, downloads, and muxes via
  // export_film(with_audio=True).
  if (planState.audioKey) reqBody.audioKey = planState.audioKey;
  // v0.55.0: pin the render row to the active project so the history
  // list can filter by project. Skipped on transient (no-project)
  // submits, which matches the pre-0.55 behavior.
  if (planState.activeProjectId) reqBody.projectId = planState.activeProjectId;
  // v0.58.0: forward {slot: cast_id} bindings for any cast members
  // whose LoRA the GPU should reuse instead of training fresh. The
  // Worker resolves these to {slot: r2_key} via getCastById (ownership-
  // scoped, ready-status-gated) and the GPU (vivijure-serverless 0.4.14+)
  // stages the .safetensors into the project before Stage 1 so the
  // ready-slot pre-check short-circuits training for them.
  // v0.135.6: no cache refresh needed here; buildCastLoraSubmit now sends all
  // bound cast ids and the server gates readiness against fresh D1 state.
  const castLoraSubmit = buildCastLoraSubmit();
  if (Object.keys(castLoraSubmit).length > 0) reqBody.castLoras = castLoraSubmit;

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    data = await resp.json();
  } catch (err) {
    setRenderStatus("network error: " + err.message, "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("submit failed: " + errs.join("; "), "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!data || !data.jobId) {
    setRenderStatus("submit returned no jobId", "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  renderState.jobId = data.jobId;
  renderState.streamFallbackHit = false;
  // v0.44.0: reset the elapsed/ETA anchor on a fresh submit so a
  // previous render's startedAt does not leak in. updateRenderProgress
  // re-anchors on the first non-IN_QUEUE status update.
  renderState.startedAt = null;
  if (renderState.tickTimer !== null) {
    clearInterval(renderState.tickTimer);
    renderState.tickTimer = null;
  }
  // v0.37.0: track display name for notifications. Use the bundle's
  // derived project slug here; resumeRender will overwrite with the
  // history row's label when available.
  renderState.currentProject = deriveProjectFromKey(bundleState.bundleKey || "");
  renderState.currentLabel = null;
  // v0.37.0: ask for notification permission on the first submit when
  // we have not asked before. Done here (not on page load) so the
  // prompt arrives at the moment the value is most obvious: right
  // before a 10-to-30 minute wait.
  if (notifyState.permission === "default") {
    requestNotificationPermission();
  }
  $("#planner-render-result").hidden = false;
  $("#planner-render-job-id").textContent = data.jobId;
  setJobStatusBadge(data.status || "IN_QUEUE");
  // v0.135.6: surface the server's LoRA reuse decision so a reused render is
  // visibly distinct from one that retrains. pretrainedSlots = slots the GPU
  // will skip training (cast LoRA staged); castLoraSkipped = slots trained
  // fresh, with a reason. Shown at submit (the moment it matters) + logged.
  const reusedSlots = Array.isArray(data.pretrainedSlots) ? data.pretrainedSlots : [];
  const skippedLoras = Array.isArray(data.castLoraSkipped) ? data.castLoraSkipped : [];
  let loraNote = "";
  if (reusedSlots.length) loraNote += " reusing trained LoRAs for " + reusedSlots.join(", ") + ".";
  if (skippedLoras.length) loraNote += " training fresh: " + skippedLoras.map((s) => s.slot + " (" + s.reason + ")").join(", ") + ".";
  if (loraNote) console.info("[render] LoRA:" + loraNote);
  setRenderStatus("submitted; opening stream..." + loraNote, "loading");
  startStream();
  // Refresh the history list so the new render appears at the top
  // without the user needing to click "refresh" manually.
  loadHistory();
  // v0.38.0: persist the new jobId so a tab close resumes the stream
  // on the next reload.
  savePersistedState();
}

// v0.162.0: enable/disable the scatter checkbox based on current state.
// Conditions: >= 2 shots in the storyboard AND castLoras non-empty (the
// server hard-400s a scatter with no castLoras; shards would diverge
// without a shared pre-trained LoRA). Shows a short reason when disabled.
function updateScatterGate() {
  const checkbox = $("#planner-scatter");
  const reasonEl = $("#planner-scatter-reason");
  const shardWrap = $("#planner-scatter-shard-wrap");
  if (!checkbox) return;

  const scenes =
    planState.storyboard && Array.isArray(planState.storyboard.scenes)
      ? planState.storyboard.scenes
      : [];
  const castLoras = buildCastLoraSubmit();
  const hasLoras = Object.keys(castLoras).length > 0;

  let reason = "";
  if (scenes.length < 2) reason = "needs >= 2 shots";
  else if (!hasLoras) reason = "every character needs a trained LoRA first";

  checkbox.disabled = !!reason;
  if (reason) checkbox.checked = false;

  if (reasonEl) {
    reasonEl.textContent = reason;
    reasonEl.hidden = !reason;
  }
  if (shardWrap) {
    shardWrap.hidden = !(checkbox.checked && !checkbox.disabled);
  }

  const shardInput = $("#planner-scatter-shards");
  if (shardInput && scenes.length >= 2) {
    shardInput.max = String(scenes.length);
    const cur = parseInt(shardInput.value, 10);
    if (!Number.isInteger(cur) || cur < 2) shardInput.value = "2";
    else if (cur > scenes.length) shardInput.value = String(scenes.length);
  }
}

// v0.162.0: POST to /api/storyboard/render/scatter and drive the existing
// renderState poll loop with the returned scatter-<uuid> jobId. Modeled on
// submitRender() -- reuses buildRenderOverrides, qualityTier, audioKey,
// projectId exactly. shotIds are derived via sceneIdAt (the canonical id
// source that matches the GPU's per-shot clip filenames).
async function submitScatterRender() {
  if (!bundleState.bundleKey) {
    setRenderStatus("no bundleKey; run 'bundle' first", "error");
    return;
  }
  const scenes =
    planState.storyboard && Array.isArray(planState.storyboard.scenes)
      ? planState.storyboard.scenes
      : [];
  const shotIds = scenes.map((s, i) => sceneIdAt(s, i));
  if (shotIds.length < 2) {
    setRenderStatus("scatter requires >= 2 shots", "error");
    return;
  }
  const castLoras = buildCastLoraSubmit();
  if (Object.keys(castLoras).length === 0) {
    setRenderStatus(
      "scatter requires at least one character with a trained LoRA bound",
      "error",
    );
    return;
  }

  const shardInput = $("#planner-scatter-shards");
  let shardCount = shardInput ? parseInt(shardInput.value, 10) : 2;
  if (!Number.isInteger(shardCount) || shardCount < 2) shardCount = 2;
  if (shardCount > shotIds.length) shardCount = shotIds.length;

  let renderOverrides;
  try {
    renderOverrides = buildRenderOverrides({
      seedText: readVal("#planner-seed"),
      keyframeSdxlSize: readVal("#planner-keyframe-sdxl-size"),
      keyframeModelId: readVal("#planner-ld-keyframe-model-id"),
      keyframeGuidanceText: readVal("#planner-ld-keyframe-guidance-scale"),
      keyframeStepsText: readVal("#planner-ld-keyframe-steps"),
      identityMethod: readVal("#planner-face-lock-mode"),
      ipScaleText: readVal("#planner-fl-ip-scale"),
      iidCnScaleText: readVal("#planner-fl-iid-cn-scale"),
      iidIpScaleText: readVal("#planner-fl-iid-ip-scale"),
      mcEngine: readVal("#planner-mc-engine"),
      mcPose: readVal("#planner-mc-pose"),
      mcLoraScaleText: readVal("#planner-mc-lora-scale"),
      mcIpScaleText: readVal("#planner-mc-ip-scale"),
      mcMaxSlotsText: readVal("#planner-mc-max-slots"),
      mcCnScaleText: readVal("#planner-mc-cn-scale"),
      i2vModelId: readVal("#planner-wd-i2v-model-id"),
      numFramesText: readVal("#planner-wan-num-frames"),
      i2vStepsText: readVal("#planner-wan-inference-steps"),
      i2vGuidanceText: readVal("#planner-wan-guidance-scale"),
      fpsText: readVal("#planner-fps"),
      flowShiftText: readVal("#planner-wd-flow-shift"),
      loraRankText: readVal("#planner-lora-rank"),
      loraStepsText: readVal("#planner-lora-steps"),
      loraLrText: readVal("#planner-lora-lr"),
      loraResolutionText: readVal("#planner-lora-resolution"),
      textareaText: readVal("#planner-render-overrides"),
    });
  } catch (err) {
    setRenderStatus(err.message, "error");
    if (/JSON|textarea/i.test(err.message)) {
      const ta = $("#planner-render-overrides");
      if (ta) ta.focus();
    }
    return;
  }

  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  const qualityTier = $("#planner-quality-tier").value;
  setRenderStatus(
    "submitting scatter render (" + shardCount + " shards)...",
    "loading",
  );
  $("#planner-render-btn").disabled = true;

  const reqBody = {
    bundleKey: bundleState.bundleKey,
    shotIds,
    shardCount,
    castLoras,
  };
  if (qualityTier) reqBody.qualityTier = qualityTier;
  if (renderOverrides && Object.keys(renderOverrides).length > 0) {
    reqBody.renderOverrides = renderOverrides;
  }
  if (planState.audioKey) reqBody.audioKey = planState.audioKey;
  if (planState.activeProjectId) reqBody.projectId = planState.activeProjectId;

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render/scatter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    data = await resp.json();
  } catch (err) {
    setRenderStatus("network error: " + err.message, "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs =
      (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("scatter submit failed: " + errs.join("; "), "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!data || !data.jobId) {
    setRenderStatus("scatter submit returned no jobId", "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  renderState.jobId = data.jobId;
  renderState.streamFallbackHit = false;
  renderState.startedAt = null;
  if (renderState.tickTimer !== null) {
    clearInterval(renderState.tickTimer);
    renderState.tickTimer = null;
  }
  renderState.currentProject = deriveProjectFromKey(bundleState.bundleKey || "");
  renderState.currentLabel = null;
  if (notifyState.permission === "default") {
    requestNotificationPermission();
  }
  $("#planner-render-result").hidden = false;
  $("#planner-render-job-id").textContent = data.jobId;
  setJobStatusBadge(data.status || "IN_QUEUE");
  setRenderStatus(
    "scatter submitted -- " + shardCount + " shards gathering...",
    "loading",
  );
  startStream();
  loadHistory();
  savePersistedState();
}

// v0.35.0: open a server-sent event connection to the worker so render
// status updates arrive as RunPod produces them, instead of on a fixed
// 8-second client poll. The worker proxies RunPod at a 3-second cadence
// and emits each snapshot as an SSE event with the same JSON shape the
// one-shot poll endpoint returns; updateRenderProgress / finalizeRender
// stay unchanged. On any stream error (auth, transient network, or the
// worker's duration cap), fall back to pollRender() so an in-flight job
// is never silently abandoned.
function startStream() {
  if (!renderState.jobId) return;

  // Clean up any prior stream / poll first so we never have two listeners
  // racing on the same panel.
  if (renderState.eventSource) {
    try { renderState.eventSource.close(); } catch {}
    renderState.eventSource = null;
  }
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  // EventSource carries the Cloudflare Access cookie automatically (same
  // origin + same auth gate as every other /api/storyboard/* request).
  const url = "/api/storyboard/render/" + encodeURIComponent(renderState.jobId) + "/stream";
  let es;
  try {
    es = new EventSource(url);
  } catch (err) {
    setRenderStatus("could not open stream: " + err.message + "; falling back to polling", "loading");
    pollRender();
    return;
  }
  renderState.eventSource = es;

  es.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      // Skip malformed event; the next one will catch up.
      return;
    }

    if (data && data.ok === false) {
      const errs = (data.errors || ["unknown stream error"]).join("; ");
      setRenderStatus("stream error: " + errs, "error");
      closeStream();
      pollRender();
      return;
    }

    // Sentinel events the worker emits at stream open and duration cap.
    if (data.status === "STREAM_OPENED") {
      setRenderStatus("stream open; awaiting first status update", "loading");
      return;
    }
    if (data.status === "STREAM_DURATION_CAP") {
      // The worker capped this stream's life. Re-open transparently so the
      // user does not see a status interruption.
      closeStream();
      setRenderStatus("stream rotation (duration cap); reconnecting", "loading");
      startStream();
      return;
    }

    updateRenderProgress(data);

    const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
    if (terminal.indexOf(data.status) >= 0) {
      finalizeRenderPoll(data);
      maybeNotifyTerminal(data);
      closeStream();
      $("#planner-render-btn").disabled = false;
      // Refresh history so the row's terminal state appears in the list.
      loadHistory();
    }
  };

  es.addEventListener("error", (ev) => {
    // EventSource fires "error" for both transient blips (which it then
    // reconnects from on its own) and permanent close. We can distinguish
    // by readyState: CLOSED means the browser will not retry.
    const closed = es.readyState === EventSource.CLOSED;
    if (closed && !renderState.streamFallbackHit) {
      renderState.streamFallbackHit = true;
      setRenderStatus("stream closed; falling back to 8s polling", "loading");
      closeStream();
      pollRender();
    }
    // Transient errors are silent; EventSource handles the reconnect.
  });
}

function closeStream() {
  if (renderState.eventSource) {
    try { renderState.eventSource.close(); } catch {}
    renderState.eventSource = null;
  }
}

async function pollRender() {
  if (!renderState.jobId) return;
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render/" + encodeURIComponent(renderState.jobId));
    data = await resp.json();
  } catch (err) {
    setRenderStatus("poll network error: " + err.message + " (retrying)", "error");
    renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("poll failed: " + errs.join("; ") + " (retrying)", "error");
    renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
    return;
  }

  updateRenderProgress(data);

  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  if (terminal.indexOf(data.status) >= 0) {
    finalizeRenderPoll(data);
    maybeNotifyTerminal(data);
    $("#planner-render-btn").disabled = false;
    return;
  }

  // Keep polling.
  setRenderStatus(data.status.toLowerCase() + "; polling every " + (POLL_INTERVAL_MS / 1000) + "s", "loading");
  renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
}

function updateRenderProgress(data) {
  setJobStatusBadge(data.status);

  const out = data.output;
  if (out && typeof out === "object") {
    if (typeof out.scene_index === "number" && typeof out.scene_total === "number") {
      const el = $("#planner-render-scene");
      el.hidden = false;
      el.innerHTML = "";
      const lab = document.createElement("span");
      lab.className = "planner-render-label";
      lab.textContent = "scene:";
      el.appendChild(lab);
      el.appendChild(
        document.createTextNode(" " + out.scene_index + "/" + out.scene_total),
      );
    }
    if (typeof out.phase === "string" && out.phase) {
      const el = $("#planner-render-phase");
      el.hidden = false;
      el.innerHTML = "";
      const lab = document.createElement("span");
      lab.className = "planner-render-label";
      lab.textContent = "phase:";
      el.appendChild(lab);
      el.appendChild(document.createTextNode(" " + out.phase));
    }
    if (Array.isArray(out.log) && out.log.length > 0) {
      const wrap = $("#planner-render-log-wrap");
      wrap.hidden = false;
      $("#planner-render-log").textContent = out.log.join("\n");
    }
  }

  if (data.error) {
    const err = $("#planner-render-error");
    err.hidden = false;
    err.textContent = data.error;
  }

  // v0.44.0: progress bar + ETA. Anchor startedAt on the first non-
  // queued observation so a long IN_QUEUE wait does not skew the
  // elapsed math. Hide the widget entirely on terminal status; the
  // tick timer is also cleaned up there.
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  if (terminal.indexOf(data.status) >= 0) {
    hideProgressWidget();
    return;
  }
  // v0.136.0: SUBMITTED (pre-confirmation) is a queue-equivalent wait; do not
  // anchor the elapsed/ETA clock on it any more than on IN_QUEUE.
  if (
    data.status !== "IN_QUEUE" &&
    data.status !== "SUBMITTED" &&
    renderState.startedAt === null
  ) {
    renderState.startedAt = Date.now();
    savePersistedState();
  }
  if (renderState.startedAt !== null) {
    refreshProgressWidget(out);
    if (renderState.tickTimer === null) {
      renderState.tickTimer = setInterval(() => {
        // No new data; just re-render the elapsed / ETA text against
        // the last-known progress fraction. cachedOut is the most
        // recent output we saw; null means we never observed one
        // (so the bar stays hidden until the first real update).
        refreshProgressWidget(renderState.lastOut);
      }, 1000);
    }
    // Cache the last observed output so the tick timer can re-render
    // the elapsed / ETA without a fresh status snapshot.
    renderState.lastOut = out && typeof out === "object" ? out : renderState.lastOut;
  }
}

// v0.44.0: pure-ish helper that converts the GPU's status envelope into
// a 0-1 progress fraction. Prefers out.progress (a float the GPU writes
// to render_status.json as render_fraction()); falls back to a count of
// completed scenes via (scene_index - 1) / scene_total when progress is
// absent. Returns null when neither signal is available, which the
// caller treats as "show the bar at 0% with 'computing...' ETA."
function computeProgressFraction(out) {
  if (!out || typeof out !== "object") return null;
  if (typeof out.progress === "number" && out.progress >= 0 && out.progress <= 1) {
    return out.progress;
  }
  if (
    typeof out.scene_index === "number"
    && typeof out.scene_total === "number"
    && out.scene_total > 0
  ) {
    // scene_index is 1-based from the GPU. (scene_index - 1) shots
    // completed gives a conservative estimate; once the GPU starts
    // writing out.progress this branch becomes a fallback only.
    const completed = Math.max(0, out.scene_index - 1);
    return Math.min(1, completed / out.scene_total);
  }
  // v0.132.0: the serverless pod streams progress as log TEXT (out.log lines
  // like "Scene 1/3 ..."), not structured scene_index/scene_total, so the two
  // branches above never fired and the ETA was stuck at "computing...". Parse
  // the latest "Scene N/M" out of the log and use the same completed-scene
  // fraction (N-1)/M. Scan from the end for the most recent counter.
  if (Array.isArray(out.log)) {
    for (let i = out.log.length - 1; i >= 0; i--) {
      const m = String(out.log[i]).match(/Scene\s+(\d+)\s*\/\s*(\d+)/i);
      if (m) {
        const idx = parseInt(m[1], 10);
        const tot = parseInt(m[2], 10);
        if (tot > 0) return Math.min(1, Math.max(0, idx - 1) / tot);
        break;
      }
    }
  }
  return null;
}

// v0.44.0: paint the progress bar + ETA from the current renderState
// + an output snapshot. Called both on a real status update and on
// the 1s tick timer (with the cached last output) so the elapsed
// counter advances smoothly between snapshots.
function refreshProgressWidget(out) {
  const widget = $("#planner-render-progress");
  if (!widget) return;
  const startedAt = renderState.startedAt;
  if (startedAt === null) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const elapsedEl = $("#planner-render-progress-elapsed");
  if (elapsedEl) elapsedEl.textContent = formatDuration(elapsedMs);

  const frac = computeProgressFraction(out);
  const pctEl = $("#planner-render-progress-pct");
  const fillEl = $("#planner-render-progress-fill");
  const etaEl = $("#planner-render-progress-eta");

  if (frac === null) {
    if (pctEl) pctEl.textContent = "?%";
    if (fillEl) fillEl.style.width = "0%";
    if (etaEl) etaEl.textContent = "computing...";
    return;
  }
  const pct = Math.round(frac * 100);
  if (pctEl) pctEl.textContent = pct + "%";
  if (fillEl) fillEl.style.width = pct + "%";

  // ETA: linear extrapolation from elapsed. Require at least 3% of
  // the work done before we trust the estimate; the very early
  // numbers are dominated by model-load time and produce wild over-
  // estimates that would scare a user away. Below 3% the bar shows
  // but the ETA stays "computing..." so the user has a visual sense
  // of motion without a misleading number.
  if (etaEl) {
    if (frac < 0.03 || elapsedMs < 10_000) {
      etaEl.textContent = "computing...";
    } else {
      const totalEstMs = elapsedMs / frac;
      const remainingMs = Math.max(0, totalEstMs - elapsedMs);
      etaEl.textContent = "~" + formatDuration(remainingMs);
    }
  }
}

// v0.44.0: tear down the progress widget on terminal status (and
// clear the tick timer). Idempotent so finalizeRender / cancel /
// re-submit can call it without checking state first.
function hideProgressWidget() {
  if (renderState.tickTimer !== null) {
    clearInterval(renderState.tickTimer);
    renderState.tickTimer = null;
  }
  renderState.lastOut = null;
  renderState.startedAt = null;
  const widget = $("#planner-render-progress");
  if (widget) widget.hidden = true;
  savePersistedState();
}

function finalizeRenderPoll(data) {
  const elapsed = data.executionTimeMs
    ? " · ran for " + formatDuration(data.executionTimeMs)
    : "";

  if (data.status === "COMPLETED") {
    setRenderStatus("completed" + elapsed, "success");
    const outpan = $("#planner-render-output");
    outpan.hidden = false;
    $("#planner-render-output-content").textContent = JSON.stringify(
      data.output || {},
      null,
      2,
    );
    // Surface the silent MP4 link if present in the assembler output.
    const out = data.output;
    if (out && typeof out.output_key === "string") {
      const url = "/api/artifact/" + out.output_key;
      const download = $("#planner-render-download");
      download.href = url;
      download.download = (out.project || "silent") + ".mp4";
      const open = $("#planner-render-open");
      open.href = url;
    }
    return;
  }

  // Terminal failure of some flavor.
  setRenderStatus(data.status.toLowerCase() + elapsed, "error");
  const outpan = $("#planner-render-output");
  outpan.hidden = false;
  $("#planner-render-output-content").textContent = JSON.stringify(data.output || {}, null, 2);
}

function setJobStatusBadge(status) {
  const el = $("#planner-render-job-status");
  el.textContent = status;
  let kind = "running";
  if (status === "COMPLETED") kind = "done";
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") kind = "error";
  el.className = "planner-render-job-status planner-render-status-" + kind;
  // Cancel button visible only while the job is still cancellable (queued
  // or running). RunPod accepts cancel on either; terminal states reject.
  const cancelBtn = $("#planner-render-cancel");
  // v0.136.0: SUBMITTED is the pre-confirmation state (we sent it, RunPod has
  // not echoed a /status yet). It is cancellable like IN_QUEUE.
  if (status === "SUBMITTED" || status === "IN_QUEUE" || status === "IN_PROGRESS") {
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
  } else {
    cancelBtn.hidden = true;
  }
  // v0.63.0: dismiss button mirrors cancel - shown only when the job is
  // in a terminal state, so the user can hide a stale FAILED / CANCELLED
  // banner that would otherwise stick around until the next render.
  const dismissBtn = $("#planner-render-dismiss");
  if (dismissBtn) {
    const terminal =
      status === "COMPLETED"
      || status === "FAILED"
      || status === "CANCELLED"
      || status === "TIMED_OUT";
    dismissBtn.hidden = !terminal;
  }
}

// v0.63.0: hide the render-result panel and clear the persisted snapshot
// so the same stale row does not reappear on the next page load. Only
// callable from the dismiss button, which the UI gates on a terminal
// status; in-flight jobs are not dismissable (use "cancel job" first).
function dismissRenderResult() {
  closeStream();
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  if (renderState.tickTimer !== null) {
    clearInterval(renderState.tickTimer);
    renderState.tickTimer = null;
  }
  renderState.jobId = null;
  renderState.streamFallbackHit = false;
  renderState.currentProject = null;
  renderState.currentLabel = null;
  renderState.startedAt = null;
  $("#planner-render-result").hidden = true;
  $("#planner-render-log-wrap").hidden = true;
  $("#planner-render-output").hidden = true;
  $("#planner-render-error").hidden = true;
  $("#planner-render-progress").hidden = true;
  setRenderStatus("", "");
  savePersistedState();
}

async function cancelRender() {
  if (!renderState.jobId) return;
  // Optimistic UX: disable the button and pause the live updates while
  // the cancel call is in flight. Failure restores the button (still
  // cancellable); success lets the next stream / poll event pick up the
  // CANCELLED state.
  const cancelBtn = $("#planner-render-cancel");
  cancelBtn.disabled = true;
  setRenderStatus("requesting cancel...", "loading");
  closeStream();
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/render/" + encodeURIComponent(renderState.jobId),
      { method: "DELETE" },
    );
    data = await resp.json();
  } catch (err) {
    setRenderStatus("cancel network error: " + err.message, "error");
    cancelBtn.disabled = false;
    // Resume polling so the UI keeps reflecting reality.
    renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("cancel failed: " + errs.join("; "), "error");
    cancelBtn.disabled = false;
    // Resume the live stream so the user keeps seeing real-time updates.
    startStream();
    return;
  }

  // RunPod accepted the cancel; the next stream event will see CANCELLED.
  setRenderStatus("cancel requested; awaiting final status", "loading");
  if (data && data.status) setJobStatusBadge(data.status);
  startStream();
}

function resetRenderStage() {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  closeStream();
  renderState.jobId = null;
  renderState.streamFallbackHit = false;
  $("#planner-render").hidden = true;
  $("#planner-render-result").hidden = true;
  // v0.35.3: clear the renderOverrides textarea on re-plan so a stale
  // value from a prior re-render does not silently carry forward into
  // the next submit.
  const overridesTextarea = $("#planner-render-overrides");
  if (overridesTextarea) overridesTextarea.value = "";
  const overridesDetails = $(".planner-overrides-details");
  if (overridesDetails) overridesDetails.open = false;
  setRenderStatus("", "");
}

// ---------- Render history (v0.34.1) ----------
//
// Loads the user's recent renders from GET /api/storyboard/renders on page
// open and after every successful submit. Each row's "view" action resumes
// the render stage with the row's stored snapshot and re-starts polling
// when the job is still in flight, so a tab close no longer loses access
// to in-progress renders. Past renders that already reached COMPLETED
// surface the silent MP4 directly via a "download" link.

// v0.35.2: dedupes concurrent loadHistory calls (refresh button + auto-
// refresh tick + post-submit refresh can all overlap). Cleared in the
// finally block whether the fetch succeeded or threw.
let isLoadingHistory = false;
// v0.35.2: setTimeout handle for the auto-refresh loop. Lives only while
// at least one history row is in a non-terminal status; set in
// maybeScheduleHistoryRefresh, cleared at the start of each loadHistory
// and on tab visibility -> hidden.
let historyRefreshTimer = null;
// v0.37.1: client-side filter state over historyState.rows. text matches
// project + label substring; status flags gate the three buckets. Default
// is "everything visible" so a returning user sees all their renders.
// v0.127.0: sentinel folder-filter value meaning "rows with no folder".
const HISTORY_UNFILED = " unfiled";

const historyState = {
  rows: [],
  filters: {
    text: "",
    showInFlight: true,
    showDone: true,
    showFailed: true,
    // v0.127.0: render-history organization filters (session-only). folderPath
    // is "" (all) | HISTORY_UNFILED | an exact folder path; selectedTags is a
    // set of tags a row must ALL carry to pass.
    folderPath: "",
    selectedTags: [],
  },
  // v0.127.0: the user's full distinct tag set (from /renders/tags), for the
  // tag-input autocomplete datalist. Refreshed on each history load.
  allTags: [],
  // v0.38.1: per-session set of row ids the user has clicked to expand.
  // Default-collapsed lets the list stay scannable once history grows;
  // clicks toggle individual rows open without leaving the page.
  expandedIds: new Set(),
  // v0.41.0: in-flight regen-shot jobs. Keyed by `<rowId>:<shotId>`.
  // Value: { jobId, kfKey, shotId, rowId, startedAt }. Used to:
  //   1. Re-disable the regen button + show the loading label when
  //      buildHistoryRow re-runs on auto-refresh.
  //   2. Drive the polling loop independently of DOM lifecycle, so a
  //      row re-render mid-poll does not cancel the poll.
  // The polling tick locates the current DOM nodes via querySelector
  // each time, so stale refs from before a re-render are not held.
  regenJobs: new Map(),
};

async function loadHistory() {
  if (isLoadingHistory) return;
  if (historyRefreshTimer) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
  }
  isLoadingHistory = true;
  try {
    // v0.55.0: when an active project is set, fetch only that
    // project's renders. Switching projects re-fetches because the
    // active id is read at call time.
    const params = new URLSearchParams();
    params.set("limit", String(HISTORY_LIMIT));
    if (planState.activeProjectId) params.set("project_id", String(planState.activeProjectId));
    const resp = await fetch("/api/storyboard/renders?" + params.toString());
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    historyState.rows = data.renders || [];
    // v0.127.0: refresh the full tag set for autocomplete (best-effort; a
    // failure just leaves the datalist showing tags from the loaded rows).
    fetchAllTags();
    applyHistoryFilters();
    maybeScheduleHistoryRefresh(historyState.rows);
  } catch (err) {
    // Silent: a history load failure should not block the planning flow.
    // The user can still plan, bundle, render normally; only the history
    // surface is missing. Do not auto-reschedule on error; the user can
    // click refresh or wait for the next intentional trigger.
    console.error("history load failed:", err);
  } finally {
    isLoadingHistory = false;
  }
}

// v0.37.1: re-render the list using the current filter state without
// re-fetching. Called from loadHistory on success AND from the filter
// input listeners. No fetch fires when the user types or toggles a
// checkbox; the row data is already in memory.
function applyHistoryFilters() {
  // v0.127.0: rebuild the folder + tag facets from the loaded rows before
  // filtering so the controls reflect what is actually present.
  rebuildHistoryFacets();
  const filtered = filterRows(historyState.rows, historyState.filters);
  renderHistoryList(filtered, historyState.rows.length);
}

// v0.127.0: fetch the user's full distinct tag set for the autocomplete
// datalist. Best-effort: silent on failure, refreshes the datalist on success.
async function fetchAllTags() {
  try {
    const resp = await fetch("/api/storyboard/renders/tags");
    if (!resp.ok) return;
    const data = await resp.json();
    if (Array.isArray(data.tags)) {
      const next = data.tags.filter((t) => typeof t === "string");
      // Re-render only if the set actually changed, so the editor's
      // suggestion pills pick up the full tag set once it arrives.
      if (next.join(" ") !== historyState.allTags.join(" ")) {
        historyState.allTags = next;
        applyHistoryFilters();
      }
    }
  } catch {
    // leave suggestions as-is
  }
}

// Distinct folders present in the loaded rows, sorted.
function historyFolders() {
  const set = new Set();
  for (const r of historyState.rows) {
    if (typeof r.folder_path === "string" && r.folder_path) set.add(r.folder_path);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Distinct tags present in the loaded rows, most-frequent first.
function historyRowTags() {
  const counts = new Map();
  for (const r of historyState.rows) {
    if (!Array.isArray(r.tags)) continue;
    for (const t of r.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

// v0.127.0: rebuild the folder <select>, the folder datalist, and the tag-
// filter pills from the loaded rows. Prunes any active folder / tag filter
// whose value is no longer present so the controls never reference a vanished
// facet. Called from applyHistoryFilters (before filtering).
function rebuildHistoryFacets() {
  const folders = historyFolders();
  const sel = $("#planner-history-folder");
  if (sel) {
    const cur = historyState.filters.folderPath;
    sel.innerHTML = "";
    const add = (value, text) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    };
    add("", "all folders");
    add(HISTORY_UNFILED, "unfiled");
    for (const f of folders) add(f, f);
    if (cur && cur !== HISTORY_UNFILED && !folders.includes(cur)) {
      historyState.filters.folderPath = "";
    }
    sel.value = historyState.filters.folderPath;
  }

  const fdl = $("#planner-history-folder-list");
  if (fdl) {
    fdl.innerHTML = "";
    for (const f of folders) {
      const o = document.createElement("option");
      o.value = f;
      fdl.appendChild(o);
    }
  }

  const tagWrap = $("#planner-history-tagfilter");
  if (tagWrap) {
    const tags = historyRowTags();
    historyState.filters.selectedTags = historyState.filters.selectedTags.filter(
      (t) => tags.includes(t),
    );
    tagWrap.innerHTML = "";
    if (tags.length > 0) {
      const label = document.createElement("span");
      label.className = "planner-history-tagfilter-label";
      label.textContent = "tags:";
      tagWrap.appendChild(label);
      for (const t of tags) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "planner-history-tagpill";
        pill.textContent = t;
        if (historyState.filters.selectedTags.includes(t)) {
          pill.classList.add("is-active");
        }
        pill.addEventListener("click", () => toggleTagFilter(t));
        tagWrap.appendChild(pill);
      }
    }
  }
}

// Toggle a tag in the selectedTags filter and re-render.
function toggleTagFilter(tag) {
  const arr = historyState.filters.selectedTags;
  const i = arr.indexOf(tag);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(tag);
  applyHistoryFilters();
}

// v0.127.0: PATCH folderPath and/or tags on a render row. Returns the parsed
// response; throws on a non-2xx with the server's error message.
async function patchRenderOrganization(row, body) {
  const resp = await fetch(
    "/api/storyboard/renders/" + encodeURIComponent(row.id),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    let msg = "HTTP " + resp.status;
    try {
      const d = await resp.json();
      if (d && d.error) msg = d.error;
    } catch {
      // keep the HTTP code
    }
    throw new Error(msg);
  }
  return resp.json();
}

// v0.127.0: the expanded-row "organize" editor: a folder input (datalist-
// backed) plus a comma-separated tags input with click-to-add suggestion
// pills. Mirrors buildHistoryLabelInput's save-on-blur / Enter / Escape and
// optimistic-local-update behavior.
function buildHistoryOrganizeRow(row) {
  const wrap = document.createElement("div");
  wrap.className = "planner-history-organize";

  // --- folder ---
  const folderField = document.createElement("label");
  folderField.className = "planner-history-org-field";
  const folderLabel = document.createElement("span");
  folderLabel.textContent = "folder";
  const folderInput = document.createElement("input");
  folderInput.type = "text";
  folderInput.className = "planner-history-org-input";
  folderInput.setAttribute("list", "planner-history-folder-list");
  folderInput.placeholder = "e.g. clients/acme";
  folderInput.maxLength = 200;
  folderInput.spellcheck = false;
  folderInput.value = row.folder_path || "";
  let folderSaved = row.folder_path || "";
  const saveFolder = async () => {
    const next = folderInput.value.trim();
    if (next === folderSaved) return;
    try {
      const data = await patchRenderOrganization(row, { folderPath: next || null });
      folderSaved = data.folderPath || "";
      folderInput.value = folderSaved;
      row.folder_path = folderSaved || null;
      applyHistoryFilters();
    } catch (err) {
      console.error("folder save failed:", err);
      window.alert("folder save failed: " + err.message);
      folderInput.value = folderSaved;
    }
  };
  folderInput.addEventListener("blur", saveFolder);
  folderInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); folderInput.blur(); }
    else if (ev.key === "Escape") { ev.preventDefault(); folderInput.value = folderSaved; folderInput.blur(); }
  });
  folderField.appendChild(folderLabel);
  folderField.appendChild(folderInput);
  wrap.appendChild(folderField);

  // --- tags ---
  const tagField = document.createElement("label");
  tagField.className = "planner-history-org-field";
  const tagLabel = document.createElement("span");
  tagLabel.textContent = "tags";
  const tagInput = document.createElement("input");
  tagInput.type = "text";
  tagInput.className = "planner-history-org-input";
  tagInput.placeholder = "comma-separated, e.g. hero, final";
  tagInput.spellcheck = false;
  const tagsToStr = (arr) => (Array.isArray(arr) ? arr.join(", ") : "");
  const parseTags = (s) =>
    s.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  tagInput.value = tagsToStr(row.tags);
  let tagsSaved = tagsToStr(row.tags);
  const saveTags = async () => {
    const parsed = parseTags(tagInput.value);
    if (parsed.join(",") === parseTags(tagsSaved).join(",")) return;
    try {
      const data = await patchRenderOrganization(row, { tags: parsed });
      row.tags = Array.isArray(data.tags) ? data.tags : [];
      tagsSaved = tagsToStr(row.tags);
      tagInput.value = tagsSaved;
      applyHistoryFilters();
    } catch (err) {
      console.error("tags save failed:", err);
      window.alert("tags save failed: " + err.message);
      tagInput.value = tagsSaved;
    }
  };
  tagInput.addEventListener("blur", saveTags);
  tagInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); tagInput.blur(); }
    else if (ev.key === "Escape") { ev.preventDefault(); tagInput.value = tagsSaved; tagInput.blur(); }
  });
  tagField.appendChild(tagLabel);
  tagField.appendChild(tagInput);
  wrap.appendChild(tagField);

  // suggestion pills: tags the user has used elsewhere that aren't on this row
  const onRow = new Set(parseTags(tagInput.value));
  const suggestions = historyState.allTags.filter((t) => !onRow.has(t));
  if (suggestions.length > 0) {
    const sugWrap = document.createElement("div");
    sugWrap.className = "planner-history-org-suggest";
    for (const t of suggestions.slice(0, 12)) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "planner-history-org-suggest-pill";
      pill.textContent = "+ " + t;
      pill.addEventListener("click", () => {
        const cur = parseTags(tagInput.value);
        if (!cur.includes(t)) cur.push(t);
        tagInput.value = cur.join(", ");
        saveTags();
      });
      sugWrap.appendChild(pill);
    }
    wrap.appendChild(sugWrap);
  }

  return wrap;
}

// Pure filter over rows + filter state. Status buckets:
//   SUBMITTED | IN_QUEUE | IN_PROGRESS  -> in-flight
//   COMPLETED               -> done
//   FAILED | CANCELLED | TIMED_OUT  -> failed
// Text matches project name OR label, case-insensitive substring.
function filterRows(rows, filters) {
  const text = (filters.text || "").toLowerCase().trim();
  return rows.filter((r) => {
    // v0.136.0: SUBMITTED is the pre-confirmation state; bucket it in-flight.
    if (r.status === "SUBMITTED" || r.status === "IN_QUEUE" || r.status === "IN_PROGRESS") {
      if (!filters.showInFlight) return false;
    } else if (r.status === "COMPLETED") {
      if (!filters.showDone) return false;
    } else if (
      r.status === "FAILED"
      || r.status === "CANCELLED"
      || r.status === "TIMED_OUT"
    ) {
      if (!filters.showFailed) return false;
    }
    // v0.127.0: folder filter. "" = all; HISTORY_UNFILED = rows with no
    // folder; otherwise an exact folder-path match.
    if (filters.folderPath) {
      if (filters.folderPath === HISTORY_UNFILED) {
        if (r.folder_path) return false;
      } else if ((r.folder_path || "") !== filters.folderPath) {
        return false;
      }
    }
    // v0.127.0: tag filter. A row must carry EVERY selected tag (AND).
    if (Array.isArray(filters.selectedTags) && filters.selectedTags.length > 0) {
      const rowTags = Array.isArray(r.tags) ? r.tags : [];
      for (const t of filters.selectedTags) {
        if (!rowTags.includes(t)) return false;
      }
    }
    if (text) {
      // v0.127.0: search now also matches folder path + any tag.
      const project = (r.project || "").toLowerCase();
      const label = (r.label || "").toLowerCase();
      const folder = (r.folder_path || "").toLowerCase();
      const tags = (Array.isArray(r.tags) ? r.tags.join(" ") : "").toLowerCase();
      if (
        !project.includes(text)
        && !label.includes(text)
        && !folder.includes(text)
        && !tags.includes(text)
      ) {
        return false;
      }
    }
    return true;
  });
}

// v0.35.2: schedule the next refresh whenever the rendered list still
// contains an in-flight row. Goes idle (no timer scheduled) when every
// row has reached a terminal status, so a page left open after a long
// render does not keep hitting the DB. Re-armed on every loadHistory
// success (called from inside renderHistoryList).
function maybeScheduleHistoryRefresh(rows) {
  if (historyRefreshTimer) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
  }
  if (document.hidden) return; // page in background; do not schedule
  if (!Array.isArray(rows) || rows.length === 0) return;
  const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  const hasInFlight = rows.some((r) => TERMINAL.indexOf(r.status) < 0);
  if (!hasInFlight) return;
  historyRefreshTimer = setTimeout(loadHistory, HISTORY_AUTO_REFRESH_MS);
}

// v0.37.1: signature now takes the filtered subset AND the total count
// so the counter can read "showing 3 of 12" vs "12 renders" without
// recomputing. totalRows defaults to rows.length for callers that don't
// filter (kept for compatibility, but in v0.37.1+ the only caller is
// applyHistoryFilters which always provides both).
function renderHistoryList(rows, totalRows) {
  const section = $("#planner-history");
  const list = $("#planner-history-list");
  const counter = $("#planner-history-counter");
  list.innerHTML = "";

  if (totalRows === undefined) totalRows = rows ? rows.length : 0;

  // v0.120.0: the History step always shows its header + filters (it is a
  // first-class stepper step now, not a trailing block), so zero renders
  // renders an empty-state placeholder rather than collapsing the section.
  // Filtered-to-zero shows the same "no matches" placeholder below.
  section.hidden = false;
  if (totalRows === 0) {
    counter.textContent = "";
    const li = document.createElement("li");
    li.className = "planner-history-empty";
    li.textContent = "no renders yet; plan, bundle, and render a storyboard to see it here.";
    list.appendChild(li);
    return;
  }

  if (!rows || rows.length === 0) {
    counter.textContent = "showing 0 of " + totalRows;
    const li = document.createElement("li");
    li.className = "planner-history-empty";
    li.textContent = "no renders match the current filters";
    list.appendChild(li);
    return;
  }

  counter.textContent =
    rows.length === totalRows
      ? totalRows + " render" + (totalRows === 1 ? "" : "s")
      : "showing " + rows.length + " of " + totalRows;

  // v0.145.2: index derived animations (finalize / animate-cloud children) by
  // their parent keyframes render so a row can union its siblings. Built from
  // ALL loaded rows (not just the filtered subset) so the version count on a
  // keyframes preview stays accurate even when a filter hides some children.
  const childrenByParent = new Map();
  const all = Array.isArray(historyState.rows) ? historyState.rows : rows;
  for (const x of all) {
    if (typeof x.parent_id !== "number") continue;
    const list2 = childrenByParent.get(x.parent_id);
    if (list2) list2.push(x);
    else childrenByParent.set(x.parent_id, [x]);
  }

  // v0.162.0: collect scatter-parent numeric ids so shard children are
  // suppressed from the top-level list. Shards are shown nested (count +
  // progress) on the parent card instead of as individual cards. Only rows
  // whose job_id starts with "scatter-" are parents; non-scatter parent/child
  // rows (keyframes-from / animate) are unaffected.
  const scatterParentIds = new Set();
  for (const x of all) {
    if (typeof x.job_id === "string" && x.job_id.startsWith("scatter-")) {
      scatterParentIds.add(x.id);
    }
  }

  for (const r of rows) {
    if (typeof r.parent_id === "number" && scatterParentIds.has(r.parent_id)) {
      continue;
    }
    list.appendChild(buildHistoryRow(r, childrenByParent));
  }
}

// v0.129.0: download filename for a per-shot SDXL still. "<project>-<shot>.png".
function shotStillFilename(row, shotId) {
  const proj = (row.project || "shot").replace(/[^a-z0-9_-]+/gi, "-");
  return proj + "-" + shotId + ".png";
}

// v0.129.0: inline shot-preview lightbox. Clicking a keyframe thumb opens the
// still larger in a full-screen overlay; click the backdrop or press Escape to
// dismiss. A single overlay element is reused across rows. The download link
// inside stops propagation so it does not dismiss before the browser handles
// the download.
let _shotLightbox = null;
function ensureShotLightbox() {
  if (_shotLightbox) return _shotLightbox;
  const box = document.createElement("div");
  box.className = "planner-lightbox";
  box.hidden = true;
  box.addEventListener("click", () => { box.hidden = true; });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && _shotLightbox) _shotLightbox.hidden = true;
  });
  document.body.appendChild(box);
  _shotLightbox = box;
  return box;
}
function openShotPreview(row, kf) {
  const box = ensureShotLightbox();
  box.innerHTML = "";
  const fig = document.createElement("figure");
  fig.className = "planner-lightbox-fig";
  const img = document.createElement("img");
  img.src = "/api/artifact/" + kf.key;
  img.alt = kf.shot_id;
  img.className = "planner-lightbox-img";
  fig.appendChild(img);
  const bar = document.createElement("figcaption");
  bar.className = "planner-lightbox-bar";
  const cap = document.createElement("span");
  cap.textContent = kf.shot_id;
  bar.appendChild(cap);
  const dl = document.createElement("a");
  dl.href = "/api/artifact/" + kf.key;
  dl.download = shotStillFilename(row, kf.shot_id);
  dl.className = "planner-lightbox-dl";
  dl.textContent = "download";
  dl.addEventListener("click", (ev) => ev.stopPropagation());
  bar.appendChild(dl);
  fig.appendChild(bar);
  box.appendChild(fig);
  box.hidden = false;
}

// v0.136.4: pick an audio file, upload it, and mux it onto a finished render's
// MP4 entirely off the GPU (audio-upload -> the render's /add-audio endpoint,
// which runs the video-finish ffmpeg container). On success the history reloads
// so the row's player + download serve the version with sound.
// v0.137.2: visible inline status for the off-GPU audio/narration mux. It runs
// on a CPU container (can take 10-30s, plus cold start), so a bare button-text
// flip is too subtle. Shows a message line in the row's action area.
function setMuxStatus(btn, message, kind) {
  const actions = btn.parentNode;
  if (!actions) return null;
  let el = actions.querySelector(".planner-history-mux-status");
  if (!el) {
    el = document.createElement("span");
    actions.appendChild(el);
  }
  el.className =
    "planner-history-mux-status" + (kind ? " planner-history-mux-status-" + kind : "");
  el.textContent = message;
  el.hidden = false;
  return el;
}
function clearMuxStatus(el) {
  if (el) {
    el.hidden = true;
    el.textContent = "";
  }
}

function addAudioToRender(r, btn) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept =
    "audio/mpeg,audio/mp3,audio/wav,audio/aac,audio/mp4,audio/x-m4a,audio/ogg,.mp3,.wav,.aac,.m4a,.ogg";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const orig = btn.textContent;
    btn.disabled = true;
    let status = null;
    try {
      btn.textContent = "uploading...";
      status = setMuxStatus(btn, "Uploading audio...", "working");
      const up = await fetch("/api/storyboard/audio-upload", {
        method: "POST",
        headers: { "content-type": file.type || "audio/mpeg" },
        body: file,
      });
      const upData = await up.json().catch(() => ({}));
      if (!up.ok || !upData.key) {
        throw new Error((upData && upData.error) || "audio upload failed");
      }
      btn.textContent = "muxing...";
      setMuxStatus(btn, "Muxing audio onto the video (CPU container, ~10-30s)...", "working");
      const mux = await fetch(
        "/api/storyboard/renders/" + encodeURIComponent(r.id) + "/add-audio",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audioKey: upData.key }),
        },
      );
      const muxData = await mux.json().catch(() => ({}));
      if (!mux.ok || muxData.ok === false) {
        throw new Error((muxData && muxData.error) || "audio mux failed");
      }
      btn.textContent = "audio added ✓";
      setMuxStatus(btn, "Audio added. Refreshing the player...", "done");
      loadHistory();
    } catch (err) {
      clearMuxStatus(status);
      window.alert("add audio failed: " + (err && err.message ? err.message : err));
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  input.click();
}

// v0.137.0: speak narration text over a finished render. Synthesizes the text
// with a TTS voice and muxes it onto the video off-GPU (the render's
// /add-narration endpoint -> Workers AI TTS -> the add-audio mux). On success
// the history reloads so the row plays/downloads the narrated version.
function addNarrationToRender(r, btn) {
  const text = window.prompt("Narration to speak over this video:");
  if (text == null) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "narrating...";
  const status = setMuxStatus(
    btn,
    "Synthesizing speech and muxing it onto the video (CPU container, ~10-30s)...",
    "working",
  );
  fetch("/api/storyboard/renders/" + encodeURIComponent(r.id) + "/add-narration", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: trimmed }),
  })
    .then(async (resp) => {
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) {
        throw new Error((data && data.error) || "narration failed");
      }
      btn.textContent = "narration added ✓";
      setMuxStatus(btn, "Narration added. Refreshing the player...", "done");
      loadHistory();
    })
    .catch((err) => {
      clearMuxStatus(status);
      window.alert("narration failed: " + (err && err.message ? err.message : err));
      btn.disabled = false;
      btn.textContent = orig;
    });
}

// v0.147.0 (Phase 4a): the image-input cloud i2v catalog, hand-maintained like
// the Wan model lists. Used by the default model dropdown AND the per-shot
// override pickers in the keyframe strip. Kept in sync with the backend's
// image-input video models (longrun-params.ts).
const CLOUD_I2V_MODELS = [
  ["bytedance/seedance-2.0-fast", "Seedance 2.0 Fast"],
  ["bytedance/seedance-2.0", "Seedance 2.0"],
  ["minimax/hailuo-2.3-fast", "Hailuo 2.3 Fast"],
  ["minimax/hailuo-2.3", "Hailuo 2.3"],
  ["runwayml/gen-4.5", "Runway Gen-4.5"],
  ["alibaba/hh1-i2v", "HappyHorse 1.0 I2V"],
];

// Short display label for a cloud model id ("runwayml/gen-4.5" -> "Runway
// Gen-4.5"; falls back to the trailing path segment for anything not in the
// catalog).
function cloudModelLabel(id) {
  const hit = CLOUD_I2V_MODELS.find((p) => p[0] === id);
  return hit ? hit[1] : (id ? String(id).split("/").pop() : "");
}

// v0.154.0 (Phase 4 hybrid, slice-3 #1): badge text for an in-flight animation.
// A hybrid run writes per-lane counts (progress.gpu / progress.cloud) so the row
// reads "GPU rendering 1/2 · cloud 3/3" during the long GPU wait; a plain
// cloud-animate run (only progress.done/total) reads "animating done/total".
function hybridProgressText(prog) {
  if (!prog || typeof prog !== "object") return "submitted";
  const gpu = prog.gpu && typeof prog.gpu === "object" ? prog.gpu : null;
  const cloud = prog.cloud && typeof prog.cloud === "object" ? prog.cloud : null;
  if (gpu || cloud) {
    const parts = [];
    if (gpu && typeof gpu.total === "number" && gpu.total > 0) {
      const st = typeof gpu.status === "string" ? gpu.status : "";
      const word =
        st === "rendering" ? "rendering " : st === "queued" ? "queued " : st === "failed" ? "failed " : "";
      parts.push("GPU " + word + (gpu.done || 0) + "/" + gpu.total);
    }
    if (cloud && typeof cloud.total === "number" && cloud.total > 0) {
      parts.push("cloud " + (cloud.done || 0) + "/" + cloud.total);
    }
    if (parts.length) return parts.join(" · ");
  }
  if (typeof prog.done === "number" && typeof prog.total === "number") {
    return "animating " + prog.done + "/" + prog.total;
  }
  return "submitted";
}

// v0.145.2: short, human label for a derived animation version. GPU finalize
// rows read mode 'finalized'/'full' (Wan); cloud-animate rows read
// 'cloud-finalized' + output.model (the i2v model). Returns "" for rows that
// are not a derived animation (so callers can skip the badge).
// v0.147.0 (Phase 4a): when a cloud run mixed models across shots, read it off
// output.clips[].model and label it "cloud · mixed" rather than a single model.
function animationVersionLabel(r) {
  if (r.mode === "cloud-finalized") {
    const out = r.output && typeof r.output === "object" ? r.output : null;
    const clips = out && Array.isArray(out.clips) ? out.clips : [];
    // v0.152.0 (Phase 4 hybrid): clips carry a per-shot backend ("gpu"|"cloud").
    // A run that used BOTH is "hybrid"; an all-gpu run (edge: a hybrid where every
    // shot resolved to GPU) reads "GPU · Wan".
    const usedBackends = new Set(
      clips.map((c) => (c && typeof c.backend === "string" ? c.backend : "")).filter(Boolean),
    );
    if (usedBackends.has("gpu") && usedBackends.has("cloud")) return "hybrid";
    if (usedBackends.size === 1 && usedBackends.has("gpu")) return "GPU · Wan";
    // All-cloud run (hybrid returned above): clips carry per-shot models; more
    // than one distinct model -> "cloud · mixed".
    const distinct = Array.from(
      new Set(clips.map((c) => (c && typeof c.model === "string" ? c.model : "")).filter(Boolean)),
    );
    if (distinct.length > 1) return "cloud · mixed";
    const model =
      distinct[0] || (out && typeof out.model === "string" ? out.model : "");
    // In-flight rows have no model yet (output holds only progress), so fall
    // back to a bare "cloud" rather than "cloud · cloud".
    if (!model) return "cloud";
    return "cloud · " + model.split("/").pop();
  }
  if (r.mode === "finalized") return "GPU · Wan";
  return "";
}

// v0.145.2: expand + scroll to another history row by its D1 id (used by the
// parent<->child cross-links). No-op when the target row is not currently
// rendered (e.g. filtered out).
function focusHistoryRow(id) {
  historyState.expandedIds.add(id);
  applyHistoryFilters();
  const li = document.querySelector('.planner-history-item[data-id="' + id + '"]');
  if (li) li.scrollIntoView({ behavior: "smooth", block: "center" });
}

function buildHistoryRow(r, childrenByParent) {
  const li = document.createElement("li");
  li.className = "planner-history-item";
  li.dataset.jobId = r.job_id;
  li.dataset.id = String(r.id);

  // v0.38.1: collapse / expand state. All rows start collapsed for a
  // scannable list; clicking the meta bar toggles expand. Expanded ids
  // live in historyState.expandedIds (per-session; not persisted).
  const isExpanded = historyState.expandedIds.has(r.id);
  if (!isExpanded) li.classList.add("planner-history-item-collapsed");

  const meta = document.createElement("div");
  meta.className = "planner-history-meta";
  meta.tabIndex = 0;
  meta.setAttribute("role", "button");
  meta.setAttribute(
    "aria-expanded",
    isExpanded ? "true" : "false",
  );

  // Disclosure chevron: right when collapsed, down when expanded.
  const chevron = document.createElement("span");
  chevron.className = "planner-history-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = isExpanded ? "▼" : "▶";
  meta.appendChild(chevron);

  const project = document.createElement("strong");
  project.textContent = r.project || "(no project)";
  meta.appendChild(project);

  const tier = document.createElement("span");
  tier.className = "planner-history-tier";
  tier.textContent = r.quality_tier || "?";
  meta.appendChild(tier);

  const status = document.createElement("span");
  status.className =
    "planner-history-status planner-history-status-" + historyStatusKind(r.status);
  status.textContent = r.status;
  meta.appendChild(status);

  // v0.40.0: keyframes-only badge. Marks rows that ran the SDXL preview
  // pass with no Wan I2V or silent-MP4 assembly. The badge sits right
  // after the status so it is visible in both collapsed and expanded
  // views. row.mode is collapsed to 'full' for legacy rows in
  // renders-db.ts so the equality check is safe without a NULL guard.
  if (r.mode === "keyframes-only") {
    const modeBadge = document.createElement("span");
    modeBadge.className = "planner-history-mode planner-history-mode-keyframes-only";
    modeBadge.textContent = "kf only";
    modeBadge.title = "this render produced SDXL keyframes only; no motion / no silent MP4";
    meta.appendChild(modeBadge);
  }

  // v0.162.0: scatter parent badge + shard progress. Shard children are
  // suppressed from the top-level list in renderHistoryList; only the parent
  // card appears. childrenByParent already indexes shards by parent numeric id.
  if (typeof r.job_id === "string" && r.job_id.startsWith("scatter-")) {
    const shards = childrenByParent.get(r.id) || [];
    const nShards = shards.length;
    const scatterBadge = document.createElement("span");
    scatterBadge.className = "planner-history-mode planner-history-mode-scatter";
    scatterBadge.textContent =
      nShards ? "distributed -- " + nShards + " shards" : "distributed";
    scatterBadge.title =
      "scatter/gather distributed render" +
      (nShards ? " (" + nShards + " parallel shards)" : "");
    meta.appendChild(scatterBadge);

    if (r.status === "SCATTERING" || r.status === "IN_PROGRESS" || r.status === "IN_QUEUE") {
      const done = shards.filter((s) => s.status === "COMPLETED").length;
      if (nShards > 0) {
        const progBadge = document.createElement("span");
        progBadge.className = "planner-history-mode planner-history-mode-progress";
        progBadge.textContent = done + " of " + nShards + " shards complete";
        progBadge.title = "shard render progress";
        meta.appendChild(progBadge);
      }
    }
  }

  // v0.145.2: version badge for a derived animation (GPU finalize or cloud
  // i2v). One keyframes preview can have several of these; the label
  // disambiguates them (e.g. "cloud · gen-4.5" vs "cloud · hailuo-2.3-fast"
  // vs "GPU · Wan").
  const versionLabel = animationVersionLabel(r);
  if (versionLabel) {
    const verBadge = document.createElement("span");
    verBadge.className = "planner-history-mode planner-history-mode-version";
    verBadge.textContent = versionLabel;
    verBadge.title = "derived animation of a keyframes preview (" + versionLabel + ")";
    meta.appendChild(verBadge);
  }

  // v0.146.0: live progress for an in-flight cloud animation. The workflow
  // writes output.progress = { done, total } as each shot lands, so the row
  // shows "animating k/N" instead of a silent IN_PROGRESS for the minutes the
  // run takes. Before the first shot completes there is no progress yet, so it
  // reads "submitted".
  const inFlight =
    r.status === "IN_QUEUE" || r.status === "IN_PROGRESS" || r.status === "SUBMITTED";
  if (inFlight && r.mode === "cloud-finalized") {
    const prog =
      r.output && typeof r.output === "object" ? r.output.progress : null;
    const pBadge = document.createElement("span");
    pBadge.className = "planner-history-mode planner-history-mode-progress";
    pBadge.textContent = hybridProgressText(prog);
    // v0.154.0 (slice-3 #1): a hybrid run carries per-lane gpu/cloud counts.
    pBadge.title =
      prog && (prog.gpu || prog.cloud)
        ? "hybrid animation in progress (GPU finalize + cloud i2v)"
        : "cloud animation in progress (one clip per shot)";
    meta.appendChild(pBadge);
  }

  // v0.154.0 (slice-3 #3): a completed run that dropped some shots
  // (continue-on-error) is flagged partial; surface which shots failed.
  if (
    !inFlight &&
    r.mode === "cloud-finalized" &&
    r.output && typeof r.output === "object" && r.output.partial === true
  ) {
    const failed = Array.isArray(r.output.failed_shots) ? r.output.failed_shots : [];
    const partBadge = document.createElement("span");
    partBadge.className = "planner-history-mode planner-history-mode-partial";
    partBadge.textContent =
      failed.length ? "partial (" + failed.length + " failed)" : "partial";
    partBadge.title = failed.length
      ? "some shots failed and were skipped; the cut omits them:\n"
        + failed
          .map((f) => "  - " + (f && f.shot_id) + " [" + (f && f.backend) + "]: " + (f && f.error))
          .join("\n")
      : "some shots failed and were skipped from the assembled cut";
    meta.appendChild(partBadge);
  }

  // v0.145.2: backlink to the keyframes preview this animation derives from.
  if (typeof r.parent_id === "number") {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "planner-history-parentlink";
    back.textContent = "↳ from keyframes #" + r.parent_id;
    back.title = "show the keyframes preview this animation was made from";
    back.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      focusHistoryRow(r.parent_id);
    });
    meta.appendChild(back);
  }

  // v0.145.2: on a keyframes preview, a count of its derived animations so the
  // user can see (and jump to) every GPU/cloud version made from these frames.
  const myChildren =
    childrenByParent && typeof r.id === "number" ? childrenByParent.get(r.id) : null;
  if (Array.isArray(myChildren) && myChildren.length > 0) {
    const kids = document.createElement("span");
    kids.className = "planner-history-childlink";
    kids.textContent =
      myChildren.length + " animation" + (myChildren.length === 1 ? "" : "s");
    kids.title = myChildren
      .map((c) => (animationVersionLabel(c) || c.mode) + " (" + c.status + ")")
      .join("\n");
    kids.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // Jump to the newest child (highest id) so the user lands on the most
      // recent version; the rest are one scroll away.
      const newest = myChildren.reduce((a, b) => (b.id > a.id ? b : a));
      focusHistoryRow(newest.id);
    });
    meta.appendChild(kids);
  }

  // v0.38.1: inline label preview, shown only while the row is collapsed
  // (CSS gates this). Read-only here; the editable input below takes over
  // when the user expands the row.
  if (r.label) {
    const labelPreview = document.createElement("span");
    labelPreview.className = "planner-history-label-preview";
    labelPreview.textContent = '"' + r.label + '"';
    meta.appendChild(labelPreview);
  }

  // v0.127.0: folder chip + tag pills in the meta bar (visible collapsed and
  // expanded so the row stays scannable). Tag pills are clickable to filter by
  // that tag; stopPropagation keeps the click from toggling the row's expand.
  if (r.folder_path) {
    const folderChip = document.createElement("span");
    folderChip.className = "planner-history-folder-chip";
    folderChip.textContent = r.folder_path;
    folderChip.title = "folder: " + r.folder_path;
    meta.appendChild(folderChip);
  }
  if (Array.isArray(r.tags) && r.tags.length > 0) {
    for (const t of r.tags) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "planner-history-rowtag";
      pill.textContent = t;
      pill.title = "filter by tag: " + t;
      if (historyState.filters.selectedTags.includes(t)) pill.classList.add("is-active");
      pill.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleTagFilter(t);
      });
      meta.appendChild(pill);
    }
  }

  // Click the meta bar to toggle expand. Action buttons sit outside meta
  // so their clicks never bubble here, and the editable label input lives
  // below the meta bar so clicks there do not collapse the row.
  const toggle = () => toggleHistoryRowExpand(r.id, li);
  meta.addEventListener("click", toggle);
  meta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle();
    }
  });

  li.appendChild(meta);

  // v0.36.0: inline-editable label. Empty -> placeholder "+ label". Save
  // on blur or Enter; Escape reverts. Failures alert and restore.
  li.appendChild(buildHistoryLabelInput(r));

  // v0.127.0: folder + tags editor (shown when the row is expanded; CSS gates
  // it the same as the label input + sub line + actions).
  li.appendChild(buildHistoryOrganizeRow(r));

  const sub = document.createElement("div");
  sub.className = "planner-history-sub";
  const parts = [];
  if (r.submitted_at) parts.push("submitted " + formatRelative(r.submitted_at));
  if (r.completed_at) parts.push("finished " + formatRelative(r.completed_at));
  if (r.execution_time_ms) parts.push("ran " + formatDuration(r.execution_time_ms));
  sub.textContent = parts.join(" · ");
  li.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "planner-history-actions";

  const view = document.createElement("button");
  view.type = "button";
  view.className = "planner-history-action";
  view.textContent = "view";
  view.addEventListener("click", () => resumeRender(r));
  actions.appendChild(view);

  if (r.output_key) {
    const dl = document.createElement("a");
    dl.href = "/api/artifact/" + r.output_key;
    dl.download = (r.project || "silent") + ".mp4";
    dl.className = "planner-history-action";
    dl.textContent = "download";
    actions.appendChild(dl);
  }

  // v0.141.0: per-render log, written to R2 on resolve at a conventional key
  // (renders/logs/<job_id>.txt). Available once the render is terminal; opens
  // the text log via /api/artifact (ownership-gated; the browser carries the
  // Access cookie).
  if (r.job_id && r.completed_at) {
    const logs = document.createElement("a");
    logs.href = "/api/artifact/renders/logs/" + encodeURIComponent(r.job_id) + ".txt";
    logs.target = "_blank";
    logs.rel = "noopener";
    logs.className = "planner-history-action";
    logs.textContent = "logs";
    logs.title = "view this render's log (status, timing, diagnostics)";
    actions.appendChild(logs);
  }

  // v0.136.4: add audio to a finished video WITHOUT the GPU. Picks an audio
  // file, uploads it, and muxes it onto this render's MP4 via the video-finish
  // (ffmpeg) container. The row then points at the muxed version.
  if (r.status === "COMPLETED" && r.output_key) {
    const addAudio = document.createElement("button");
    addAudio.type = "button";
    addAudio.className = "planner-history-action";
    addAudio.textContent = "add audio";
    addAudio.title = "mux an audio file onto this finished video (CPU container, no GPU)";
    addAudio.addEventListener("click", () => addAudioToRender(r, addAudio));
    actions.appendChild(addAudio);

    // v0.137.0: spoken narration (TTS) over the finished video, off-GPU.
    const narrate = document.createElement("button");
    narrate.type = "button";
    narrate.className = "planner-history-action";
    narrate.textContent = "narrate";
    narrate.title = "speak narration text over this finished video (TTS, no GPU, no re-render)";
    narrate.addEventListener("click", () => addNarrationToRender(r, narrate));
    actions.appendChild(narrate);
  }

  // v0.35.1: "re-render" with the same bundle. Skips plan + bundle stages.
  const rerun = document.createElement("button");
  rerun.type = "button";
  rerun.className = "planner-history-action";
  rerun.textContent = "re-render";
  rerun.title = "render this bundle again (skips plan + bundle stages)";
  rerun.addEventListener("click", () => rerunBundle(r));
  actions.appendChild(rerun);

  // v0.60.0: one-click retry on terminal-failure rows. Re-POSTs the
  // same args server-side (project, bundle_key, quality_tier,
  // render_overrides, mode); the GPU side resumes incrementally off
  // the network volume so this is much cheaper than the original
  // submit. Finalize rows have their own retry path (click finalize
  // on the parent preview) and are excluded.
  const isFailed =
    r.status === "FAILED" || r.status === "CANCELLED" || r.status === "TIMED_OUT";
  if (isFailed && r.mode !== "finalized") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "planner-history-action";
    retry.textContent = "retry";
    retry.title = "resubmit this render as-is (the GPU resumes off the volume so it picks up where it died)";
    retry.addEventListener("click", () => retryFailedRender(r, retry));
    actions.appendChild(retry);
  }

  // v0.35.4: delete the row from history (and the silent MP4 from R2 when
  // no other row references it). Confirmation prompt before any destructive
  // request leaves the page.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "planner-history-action planner-history-action-delete";
  del.textContent = "delete";
  del.title = "remove this row from history and (if not shared) the silent MP4 from R2";
  del.addEventListener("click", () => deleteHistoryRow(r));
  actions.appendChild(del);

  li.appendChild(actions);

  // v0.129.0: inline movie player, full card width, directly below the action
  // buttons (view / re-render / delete). Completed rows that produced a silent
  // MP4 get an HTML5 <video controls>; preload="metadata" so opening a row does
  // not auto-pull the whole file (the fetch starts on play). Gated by the
  // -collapsed class so a collapsed row stays one line.
  if (r.status === "COMPLETED" && r.output_key) {
    const playerWrap = document.createElement("div");
    playerWrap.className = "planner-history-player";
    const video = document.createElement("video");
    video.src = "/api/artifact/" + r.output_key;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.className = "planner-history-player-video";
    playerWrap.appendChild(video);
    li.appendChild(playerWrap);
  }

  // v0.39.0: SDXL keyframe thumbnails. Hidden when the row is collapsed
  // (CSS gates .planner-history-keyframes the same way it gates sub /
  // actions). Each thumb is an <img loading="lazy"> served by the
  // existing /api/artifact ownership-checked route; the GPU side stamps
  // each keyframe upload with the submitter's user_email so the route
  // authorizes the user back to their own thumbs.
  // v0.41.0: each thumbnail also gets a `regen` button that submits a
  // single-shot SDXL regeneration to the GPU. The button is gated on
  // (a) the originating row being COMPLETED (no point regening an in-
  // flight render's keyframes) and (b) the row having a bundle_key
  // (preserved on every row at submit time). Re-render survival is
  // handled by reading historyState.regenJobs in buildHistoryRow: an
  // already-in-flight regen leaves the button disabled + labeled
  // "regen..." after the row re-builds on the 30s auto-refresh.
  if (Array.isArray(r.keyframes) && r.keyframes.length > 0) {
    const strip = document.createElement("div");
    strip.className = "planner-history-keyframes";
    const regenEligible = r.status === "COMPLETED" && r.bundle_key;
    // v0.145.2: union the per-shot rendered clip onto its keyframe. A derived
    // animation row (finalize / animate-cloud) stores output.clips as
    // [{ shot_id, key }] (one motion mp4 per shot); index by shot_id so each
    // still can show the clip it produced. Empty for keyframes-only previews.
    const clipByShot = new Map();
    const outClips =
      r.output && typeof r.output === "object" && Array.isArray(r.output.clips)
        ? r.output.clips
        : [];
    for (const c of outClips) {
      if (c && typeof c.shot_id === "string" && typeof c.key === "string") {
        clipByShot.set(c.shot_id, {
          key: c.key,
          model: typeof c.model === "string" ? c.model : "",
        });
      }
    }
    // v0.147.0 (Phase 4a): per-shot model picker is offered on a keyframes-only
    // preview (the row that carries the Cloud animate button); hidden until Cloud
    // is selected. Not shown on derived-animation rows (those already ran).
    const offerPerShotModel = r.mode === "keyframes-only" && r.status === "COMPLETED";
    for (const kf of r.keyframes) {
      if (!kf || typeof kf.key !== "string" || typeof kf.shot_id !== "string") continue;
      const wrap = document.createElement("div");
      wrap.className = "planner-history-keyframe-wrap";
      // v0.129.0: click a thumb to preview the shot still larger in an inline
      // lightbox (was: open the raw artifact in a new tab). The href is kept so
      // right-click / middle-click still works.
      const a = document.createElement("a");
      a.href = "/api/artifact/" + kf.key;
      a.rel = "noopener";
      a.className = "planner-history-keyframe";
      a.title = "preview " + kf.shot_id;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openShotPreview(r, kf);
      });
      const img = document.createElement("img");
      img.src = "/api/artifact/" + kf.key;
      img.alt = kf.shot_id;
      img.loading = "lazy";
      img.dataset.shotId = kf.shot_id;
      img.className = "planner-history-keyframe-img";
      a.appendChild(img);
      const cap = document.createElement("span");
      cap.className = "planner-history-keyframe-cap";
      cap.textContent = kf.shot_id;
      a.appendChild(cap);
      wrap.appendChild(a);

      // v0.145.2: the motion clip rendered FROM this keyframe, shown directly
      // under the still so the keyframe and its animation read as one unit.
      // Only present on derived-animation rows; preload="metadata" so opening a
      // row does not pull every shot's bytes (the fetch starts on play).
      const clipRef = clipByShot.get(kf.shot_id);
      if (clipRef) {
        const clip = document.createElement("video");
        clip.src = "/api/artifact/" + clipRef.key;
        clip.controls = true;
        clip.preload = "metadata";
        clip.playsInline = true;
        clip.className = "planner-history-keyframe-clip";
        clip.title = "motion clip for " + kf.shot_id
          + (clipRef.model ? " (" + cloudModelLabel(clipRef.model) + ")" : "");
        wrap.appendChild(clip);
        // v0.147.0 (Phase 4a): label the clip with the model that produced it,
        // so a mixed-model run is legible per shot.
        if (clipRef.model) {
          const ml = document.createElement("span");
          ml.className = "planner-history-keyframe-model";
          ml.textContent = cloudModelLabel(clipRef.model);
          wrap.appendChild(ml);
        }
      }

      // v0.147.0 (Phase 4a): per-shot cloud-model override. "(default)" leaves
      // the shot on the row's default model; any other choice overrides just
      // this shot. Hidden until the Cloud backend is selected (toggled by the
      // Motion select's change handler via the .planner-keyframe-cloud-model
      // class). data-shot-id lets the submit handler collect the map.
      if (offerPerShotModel) {
        const modelSel = document.createElement("select");
        modelSel.className = "planner-keyframe-cloud-model";
        modelSel.dataset.shotId = kf.shot_id;
        modelSel.title = "cloud i2v model for " + kf.shot_id + " (default uses the row model)";
        modelSel.style.display = "none";
        const def = document.createElement("option");
        def.value = "";
        def.textContent = "(default)";
        modelSel.appendChild(def);
        // v0.152.0 (Phase 4 hybrid): a "GPU (Wan)" option, revealed only in Hybrid
        // mode (hidden in Cloud mode, where this picker is cloud-models-only). In
        // Hybrid, an unset shot defaults to GPU; pick a cloud model to send it
        // there instead.
        const gpuOpt = document.createElement("option");
        gpuOpt.value = "gpu";
        gpuOpt.textContent = "GPU (Wan)";
        gpuOpt.hidden = true;
        modelSel.appendChild(gpuOpt);
        CLOUD_I2V_MODELS.forEach((pair) => {
          const o = document.createElement("option");
          o.value = pair[0];
          o.textContent = pair[1];
          modelSel.appendChild(o);
        });
        modelSel.addEventListener("click", (ev) => ev.stopPropagation());
        wrap.appendChild(modelSel);
      }

      // v0.129.0: per-shot still download (PNG). Available on every keyframe,
      // independent of the regen / lock controls below.
      const dlShot = document.createElement("a");
      dlShot.href = "/api/artifact/" + kf.key;
      dlShot.download = shotStillFilename(r, kf.shot_id);
      dlShot.className = "planner-history-keyframe-dl";
      dlShot.textContent = "download";
      dlShot.title = "download this shot still (PNG)";
      dlShot.addEventListener("click", (ev) => ev.stopPropagation());
      wrap.appendChild(dlShot);

      if (regenEligible) {
        const regenKey = String(r.id) + ":" + kf.shot_id;
        const active = historyState.regenJobs.get(regenKey);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "planner-history-keyframe-regen";
        btn.dataset.shotId = kf.shot_id;
        btn.title = "regenerate this keyframe (SDXL only; about 30-60s)";
        if (active) {
          btn.disabled = true;
          btn.textContent = "regen...";
        } else {
          btn.textContent = "regen";
        }
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          regenShot(r, kf, btn, img);
        });
        wrap.appendChild(btn);

        // v0.42.0: lock pin. Toggles whether this shot is in r.locked_shots
        // (the user's "approved" set). Click PATCHes the row; the new
        // set is reflected immediately in the row's local data + the UI.
        // Locked shots are surfaced to the user as a count next to the
        // finalize button; v0.42.0 does NOT gate finalize on lock state
        // (the GPU runs I2V over every shot regardless).
        const lockedSet = new Set(Array.isArray(r.locked_shots) ? r.locked_shots : []);
        const lockBtn = document.createElement("button");
        lockBtn.type = "button";
        lockBtn.className = "planner-history-keyframe-lock";
        lockBtn.dataset.shotId = kf.shot_id;
        const isLocked = lockedSet.has(kf.shot_id);
        if (isLocked) lockBtn.classList.add("planner-history-keyframe-lock-on");
        lockBtn.textContent = isLocked ? "locked" : "lock";
        lockBtn.title = isLocked
          ? "click to remove this shot from the approved set"
          : "mark this shot as approved (informational; does not gate finalize)";
        lockBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          toggleShotLock(r, kf.shot_id, lockBtn);
        });
        wrap.appendChild(lockBtn);
      }

      strip.appendChild(wrap);
    }
    if (strip.children.length > 0) li.appendChild(strip);
  }

  // v0.42.0: finalize button. Shown only on completed keyframes-only
  // previews. Submits a finalize render (Wan I2V + assemble) using the
  // same bundle the preview used; the result lands as a NEW history
  // row, the preview row stays.
  if (
    r.mode === "keyframes-only"
    && r.status === "COMPLETED"
    && r.bundle_key
    && Array.isArray(r.keyframes)
    && r.keyframes.length > 0
  ) {
    const finalizeRow = document.createElement("div");
    finalizeRow.className = "planner-history-finalize-row";
    const lockedCount = Array.isArray(r.locked_shots) ? r.locked_shots.length : 0;
    const summary = document.createElement("span");
    summary.className = "planner-history-finalize-summary";
    summary.textContent = lockedCount > 0
      ? lockedCount + " of " + r.keyframes.length + " shots locked (finalize will assemble these only)"
      : r.keyframes.length + " keyframes ready; lock the shots you want in the movie, or finalize as-is to include all";
    finalizeRow.appendChild(summary);

    // v0.145.0: motion backend selector. The keyframes can be animated two ways:
    // GPU (the pod's Wan 2.2 I2V, via finalize) or CLOUD (a per-shot cloud
    // image-to-video model, via animate-cloud). The cloud model dropdown only
    // shows when Cloud is picked. Cloud models are the image-input video catalog
    // (v0.143.0); kept in sync by hand here, like the Wan model option lists.
    const GPU_LABEL = "finalize (Wan I2V + assemble)";
    const CLOUD_LABEL = "animate (cloud i2v)";
    const HYBRID_LABEL = "animate (hybrid)";
    const GPU_TITLE = "run Wan I2V on every keyframe + assemble silent MP4 (about 20 to 30 minutes)";
    const CLOUD_TITLE = "animate each keyframe with the selected cloud model + assemble a silent MP4 (no GPU pod; add a score after with add-audio)";
    const HYBRID_TITLE = "animate per-shot across BOTH backends (GPU Wan + cloud i2v) and assemble one silent MP4; set each shot's backend below (unset = GPU)";

    const motion = document.createElement("div");
    motion.className = "planner-motion-backend";

    const backendSel = document.createElement("select");
    backendSel.className = "planner-motion-backend-select";
    backendSel.title = "how to animate these keyframes into motion";
    [
      ["gpu", "GPU (Wan I2V)"],
      ["cloud", "Cloud (per-shot i2v)"],
      ["hybrid", "Hybrid (per-shot GPU/Cloud)"],
    ].forEach((pair) => {
      const o = document.createElement("option");
      o.value = pair[0];
      o.textContent = pair[1];
      backendSel.appendChild(o);
    });

    const cloudModelSel = document.createElement("select");
    cloudModelSel.className = "planner-motion-model-select";
    cloudModelSel.title = "default cloud image-to-video model (per-shot overrides below)";
    cloudModelSel.style.display = "none";
    CLOUD_I2V_MODELS.forEach((pair) => {
      const o = document.createElement("option");
      o.value = pair[0];
      o.textContent = pair[1];
      cloudModelSel.appendChild(o);
    });

    const finalizeBtn = document.createElement("button");
    finalizeBtn.type = "button";
    finalizeBtn.className = "planner-history-finalize-btn";
    finalizeBtn.textContent = GPU_LABEL;
    finalizeBtn.title = GPU_TITLE;

    backendSel.addEventListener("change", () => {
      const mode = backendSel.value; // "gpu" | "cloud" | "hybrid"
      const showPicker = mode === "cloud" || mode === "hybrid";
      cloudModelSel.style.display = mode === "cloud" ? "" : "none";
      finalizeBtn.textContent =
        mode === "cloud" ? CLOUD_LABEL : mode === "hybrid" ? HYBRID_LABEL : GPU_LABEL;
      finalizeBtn.title =
        mode === "cloud" ? CLOUD_TITLE : mode === "hybrid" ? HYBRID_TITLE : GPU_TITLE;
      // v0.147.0 (Phase 4a) / v0.152.0 (hybrid): reveal the per-shot pickers for
      // Cloud or Hybrid. The "GPU (Wan)" per-shot option shows only in Hybrid; a
      // stale "gpu" pick is reset when switching to Cloud (cloud can't do GPU).
      li.querySelectorAll(".planner-keyframe-cloud-model").forEach((sel) => {
        sel.style.display = showPicker ? "" : "none";
        const gpuOpt = sel.querySelector('option[value="gpu"]');
        if (gpuOpt) gpuOpt.hidden = mode !== "hybrid";
        if (mode === "cloud" && sel.value === "gpu") sel.value = "";
      });
    });

    finalizeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const mode = backendSel.value;
      if (mode === "cloud") {
        // v0.147.0 (Phase 4a): gather per-shot model overrides ({ shot_id: modelId }).
        const perShot = {};
        li.querySelectorAll(".planner-keyframe-cloud-model").forEach((sel) => {
          if (sel.value && sel.value !== "gpu" && sel.dataset.shotId) {
            perShot[sel.dataset.shotId] = sel.value;
          }
        });
        animateCloudRender(r, finalizeBtn, cloudModelSel.value, perShot);
      } else if (mode === "hybrid") {
        // v0.152.0 (Phase 4 hybrid): build the per-shot backend map. A cloud-model
        // value -> { backend:"cloud", model }; "gpu" -> { backend:"gpu" }; an unset
        // picker ("") falls through to defaultBackend ("gpu") on the server.
        const backends = {};
        li.querySelectorAll(".planner-keyframe-cloud-model").forEach((sel) => {
          const sid = sel.dataset.shotId;
          if (!sid) return;
          if (sel.value === "gpu") backends[sid] = { backend: "gpu" };
          else if (sel.value) backends[sid] = { backend: "cloud", model: sel.value };
        });
        animateHybridRender(r, finalizeBtn, backends);
      } else {
        finalizeRender(r, finalizeBtn);
      }
    });

    motion.appendChild(backendSel);
    motion.appendChild(cloudModelSel);
    finalizeRow.appendChild(motion);
    finalizeRow.appendChild(finalizeBtn);
    li.appendChild(finalizeRow);
  }

  return li;
}

// v0.41.0: submit a single-shot SDXL regen + start polling. The button
// and img refs are passed in for the immediate UI flip (disabled +
// "submitting..."); subsequent polls re-query the DOM each tick so
// they survive a parent row re-render on the 30s auto-refresh.
async function regenShot(row, kf, btnEl, imgEl) {
  const confirmMsg =
    "regen keyframe for " + kf.shot_id + "?\n\n"
    + "this runs SDXL only (no motion, no assembly) and overwrites the "
    + "thumbnail above. takes about 30 to 60 seconds.";
  if (!window.confirm(confirmMsg)) return;

  const regenKey = String(row.id) + ":" + kf.shot_id;
  btnEl.disabled = true;
  btnEl.textContent = "submitting...";

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id) + "/regen-shot",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotId: kf.shot_id }),
      },
    );
    data = await resp.json();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "regen";
    window.alert("regen submit failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    btnEl.disabled = false;
    btnEl.textContent = "regen";
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("regen submit failed: " + msg);
    return;
  }

  // Submitted. Park the state in regenJobs and start polling.
  btnEl.textContent = "regen...";
  imgEl.classList.add("planner-history-keyframe-img-regen-pending");
  historyState.regenJobs.set(regenKey, {
    jobId: data.jobId,
    kfKey: kf.key,
    shotId: kf.shot_id,
    rowId: row.id,
    startedAt: Date.now(),
  });
  // v0.41.1: snapshot the new entry to localStorage immediately so a
  // page refresh between here and the poll's terminal tick resumes
  // polling instead of stranding the regen.
  savePersistedState();
  pollRegenJob(regenKey);
}

// v0.41.0: poll one regen job. Re-queries the DOM each tick so a row
// re-render on auto-refresh does not strand us with detached refs.
// Reuses the existing /api/storyboard/render/<jobId> route (no new
// poll endpoint; the GPU job is just another RunPod job from the
// platform's perspective).
function pollRegenJob(regenKey) {
  const state = historyState.regenJobs.get(regenKey);
  if (!state) return;
  fetch("/api/storyboard/render/" + encodeURIComponent(state.jobId))
    .then((r) => r.json())
    .then((data) => {
      const status = (data && data.status) || "IN_QUEUE";
      const terminal = (
        status === "COMPLETED"
          || status === "FAILED"
          || status === "CANCELLED"
          || status === "TIMED_OUT"
      );
      if (!terminal) {
        setTimeout(() => pollRegenJob(regenKey), 4000);
        return;
      }
      // Locate the current DOM nodes for this row + shot. The row may
      // have been re-rendered since the regen was submitted (auto-
      // refresh on a 30s timer), so the original refs would be stale.
      const li = document.querySelector(
        '.planner-history-item[data-id="' + state.rowId + '"]',
      );
      const img = li && li.querySelector(
        '.planner-history-keyframe-img[data-shot-id="' + cssEscape(state.shotId) + '"]',
      );
      const btn = li && li.querySelector(
        '.planner-history-keyframe-regen[data-shot-id="' + cssEscape(state.shotId) + '"]',
      );
      historyState.regenJobs.delete(regenKey);
      // v0.41.1: clear the stashed entry on terminal status so a
      // subsequent reload does not try to re-poll a finished job.
      savePersistedState();
      if (status === "COMPLETED") {
        if (img) {
          img.src = "/api/artifact/" + state.kfKey + "?v=" + Date.now();
          img.classList.remove("planner-history-keyframe-img-regen-pending");
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = "regen";
        }
        return;
      }
      // Terminal but not COMPLETED.
      if (img) img.classList.remove("planner-history-keyframe-img-regen-pending");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "regen";
      }
      window.alert(
        "regen " + status.toLowerCase() + " for " + state.shotId + ": "
          + ((data && data.error) || "(no error message)"),
      );
    })
    .catch((err) => {
      console.warn("regen poll failed:", err);
      setTimeout(() => pollRegenJob(regenKey), 4000);
    });
}

// Build the namespaced render_overrides { keyframe, i2v, lora } the clean-room
// backend reads (config.py RenderConfig.from_request) from the render-step
// controls. Every key traces to a config.py field; controls without a home were
// removed in the v0.158.0 namespaced-overrides rework. The raw-JSON textarea is
// the power-user escape hatch -- it must itself be namespaced and deep-merges per
// section (textarea wins). Throws on a malformed size / textarea so the caller
// keeps its mid-flow status + focus contract.
function buildRenderOverrides(inp) {
  inp = inp || {};
  const num = (t) => {
    const x = (t || "").trim();
    if (!x) return undefined;
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  };
  const intIn = (t, lo, hi) => {
    const n = num(t);
    return n !== undefined && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
  };
  const floatIn = (t, lo, hi) => {
    const n = num(t);
    return n !== undefined && n >= lo && n <= hi ? n : undefined;
  };
  const str = (t, max) => {
    const x = (t || "").trim();
    return x && x.length <= max ? x : undefined;
  };

  // --- keyframe (SDXL keyframe stage) ---
  const keyframe = {};
  const seed = intIn(inp.seedText, 0, 2 ** 31 - 1);
  if (seed !== undefined) keyframe.seed = seed;
  if (typeof inp.keyframeSdxlSize === "string" && inp.keyframeSdxlSize.trim().length > 0) {
    const m = inp.keyframeSdxlSize.trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
    if (!m) throw new Error("keyframe size must be 'WxH' (e.g. 1216x832)");
    keyframe.resolution = m[1] + "x" + m[2];
  }
  const kfModel = str(inp.keyframeModelId, 256);
  if (kfModel) keyframe.base_model = kfModel;
  const kfg = floatIn(inp.keyframeGuidanceText, 0, 30);
  if (kfg !== undefined) keyframe.guidance_scale = kfg;
  const kfs = intIn(inp.keyframeStepsText, 1, 128);
  if (kfs !== undefined) keyframe.steps = kfs;
  if (inp.identityMethod === "ip_adapter" || inp.identityMethod === "instantid" || inp.identityMethod === "both") {
    keyframe.identity_method = inp.identityMethod;
  }
  const ips = floatIn(inp.ipScaleText, 0, 1);
  if (ips !== undefined) keyframe.ip_adapter_scale = ips;
  const iidCn = floatIn(inp.iidCnScaleText, 0, 1.5);
  if (iidCn !== undefined) keyframe.instantid_controlnet_scale = iidCn;
  const iidIp = floatIn(inp.iidIpScaleText, 0, 1.5);
  if (iidIp !== undefined) keyframe.instantid_ip_adapter_scale = iidIp;

  // keyframe.multi_char (regional multi-character anti-bleed)
  const mc = {};
  if (inp.mcEngine === "regional") mc.regional = true;
  else if (inp.mcEngine === "composite_legacy") mc.regional = false;
  if (inp.mcPose === "true") mc.pose_conditioning = true;
  else if (inp.mcPose === "false") mc.pose_conditioning = false;
  const mcLs = floatIn(inp.mcLoraScaleText, 0, 2);
  if (mcLs !== undefined) mc.lora_scale_per_slot = mcLs;
  const mcIp = floatIn(inp.mcIpScaleText, 0, 1);
  if (mcIp !== undefined) mc.ip_adapter_scale_per_slot = mcIp;
  const mcMax = intIn(inp.mcMaxSlotsText, 1, 4);
  if (mcMax !== undefined) mc.max_slots = mcMax;
  const mcCn = floatIn(inp.mcCnScaleText, 0, 1.5);
  if (mcCn !== undefined) mc.controlnet_pose_scale = mcCn;
  if (Object.keys(mc).length > 0) keyframe.multi_char = mc;

  // --- i2v (Wan image-to-video) ---
  const i2v = {};
  const i2vModel = str(inp.i2vModelId, 256);
  if (i2vModel) i2v.model = i2vModel;
  const nf = intIn(inp.numFramesText, 1, 256);
  if (nf !== undefined) i2v.num_frames = nf;
  const ist = intIn(inp.i2vStepsText, 1, 64);
  if (ist !== undefined) i2v.steps = ist;
  const ig = floatIn(inp.i2vGuidanceText, 0, 30);
  if (ig !== undefined) i2v.guidance_scale = ig;
  const fps = intIn(inp.fpsText, 1, 120);
  if (fps !== undefined) i2v.fps = fps;
  const fsh = floatIn(inp.flowShiftText, 0, 20);
  if (fsh !== undefined) i2v.flow_shift = fsh;

  // --- lora (character LoRA training) ---
  const lora = {};
  const lr = intIn(inp.loraRankText, 1, 128);
  if (lr !== undefined) lora.rank = lr;
  const lms = intIn(inp.loraStepsText, 1, 5000);
  if (lms !== undefined) lora.max_steps = lms;
  const llr = floatIn(inp.loraLrText, 1e-6, 1e-2);
  if (llr !== undefined) lora.learning_rate = llr;
  const lres = intIn(inp.loraResolutionText, 512, 1536);
  if (lres !== undefined) lora.resolution = lres;

  const out = {};
  if (Object.keys(keyframe).length > 0) out.keyframe = keyframe;
  if (Object.keys(i2v).length > 0) out.i2v = i2v;
  if (Object.keys(lora).length > 0) out.lora = lora;

  // Power-user escape hatch: raw namespaced JSON, restricted to the in-spec
  // sections + routing flags and deep-merged per section (textarea wins). A
  // stray flat key the user types is dropped here, so the planner never emits
  // anything outside the { keyframe, i2v, lora } + flags contract.
  if (typeof inp.textareaText === "string" && inp.textareaText.trim().length > 0) {
    let parsed;
    try {
      parsed = JSON.parse(inp.textareaText.trim());
    } catch (err) {
      throw new Error("raw JSON textarea is invalid: " + err.message);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error('raw JSON textarea must be a JSON object, e.g. {"keyframe": {"seed": 7}}');
    }
    for (const k of ["keyframe", "i2v", "lora"]) {
      const v = parsed[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = (out[k] && typeof out[k] === "object" && !Array.isArray(out[k]))
          ? Object.assign({}, out[k], v)
          : v;
      }
    }
    for (const k of ["keyframes_only", "finish_offloaded"]) {
      if (typeof parsed[k] === "boolean") out[k] = parsed[k];
    }
  }

  return out;
}

// v0.42.0: toggle a single shot's lock state on a row. Optimistic:
// mutates row.locked_shots locally so the next buildHistoryRow shows
// the new state before the PATCH round-trip lands; on PATCH failure
// the toggle is reverted + the button reset. The row's data lives in
// historyState.rows so subsequent renders see the mutation.
async function toggleShotLock(row, shotId, btnEl) {
  const current = new Set(Array.isArray(row.locked_shots) ? row.locked_shots : []);
  const willLock = !current.has(shotId);
  if (willLock) current.add(shotId);
  else current.delete(shotId);
  const next = Array.from(current);
  // Optimistic UI flip first.
  row.locked_shots = next;
  if (willLock) {
    btnEl.classList.add("planner-history-keyframe-lock-on");
    btnEl.textContent = "locked";
  } else {
    btnEl.classList.remove("planner-history-keyframe-lock-on");
    btnEl.textContent = "lock";
  }
  btnEl.disabled = true;
  // PATCH the renders row with the new locked_shots set.
  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockedShots: next }),
      },
    );
    data = await resp.json();
  } catch (err) {
    // Revert.
    if (willLock) current.delete(shotId);
    else current.add(shotId);
    row.locked_shots = Array.from(current);
    btnEl.classList.toggle("planner-history-keyframe-lock-on", current.has(shotId));
    btnEl.textContent = current.has(shotId) ? "locked" : "lock";
    btnEl.disabled = false;
    window.alert("lock toggle failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    if (willLock) current.delete(shotId);
    else current.add(shotId);
    row.locked_shots = Array.from(current);
    btnEl.classList.toggle("planner-history-keyframe-lock-on", current.has(shotId));
    btnEl.textContent = current.has(shotId) ? "locked" : "lock";
    btnEl.disabled = false;
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("lock toggle failed: " + msg);
    return;
  }
  // Authoritative locked_shots back from the Worker; mirror onto the
  // local row data so subsequent UI logic uses the canonical value.
  if (Array.isArray(data.lockedShots)) {
    row.locked_shots = data.lockedShots;
  }
  btnEl.disabled = false;
  // Refresh the parent row's finalize-row summary if present so the
  // "N of M shots locked" text reflects the new count without waiting
  // for the next auto-refresh.
  const li = btnEl.closest(".planner-history-item");
  if (li) {
    const summary = li.querySelector(".planner-history-finalize-summary");
    if (summary && Array.isArray(row.keyframes)) {
      const lockedCount = Array.isArray(row.locked_shots) ? row.locked_shots.length : 0;
      summary.textContent = lockedCount > 0
        ? lockedCount + " of " + row.keyframes.length + " shots locked (finalize will assemble these only)"
        : row.keyframes.length + " keyframes ready; lock the shots you want in the movie, or finalize as-is to include all";
    }
  }
}

// v0.42.0: submit a finalize render from a completed keyframes-only
// preview. Asks for confirmation since the operation is long (20 to
// 30 min on final tier), then POSTs to the renders/{id}/finalize
// route. On success a fresh history row is reloaded so the user sees
// the in-flight finalize next to the preview it came from.
async function finalizeRender(row, btnEl) {
  const lockedCount = Array.isArray(row.locked_shots) ? row.locked_shots.length : 0;
  const kfCount = Array.isArray(row.keyframes) ? row.keyframes.length : 0;
  // v0.45.0: lock state actually gates which shots make it into the
  // silent MP4. When lockedCount > 0, the GPU restricts I2V + assembly
  // to those shot_ids only; when 0, the GPU runs the full all-scenes
  // flow. Confirm dialog reflects the actual behavior so the user
  // does not end up with a 1-shot movie because they locked one shot
  // by accident.
  const processedCount = lockedCount > 0 ? lockedCount : kfCount;
  const minMinutes = Math.max(5, Math.round(processedCount * 4));
  const maxMinutes = Math.max(10, Math.round(processedCount * 6));
  const confirmMsg =
    "finalize this preview?\n\n"
    + (lockedCount > 0
      ? "this will assemble the silent MP4 from " + lockedCount + " of "
        + kfCount + " keyframes (only the LOCKED shots). "
      : "no shots are locked, so all " + kfCount
        + " keyframes will be included. ")
    + "Wan I2V + assembly takes roughly " + minMinutes + " to "
    + maxMinutes + " minutes on the final tier.\n\n"
    + (lockedCount > 0 && lockedCount < kfCount
      ? "the unlocked shots (" + (kfCount - lockedCount)
        + ") will NOT appear in the final movie. continue?"
      : "continue?");
  if (!window.confirm(confirmMsg)) return;

  btnEl.disabled = true;
  btnEl.textContent = "submitting...";

  let resp = null;
  let data = null;
  try {
    // v0.52.0: forward the planner's current audio bed key. The Worker
    // accepts the body defensively (no body == no audio mux, same as
    // pre-v0.52 finalizes). When set, the audio_key reaches
    // vivijure-serverless 0.4.11+ which downloads + muxes via
    // export_film(with_audio=True).
    // v0.58.0: also forward castLoras for the same pretrained-LoRA reuse
    // as the render-submit body. Same ownership-scoped resolution on
    // the Worker side.
    const finalizeBody = {};
    if (planState.audioKey) finalizeBody.audioKey = planState.audioKey;
    // v0.135.6: server gates readiness against fresh D1 state (see submitRender).
    const finalizeCastLoras = buildCastLoraSubmit();
    if (Object.keys(finalizeCastLoras).length > 0) {
      finalizeBody.castLoras = finalizeCastLoras;
    }
    // Finalize reuses the render_overrides persisted on the originating row
    // (the backend reads row.render_overrides); no per-finalize override body.
    const hasBody = Object.keys(finalizeBody).length > 0;
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id) + "/finalize",
      hasBody
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(finalizeBody) }
        : { method: "POST" },
    );
    data = await resp.json();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "finalize (Wan I2V + assemble)";
    window.alert("finalize submit failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    btnEl.disabled = false;
    btnEl.textContent = "finalize (Wan I2V + assemble)";
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("finalize submit failed: " + msg);
    return;
  }
  btnEl.textContent = "finalize submitted";
  // Reload the history list so the new in-flight row appears alongside
  // the preview it came from. loadHistory hydrates rows from the
  // server; the auto-refresh handles further polling.
  loadHistory();
}

// v0.145.0: cloud motion backend. Animate the preview's keyframes via a cloud
// image-to-video model (POST .../animate-cloud), the control-plane alternative
// to the GPU finalize (Wan). Output is silent by design; add a score afterward
// with the add-audio action. Mirrors finalizeRender's submit + error + reload
// flow; the new cloud-<uuid> row is polled by the history auto-refresh (the
// render-poll cloud short-circuit serves it).
async function animateCloudRender(row, btnEl, model, perShot) {
  const kfCount = Array.isArray(row.keyframes) ? row.keyframes.length : 0;
  // v0.147.0 (Phase 4a): summarize any per-shot model overrides in the confirm.
  const overrides = perShot && typeof perShot === "object" ? perShot : {};
  const overrideCount = Object.keys(overrides).length;
  const overrideLine = overrideCount > 0
    ? "\n" + overrideCount + " shot" + (overrideCount === 1 ? "" : "s")
      + " overridden: "
      + Object.entries(overrides)
        .map(([s, m]) => s + " -> " + cloudModelLabel(m))
        .join(", ")
    : "";
  const confirmMsg =
    "animate this preview on the cloud?\n\n"
    + "this animates all " + kfCount + " keyframes with " + cloudModelLabel(model)
    + " (one clip per shot) and assembles a SILENT MP4. No GPU pod is used; "
    + "add a soundtrack afterward with the add-audio action." + overrideLine
    + "\n\ncontinue?";
  if (!window.confirm(confirmMsg)) return;

  btnEl.disabled = true;
  btnEl.textContent = "submitting...";

  let resp = null;
  let data = null;
  try {
    const reqBody = { model: model };
    if (overrideCount > 0) reqBody.perShot = overrides;
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id) + "/animate-cloud",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      },
    );
    data = await resp.json();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "animate (cloud i2v)";
    window.alert("cloud animate submit failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    btnEl.disabled = false;
    btnEl.textContent = "animate (cloud i2v)";
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("cloud animate submit failed: " + msg);
    return;
  }
  btnEl.textContent = "cloud animate submitted";
  loadHistory();
}

// v0.152.0 (Phase 4 hybrid): animate a keyframes-only preview across BOTH
// backends in one film via POST .../animate-hybrid. `backends` =
// { shot_id: { backend: "gpu"|"cloud", model? } }; shots omitted default to GPU
// (defaultBackend). Output is one silent MP4 (GPU clips + cloud clips merged in
// shot order). Mirrors animateCloudRender's submit + reload; the new
// cloud-<uuid> row polls via the history auto-refresh.
async function animateHybridRender(row, btnEl, backends) {
  const kfCount = Array.isArray(row.keyframes) ? row.keyframes.length : 0;
  const entries = Object.entries(backends || {});
  const cloudN = entries.filter(([, b]) => b && b.backend === "cloud").length;
  const explicitGpuN = entries.filter(([, b]) => b && b.backend === "gpu").length;
  const gpuTotal = kfCount - cloudN; // everything not explicitly cloud is GPU
  // v0.154.0 (slice-3 #2): qualitative cost hint. We have no per-provider price
  // table, so surface HOW each lane bills rather than an invented dollar figure.
  const costLines = [];
  if (gpuTotal > 0) {
    costLines.push(
      "  - GPU: " + gpuTotal + " shot(s) run as one scale-to-zero pod render "
      + "(~20-30 min of GPU time, billed per-minute)",
    );
  }
  if (cloudN > 0) {
    costLines.push(
      "  - Cloud: " + cloudN + " shot(s), billed per-second per provider "
      + "(one i2v call each)",
    );
  }
  const costHint = costLines.length
    ? "approx cost:\n" + costLines.join("\n") + "\n\n"
    : "";
  const confirmMsg =
    "animate this preview as a HYBRID film?\n\n"
    + gpuTotal + " shot(s) on GPU Wan, " + cloudN + " on cloud i2v"
    + (explicitGpuN ? " (" + explicitGpuN + " GPU set explicitly)" : "")
    + ", assembled into one SILENT MP4. add a score afterward with the add-audio "
    + "action.\n\n" + (cloudN === 0
      ? "NOTE: no shots set to Cloud -- this is effectively an all-GPU finalize.\n\n"
      : "")
    + costHint
    + "continue?";
  if (!window.confirm(confirmMsg)) return;

  btnEl.disabled = true;
  btnEl.textContent = "submitting...";

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id) + "/animate-hybrid",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          backends: backends,
          defaultBackend: "gpu",
          defaultCloudModel: "alibaba/hh1-i2v",
        }),
      },
    );
    data = await resp.json();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "animate (hybrid)";
    window.alert("hybrid submit failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || data.ok === false) {
    btnEl.disabled = false;
    btnEl.textContent = "animate (hybrid)";
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("hybrid submit failed: " + msg);
    return;
  }
  btnEl.textContent = "hybrid submitted";
  loadHistory();
}

// Minimal CSS.escape polyfill. Modern browsers ship it but planner.js
// is loaded by older devices too; this covers the safe subset we need
// for shot ids ("shot_01", "shot_02", ...). For anything outside that
// shape we fall back to the input string, which is fine because the
// shot ids are validated on the GPU side and never contain CSS-meta.
function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// v0.35.4: prompt + delete one history row. The artifact-cleanup query
// flag is sent only when the row has an output_key (no point asking the
// worker to clean nothing). Refreshes the list on success so the row
// disappears immediately.
async function deleteHistoryRow(row) {
  const hasArtifact = !!row.output_key;
  const prompt = hasArtifact
    ? "delete this render from history (and the silent MP4 in R2 if no other row references it)?"
    : "delete this render from history?";
  if (!window.confirm(prompt)) return;

  const url =
    "/api/storyboard/renders/" + encodeURIComponent(row.id)
    + (hasArtifact ? "?artifact=true" : "");
  let resp = null;
  let data = null;
  try {
    resp = await fetch(url, { method: "DELETE" });
    data = await resp.json();
  } catch (err) {
    window.alert("delete failed: " + err.message);
    return;
  }

  if (!resp.ok || !data || data.ok !== true) {
    const errMsg = (data && data.error) || ("HTTP " + resp.status);
    window.alert("delete failed: " + errMsg);
    return;
  }

  if (hasArtifact && data.artifactSkippedReason) {
    // Soft notice: the row is gone but the artifact stayed. Surface so
    // the user is not surprised that the file is still on R2.
    console.info("artifact preserved:", data.artifactSkippedReason);
  }

  // Refresh so the row drops out of the list immediately and the
  // auto-refresh loop re-arms from the new state.
  loadHistory();
}

// v0.35.1: load a bundle key (from a history row or a paste prompt) into
// the render stage and reveal it. The user then picks a quality tier and
// clicks "render"; the existing submitRender flow takes it from there.
// Closes any active stream / poll on a different jobId so the panel does
// not show stale progress from the previous render.
function rerunBundle(row) {
  closeStream();
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  renderState.jobId = null;
  renderState.streamFallbackHit = false;
  // v0.37.0: carry the row's label / project forward so the post-submit
  // notification (when the new render lands) reads "cherry-final-take1"
  // rather than the slug. Will be overwritten on the next submit.
  renderState.currentProject = row.project || null;
  renderState.currentLabel = row.label || null;
  bundleState.bundleKey = row.bundle_key;

  const renderSection = $("#planner-render");
  renderSection.hidden = false;
  $("#planner-render-result").hidden = true;
  $("#planner-render-error").hidden = true;
  $("#planner-render-log-wrap").hidden = true;
  $("#planner-render-output").hidden = true;
  // v0.120.0: jump to the Render step (this row carried a bundle key forward).
  refreshSteps();
  showStep("render");

  // Pre-select the same quality tier the original render used so a single
  // click matches the previous run; the user can still flip it before
  // hitting render.
  const tierSelect = $("#planner-quality-tier");
  if (tierSelect && row.quality_tier) {
    tierSelect.value = row.quality_tier;
  }

  // v0.35.3: pre-fill the renderOverrides textarea from the row so a
  // re-render reproduces the previous run end to end. If overrides were
  // present, open the <details> wrapper so the user sees we are carrying
  // them forward (else they would think "no overrides" by default).
  const overridesTextarea = $("#planner-render-overrides");
  // v0.123.0: the raw-overrides textarea moved into "expert: raw JSON"; open
  // that disclosure (not "advanced settings") so a carried-forward override
  // is visible.
  const overridesDetails = $(".planner-overrides-expert");
  if (overridesTextarea) {
    if (
      row.render_overrides
      && typeof row.render_overrides === "object"
      && !Array.isArray(row.render_overrides)
      && Object.keys(row.render_overrides).length > 0
    ) {
      overridesTextarea.value = JSON.stringify(row.render_overrides, null, 2);
      if (overridesDetails) overridesDetails.open = true;
    } else {
      overridesTextarea.value = "";
      if (overridesDetails) overridesDetails.open = false;
    }
  }

  setRenderStatus(
    "loaded bundle " + row.bundle_key
      + " (project " + (row.project || "?") + "); pick a quality tier and click render",
    "loading",
  );
  renderSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

// v0.60.0: one-click retry for a FAILED / CANCELLED / TIMED_OUT row.
// POSTs /api/storyboard/renders/<id>/retry; the Worker re-submits with
// the row's stored args and the GPU resumes incrementally off the
// volume (lora_already_trained + _indices_skip_locked). On success, a
// fresh row appears at the top of the history list; the failed row
// stays for the audit trail.
async function retryFailedRender(row, btnEl) {
  const confirmMsg =
    "retry this render?\n\n"
    + "the GPU side resumes off its volume so any already-trained LoRAs "
    + "and already-rendered shots are reused. on the same endpoint within "
    + "the volume's retention window this is much cheaper than a fresh "
    + "submit.\n\ncontinue?";
  if (!window.confirm(confirmMsg)) return;

  btnEl.disabled = true;
  btnEl.textContent = "submitting...";

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id) + "/retry",
      { method: "POST" },
    );
    data = await resp.json();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "retry";
    window.alert("retry submit failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    btnEl.disabled = false;
    btnEl.textContent = "retry";
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("retry submit failed: " + msg);
    return;
  }
  btnEl.textContent = "retry submitted";
  loadHistory();
}

// v0.35.1: paste an R2 bundle key directly to render a bundle that does
// not appear in the history (e.g. one staged by curl or one from before
// the v0.34.0 history migration). Reuses rerunBundle with a synthetic
// row whose project + tier come from a slug-derive on the key.
function promptCustomBundle() {
  const key = window.prompt(
    "paste an R2 bundle key (e.g. bundles/cherry.tar.gz) to render it without re-bundling:",
    "bundles/",
  );
  if (!key || !key.trim()) return;
  const trimmed = key.trim();
  rerunBundle({
    job_id: "(custom)",
    project: deriveProjectFromKey(trimmed),
    bundle_key: trimmed,
    quality_tier: "final",
    status: "PENDING",
  });
}

function deriveProjectFromKey(bundleKey) {
  const m = bundleKey.match(/^bundles\/(.+)\.tar\.gz$/);
  if (m) return m[1];
  return bundleKey;
}

// v0.36.0: free-form text input that doubles as the row's label display.
// Reads as italic + dimmed when empty (shows "+ label" placeholder);
// gains a border + normal weight on focus to signal "edit mode". On blur
// or Enter, if the value changed, PATCH the row and update local state.
// On Escape, revert without firing the network call.
function buildHistoryLabelInput(row) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "planner-history-label-input";
  input.value = row.label || "";
  input.placeholder = "+ label";
  input.maxLength = 200;
  input.spellcheck = false;
  input.title = "click to label this render (max 200 chars)";

  // Track the last server-acknowledged value so we never PATCH on a
  // blur that did not actually change anything.
  let lastSaved = row.label || "";

  const save = async () => {
    const next = input.value.trim();
    if (next === lastSaved) return;
    try {
      const resp = await fetch(
        "/api/storyboard/renders/" + encodeURIComponent(row.id),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: next || null }),
        },
      );
      if (!resp.ok) {
        let msg = "HTTP " + resp.status;
        try {
          const data = await resp.json();
          if (data && data.error) msg = data.error;
        } catch {
          // non-JSON body; keep the HTTP code
        }
        throw new Error(msg);
      }
      const data = await resp.json();
      lastSaved = data.label || "";
      input.value = lastSaved;
      row.label = lastSaved || null;
    } catch (err) {
      console.error("label save failed:", err);
      window.alert("label save failed: " + err.message);
      input.value = lastSaved;
    }
  };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      input.blur();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      input.value = lastSaved;
      input.blur();
    }
  });

  return input;
}

// v0.38.1: flip the collapsed / expanded state of one history row. Updates
// the chevron, the aria-expanded attribute, and the CSS class that hides
// the label input + sub line + actions row when collapsed. State lives in
// historyState.expandedIds; cleared on reload (intentional, since collapsed
// default after refresh keeps the list scannable for the next session).
function toggleHistoryRowExpand(id, liEl) {
  const expanded = historyState.expandedIds.has(id);
  const next = !expanded;
  if (next) {
    historyState.expandedIds.add(id);
    liEl.classList.remove("planner-history-item-collapsed");
  } else {
    historyState.expandedIds.delete(id);
    liEl.classList.add("planner-history-item-collapsed");
  }
  const meta = liEl.querySelector(".planner-history-meta");
  if (meta) meta.setAttribute("aria-expanded", next ? "true" : "false");
  const chevron = liEl.querySelector(".planner-history-chevron");
  if (chevron) chevron.textContent = next ? "▼" : "▶";
}

function historyStatusKind(status) {
  if (status === "COMPLETED") return "done";
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") return "error";
  return "running";
}

// Load the render stage with the past render's stored state and resume
// polling when the job is still in flight. Skips the plan + bundle stages
// since the user is jumping straight to "see this render's status".
function resumeRender(row) {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  renderState.jobId = row.job_id;
  // v0.37.0: surface label / project for the notification when this
  // resumed render reaches a terminal status (catches users who walk
  // away after clicking "view" on an in-flight history row).
  renderState.currentProject = row.project || null;
  renderState.currentLabel = row.label || null;
  bundleState.bundleKey = row.bundle_key;

  const renderSection = $("#planner-render");
  renderSection.hidden = false;
  // v0.120.0: jump to the Render step to show this in-flight / past render.
  refreshSteps();
  showStep("render");
  $("#planner-render-result").hidden = false;
  $("#planner-render-job-id").textContent = row.job_id;
  setJobStatusBadge(row.status);

  // Reset transient panels before populating from the row.
  $("#planner-render-scene").hidden = true;
  $("#planner-render-phase").hidden = true;
  $("#planner-render-error").hidden = true;
  $("#planner-render-log-wrap").hidden = true;
  $("#planner-render-output").hidden = true;

  if (row.output) {
    const outpan = $("#planner-render-output");
    outpan.hidden = false;
    $("#planner-render-output-content").textContent = JSON.stringify(row.output, null, 2);
    if (row.output_key) {
      const url = "/api/artifact/" + row.output_key;
      $("#planner-render-download").href = url;
      $("#planner-render-download").download = (row.project || "silent") + ".mp4";
      $("#planner-render-open").href = url;
    }
    // In-flight rows may carry a render log on the persisted output blob;
    // surface it for visual continuity with a live poll.
    if (row.output && typeof row.output === "object" && Array.isArray(row.output.log)) {
      const wrap = $("#planner-render-log-wrap");
      wrap.hidden = false;
      $("#planner-render-log").textContent = row.output.log.join("\n");
    }
  }

  if (row.error) {
    const err = $("#planner-render-error");
    err.hidden = false;
    err.textContent = row.error;
  }

  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  if (terminal.indexOf(row.status) < 0) {
    setRenderStatus("resumed; opening stream...", "loading");
    renderState.streamFallbackHit = false;
    startStream();
  } else {
    const kind = row.status === "COMPLETED" ? "success" : "error";
    setRenderStatus(row.status.toLowerCase() + " (from history)", kind);
  }

  renderSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatRelative(unixSeconds) {
  if (!unixSeconds) return "";
  const now = Math.floor(Date.now() / 1000);
  const delta = now - Number(unixSeconds);
  if (delta < 60) return delta + "s ago";
  if (delta < 3600) return Math.floor(delta / 60) + "m ago";
  if (delta < 86400) return Math.floor(delta / 3600) + "h ago";
  return Math.floor(delta / 86400) + "d ago";
}

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
  // v0.38.0: restore form + result panels + render stream BEFORE async
  // data loaders fire, so the user sees their work immediately on reload.
  // The model picker value is set after loadModels resolves (its options
  // are populated by an async fetch).
  const stash = restorePersistedState();
  // v0.120.0: build the step rail + collapse to the active step now that the
  // restored pipeline state (planState / bundleState / renderState) determines
  // which steps are unlocked.
  buildStepper();
  stepState.unlocked = computeStepUnlocked();
  showStep("plan");
  // v0.124.0: inject the per-option "?" help affordance into the render-step
  // override fields (registry-backed, with auto-derived values/range/default).
  attachFieldHelp();
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
  // v0.48.0: fetch the user's cast catalog and rebuild the dropdown
  // options on each row. After this resolves, any bindings stashed by
  // restorePersistedState are reconciled against the live catalog so a
  // deleted cast member does not leave a slot stuck in "bound" mode.
  loadCast().then(() => {
    renderCastPickerOptions();
    applyRestoredCastBindings();
  });
  // v0.53.0: load the project catalog + reselect any persisted active
  // project. The picker is always visible; loading the project's last
  // storyboard happens inside selectProject().
  loadProjects().then(() => {
    if (planState.activeProjectId) {
      const sel = $("#planner-project-picker");
      if (sel) sel.value = String(planState.activeProjectId);
      // Only re-apply prefs (not re-load the storyboard) on restore so
      // we do not overwrite any in-flight transient edits with stale
      // saved state. The user re-selects from the dropdown if they
      // want the saved storyboard back.
      const p = findProject(planState.activeProjectId);
      if (p) applyProjectPrefs(p.prefs);
      refreshProjectButtonGates();
    }
  });
  loadHistory();
  initNotifications();
  // v0.49.0: scene editor discard button. The button itself is in
  // the markup at all times; toggled disabled based on dirty state by
  // refreshSceneDirtyBadge after every edit.
  const discardBtn = $("#planner-scenes-discard");
  if (discardBtn) discardBtn.addEventListener("click", discardSceneEdits);
  // v0.50.0: refinement chat send button + Cmd/Ctrl+Enter in the textarea.
  const refineSend = $("#planner-refine-send");
  if (refineSend) refineSend.addEventListener("click", sendRefine);
  // v0.131.0: freeform chat send + new-conversation + Cmd/Ctrl+Enter.
  const chatSend = $("#planner-chat-send");
  if (chatSend) chatSend.addEventListener("click", sendChat);
  const chatClear = $("#planner-chat-clear");
  if (chatClear) chatClear.addEventListener("click", clearChat);
  const chatScript = $("#planner-chat-script");
  if (chatScript) chatScript.addEventListener("click", scriptMyPlan);
  // v0.133.3 / v0.161.1: "new / reset" button -- full session reset. Clears
  // the brief, storyboard, audio, bundle, render, and persisted snapshot so
  // the next plan starts with a clean slate and no prior project bleeds in.
  const briefClear = $("#planner-brief-clear");
  if (briefClear) {
    briefClear.addEventListener("click", () => {
      const briefEl = $("#planner-brief");
      if (briefEl) briefEl.value = "";
      planState.storyboard = null;
      planState.originalStoryboard = null;
      planState.refineHistory = [];
      planState.audioKey = null;
      planState.audioMime = null;
      planState.audioSourceLabel = null;
      planState.bpm = null;
      planState.beatsPerShot = null;
      planState.activeProjectId = null;
      $("#planner-output").hidden = true;
      resetBundleStage();
      resetRenderStage();
      savePersistedState();
      if (briefEl) briefEl.focus();
    });
  }
  const chatInput = $("#planner-chat-input");
  if (chatInput) {
    // Match the main chat composer: Enter sends, Shift+Enter inserts a newline.
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
  }
  const refineInput = $("#planner-refine-input");
  if (refineInput) {
    refineInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendRefine();
      }
    });
  }
  // v0.51.0: audio bed + beat timing.
  const musicGen = $("#planner-music-gen");
  if (musicGen) musicGen.addEventListener("click", generateMusic);
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
    selectProject(v ? Number(v) : null);
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
  // v0.43.0: persist the structured render-settings fields. Each
  // listens for the appropriate event (input on text + number,
  // change on selects).
  const seedEl = $("#planner-seed");
  if (seedEl) seedEl.addEventListener("input", persistSoon);
  // v0.43.0: randomize-seed button. Fills the seed input with a fresh
  // 32-bit unsigned int and triggers persistSoon so the value survives
  // a reload before the next render submission.
  const randomizeBtn = $("#planner-seed-randomize");
  if (randomizeBtn && seedEl) {
    randomizeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      seedEl.value = String(Math.floor(Math.random() * 0x1_0000_0000));
      persistSoon();
    });
  }
  $("#planner-plan").addEventListener("click", plan);
  $("#planner-reprompt").addEventListener("click", repromptWithErrors);
  $("#planner-bundle-btn").addEventListener("click", bundleNow);
  // v0.162.0: dispatch to submitScatterRender when the scatter checkbox is
  // checked; fall through to submitRender for all other cases.
  $("#planner-render-btn").addEventListener("click", () => {
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

  $("#planner-brief").addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      plan();
    }
  });

  // v0.162.0: gate the scatter checkbox on page load (no storyboard yet,
  // so it starts disabled with a reason).
  updateScatterGate();
});
