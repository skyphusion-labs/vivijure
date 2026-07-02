// Planner UI -- audio bed, score / narration score modules, and beat-sync timing.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

// ---------- Audio bed + beat timing (v0.51.0) ----------
//
// Two paths to set planState.audioKey: generate via an installed score module
// (POST /api/storyboard/score-bed; poll GET /api/job/:id?module=...), or upload
// a BYO mp3/wav/aac/m4a/ogg via POST /api/storyboard/audio-upload (binary,
// returns the R2 key directly). Once set, BPM + beats-per-shot drive a pure-JS
// snap that rounds each scene's target_seconds to a musical-phrase multiple.

const MUSIC_POLL_MS = 5000;
let musicPollTimer = null;

// Score modules -- populated from GET /api/modules via plannerRegistry.
let scoreMusicState = { modules: [] };
let scoreNarrationState = { modules: [] };

function activeScoreMusicModule() {
  const sel = $("#planner-music-module");
  if (sel && sel.value) return sel.value;
  return scoreMusicState.modules.length ? scoreMusicState.modules[0].name : null;
}

function activeScoreMusicLabel() {
  const name = activeScoreMusicModule();
  const mod = scoreMusicState.modules.find((m) => m.name === name);
  return mod ? mod.label : "music generator";
}

function activeScoreNarrationModule() {
  const sel = $("#planner-narration-module");
  if (sel && sel.value) return sel.value;
  return scoreNarrationState.modules.length ? scoreNarrationState.modules[0].name : null;
}

function activeScoreNarrationLabel() {
  const name = activeScoreNarrationModule();
  const mod = scoreNarrationState.modules.find((m) => m.name === name);
  return mod ? mod.label : "narration";
}

