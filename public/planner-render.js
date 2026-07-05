// Planner UI -- render stage + the LoRA training preflight gate.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Render stage ----------

function showRenderStage() {
  const stage = $("#planner-render");
  stage.hidden = false;
  $("#planner-render-result").hidden = true;
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
  setRenderStatus("", "");
  // v0.221.0: a fresh visit to the render stage starts with no LoRA warning;
  // the next render click re-checks against fresh cast state.
  hideLoraPreflightWarning();
  loraPreflightAck = null;
  updateScatterGate();
  updateRenderGate();
}

// ---------- LoRA training preflight (v0.221.0) ----------
//
// A bound character whose LoRA is not trained-and-ready gets its LoRA RETRAINED
// inline (~20 min) on EVERY render via the server fail-safe (resolveCastLoras).
// That used to fire with no visible signal -- the bug this closes. Right before
// a render submit we re-read FRESH cast state and, if any bound slot will
// trigger the retrain tax, show a visible, actionable warning. It is NOT a hard
// block: the fail-safe is a valid escape hatch, so a second render click (with
// the same warning standing) proceeds anyway.
//
// FRESH, not cached: the page-load cast catalog's lora_status goes stale when
// training finishes after load (see buildCastLoraSubmit v0.135.6), so the gate
// re-fetches /api/cast before checking rather than trusting planState.castCatalog.

// Signature of the unready-slot set the user has already acknowledged by
// clicking render a second time. Reset whenever the set is empty or changes.
let loraPreflightAck = null;

