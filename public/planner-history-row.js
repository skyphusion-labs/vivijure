// Planner UI -- render history: per-row build + the row actions (regen / finalize / animate / etc.).
//
// Part of the planner UI (split out of the former monolithic planner.js).
// Loaded as a classic <script>; all planner files share one global scope,
// so top-level declarations are visible across files in load order. The
// <script> tag order in planner.html is significant -- do not reorder.


// artifactUrl: an artifact reference is normally an R2 key served through the studio /api/artifact/
// presign route. The public demo studio (#625) has no R2 binding and seeds render rows whose
// output_key is an ABSOLUTE showcase URL; return such a URL verbatim so the film plays straight from
// assets.skyphusion.net. For a normal relative key this is byte-identical to before, so prod behavior
// is unchanged (a projection that also accepts an absolute artifact URL).
function artifactUrl(key) {
  return /^https?:\/\//i.test(key) ? key : "/api/artifact/" + key;
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
  // v0.170.0: stall badge reads the explicit server-authored stall signal from
  // Rollins' driver (#131). output_json on an IN_PROGRESS row carries:
  //   stalled: true          -- driver's own verdict (present only when stalled)
  //   stall_seconds: N       -- how long the current phase has been stuck
  //   last_progress_at: T    -- epoch ms the job entered its current phase
  // A client threshold is NOT used -- the server holds that logic (20min, same
  // constant as KEYFRAME_STALL_SECONDS). Badge and behavior stay in lockstep.
  const stalled = isStalled(r);
  status.className =
    "planner-history-status planner-history-status-" +
    (stalled ? "stalled" : historyStatusKind(r.status));
  const stallSec = stalled && r.output && typeof r.output === "object"
    ? r.output.stall_seconds : null;
  status.textContent = r.status + (stalled
    ? " ! (" + (stallSec != null ? Math.round(Number(stallSec) / 60) + "m" : "stalled") + ")"
    : "");
  status.title = stalled ? "render phase has not advanced -- may need attention" : "";
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
    modeBadge.title = "this render produced " + keyframeLabel() + " keyframes only; no motion / no silent MP4";
    meta.appendChild(modeBadge);
  }

  // v0.221.0: LoRA inline-retrain (fail-safe) badge. A bound character with no
  // trained LoRA at submit gets retrained inline (~20 min) instead of reused.
  // This used to be invisible; the badge makes it never silent again. The flag
  // is stamped by the backend sibling task -- loraFailsafeInfo is a no-op until
  // it lands, then a visible badge.
  const failsafe = loraFailsafeInfo(r);
  if (failsafe.fired) {
    const fsBadge = document.createElement("span");
    fsBadge.className = "planner-history-mode planner-history-mode-lora-failsafe";
    fsBadge.textContent = "LoRA retrained inline";
    fsBadge.title =
      "a bound character had no trained LoRA, so it was retrained inline during this render (~20 min)" +
      (failsafe.slots.length ? ": " + failsafe.slots.join(", ") : "") +
      ". Train it on the Cast page for instant reuse next time.";
    meta.appendChild(fsBadge);
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
  if (typeof r.parent_id === "string") {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "planner-history-parentlink";
    // S9 (F13): parent_id is an opaque public id (UUID string), not a short
    // number, so it is not shown inline; the backlink jumps to the row.
    back.textContent = "↳ from keyframes preview";
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
    childrenByParent && typeof r.id === "string" ? childrenByParent.get(r.id) : null;
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
      // Jump to the newest child so the user lands on the most recent version;
      // the rest are one scroll away. S9 (F13): ids are opaque UUID strings and
      // do NOT sort by creation, so order by submitted_at (the creation stamp),
      // falling back to updated_at.
      const stamp = (x) => (x && (x.submitted_at || x.updated_at)) || 0;
      const newest = myChildren.reduce((a, b) => (stamp(b) > stamp(a) ? b : a));
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
  // v0.170.0: for in-flight rows, show when the current render phase started
  // (last_progress_at from Rollins' driver, epoch MILLIS in output_json). This
  // is the true "last actually moved" signal -- updated_at heartbeats every
  // sweep tick regardless of real progress, so it is NOT used here.
  // Gate: only when last_progress_at is present and the row is IN_PROGRESS
  // (SUBMITTED/IN_QUEUE have no phase yet; completed rows have completed_at).
  if (
    r.status === "IN_PROGRESS" &&
    r.output && typeof r.output === "object" &&
    typeof r.output.last_progress_at === "number"
  ) {
    const lastProgressSec = Math.floor(r.output.last_progress_at / 1000);
    parts.push("phase since " + formatRelative(lastProgressSec));
  }
  sub.textContent = parts.join(" · ");

  // v0.170.0: inline error snippet for terminal-failed rows. Shows the first
  // ~100 chars of the error in the sub-line without requiring the user to
  // expand the row. Long errors are truncated with an ellipsis; the full text
  // remains visible after clicking "view".
  const isFailed2 = r.status === "FAILED" || r.status === "CANCELLED" || r.status === "TIMED_OUT";
  if (isFailed2 && r.error) {
    const errSnip = document.createElement("span");
    errSnip.className = "planner-history-error-inline";
    const maxLen = 100;
    errSnip.textContent =
      "error: " +
      (r.error.length > maxLen ? r.error.slice(0, maxLen) + "..." : r.error);
    errSnip.title = r.error;
    sub.appendChild(errSnip);
  }

  li.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "planner-history-actions";

  const view = document.createElement("button");
  view.type = "button";
  view.className = "planner-history-action";
  view.textContent = "view";
  view.addEventListener("click", () => resumeRender(r));
  actions.appendChild(view);

  // #757: cancel any in-flight render straight from the history list, not just
  // the one the panel itself launched. Any non-terminal row is cancelable via
  // the same DELETE /api/storyboard/render/:jobId route the render panel uses,
  // so an out-of-band render (slate bot / direct API / MCP) can be stopped here
  // instead of by hand. Terminal rows never show it. On a readonly/demo deploy
  // the fetch shim blocks the DELETE, so no extra gate is needed here.
  const cancelable =
    r.status === "IN_QUEUE"
    || r.status === "IN_PROGRESS"
    || r.status === "SUBMITTED"
    || r.status === "SCATTERING";
  if (cancelable && r.job_id) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "planner-history-action planner-history-action-cancel";
    cancel.textContent = "cancel";
    cancel.title = "cancel this in-flight render (stops the GPU job)";
    cancel.addEventListener("click", () => cancelHistoryRow(r, cancel));
    actions.appendChild(cancel);
  }

  if (r.output_key) {
    const dl = document.createElement("a");
    dl.href = artifactUrl(r.output_key);
    dl.download = (r.project || "silent") + ".mp4";
    dl.className = "planner-history-action";
    dl.textContent = "download";
    actions.appendChild(dl);
  }

  // #669: the subtitle module (film.finish) can write a soft .srt (mode = sidecar or both); #663
  // re-times it and the core surfaces its R2 key on the done render row as output.sidecar_key. Offer
  // it as a download next to the film. Absent (burn-only, silent, pre-#663) means not rendered.
  const sidecarKey = r.output && typeof r.output === "object" ? r.output.sidecar_key : undefined;
  if (typeof sidecarKey === "string" && sidecarKey) {
    const srt = document.createElement("a");
    srt.href = artifactUrl(sidecarKey);
    srt.download = (r.project || "film") + ".srt";
    srt.className = "planner-history-action planner-history-action-srt";
    srt.textContent = "subtitles (.srt)";
    srt.title = "download the soft subtitle sidecar (.srt)";
    actions.appendChild(srt);
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

    // v0.137.0: spoken narration via installed score module (config_schema.text).
    if (
      window.plannerRegistry
      && window.plannerRegistry.narrationScoreModules().length > 0
    ) {
      const narrate = document.createElement("button");
      narrate.type = "button";
      narrate.className = "planner-history-action";
      narrate.textContent = "narrate";
      narrate.title = "synthesize narration with the installed score module and mux it onto this video";
      narrate.addEventListener("click", () => addNarrationToRender(r, narrate));
      actions.appendChild(narrate);
    }
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
    video.src = artifactUrl(r.output_key);
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
    // #707: per-shot delivered-vs-planned duration, indexed by shot_id. Same wire
    // shape as output.clips: the poll view carries output.clip_deliveries =
    // [{ shot_id, planned_seconds, delivered_seconds, fps, frames, distilled? }],
    // one entry per done shot whose backend reported usable fps+frames. Absent (an
    // older row, or a backend that reported nothing) -> the map is empty and the
    // honesty line renders NOTHING; no placeholder, no fabricated value.
    const deliveryByShot = new Map();
    const outDeliveries =
      r.output && typeof r.output === "object" && Array.isArray(r.output.clip_deliveries)
        ? r.output.clip_deliveries
        : [];
    for (const d of outDeliveries) {
      if (
        d
        && typeof d.shot_id === "string"
        && typeof d.planned_seconds === "number"
        && typeof d.delivered_seconds === "number"
      ) {
        deliveryByShot.set(d.shot_id, d);
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

      // #707: delivered-vs-planned honesty line. A fixed-grid motion backend (e.g.
      // CogVideoX: 8fps pinned, per-tier frame caps) honestly clamps a shot's
      // requested duration; surface the real delivered seconds against the planned,
      // visibly flagged when the clip came up meaningfully short (a clamp). A
      // "(distilled)" marker is added when the delivery reports distilled === true.
      // Rendered only when the shot has a delivery record (absent renders nothing).
      const delivery = deliveryByShot.get(kf.shot_id);
      if (delivery) {
        const planned = delivery.planned_seconds;
        const delivered = delivery.delivered_seconds;
        const clamped = delivered < planned - 0.05;
        const fmt = (s) => (Math.round(s * 10) / 10) + "s";
        const dur = document.createElement("span");
        dur.className = "planner-history-keyframe-dur";
        if (clamped) dur.classList.add("planner-history-keyframe-dur-clamped");
        let text = fmt(delivered) + " delivered / " + fmt(planned) + " planned";
        if (clamped) text += " (clamped)";
        if (delivery.distilled === true) text += " (distilled)";
        dur.textContent = text;
        if (typeof delivery.frames === "number" && typeof delivery.fps === "number") {
          dur.title = delivery.frames + " frames at " + delivery.fps + "fps";
        }
        wrap.appendChild(dur);
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
        gpuOpt.textContent = gpuMotionLabel();
        gpuOpt.hidden = true;
        modelSel.appendChild(gpuOpt);
        cloudModelOptions().forEach((pair) => {
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
        btn.title = "regenerate this keyframe (" + keyframeLabel() + " only; about 30-60s)";
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

    const cloudOpts = cloudModelOptions();
    const gpuLbl = gpuMotionLabel();
    const backendChoices = [];
    if (window.plannerRegistry && window.plannerRegistry.ownGpuModule()) {
      backendChoices.push(["gpu", gpuLbl]);
    }
    if (cloudOpts.length > 0) {
      backendChoices.push(["cloud", "Cloud (per-shot i2v)"]);
      backendChoices.push(["hybrid", "Hybrid (per-shot GPU/Cloud)"]);
    }

    if (backendChoices.length === 0) {
      summary.textContent += " (no motion.backend modules installed)";
    } else {
    const GPU_LABEL = "finalize (" + gpuLbl + " + assemble)";
    const CLOUD_LABEL = "animate (cloud i2v)";
    const HYBRID_LABEL = "animate (hybrid)";
    const GPU_TITLE = "run " + gpuLbl + " on every keyframe + assemble silent MP4 (about 20 to 30 minutes)";
    const CLOUD_TITLE = "animate each keyframe with the selected cloud module + assemble a silent MP4";
    const HYBRID_TITLE = "animate per-shot across BOTH backends (" + gpuLbl + " + cloud i2v) and assemble one silent MP4";

    const motion = document.createElement("div");
    motion.className = "planner-motion-backend";

    const backendSel = document.createElement("select");
    backendSel.className = "planner-motion-backend-select";
    backendSel.title = "how to animate these keyframes into motion";
    backendChoices.forEach((pair) => {
      const o = document.createElement("option");
      o.value = pair[0];
      o.textContent = pair[1];
      backendSel.appendChild(o);
    });

    const cloudModelSel = document.createElement("select");
    cloudModelSel.className = "planner-motion-model-select";
    cloudModelSel.title = "default cloud motion module (per-shot overrides below)";
    cloudModelSel.style.display = "none";
    cloudOpts.forEach((pair) => {
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
        const perShot = {};
        li.querySelectorAll(".planner-keyframe-cloud-model").forEach((sel) => {
          if (sel.value && sel.value !== "gpu" && sel.dataset.shotId) {
            perShot[sel.dataset.shotId] = sel.value;
          }
        });
        animateCloudRender(r, finalizeBtn, cloudModelSel.value, perShot);
      } else if (mode === "hybrid") {
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
    }
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
    + "this runs " + keyframeLabel() + " only (no motion, no assembly) and overwrites the "
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
    + gpuMotionLabel() + " + assembly takes roughly " + minMinutes + " to "
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
    btnEl.textContent = "finalize (" + gpuMotionLabel() + " + assemble)";
    window.alert("finalize submit failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    btnEl.disabled = false;
    btnEl.textContent = "finalize (" + gpuMotionLabel() + " + assemble)";
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
    + gpuTotal + " shot(s) on " + gpuMotionLabel() + ", " + cloudN + " on cloud i2v"
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
          defaultCloudModel: (cloudModelOptions()[0] && cloudModelOptions()[0][0]) || "seedance",
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

// #757: cancel one in-flight render row via the same route the render panel
// uses (DELETE /api/storyboard/render/:jobId, keyed on job_id -- NOT the
// renders/:id delete route). Works for any non-terminal render regardless of
// who launched it (panel / slate / API / MCP). The route returns the poll view
// (with the now-CANCELLED status), not an { ok } envelope, so success is just a
// 2xx. Refreshes the list so the row flips to CANCELLED immediately.
async function cancelHistoryRow(row, btn) {
  if (!row.job_id) return;
  if (!window.confirm("cancel this in-flight render? the GPU job is stopped and cannot be resumed.")) return;

  if (btn) { btn.disabled = true; btn.textContent = "cancelling..."; }

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/render/" + encodeURIComponent(row.job_id),
      { method: "DELETE" },
    );
    data = await resp.json();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "cancel"; }
    window.alert("cancel failed: " + err.message);
    return;
  }

  if (!resp.ok) {
    const errMsg = (data && data.error) || ("HTTP " + resp.status);
    if (btn) { btn.disabled = false; btn.textContent = "cancel"; }
    window.alert("cancel failed: " + errMsg);
    return;
  }

  // Refresh so the row flips to CANCELLED immediately and the auto-refresh loop
  // re-arms from the new state.
  loadHistory();
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
      if (window.plannerRenderConfig && row.render_overrides.config) {
        window.plannerRenderConfig.restore(row.render_overrides);
      }
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

// v0.170.0: read the explicit stall signal Rollins' driver (#131) writes into
// output_json on IN_PROGRESS film-job rows. The field is ABSENT on healthy rows
// (treat missing as false) and present + true once the current phase has sat
// >20min with no advance (same threshold as KEYFRAME_STALL_SECONDS on the server).
// Source of truth: stallSignal() in src/film-render-bridge.ts.
// Do NOT compute staleness client-side from updated_at -- the sweep bumps it
// every minute regardless of real progress.
function isStalled(r) {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  if (terminal.indexOf(r.status) >= 0) return false;
  if (!r.output || typeof r.output !== "object") return false;
  return r.output.stalled === true;
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

