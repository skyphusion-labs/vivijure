// /cast page (v0.46.0). Persisted cast manager: list, create, edit name +
// bible, upload portrait, manage training-ref set, delete. All routes
// scoped per Cloudflare Access user_email server-side; this file owns no
// auth state.
//
// Vanilla JS, no framework, no bundler, matching the existing planner.js
// and app.js idiom. DOM-glue only; the pure helpers (encodeRefKey, etc.)
// are exported via window for vitest.

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const state = {
    cast: [],
    selectedId: null,
    dirty: false,
    // v0.90.0: per-edit-session set of source keys the user wants
    // attached to the NEXT portrait generation. Repopulated on every
    // populateEditor (default: include every persisted source); the
    // user can uncheck individual sources to skip them on one
    // generate without removing them from the row.
    sourceSelection: new Set(),
  };

  // The ref key path-segment can contain "/" (cast/<id>/refs/<uuid>.<ext>);
  // encodeURIComponent passes through "/", which the delete route's regex
  // catches via /^\/api\/cast\/(\d+)\/refs\/(.+)$/ on the server. We still
  // double-encode reserved chars defensively.
  function encodeRefKey(key) {
    return encodeURIComponent(key);
  }

  function artifactUrl(key) {
    if (!key) return "";
    // #625/demo: a portrait_key (or ref/source key) can be an ABSOLUTE showcase URL -- the public demo
    // studio seeds cast portraits from assets.skyphusion.net and binds NO R2. Return such a URL verbatim;
    // a normal relative R2 key still flows through the studio /api/artifact/ presign route as before, so
    // prod behavior is byte-identical. Same passthrough as planner-history-row.js artifactUrl.
    return /^https?:\/\//i.test(key) ? key : "/api/artifact/" + key;
  }

  function setListStatus(text, isError) {
    const el = $("#cast-list-status");
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  // Inline editor status (replaces the old window.alert error dialogs): errors render in the
  // page, styled by the shared .is-error class, and clear on the next selection or success.
  function setEditorStatus(text, isError) {
    const el = $("#cast-editor-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function setEditorVisible(visible) {
    $("#cast-editor").hidden = !visible;
    $("#cast-editor-empty").hidden = !!visible;
  }

  function markDirty(dirty) {
    state.dirty = !!dirty;
    $("#cast-save-btn").disabled = !dirty;
  }

  async function api(path, init) {
    const resp = await fetch(path, init);
    let data = null;
    try { data = await resp.json(); } catch { /* non-JSON */ }
    if (!resp.ok) {
      const msg = (data && data.error) || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // v0.132.1: the image providers' safety checker (FLUX-2 / nano-banana) can
  // false-positive ("3030 ... your output has been flagged ... choose another
  // prompt / input image") on perfectly fine inputs (e.g. a masked character
  // with a stylized weapon), and the flag has per-call nondeterminism since
  // each /api/chat image call rolls a fresh seed. Retry the call a couple of
  // times on a flag before surfacing it, so borderline-but-fine references do
  // not hard-fail on the first roll. Only safety flags are retried; every other
  // error (bad model, network, etc.) propagates immediately.
  function isFlaggedError(msg) {
    const s = String(msg || "").toLowerCase();
    return s.includes("3030")
      || s.includes("has been flagged")
      || s.includes("choose another prompt");
  }
  // v0.132.2: FLUX-2's safety checker deterministically over-flags some fine
  // inputs (masked / glowing-red-eyes characters) that Google's Nano Banana Pro
  // renders without complaint (verified: same portrait, flux-2-klein-9b +
  // flux-2-dev both 3030, nano-banana-pro 200). When the per-call retries
  // exhaust on a flag, fall back to this model once before surfacing the error,
  // so a borderline character does not dead-end on the model picker.
  const FLAG_FALLBACK_MODEL = "google/nano-banana-pro";

  function postChat(payload) {
    return api("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function chatImageWithRetry(payload, attempts) {
    const max = attempts || 3;
    let lastErr;
    for (let n = 0; n < max; n++) {
      try {
        return await postChat(payload);
      } catch (e) {
        lastErr = e;
        if (!isFlaggedError(e && e.message)) throw e;
      }
    }
    // Retries exhausted on a safety flag: try the more permissive model once,
    // unless that is already the model we were using.
    if (isFlaggedError(lastErr && lastErr.message) && payload.model !== FLAG_FALLBACK_MODEL) {
      try {
        return await postChat({ ...payload, model: FLAG_FALLBACK_MODEL });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  // #146: remember the most-recently-viewed character so a reload reopens it
  // (and its detail pane) instead of landing on an empty "pick a character".
  const LAST_VIEWED_LS = "cast-last-viewed";
  function readLastViewedId() {
    try {
      const raw = localStorage.getItem(LAST_VIEWED_LS);
      if (raw == null || raw === "") return null;
      // S9 (F13): a cast id is an opaque public id (UUID string); return it
      // verbatim. parseInt() would truncate a UUID to a bogus leading-digit
      // number (or NaN) and never match a real row.
      return raw;
    } catch (_) {
      return null;
    }
  }
  function writeLastViewedId(id) {
    try { localStorage.setItem(LAST_VIEWED_LS, String(id)); } catch (_) {}
  }

  async function loadCastList() {
    setListStatus("loading...");
    try {
      const data = await api("/api/cast");
      state.cast = Array.isArray(data.cast) ? data.cast : [];
      renderCastList();
      setListStatus(
        state.cast.length === 0
          ? "no characters yet. click + new character to start."
          : ""
      );
      // #146: open a character on load so the list highlight and the detail
      // pane are in sync from the start (most-recently-viewed if it still
      // exists, else the first). Only when nothing is selected yet, so a
      // reload after the user has already picked one is left alone.
      if (state.selectedId == null && state.cast.length > 0) {
        const pick = window.castSelect
          ? window.castSelect.pickInitialCastId(state.cast, readLastViewedId())
          : state.cast[0].id;
        if (pick != null) selectCast(pick);
      }
    } catch (e) {
      setListStatus("could not load cast: " + e.message, true);
    }
  }

  // Fill the dialogue-voice picker from the catalog (GET /api/voices). One source of truth on the
  // server (src/voices.ts); the "no voice (silent)" option is authored in the HTML and kept.
  async function loadVoices() {
    const sel = $("#cast-voice");
    if (!sel) return;
    try {
      const data = await api("/api/voices");
      const voices = Array.isArray(data.voices) ? data.voices : [];
      for (const v of voices) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.label;
        sel.appendChild(opt);
      }
    } catch (e) {
      // Non-fatal: the picker just stays at "no voice (silent)" if the catalog cannot load.
      console.warn("could not load voices:", e.message);
    }
  }

  function renderCastList() {
    const ul = $("#cast-list");
    ul.innerHTML = "";
    for (const c of state.cast) {
      const li = document.createElement("li");
      li.className = "cast-list-item";
      if (c.id === state.selectedId) li.classList.add("is-selected");
      li.dataset.castId = String(c.id);

      const thumb = document.createElement("div");
      thumb.className = "cast-list-thumb";
      if (c.portrait_key) {
        const img = document.createElement("img");
        img.src = artifactUrl(c.portrait_key);
        img.alt = c.name;
        img.loading = "lazy";
        thumb.appendChild(img);
      } else {
        thumb.textContent = c.name.slice(0, 2).toUpperCase();
        thumb.classList.add("is-placeholder");
      }
      li.appendChild(thumb);

      const meta = document.createElement("div");
      meta.className = "cast-list-meta";
      const name = document.createElement("div");
      name.className = "cast-list-name";
      name.textContent = c.name;
      meta.appendChild(name);
      const sub = document.createElement("div");
      sub.className = "cast-list-sub";
      const parts = [];
      if (c.ref_keys.length > 0) parts.push(c.ref_keys.length + " refs");
      if (!c.portrait_key) parts.push("no portrait");
      sub.textContent = parts.join(" · ") || "ready";
      meta.appendChild(sub);
      li.appendChild(meta);

      li.addEventListener("click", () => selectCast(c.id));
      ul.appendChild(li);
    }
    // v0.92.0: keep the multi-character scene pickers synced with the
    // cast list. Cheap enough to do on every renderCastList call.
    if (typeof populateMultiScenePickers === "function") {
      populateMultiScenePickers();
    }
  }

  function findCast(id) {
    return state.cast.find((c) => c.id === id) || null;
  }

  function populateEditor(c) {
    setEditorStatus("");
    $("#cast-name").value = c.name;
    $("#cast-bible").value = c.bible || "";
    $("#cast-voice").value = c.voice_id || "";
    $("#cast-slug").textContent = "/" + c.slug;
    updateExportLink(c); // #324: point the .vvcast download at this cast
    restoreTrainingStyle(c.id); // v0.135.13: per-character training art-style

    const img = $("#cast-portrait-img");
    const empty = $("#cast-portrait-empty");
    if (c.portrait_key) {
      img.src = artifactUrl(c.portrait_key);
      img.alt = c.name;
      img.hidden = false;
      empty.hidden = true;
      $("#cast-portrait-clear").disabled = false;
    } else {
      img.src = "";
      img.hidden = true;
      empty.hidden = false;
      $("#cast-portrait-clear").disabled = true;
    }

    const refs = $("#cast-refs-list");
    refs.innerHTML = "";
    for (const r of c.ref_keys) {
      const li = document.createElement("li");
      li.className = "cast-ref-item";
      const a = document.createElement("a");
      a.href = artifactUrl(r.key);
      a.target = "_blank";
      a.rel = "noopener";
      const img2 = document.createElement("img");
      img2.src = artifactUrl(r.key);
      img2.alt = "ref";
      img2.loading = "lazy";
      a.appendChild(img2);
      li.appendChild(a);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "cast-ref-delete";
      del.textContent = "remove";
      del.dataset.refKey = r.key;
      del.addEventListener("click", () => removeRef(r.key));
      li.appendChild(del);
      refs.appendChild(li);
    }

    // v0.90.0: render the persisted source/reference photos used as
    // FLUX.2 multi-reference inputs for portrait generation. Default
    // every source to "selected" on editor open; the per-thumbnail
    // checkbox lets the user skip individual sources for a single
    // generate without deleting them.
    const sources = c.source_keys || [];
    state.sourceSelection = new Set(sources.map((s) => s.key));
    renderSources(sources);

    markDirty(false);

    // v0.47.0: keep generation UI in sync with the freshly-populated row.
    // Clears any stale preview / progress from the previously-selected
    // character; the training-set button is gated on portrait_key.
    if (typeof updateTrainingGate === "function") {
      updateTrainingGate(c);
      hidePortraitGenPreview();
      setPortraitGenStatus("");
      setTrainingStatus("");
      const prog = document.getElementById("cast-training-progress");
      if (prog) prog.innerHTML = "";
    }

    // v0.57.0: render the LoRA training pane state.
    renderLoraPane(c);
    if (c.lora_status === "training") {
      schedulePollLoraStatus(c.id);
    }
  }

  function selectCast(id) {
    if (state.dirty) {
      if (!window.confirm("you have unsaved changes. discard?")) return;
    }
    state.selectedId = id;
    const c = findCast(id);
    if (!c) {
      setEditorVisible(false);
      renderCastList();
      return;
    }
    writeLastViewedId(id); // #146: persist most-recently-viewed for reloads
    setEditorVisible(true);
    populateEditor(c);
    renderCastList();
  }

  // #324: point the export link at the selected cast and label the download
  // with its slug. GET /api/cast/export/:id is a side-effect-free download, so
  // a plain <a download> link is all the happy path needs. The server sets
  // Content-Disposition; the download attr is the matching browser fallback.
  function updateExportLink(c) {
    const link = $("#cast-export-link");
    if (!link) return;
    if (!c) {
      link.hidden = true;
      link.removeAttribute("href");
      return;
    }
    link.href = "/api/cast/export/" + c.id;
    link.setAttribute("download", (c.slug || "cast") + ".vvcast");
    link.hidden = false;
  }

  // #324: import a .vvcast bundle. POST the raw file bytes; on 201 the new cast
  // joins the list and opens, on failure the server's ACTUAL error message is
  // surfaced (fail loud: no fake success, no swallowing the error). All status
  // text flows through setListStatus -> textContent, so an untrusted imported
  // cast name or server error string can never inject markup (no XSS).
  async function importBundle(file) {
    if (!file) return;
    setListStatus("importing " + file.name + "...");
    try {
      // Body is the raw file bytes. Content-Type is not enforced by the
      // importer (the bytes are magic-validated via the manifest), so we let
      // the browser send the file blob as-is.
      const data = await api("/api/cast/import", { method: "POST", body: file });
      const cast = data && data.cast;
      if (!cast) throw new Error("import returned no cast");
      state.cast.unshift(cast);
      selectCast(cast.id);
      setListStatus("imported " + cast.name + ".");
    } catch (e) {
      setListStatus("import failed: " + e.message, true);
    }
  }

  async function newCast() {
    const name = window.prompt("character name?");
    if (!name || !name.trim()) return;
    try {
      const data = await api("/api/cast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      state.cast.unshift(data.cast);
      selectCast(data.cast.id);
    } catch (e) {
      setListStatus("Could not create the character: " + e.message, true);
    }
  }

  async function saveCast() {
    const id = state.selectedId;
    if (!id) return;
    const name = $("#cast-name").value.trim();
    const bible = $("#cast-bible").value;
    const voice_id = $("#cast-voice").value; // "" clears the voice
    if (!name) {
      setEditorStatus("Name cannot be empty.", true);
      return;
    }
    try {
      const data = await api("/api/cast/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, bible, voice_id }),
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      markDirty(false);
      setEditorStatus("");
      renderCastList();
      $("#cast-slug").textContent = "/" + data.cast.slug;
      updateExportLink(data.cast); // #324: slug may have changed; refresh filename
    } catch (e) {
      setEditorStatus("Save failed: " + e.message, true);
    }
  }

  async function deleteSelected() {
    const id = state.selectedId;
    if (!id) return;
    const c = findCast(id);
    if (!c) return;
    if (!window.confirm("delete " + c.name + "? this removes the portrait and all reference images.")) return;
    try {
      await api("/api/cast/" + id, { method: "DELETE" });
      state.cast = state.cast.filter((x) => x.id !== id);
      state.selectedId = null;
      setEditorVisible(false);
      renderCastList();
    } catch (e) {
      setEditorStatus("Delete failed: " + e.message, true);
    }
  }

  async function uploadBytes(file) {
    const up = await api("/api/upload", {
      method: "POST",
      headers: { "content-type": file.type || "image/octet-stream" },
      body: file,
    });
    if (!up || !up.key) throw new Error("upload: no key returned");
    return { key: up.key, mime: up.mime || file.type };
  }

  async function uploadPortraitFile(file) {
    const id = state.selectedId;
    if (!id || !file) return;
    try {
      const { key, mime } = await uploadBytes(file);
      const data = await api("/api/cast/" + id + "/portrait", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, mime }),
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      setEditorStatus("Portrait upload failed: " + e.message, true);
    }
  }

  async function clearPortrait() {
    const id = state.selectedId;
    if (!id) return;
    if (!window.confirm("clear the portrait?")) return;
    try {
      const data = await api("/api/cast/" + id + "/portrait", { method: "DELETE" });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      setEditorStatus("Could not clear the portrait: " + e.message, true);
    }
  }

  // v0.90.0: source-photo helpers. Mirror the ref upload/remove path
  // but write to /api/cast/:id/sources and the source_keys array.

  function renderSources(sources) {
    const list = $("#cast-sources-list");
    if (!list) return;
    list.innerHTML = "";
    for (const s of sources) {
      const li = document.createElement("li");
      li.className = "cast-source-item";
      const label = document.createElement("label");
      label.className = "cast-source-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.sourceSelection.has(s.key);
      cb.addEventListener("change", () => {
        if (cb.checked) state.sourceSelection.add(s.key);
        else state.sourceSelection.delete(s.key);
        // v0.91.0: training-set gate copy reflects selected sources;
        // refresh on every toggle.
        const c = findCast(state.selectedId);
        if (c && typeof updateTrainingGate === "function") updateTrainingGate(c);
      });
      label.appendChild(cb);
      const img = document.createElement("img");
      img.src = artifactUrl(s.key);
      img.alt = "source";
      img.loading = "lazy";
      label.appendChild(img);
      li.appendChild(label);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "cast-ref-delete";
      del.textContent = "remove";
      del.dataset.sourceKey = s.key;
      del.addEventListener("click", () => removeSource(s.key));
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  async function uploadSourceFile(file) {
    const id = state.selectedId;
    if (!id || !file) return;
    try {
      const { key, mime } = await uploadBytes(file);
      const data = await api("/api/cast/" + id + "/source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, mime }),
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      setEditorStatus("Source photo upload failed: " + e.message, true);
    }
  }

  async function removeSource(key) {
    const id = state.selectedId;
    if (!id) return;
    if (!window.confirm("remove this source photo?")) return;
    try {
      const data = await api("/api/cast/" + id + "/source/" + encodeRefKey(key), {
        method: "DELETE",
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      setEditorStatus("Could not remove the source photo: " + e.message, true);
    }
  }

  async function uploadRefFile(file) {
    const id = state.selectedId;
    if (!id || !file) return;
    try {
      const { key, mime } = await uploadBytes(file);
      const data = await api("/api/cast/" + id + "/ref", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, mime }),
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      setEditorStatus("Reference image upload failed: " + e.message, true);
    }
  }

  async function removeRef(key) {
    const id = state.selectedId;
    if (!id) return;
    if (!window.confirm("remove this reference image?")) return;
    try {
      const data = await api("/api/cast/" + id + "/refs/" + encodeRefKey(key), {
        method: "DELETE",
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      setEditorStatus("Could not remove the reference image: " + e.message, true);
    }
  }

  // ---------- v0.47.0: portrait + training-set generation via /api/chat ----------

  // v0.65.0: The training-set generator needs a model that identity-conditions
  // on the saved portrait via the attachments path. Empirically (verified
  // against /api/chat output) the multi-reference behavior is shared across
  // the FLUX 2 family - both Dev AND the two Klein variants accept the
  // attached portrait and produce output that locks the subject's identity
  // (hair color, skin tone, eyes, clothing). gpt-image-1.5 accepts the
  // attachment but IGNORES it for identity, so it is not surfaced here.
  // v0.135.11: nano-banana-pro is now offered too. The earlier "ignores
  // identity" verdict was drawn from photoreal testing; for ANIME subjects it
  // locks identity well (confirmed in use), and it does not over-flag on
  // content the way FLUX 2 does (the 3030 path). FLUX Klein-9b stays the
  // default (safe for photoreal too); pick nano-banana for anime characters.
  //
  // Pre-v0.65 this was hardcoded to flux-2-dev based on a stale catalog
  // comment claiming Dev was the only multi-reference model. That cost us
  // the ability to fall back to a Klein variant when the FLUX 2 Dev gateway
  // was flaking with 502s, which is exactly what happened during the
  // post-v0.60 smoke test. The picker defaults to Klein-9b (frontier
  // quality, better gateway availability lately) but the user can switch
  // back to Dev or down to the faster Klein-4b.
  const TRAINING_MODELS = [
    { id: "@cf/black-forest-labs/flux-2-klein-9b", label: "FLUX 2 Klein 9B (frontier, recommended)" },
    { id: "google/nano-banana-pro",                label: "Nano Banana Pro (Google; strong anime identity, no over-flag)" },
    { id: "@cf/black-forest-labs/flux-2-klein-4b", label: "FLUX 2 Klein 4B (faster)" },
    { id: "@cf/black-forest-labs/flux-2-dev",       label: "FLUX 2 Dev (original multi-reference)" },
  ];
  const DEFAULT_TRAINING_MODEL_ID = TRAINING_MODELS[0].id;
  const FLUX2_REF_MAX_DIM = 512;

  // 10 training templates spanning orthogonal axes: framing (close-up,
  // medium, three-quarter, full-body, profile), camera angle (eye-level,
  // low, high, slight tilt), lighting (studio neutral, golden hour, side
  // window, dramatic side, harsh midday, warm interior), expression
  // (neutral, slight smile, serious, contemplative), pose (standing,
  // sitting, mid-action), and background (clean grey, blurred outdoor,
  // neutral indoor, plain wall, soft bokeh).
  //
  // v0.64.0: the pre-v0.64 set was 8/10 "portrait, ... clean background"
  // with tiny expression/lighting tweaks, producing near-duplicate
  // training images. The LoRA overfit on the clean-background-portrait
  // distribution rather than identity, so the GPU-side LoRA quality gate
  // ssim scored ~0 on the smoke-test cast. Diversifying the prompts
  // forces the LoRA to learn the subject's identity independent of any
  // single framing or lighting choice.
  const TRAINING_PROMPTS = [
    "close-up portrait, neutral expression, eye level, soft studio lighting, clean grey background",
    "medium shot, three-quarter angle, looking forward, golden-hour outdoor lighting, blurred natural background",
    "full-body shot, standing pose, hands at sides, even daylight, plain neutral indoor space",
    "profile shot looking left, shoulders-up framing, soft window light from the side, plain wall background",
    "three-quarter shot from slightly above, looking down, warm interior lighting, soft bokeh background",
    "medium close-up, slight smile, looking off to the right, overcast natural daylight, outdoor blurred treeline",
    "close-up portrait, serious expression, looking at camera, dramatic side lighting from the right, dark backdrop",
    "medium shot, dynamic mid-action pose, looking forward, harsh midday sunlight, plain background",
    "three-quarter shot, sitting on a stool, looking thoughtfully to the side, warm indoor lamp lighting, plain dark background",
    "close-up portrait, slight head tilt, looking up at the camera, soft natural window light, plain background",
  ];

  // Build the prompt sent to /api/chat: pose template, then a separator,
  // then the bible (capped so the upstream prompt limit holds). Pure for
  // vitest.
  // v0.135.13: lead with an EXPLICIT art style when the user sets one. The
  // templates above are photographic ("studio lighting", "golden hour"), and
  // nano-banana-pro weights the text over the attached reference image, so an
  // anime portrait produced photoreal training refs. A "match the reference
  // image" instruction does NOT fix this (verified by generating both: still
  // photoreal); stating the style outright does (verified: clean anime). When
  // `style` is set (e.g. "anime") we lead with it; blank keeps the templates
  // as-is, which is correct for photoreal characters.
  function composeTrainingPrompt(template, bible, style) {
    const safeStyle = String(style || "").trim();
    const lead = safeStyle ? safeStyle + " art style, " + safeStyle + " illustration. " : "";
    const safeBible = String(bible || "").trim();
    if (!safeBible) return lead + template;
    // Cap bible at ~600 chars so the joined prompt stays comfortably
    // under the typical 1500-char gateway limit even with overhead.
    const trimmed = safeBible.length > 600 ? safeBible.slice(0, 600) : safeBible;
    return lead + template + ". " + trimmed;
  }

  // Downscale an image to fit within FLUX2_REF_MAX_DIM on the long edge,
  // preserving aspect. Returns a data URL (image/png). FLUX 2's schema
  // caps inputs at 512x512; sending bigger gets rejected upstream.
  async function downscaleToDataUrl(blob, maxDim) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = (e) => reject(new Error("image decode failed"));
        el.src = url;
      });
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      const scale = longest > maxDim ? maxDim / longest : 1;
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function fetchPortraitAsDataUrl(portraitKey) {
    const resp = await fetch(artifactUrl(portraitKey));
    if (!resp.ok) throw new Error("could not fetch portrait: HTTP " + resp.status);
    const blob = await resp.blob();
    return downscaleToDataUrl(blob, FLUX2_REF_MAX_DIM);
  }

  let imageModelsCache = null;

  async function loadImageModels() {
    if (imageModelsCache) return imageModelsCache;
    const data = await api("/api/models");
    imageModelsCache = (data.models || []).filter((m) => m.type === "image");
    return imageModelsCache;
  }

  // v0.65.0: populate the training-set model dropdown once at page load.
  // Pure DOM init - no network fetch needed; the list is static.
  function ensureTrainingModelOptions() {
    const sel = $("#cast-training-model");
    if (!sel || sel.options.length > 0) return;
    for (const m of TRAINING_MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
    sel.value = DEFAULT_TRAINING_MODEL_ID;
  }

  function getSelectedTrainingModelId() {
    const sel = $("#cast-training-model");
    return (sel && sel.value) || DEFAULT_TRAINING_MODEL_ID;
  }

  // v0.135.13: per-character training art-style, remembered in localStorage
  // (no D1 column needed). Read at gen time, restored when a character is
  // selected, persisted on edit.
  const TRAINING_STYLE_LS = "cast-training-style-";
  function getTrainingStyle() {
    const el = $("#cast-training-style");
    return (el && el.value.trim()) || "";
  }
  function restoreTrainingStyle(castId) {
    const el = $("#cast-training-style");
    if (!el) return;
    let v = "";
    try { v = (castId != null && localStorage.getItem(TRAINING_STYLE_LS + castId)) || ""; } catch (_) {}
    el.value = v;
  }
  function persistTrainingStyle() {
    const el = $("#cast-training-style");
    if (!el || state.selectedId == null) return;
    try { localStorage.setItem(TRAINING_STYLE_LS + state.selectedId, el.value.trim()); } catch (_) {}
  }

  // Portrait-gen uses the same static image-gen catalog as training (FLUX 2 / Nano Banana).
  // No fetch: the old /api/models route 404'd, and /api/storyboard/models serves LLM planning
  // models (type "text"), not image-gen -- so the filtered list was always empty anyway.
  async function ensurePortraitGenModelOptions() {
    const sel = $("#cast-portrait-gen-model");
    if (sel.options.length > 0) return;
    for (const m of TRAINING_MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      sel.appendChild(opt);
    }
    sel.value = DEFAULT_TRAINING_MODEL_ID;
  }

  // Portrait gen state (one in-flight at a time per character).
  const portraitGen = {
    pendingKey: null,
    busy: false,
  };

  function setPortraitGenStatus(text, isError) {
    const el = $("#cast-portrait-gen-status");
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function showPortraitGenPreview(key) {
    portraitGen.pendingKey = key;
    const img = $("#cast-portrait-gen-img");
    img.src = artifactUrl(key);
    $("#cast-portrait-gen-preview").hidden = false;
  }

  function hidePortraitGenPreview() {
    portraitGen.pendingKey = null;
    $("#cast-portrait-gen-img").src = "";
    $("#cast-portrait-gen-preview").hidden = true;
  }

  async function generatePortrait() {
    const id = state.selectedId;
    if (!id) return;
    if (portraitGen.busy) return;
    const c = findCast(id);
    if (!c) return;
    const modelId = $("#cast-portrait-gen-model").value;
    if (!modelId) {
      setPortraitGenStatus("pick an image-gen model first", true);
      return;
    }
    const promptInput = $("#cast-portrait-gen-prompt").value.trim();
    const prompt = promptInput || c.bible || c.name;
    if (!prompt) {
      setPortraitGenStatus("write a prompt or a bible first", true);
      return;
    }
    portraitGen.busy = true;
    $("#cast-portrait-gen-btn").disabled = true;
    hidePortraitGenPreview();
    try {
      // v0.90.0: attach the user-selected source photos as FLUX.2
      // multi-reference inputs. FLUX 2 accepts up to 4 input images
      // per call (the worker enforces the cap server-side too);
      // we take the first 4 selected sources. Sources live in R2
      // already, so we fetch + downscale each to a 512px data URL
      // before stuffing them into the attachments array (the chat
      // path expects data URLs in this shape).
      const sources = (c.source_keys || []).filter((s) => state.sourceSelection.has(s.key)).slice(0, 4);
      const attachments = [];
      if (sources.length > 0) {
        setPortraitGenStatus(`preparing ${sources.length} reference${sources.length === 1 ? "" : "s"}...`);
        for (const s of sources) {
          const dataUrl = await fetchPortraitAsDataUrl(s.key);
          attachments.push({
            type: "image",
            data: dataUrl,
            mime: "image/png",
            filename: "reference.png",
          });
        }
      }
      setPortraitGenStatus(sources.length > 0
        ? `generating with ${sources.length} reference${sources.length === 1 ? "" : "s"} (10-40s)...`
        : "generating (10-40s depending on model)...");
      const result = await chatImageWithRetry({
        model: modelId,
        user_input: prompt,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      const oa = result && result.output_artifact;
      if (!oa || oa.type !== "image" || !oa.key) {
        throw new Error("model did not return an image artifact");
      }
      showPortraitGenPreview(oa.key);
      setPortraitGenStatus("preview ready. accept to save as the portrait.");
    } catch (e) {
      setPortraitGenStatus("generation failed: " + e.message, true);
    } finally {
      portraitGen.busy = false;
      $("#cast-portrait-gen-btn").disabled = false;
    }
  }

  async function acceptGeneratedPortrait() {
    const id = state.selectedId;
    const key = portraitGen.pendingKey;
    if (!id || !key) return;
    try {
      const data = await api("/api/cast/" + id + "/portrait", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_chat_artifact: key }),
      });
      const idx = state.cast.findIndex((x) => x.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
      hidePortraitGenPreview();
      setPortraitGenStatus("");
    } catch (e) {
      setPortraitGenStatus("could not save: " + e.message, true);
    }
  }

  // Training-set state.
  const training = {
    busy: false,
    abort: false,
  };

  function setTrainingStatus(text, isError) {
    const el = $("#cast-training-status");
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  // v0.91.0: training-set generator now accepts EITHER the saved
  // portrait OR the selected v0.90.0 sources as reference material.
  // Gate is enabled when either is present. selectedTrainingSources()
  // returns the [{key, mime}] list that generateTrainingSet should
  // attach as FLUX 2 multi-reference inputs; empty array means "no
  // sources selected, use the saved portrait" (previous behavior).
  function selectedTrainingSources(c) {
    if (!c || !Array.isArray(c.source_keys)) return [];
    return c.source_keys.filter((s) => state.sourceSelection.has(s.key)).slice(0, 4);
  }

  function updateTrainingGate(c) {
    const usingSources = selectedTrainingSources(c);
    const hasPortrait = !!(c && c.portrait_key);
    const hasUsableRef = hasPortrait || usingSources.length > 0;
    const disabled = !c || !hasUsableRef;
    $("#cast-training-btn").disabled = disabled || training.busy;
    const hint = $("#cast-training-disabled");
    if (!hint) return;
    hint.hidden = !disabled;
    if (disabled) {
      hint.textContent = "save a portrait OR upload at least one reference photo above to enable this.";
      hint.classList.remove("cast-gen-status-ok");
    } else if (usingSources.length > 0) {
      hint.hidden = false;
      hint.textContent = `will use ${usingSources.length} selected source${usingSources.length === 1 ? "" : "s"} as the reference for all 10 training shots.`;
      hint.classList.add("cast-gen-status-ok");
    } else if (hasPortrait) {
      hint.hidden = false;
      hint.textContent = "will use the saved portrait as the reference (uncheck a source above to skip it, or check sources to override).";
      hint.classList.add("cast-gen-status-ok");
    }
  }

  // v0.158.0: the training set is generated SERVER-SIDE by the cast.image
  // module now, not by this per-image client loop against /api/chat. The
  // browser starts a job (POST .../generate-refs) and polls it to done (GET
  // .../refs-job/:jobId); the module presigns the portrait/sources, renders
  // the 10-prompt set a few images at a time, and the core registers them onto
  // the cast member when the run finishes. No more client-side downscaling or
  // chat-artifact plumbing -- the prompt set + composition live in the module.
  async function generateTrainingSet() {
    const id = state.selectedId;
    if (!id) return;
    const c = findCast(id);
    if (!c) return;
    if (training.busy) return;

    // v0.91.0: prefer the user-selected v0.90.0 sources over the saved
    // portrait when any are checked. If neither is available, refuse.
    const sourcesToUse = selectedTrainingSources(c);
    const useSources = sourcesToUse.length > 0;
    if (!useSources && !c.portrait_key) {
      setTrainingStatus("save a portrait or pick at least one source above first", true);
      return;
    }
    const refLabel = useSources
      ? `${sourcesToUse.length} selected source${sourcesToUse.length === 1 ? "" : "s"}`
      : "the saved portrait";
    if (!window.confirm(`generate ${TRAINING_PROMPTS.length} training images using ${refLabel} as the reference? this takes about 2-4 minutes -- keep this tab open while it runs.`)) return;

    training.busy = true;
    training.abort = false;
    $("#cast-training-btn").disabled = true;
    $("#cast-training-progress").innerHTML = "";
    setTrainingStatus("starting...");

    try {
      const start = await api("/api/cast/" + id + "/generate-refs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { model: getSelectedTrainingModelId(), num_images: TRAINING_PROMPTS.length },
          art_style: getTrainingStyle() || undefined,
          source_keys: useSources ? sourcesToUse.map((s) => s.key) : undefined,
        }),
      });
      if (start.phase === "failed") throw new Error(start.error || "could not start generation");
      const jobId = start.job_id;
      setTrainingStatus("generating training set (about 2-4 minutes)...");

      // Poll to a terminal phase. Each GET drives one image render server-side,
      // so the request itself is slow; a short gap between polls is plenty. The
      // loop cap is a generous backstop above the image count.
      let job = start;
      const maxPolls = TRAINING_PROMPTS.length * 4 + 10;
      for (let i = 0; i < maxPolls && !training.abort; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        job = await api("/api/cast/" + id + "/refs-job/" + encodeURIComponent(jobId));
        if (job.phase !== "generating") break;
      }

      if (training.abort) {
        setTrainingStatus("stopped polling. the run may still finish server-side; reopen this character to see saved refs.");
      } else if (job.phase === "failed") {
        throw new Error(job.error || "generation failed");
      } else if (job.phase === "done") {
        const n = job.registered || 0;
        setTrainingStatus(n + " training image" + (n === 1 ? "" : "s") + " saved.", n === 0);
      } else {
        setTrainingStatus("still running; reopen this character shortly to see the saved refs.", true);
      }

      // Refresh the cast member so the newly-registered refs render.
      const refreshed = await api("/api/cast/" + id);
      if (refreshed && refreshed.cast) {
        const idx = state.cast.findIndex((x) => x.id === id);
        if (idx >= 0) state.cast[idx] = refreshed.cast;
        populateEditor(refreshed.cast);
        renderCastList();
      }
    } catch (e) {
      setTrainingStatus("generation failed: " + e.message, true);
    } finally {
      training.busy = false;
      updateTrainingGate(findCast(id));
    }
  }

  // ---------- v0.92.0: multi-character scene preview ----------
  //
  // Pick two cast members, write a scene prompt, get one composed
  // image via FLUX 2 multi-reference (each character's saved portrait
  // becomes one of the input images; FLUX 2 accepts up to 4 total).
  // No D1 / R2 writes; the result lives only as a chat artifact, with
  // download. Distinct from the planner's regional render path - this
  // is the fast 2D preview tool, the planner is for video.

  const multiScene = { busy: false, pendingKey: null, model: null };

  function populateMultiScenePickers() {
    const aSel = $("#cast-multi-a");
    const bSel = $("#cast-multi-b");
    if (!aSel || !bSel) return;
    // Preserve current selection across refreshes so a new-cast-create
    // or save does not nuke whatever the user was lining up.
    const prevA = aSel.value;
    const prevB = bSel.value;
    const opts = state.cast
      .map((c) => `<option value="${c.id}">${escapeForOption(c.name)}</option>`)
      .join("");
    const empty = "<option value=''>(none)</option>";
    aSel.innerHTML = empty + opts;
    bSel.innerHTML = empty + opts;
    aSel.value = prevA && state.cast.some((c) => String(c.id) === prevA) ? prevA : "";
    bSel.value = prevB && state.cast.some((c) => String(c.id) === prevB) ? prevB : "";
    updateMultiSceneGate();
  }

  // #339 (F6 hardening): a COMPLETE HTML-entity escaper. Escapes the five
  // characters that can break out of element text OR a double-quoted attribute
  // value (& < > " '), so a crafted cast name can never inject markup or break
  // out of the <option value="..."> we build by string concat. The single
  // quote was previously omitted; harmless given the only attribute here is a
  // numeric id in double quotes, but a complete escaper removes the latent
  // sink for any future reuse. ' uses the numeric &#39; (HTML4-safe; &apos; is
  // not).
  function escapeForOption(s) {
    return String(s || "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function multiSceneRefFor(cast) {
    if (!cast) return null;
    if (cast.portrait_key) return { key: cast.portrait_key, mime: cast.portrait_mime || "image/png" };
    if (Array.isArray(cast.source_keys) && cast.source_keys.length > 0) return cast.source_keys[0];
    return null;
  }

  function updateMultiSceneGate() {
    // S9 (F13): the option value is a cast opaque public id (UUID string).
    const aId = $("#cast-multi-a") && $("#cast-multi-a").value;
    const bId = $("#cast-multi-b") && $("#cast-multi-b").value;
    const a = aId ? findCast(aId) : null;
    const b = bId ? findCast(bId) : null;
    const prompt = ($("#cast-multi-prompt") || {}).value || "";
    const model = $("#cast-multi-model") && $("#cast-multi-model").value;
    const aRef = multiSceneRefFor(a);
    const bRef = multiSceneRefFor(b);
    let reason = "";
    if (!a || !b) reason = "pick two characters";
    else if (a.id === b.id) reason = "pick two different characters";
    else if (!aRef) reason = `${a.name} needs a portrait or a source photo first`;
    else if (!bRef) reason = `${b.name} needs a portrait or a source photo first`;
    else if (!prompt.trim()) reason = "write a scene prompt";
    else if (!model) reason = "pick a model";
    const btn = $("#cast-multi-gen-btn");
    if (btn) btn.disabled = !!reason || multiScene.busy;
    const status = $("#cast-multi-gen-status");
    if (status && !multiScene.busy) status.textContent = reason;
  }

  async function ensureMultiSceneModels() {
    const sel = $("#cast-multi-model");
    if (!sel || sel.options.length > 0) return;
    for (const m of TRAINING_MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
    sel.value = DEFAULT_TRAINING_MODEL_ID;
    updateMultiSceneGate();
  }

  function showMultiScenePreview(key) {
    multiScene.pendingKey = key;
    const url = artifactUrl(key);
    const img = $("#cast-multi-img");
    const dl = $("#cast-multi-download");
    if (img) img.src = url;
    if (dl) dl.href = url;
    $("#cast-multi-preview").hidden = false;
  }

  function hideMultiScenePreview() {
    multiScene.pendingKey = null;
    const img = $("#cast-multi-img");
    if (img) img.src = "";
    const preview = $("#cast-multi-preview");
    if (preview) preview.hidden = true;
  }

  async function generateMultiScene() {
    if (multiScene.busy) return;
    const aId = $("#cast-multi-a").value;
    const bId = $("#cast-multi-b").value;
    const a = findCast(aId);
    const b = findCast(bId);
    const promptInput = $("#cast-multi-prompt").value.trim();
    const modelId = $("#cast-multi-model").value;
    const aRef = multiSceneRefFor(a);
    const bRef = multiSceneRefFor(b);
    if (!a || !b || a.id === b.id || !aRef || !bRef || !promptInput || !modelId) {
      updateMultiSceneGate();
      return;
    }

    multiScene.busy = true;
    $("#cast-multi-gen-btn").disabled = true;
    const status = $("#cast-multi-gen-status");
    if (status) status.textContent = `loading references for ${a.name} + ${b.name}...`;
    hideMultiScenePreview();

    let aData, bData;
    try {
      aData = await fetchPortraitAsDataUrl(aRef.key);
      bData = await fetchPortraitAsDataUrl(bRef.key);
    } catch (e) {
      if (status) status.textContent = "could not load references: " + e.message;
      multiScene.busy = false;
      $("#cast-multi-gen-btn").disabled = false;
      return;
    }

    // Bias the prompt with the cast names so the model knows who is
    // who. Appearance details stay out (those come from the reference
    // images), matching the v0.88.0 storyboard convention.
    const effectivePrompt = `${a.name} and ${b.name}. ${promptInput}`;
    if (status) status.textContent = "generating (10-40s depending on model)...";

    try {
      const result = await chatImageWithRetry({
        model: modelId,
        user_input: effectivePrompt,
        attachments: [
          { type: "image", mime: aRef.mime || "image/png", filename: `${a.slug || "a"}.png`, data: aData },
          { type: "image", mime: bRef.mime || "image/png", filename: `${b.slug || "b"}.png`, data: bData },
        ],
      });
      const oa = result && result.output_artifact;
      if (!oa || oa.type !== "image" || !oa.key) throw new Error("model did not return an image");
      showMultiScenePreview(oa.key);
      if (status) status.textContent = "preview ready. download to keep, discard to retry.";
    } catch (e) {
      if (status) status.textContent = "generation failed: " + e.message;
    } finally {
      multiScene.busy = false;
      updateMultiSceneGate();
    }
  }

  function wire() {
    $("#cast-new-btn").addEventListener("click", newCast);
    const importFile = $("#cast-import-file"); // #324: import a .vvcast bundle
    if (importFile) {
      importFile.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        importBundle(f);
        e.target.value = ""; // reset so the same file can be re-picked
      });
    }
    $("#cast-save-btn").addEventListener("click", saveCast);
    $("#cast-delete-btn").addEventListener("click", deleteSelected);
    $("#cast-portrait-clear").addEventListener("click", clearPortrait);

    $("#cast-name").addEventListener("input", () => markDirty(true));
    $("#cast-bible").addEventListener("input", () => markDirty(true));
    $("#cast-voice").addEventListener("change", () => markDirty(true));
    $("#cast-training-style").addEventListener("input", persistTrainingStyle); // v0.135.13

    $("#cast-portrait-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadPortraitFile(f);
      e.target.value = "";
    });
    $("#cast-ref-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadRefFile(f);
      e.target.value = "";
    });
    // v0.90.0: source/reference photo uploader for the portrait
    // generator. Drops uploads directly into env.R2_RENDERS under
    // cast/<id>/sources/.
    const sourceFile = $("#cast-source-file");
    if (sourceFile) {
      sourceFile.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) uploadSourceFile(f);
        e.target.value = "";
      });
    }

    // v0.47.0: portrait + training-set generation.
    $("#cast-portrait-gen-btn").addEventListener("click", generatePortrait);
    $("#cast-portrait-gen-accept").addEventListener("click", acceptGeneratedPortrait);
    $("#cast-portrait-gen-discard").addEventListener("click", () => {
      hidePortraitGenPreview();
      setPortraitGenStatus("");
    });
    $("#cast-training-btn").addEventListener("click", generateTrainingSet);
    // v0.57.0: standalone LoRA training.
    const loraBtn = $("#cast-lora-train-btn");
    if (loraBtn) loraBtn.addEventListener("click", trainLora);

    // v0.90.0: portrait-gen lives in a first-class <section> now (no
    // <details> wrapper), so populate the model picker eagerly. Same
    // for the training-set model picker.
    ensurePortraitGenModelOptions();
    ensureTrainingModelOptions();
    const trainingDetails = $("#cast-training-block");
    if (trainingDetails) {
      trainingDetails.addEventListener("toggle", () => {
        if (trainingDetails.open) ensureTrainingModelOptions();
      }, { once: false });
    }

    // v0.92.0: multi-character scene preview wirings.
    populateMultiScenePickers();
    ensureMultiSceneModels();
    const multiA = $("#cast-multi-a");
    const multiB = $("#cast-multi-b");
    const multiPrompt = $("#cast-multi-prompt");
    const multiModel = $("#cast-multi-model");
    if (multiA) multiA.addEventListener("change", updateMultiSceneGate);
    if (multiB) multiB.addEventListener("change", updateMultiSceneGate);
    if (multiPrompt) multiPrompt.addEventListener("input", updateMultiSceneGate);
    if (multiModel) multiModel.addEventListener("change", updateMultiSceneGate);
    const multiBtn = $("#cast-multi-gen-btn");
    if (multiBtn) multiBtn.addEventListener("click", generateMultiScene);
    const multiDiscard = $("#cast-multi-discard");
    if (multiDiscard) multiDiscard.addEventListener("click", () => {
      hideMultiScenePreview();
      const status = $("#cast-multi-gen-status");
      if (status) status.textContent = "";
    });
  }

  // ---------- v0.57.0: standalone LoRA training ----------

  const LORA_POLL_MS = 5000;
  let loraPollTimer = null;
  let loraPollInflight = false;

  function timeAgoSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 60) return Math.floor(seconds) + "s";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
    return Math.floor(seconds / 86400) + "d";
  }

  function setLoraStatusText(text, kind) {
    const el = $("#cast-lora-status-text");
    if (!el) return;
    el.textContent = text || "";
    el.className = "cast-gen-status" + (kind ? " is-" + kind : "");
  }

  function renderLoraPane(c) {
    const badge = $("#cast-lora-badge");
    const meta = $("#cast-lora-meta");
    const btn = $("#cast-lora-train-btn");
    const dl = $("#cast-lora-download");
    if (!badge || !meta || !btn || !dl) return;
    if (!c) {
      badge.textContent = "idle";
      badge.className = "cast-lora-badge cast-lora-badge-idle";
      meta.textContent = "";
      btn.disabled = true;
      dl.hidden = true;
      setLoraStatusText("");
      return;
    }
    const status = c.lora_status || "idle";
    badge.textContent = status;
    badge.className = "cast-lora-badge cast-lora-badge-" + status;
    // Meta text: ready -> "trained Xm ago, N.M MB"; training -> job id
    // tail; failed -> show the error (truncated); idle -> nothing.
    let metaText = "";
    if (status === "ready" && c.lora_trained_at) {
      const trained = new Date(c.lora_trained_at + "Z");
      const ageS = (Date.now() - trained.getTime()) / 1000;
      metaText = "trained " + timeAgoSeconds(ageS) + " ago";
    } else if (status === "training" && c.lora_job_id) {
      metaText = "job " + c.lora_job_id.slice(0, 18) + "…";
    } else if (status === "failed" && c.lora_error) {
      metaText = c.lora_error.slice(0, 120) + (c.lora_error.length > 120 ? "…" : "");
    }
    meta.textContent = metaText;
    // Train button enabled when we have the inputs and no run is in
    // flight. Retraining (status: ready / failed) is allowed.
    const ready = !!c.portrait_key && Array.isArray(c.ref_keys) && c.ref_keys.length >= 4;
    btn.disabled = status === "training" || !ready;
    btn.textContent = status === "ready" || status === "failed" ? "retrain LoRA" : "train LoRA";
    if (status === "ready" && c.lora_key) {
      dl.href = "/api/artifact/" + c.lora_key;
      dl.hidden = false;
    } else {
      dl.hidden = true;
      dl.href = "";
    }
    if (!ready) {
      setLoraStatusText(
        c.portrait_key
          ? "add at least 4 training references before training"
          : "save a portrait first",
        "warn"
      );
    } else if (status === "idle") {
      setLoraStatusText("");
    } else if (status === "training") {
      setLoraStatusText("training in progress, ~8-15 min on the GPU", "loading");
    } else if (status === "ready") {
      setLoraStatusText("LoRA ready to use in future renders", "success");
    } else if (status === "failed") {
      setLoraStatusText("training failed; see meta above", "error");
    }
  }

  async function trainLora() {
    const id = state.selectedId;
    if (!id) return;
    const c = findCast(id);
    if (!c) return;
    if (!window.confirm(
      "Train LoRA for " + c.name + "?\n\n"
      + "This kicks off a standalone training job on the GPU. "
      + "Typical wall-clock: 8-15 minutes. Estimated cost: $0.50-$2 of GPU time.\n\n"
      + (c.lora_status === "ready"
        ? "This will retrain (the existing .safetensors stays in R2 until you delete it).\n\n"
        : "")
      + "Continue?"
    )) return;
    setLoraStatusText("submitting...", "loading");
    try {
      const data = await api("/api/cast/" + id + "/train-lora", { method: "POST" });
      const idx = state.cast.findIndex((x) => x.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      renderLoraPane(data.cast);
      schedulePollLoraStatus(id);
    } catch (e) {
      setLoraStatusText("submit failed: " + e.message, "error");
    }
  }

  function schedulePollLoraStatus(id) {
    if (loraPollTimer) clearTimeout(loraPollTimer);
    loraPollTimer = setTimeout(() => pollLoraStatus(id), LORA_POLL_MS);
  }

  async function pollLoraStatus(id) {
    if (loraPollInflight) {
      schedulePollLoraStatus(id);
      return;
    }
    if (state.selectedId !== id) {
      // User switched to another character; let the new selection
      // restart polling if needed.
      loraPollTimer = null;
      return;
    }
    loraPollInflight = true;
    try {
      const data = await api("/api/cast/" + id + "/lora-status");
      const idx = state.cast.findIndex((x) => x.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      if (state.selectedId === id) {
        renderLoraPane(data.cast);
      }
      if (data.cast && data.cast.lora_status === "training") {
        schedulePollLoraStatus(id);
      } else {
        loraPollTimer = null;
      }
    } catch (e) {
      setLoraStatusText("poll error: " + e.message + " (retrying)", "error");
      schedulePollLoraStatus(id);
    } finally {
      loraPollInflight = false;
    }
  }

  // Expose pure helpers for vitest.
  window.__castHelpers = { encodeRefKey, artifactUrl, composeTrainingPrompt };

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    loadVoices();
    loadCastList();
  });
})();