function hideLoraPreflightWarning() {
  const el = $("#planner-lora-preflight-warning");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

function showLoraPreflightWarning(unready) {
  const el = $("#planner-lora-preflight-warning");
  if (!el) return;
  const names = unready.map((u) => u.name).join(", ");
  el.textContent = "";
  // Build with textContent (names are user-authored) plus a real link to /cast.
  const msg = document.createElement("span");
  msg.className = "planner-lora-preflight-msg";
  msg.textContent =
    "Warning: these characters have no trained LoRA and will be retrained inline " +
    "(~20 min each) during this render: " + names + ". Train them on the Cast page " +
    "first for instant reuse. Click render again to proceed anyway.";
  const link = document.createElement("a");
  link.href = "/cast";
  link.className = "planner-lora-preflight-link";
  link.textContent = "open Cast page";
  el.appendChild(msg);
  el.appendChild(document.createTextNode(" "));
  el.appendChild(link);
  el.hidden = false;
}

// Returns true when the render may proceed, false when it should pause on a
// freshly-shown warning. Re-fetches /api/cast so the readiness check is fresh.
async function loraPreflightGate() {
  const bindings = planState.castBindings || {};
  if (Object.keys(bindings).length === 0) {
    hideLoraPreflightWarning();
    loraPreflightAck = null;
    return true;
  }
  setRenderStatus("checking cast LoRA status...", "loading");
  // Refresh the catalog in place; loadCast swallows its own errors and leaves
  // the prior catalog on failure, which is an acceptable fall-back here.
  await loadCast();
  const unready = window.loraPreflight.unreadyBoundLoraSlots(bindings, planState.castCatalog);
  if (unready.length === 0) {
    hideLoraPreflightWarning();
    loraPreflightAck = null;
    setRenderStatus("", "");
    return true;
  }
  const sig = window.loraPreflight.loraSlotSignature(unready);
  if (loraPreflightAck === sig) {
    // Same warning the user already saw; they clicked render again -> proceed.
    hideLoraPreflightWarning();
    return true;
  }
  loraPreflightAck = sig;
  showLoraPreflightWarning(unready);
  setRenderStatus(
    unready.length === 1
      ? "1 bound character has no trained LoRA (see warning above)"
      : unready.length + " bound characters have no trained LoRA (see warning above)",
    "error",
  );
  return false;
}

async function submitRender() {
  // vivijure#552: own the in-flight flag for the whole submit; cleared on jobId
  // handoff or on any bail/error path below.
  renderState.submitting = true;
  if (!bundleState.bundleKey) {
    setRenderStatus("no bundleKey; run 'bundle' first", "error");
    renderState.submitting = false;
    return;
  }
  if (!planState.storyboard || !Array.isArray(planState.storyboard.scenes) || planState.storyboard.scenes.length === 0) {
    setRenderStatus("no storyboard scenes; plan first", "error");
    renderState.submitting = false;
    return;
  }
  const filmScenes = buildFilmScenes(planState.storyboard);
  if (filmScenes.length === 0) {
    setRenderStatus("every scene needs a prompt before render", "error");
    renderState.submitting = false;
    return;
  }
  // v0.40.0: the keyframes-only checkbox is the source of truth for the next submission;
  // read it BEFORE collecting overrides so the collect can honor the #500 keyframes-only
  // exemption (vivijure#501) -- a keyframes-only preview runs no motion leg and needs no
  // backend pick, so it must never be blocked by the multi-backend choice gate.
  const kfOnlyEl = $("#planner-keyframes-only");
  const keyframesOnly = !!(kfOnlyEl && kfOnlyEl.checked);
  // v0.35.3 + module config: collect registry-driven overrides + optional expert JSON.
  let renderOverrides;
  try {
    renderOverrides = collectRenderOverrides({ keyframesOnly });
  } catch (err) {
    setRenderStatus(err.message, "error");
    const ta = $("#planner-render-overrides");
    if (ta) ta.focus();
    renderState.submitting = false;
    return;
  }
  // Stop any prior poll loop before starting a new render.
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  const qualityTier = $("#planner-quality-tier").value;
  // v0.40.0: the checkbox (read above) is the source of truth for the next submission. The
  // Worker merges this into render_overrides.keyframes_only=true on the wire; the GPU side
  // (vivijure-serverless 0.4.2+) short-circuits the orchestrator after the SDXL pass when
  // it is set.
  setRenderStatus(
    keyframesOnly ? "submitting keyframes-only preview..." : "submitting render pipeline...",
    "loading",
  );
  $("#planner-render-btn").disabled = true;

  const reqBody = {
    bundleKey: bundleState.bundleKey,
    qualityTier,
    scenes: filmScenes,
  };
  // v0.43.0: buildRenderOverrides returns {} when nothing is set, so
  // gate on key count rather than truthiness; an empty object would
  // otherwise round-trip as `render_overrides: {}` and the Worker
  // would drop it anyway, but skipping it here keeps the wire clean.
  if (renderOverrides) reqBody.renderOverrides = renderOverrides;
  if (keyframesOnly) reqBody.keyframesOnly = true;
  // v0.52.0: forward the audio bed R2 key when one is set. The Worker
  // cross-bucket-copies MiniMax-generated keys (out/<uuid>.<ext>) into
  // env.R2_RENDERS at submit time; uploaded BYO audio (audio/<...>)
  // passes through. The GPU side (vivijure-serverless 0.4.11+) reads
  // audio_key from the job input, downloads, and muxes via
  // export_film(with_audio=True).
  if (planState.audioKey) reqBody.audioKey = planState.audioKey;
  // Forward the title / credit-card TEXT. The film.finish chain (film-titles) reads it off the job
  // (job.film_titles -> FilmFinishInput.title/credits); without this the cards never rendered from the
  // planner. Omitted when empty, and the core ignores it on a keyframes-only preview (no assembled film
  // to card), mirroring audioKey.
  const filmTitles = collectFilmTitles();
  if (filmTitles && !keyframesOnly) reqBody.film_titles = filmTitles;
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
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("submit failed: " + errs.join("; "), "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!data || !data.jobId) {
    setRenderStatus("submit returned no jobId", "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  renderState.jobId = data.jobId;
  // vivijure#552: jobId set; the jobId/pollTimer guard now owns the button.
  renderState.submitting = false;
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

// vivijure#546: gate the primary render button on a REQUIRED-but-unmade motion-backend
// choice so the obligation is a visible disabled affordance (mirroring the distributed-
// render checkbox), not a click-time-only block. Keyframes-only previews run no motion
// leg and are exempt. Presentation only; the collectForSubmit throw stays the hard
// backstop. Never fights the in-flight/streaming disable owned by the submit paths.
function updateRenderGate() {
  const btn = $("#planner-render-btn");
  if (!btn) return;
  const reasonEl = $("#planner-render-reason");
  // While a render is submitting/streaming the submit path owns the button; leave it be.
  if (renderState && (renderState.submitting || renderState.jobId || renderState.pollTimer)) return;
  const kfOnlyEl = $("#planner-keyframes-only");
  const keyframesOnly = !!(kfOnlyEl && kfOnlyEl.checked);
  const cfg = window.plannerRenderConfig;
  const pending = !keyframesOnly
    && cfg
    && typeof cfg.backendChoicePending === "function"
    && cfg.backendChoicePending();
  const reason = pending ? "pick a render backend above" : "";
  btn.disabled = !!reason;
  if (reasonEl) {
    reasonEl.textContent = reason;
    reasonEl.hidden = !reason;
  }
}

// v0.162.0: POST to /api/storyboard/render/scatter and drive the existing
// renderState poll loop with the returned scatter-<uuid> jobId. Modeled on
// submitRender() -- reuses buildRenderOverrides, qualityTier, audioKey,
// projectId exactly. shotIds are derived via sceneIdAt (the canonical id
// source that matches the GPU's per-shot clip filenames).
async function submitScatterRender() {
  // vivijure#552: see submitRender.
  renderState.submitting = true;
  if (!bundleState.bundleKey) {
    setRenderStatus("no bundleKey; run 'bundle' first", "error");
    renderState.submitting = false;
    return;
  }
  const scenes =
    planState.storyboard && Array.isArray(planState.storyboard.scenes)
      ? planState.storyboard.scenes
      : [];
  const shotIds = scenes.map((s, i) => sceneIdAt(s, i));
  if (shotIds.length < 2) {
    setRenderStatus("scatter requires >= 2 shots", "error");
    renderState.submitting = false;
    return;
  }
  const castLoras = buildCastLoraSubmit();
  if (Object.keys(castLoras).length === 0) {
    setRenderStatus(
      "scatter requires at least one character with a trained LoRA bound",
      "error",
    );
    renderState.submitting = false;
    return;
  }

  // Talking characters: the scatter render reads per-shot dialogue from the SAVED storyboard in D1
  // (last_storyboard), so flush any unsaved edits (incl. dialogue lines) before submitting. No-ops
  // without an active project -- and dialogue needs a saved project for its projectId anyway.
  if (planState.activeProjectId) await saveStoryboardToProject();

  const shardInput = $("#planner-scatter-shards");
  let shardCount = shardInput ? parseInt(shardInput.value, 10) : 2;
  if (!Number.isInteger(shardCount) || shardCount < 2) shardCount = 2;
  if (shardCount > shotIds.length) shardCount = shotIds.length;

  let renderOverrides;
  try {
    renderOverrides = collectRenderOverrides();
  } catch (err) {
    setRenderStatus(err.message, "error");
    const ta = $("#planner-render-overrides");
    if (ta) ta.focus();
    renderState.submitting = false;
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
  if (renderOverrides) reqBody.renderOverrides = renderOverrides;
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
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs =
      (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("scatter submit failed: " + errs.join("; "), "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!data || !data.jobId) {
    setRenderStatus("scatter submit returned no jobId", "error");
    renderState.submitting = false;
    $("#planner-render-btn").disabled = false;
    return;
  }

  renderState.jobId = data.jobId;
  // vivijure#552: jobId set; the jobId/pollTimer guard now owns the button.
  renderState.submitting = false;
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

// Render progress tracking. Polls GET /api/storyboard/render/<jobId> on an
// 8-second loop against the structured status channel (docs/observability.md);
// updateRenderProgress / finalizeRenderPoll consume each snapshot. A live SSE
// progress stream was scaffolded here client-side (v0.35.0) but the worker
// never had a matching /stream endpoint, so the EventSource attempt always
// errored straight to this poll while flashing a spurious "stream closed;
// falling back" status. That dead path was removed; the 8s poll is the single
// honest mechanism. Re-implementing SSE server-side is a post-announce
// enhancement (see issue #414).
function startStream() {
  pollRender();
}

// Stop render progress tracking. Named closeStream for caller compatibility
// with the removed SSE path; it now clears the poll loop (the callers that stop
// tracking pair it with the same clear, so this is idempotent).
function closeStream() {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
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
  // #115: the phase-aware overall-completion fraction lives in the testable
  // render-eta.js module (window.renderEta). The old inline scene-count logic
  // returned 0 for the whole keyframe phase and null for finish/assemble/mux,
  // so the UI sat at "?% eta computing..." for big stretches of a render. Keep
  // a tiny inline fallback so a missing script never throws (coarser guess).
  if (window.renderEta) return window.renderEta.progressFraction(out);
  if (!out || typeof out !== "object") return null;
  if (typeof out.progress === "number" && out.progress >= 0 && out.progress <= 1) {
    return out.progress;
  }
  if (
    typeof out.scene_index === "number"
    && typeof out.scene_total === "number"
    && out.scene_total > 0
  ) {
    return Math.min(1, Math.max(0, out.scene_index - 1) / out.scene_total);
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

  // ETA: linear extrapolation, computed in the testable render-eta.js module
  // (window.renderEta.remainingMs). It withholds a number until we are
  // confident (>= 3% done and >= 10s elapsed) so early model-load skew never
  // produces a wild, scary estimate; null renders as "computing...".
  if (etaEl) {
    const remaining = window.renderEta
      ? window.renderEta.remainingMs(frac, elapsedMs)
      : null;
    etaEl.textContent = remaining === null ? "computing..." : "~" + formatDuration(remaining);
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

