// Planner UI -- refinement chat (iterative edits on the in-flight storyboard).
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

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
    // #743: refine response carries no yaml field; fetch the preview like scene-edit.
    refreshYamlPreview();
    $("#planner-json").textContent = JSON.stringify(data.storyboard, null, 2);
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

