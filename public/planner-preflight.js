// Planner UI -- pre-render preflight panel (POSTs to the server preflight validator).
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

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

// v0.165.0 (#144): mirror showAudioSection -- when the user navigates to
// Cast & Bundle, ensure the preflight and bundle sections are visible if a
// storyboard exists. showStep only toggles the step-hidden class (not the
// hidden attr), so sections that start with `hidden` in HTML stay invisible
// unless their hidden attr is explicitly cleared here.
function showCastSection() {
  showPreflightSection();
  if (planState.storyboard) {
    const bundle = $("#planner-bundle");
    if (bundle) bundle.hidden = false;
  }
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
    // #707: name the currently selected motion backend + quality tier so the
    // server can warn per shot when that backend's declared duration_grid would
    // clamp a planned duration. Both are OPTIONAL and additive on the envelope:
    // absent when the user has not chosen yet (an unmade multi-backend pick, or a
    // panel not yet rendered), in which case the server emits no grid warning.
    const motionSel = document.getElementById("planner-motion-backend");
    if (motionSel && motionSel.value) body.motionBackend = motionSel.value;
    const tierEl = document.getElementById("planner-quality-tier");
    if (tierEl && tierEl.value) body.quality = tierEl.value;
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