function setScoreBedStatus(kind, text, statusKind) {
  const id = kind === "narration" ? "planner-narration-gen-status" : "planner-music-gen-status";
  const el = $("#" + id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "planner-status" + (statusKind ? " planner-" + statusKind : "");
}

function setScoreBedButtonDisabled(kind, disabled) {
  const id = kind === "narration" ? "planner-narration-gen" : "planner-music-gen";
  const btn = $("#" + id);
  if (btn) btn.disabled = disabled;
}

function initScoreModulesFromRegistry() {
  if (!window.plannerRegistry) return;
  window.plannerRegistry.load().then(() => {
    initScoreMusicFromRegistry();
    initScoreNarrationFromRegistry();
  }).catch(() => {});
}

function initScoreMusicFromRegistry() {
  const block = $("#planner-music-gen-block");
  const summary = $("#planner-music-gen-summary");
  const wrap = $("#planner-music-module-wrap");
  const sel = $("#planner-music-module");
  if (!block || !window.plannerRegistry) return;

  const mods = window.plannerRegistry.musicScoreModules();
  scoreMusicState.modules = mods.map((m) => ({
    name: m.name,
    label: window.plannerRegistry.moduleLabel(m),
  }));
  if (!scoreMusicState.modules.length) return;

  block.hidden = false;
  if (summary) {
    summary.textContent = scoreMusicState.modules.length === 1
      ? ("generate music via " + scoreMusicState.modules[0].label)
      : "generate music";
  }
  if (sel && wrap) {
    sel.replaceChildren();
    for (const mod of scoreMusicState.modules) {
      const opt = document.createElement("option");
      opt.value = mod.name;
      opt.textContent = mod.label;
      sel.append(opt);
    }
    wrap.hidden = scoreMusicState.modules.length <= 1;
    if (planState.pendingMusicModule) sel.value = planState.pendingMusicModule;
  }
}

function initScoreNarrationFromRegistry() {
  const block = $("#planner-narration-gen-block");
  const summary = $("#planner-narration-gen-summary");
  const wrap = $("#planner-narration-module-wrap");
  const sel = $("#planner-narration-module");
  if (!block || !window.plannerRegistry) return;

  const mods = window.plannerRegistry.narrationScoreModules();
  scoreNarrationState.modules = mods.map((m) => ({
    name: m.name,
    label: window.plannerRegistry.moduleLabel(m),
  }));
  if (!scoreNarrationState.modules.length) return;

  block.hidden = false;
  if (summary) {
    summary.textContent = scoreNarrationState.modules.length === 1
      ? ("generate narration via " + scoreNarrationState.modules[0].label)
      : "generate narration";
  }
  if (sel && wrap) {
    sel.replaceChildren();
    for (const mod of scoreNarrationState.modules) {
      const opt = document.createElement("option");
      opt.value = mod.name;
      opt.textContent = mod.label;
      sel.append(opt);
    }
    wrap.hidden = scoreNarrationState.modules.length <= 1;
    if (planState.pendingMusicModule && scoreNarrationState.modules.some((m) => m.name === planState.pendingMusicModule)) {
      sel.value = planState.pendingMusicModule;
    }
  }
}

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
  setScoreBedStatus("music", text, kind);
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

// v0.137.6: suggest an ideal music prompt that matches the planned
// video, so the generated track fits the mood/tempo/energy instead of being a
// blind guess. One-shot /api/chat: feeds the storyboard's
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
    + "to SCORE a short cinematic/anime video. Output ONE "
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

async function startScoreBedJob(kind, opts) {
  if (planState.pendingMusicChatId) {
    setScoreBedStatus(kind, "a score job is already in flight; wait or refresh.", "error");
    return;
  }
  const moduleName = opts.moduleName;
  const moduleLabel = opts.moduleLabel;
  if (!moduleName) {
    setScoreBedStatus(kind, "no " + kind + " score module installed.", "error");
    return;
  }
  setScoreBedButtonDisabled(kind, true);
  setScoreBedStatus(kind, "submitting to " + moduleLabel + "...", "loading");
  try {
    const scenes = planState.storyboard && Array.isArray(planState.storyboard.scenes)
      ? planState.storyboard.scenes
      : [];
    const seconds = planState.storyboard
      ? Math.round(
          Number(planState.storyboard.duration_seconds)
            || scenes.length * (Number(planState.storyboard.clip_seconds) || 4),
        )
      : undefined;
    const body = {
      kind: kind,
      module: moduleName,
      storyboard: planState.storyboard || undefined,
      seconds,
    };
    if (kind === "music") body.prompt = opts.prompt;
    else body.text = opts.text || "";

    const resp = await fetch("/api/storyboard/score-bed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setScoreBedStatus(kind, "submit failed: " + (data.error || "HTTP " + resp.status), "error");
      setScoreBedButtonDisabled(kind, false);
      return;
    }
    if (data.status !== "pending" || !data.id) {
      setScoreBedStatus(kind, "unexpected response shape", "error");
      setScoreBedButtonDisabled(kind, false);
      return;
    }
    planState.pendingMusicChatId = data.id;
    planState.pendingMusicModule = data.module || moduleName;
    planState.pendingScoreBedKind = kind;
    planState.pendingScoreBedLabel = data.label || moduleLabel;
    persistSoon();
    setScoreBedStatus(kind, "generating with " + planState.pendingScoreBedLabel + " (~30-90s)...", "loading");
    pollScoreBedJob();
  } catch (err) {
    setScoreBedStatus(kind, "network error: " + err.message, "error");
    setScoreBedButtonDisabled(kind, false);
  }
}

async function generateMusic() {
  const prompt = ($("#planner-music-prompt").value || "").trim();
  if (!prompt) {
    setMusicGenStatus("describe the track first.", "error");
    return;
  }
  await startScoreBedJob("music", {
    moduleName: activeScoreMusicModule(),
    moduleLabel: activeScoreMusicLabel(),
    prompt,
  });
}

async function generateNarration() {
  const text = ($("#planner-narration-text").value || "").trim();
  await startScoreBedJob("narration", {
    moduleName: activeScoreNarrationModule(),
    moduleLabel: activeScoreNarrationLabel(),
    text,
  });
}

function resumeMusicPolling() {
  if (!planState.pendingMusicChatId || !planState.pendingMusicModule) return;
  const kind = planState.pendingScoreBedKind || "music";
  const label = planState.pendingScoreBedLabel
    || (kind === "narration" ? activeScoreNarrationLabel() : activeScoreMusicLabel());
  setScoreBedStatus(kind, "resuming poll on prior " + label + " job...", "loading");
  setScoreBedButtonDisabled(kind, true);
  pollScoreBedJob();
}

async function pollScoreBedJob() {
  if (!planState.pendingMusicChatId || !planState.pendingMusicModule) return;
  const kind = planState.pendingScoreBedKind || "music";
  try {
    const resp = await fetch(
      "/api/job/" + encodeURIComponent(planState.pendingMusicChatId)
      + "?module=" + encodeURIComponent(planState.pendingMusicModule),
    );
    const data = await resp.json();
    if (data.status === "done" && data.output_artifact && data.output_artifact.key) {
      planState.audioKey = data.output_artifact.key;
      planState.audioMime = data.output_artifact.mime || "audio/mpeg";
      planState.audioSourceLabel = planState.pendingScoreBedLabel
        || (kind === "narration" ? activeScoreNarrationLabel() : activeScoreMusicLabel());
      planState.pendingMusicChatId = null;
      planState.pendingMusicModule = null;
      planState.pendingScoreBedKind = null;
      planState.pendingScoreBedLabel = null;
      renderAudioCurrent();
      setScoreBedStatus(kind, "done.", "success");
      setScoreBedButtonDisabled(kind, false);
      persistSoon();
      schedulePreflight();
      return;
    }
    if (data.status === "failed") {
      planState.pendingMusicChatId = null;
      planState.pendingMusicModule = null;
      planState.pendingScoreBedKind = null;
      planState.pendingScoreBedLabel = null;
      setScoreBedStatus(kind, "model failed: " + (data.job_error || "(no detail)"), "error");
      setScoreBedButtonDisabled(kind, false);
      persistSoon();
      return;
    }
    musicPollTimer = setTimeout(pollScoreBedJob, MUSIC_POLL_MS);
  } catch (err) {
    setScoreBedStatus(kind, "poll error: " + err.message + " (retrying)", "error");
    musicPollTimer = setTimeout(pollScoreBedJob, MUSIC_POLL_MS);
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
// Server-side beat analysis: POST /api/audio/analyze invokes the beat-sync score module
// (librosa on the fleet audio-beat-sync container over Workers VPC) and returns the beat plan
// inline (one synchronous request, no jobId/poll), then we apply its per-scene beat-aligned
// target_seconds.
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

