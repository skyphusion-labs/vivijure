// Planner UI -- render history: load, tag facets, filters, and list rendering.
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.

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
const HISTORY_UNFILED = "\u0000unfiled";

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
      if (next.join("\u0000") !== historyState.allTags.join("\u0000")) {
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
    if (typeof x.parent_id !== "string") continue;
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
    if (typeof r.parent_id === "string" && scatterParentIds.has(r.parent_id)) {
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
  const narrMods = window.plannerRegistry ? window.plannerRegistry.narrationScoreModules() : [];
  const moduleName = narrMods.length ? narrMods[0].name : undefined;
  const moduleLabel = narrMods.length ? window.plannerRegistry.moduleLabel(narrMods[0]) : "narration";
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "narrating...";
  const status = setMuxStatus(
    btn,
    "Synthesizing with " + moduleLabel + " and muxing onto the video (~30-90s)...",
    "working",
  );
  fetch("/api/storyboard/renders/" + encodeURIComponent(r.id) + "/add-narration", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: trimmed, module: moduleName }),
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

// Cloud motion.backend modules from the registry (replaces the old hand-maintained catalog).
function cloudModelLabel(id) {
  return window.plannerRegistry ? window.plannerRegistry.cloudModelLabel(id) : (id || "");
}

function cloudModelOptions() {
  return window.plannerRegistry ? window.plannerRegistry.cloudModelOptions() : [];
}

function gpuMotionLabel() {
  return window.plannerRegistry ? window.plannerRegistry.gpuMotionLabel() : "GPU i2v";
}

// Compact display token for the keyframe-stage backend/model (e.g. "SDXL"), projected from the
// keyframe module manifest via the registry. Mirrors gpuMotionLabel; falls back to "SDXL" when the
// registry has not loaded or no keyframe module declares a label.
function keyframeLabel() {
  return window.plannerRegistry ? window.plannerRegistry.keyframeLabel() : "SDXL";
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
    if (usedBackends.size === 1 && usedBackends.has("gpu")) return gpuMotionLabel();
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
  if (r.mode === "finalized") return gpuMotionLabel();
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

// v0.221.0: read the inline-retrain (fail-safe) signal off a render row. When a
// bound character had no trained LoRA at submit, the GPU retrained it inline
// (~20 min) instead of reusing -- the silent tax this preflight surfaces. The
// backend stamps the row with lora_failsafe_retrain (Mackaye's sibling task);
// this reader is the UI hook, tolerant of the final wire shape so the badge
// lights up the moment the flag lands without a second frontend change. Returns
// { fired, slots }; fired drives the badge, slots names it when available.
function loraFailsafeInfo(r) {
  if (!r) return { fired: false, slots: [] };
  const raw = r.lora_failsafe_retrain != null
    ? r.lora_failsafe_retrain
    : (r.output && typeof r.output === "object" ? r.output.lora_failsafe_retrain : null);
  if (raw == null || raw === false) return { fired: false, slots: [] };
  let slots = [];
  if (Array.isArray(raw)) slots = raw.map(String);
  else if (typeof raw === "object" && Array.isArray(raw.slots)) slots = raw.slots.map(String);
  return { fired: true, slots };
}

