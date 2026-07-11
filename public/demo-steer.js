// demo-steer.js -- demo-mode first-impression steering for public demo deployments.
// A PROJECTION of the registry: the only signals are host.readonly, host.render.available, and
// host.assistant on GET /api/modules. On a normal deploy those flags are absent, so this shim does
// nothing and the studio behaves byte-identically. Loaded AFTER readonly-gate.js (which owns the
// mutation safety net + the site banner); this file is the steering UX layered on top of that gate.
//
// The demo write surface (/api/demo/render, /api/demo/chat) is capped server-side and allow-listed
// through readonly-gate.js, so window.fetch is safe to use for those sanctioned endpoints here.
(function () {
  "use strict";
  var REPO_URL = "https://github.com/skyphusion-labs/vivijure";
  var POLL_MS = 8000;

  fetch("/api/modules")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var host = (d && d.host) || {};
      if (!host.readonly) return;
      domReady(function () { init(host); });
    })
    .catch(function () { /* modules unreachable: leave the studio as-is */ });

  function domReady(fn) {
    if (document.body) fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  function init(host) {
    document.body.classList.add("demo-steer-active");
    var page = document.body.getAttribute("data-studio-page");
    if (page === "planner") buildPlannerSteer(host);
    if (page === "cast") buildCastNote();
    if (host.assistant) buildAssistant(host.assistant);
  }

  // --- small DOM helpers (no framework, by design) ---
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtWait(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return "about " + Math.max(5, sec) + " sec";
    return "about " + Math.round(sec / 60) + " min";
  }
  // An artifact reference is normally an R2 key served through /api/artifact/; a seeded showcase film
  // carries an ABSOLUTE URL (assets.skyphusion.net, admitted by the demo media-src). Mirror of
  // artifactUrl() in planner-history-row.js: pass an absolute URL through, prefix a bare key.
  function artifactUrl(key) {
    return /^https?:\/\//i.test(key) ? key : "/api/artifact/" + key;
  }

  // --- planner: replace the plan form with a steer panel (CSS hides the flow sections) ---
  function buildPlannerSteer(host) {
    var main = document.querySelector(".planner-layout");
    if (!main || document.getElementById("demo-panel")) return;
    var render = host.render || {};

    var panel = el("section", "demo-panel");
    panel.id = "demo-panel";

    var intro = el("div", "demo-panel-intro");
    intro.appendChild(el("h2", null, "The Vivijure demo studio"));
    intro.appendChild(el("p", "demo-panel-lede",
      "This is a live, read-only tour. Render a real clip on a real GPU, watch films already made here, then run your own Vivijure to plan and produce your own."));
    panel.appendChild(intro);

    var grid = el("div", "demo-actions");

    // action 1: render a free clip (scene menu inline)
    var renderCard = el("div", "demo-render");
    renderCard.appendChild(el("h3", null, "Render a free clip"));
    renderCard.appendChild(el("p", "demo-hint", "Pick a scene and we render it on a real GPU. A few free clips per day."));
    var scenesWrap = el("div", "demo-scenes");
    scenesWrap.id = "demo-scenes";
    renderCard.appendChild(scenesWrap);
    var liveWrap = el("div", "demo-render-live");
    liveWrap.id = "demo-render-live";
    liveWrap.hidden = true;
    renderCard.appendChild(liveWrap);
    grid.appendChild(renderCard);

    // side actions: watch films + run your own
    var side = el("div", "demo-side");
    var watch = el("button", "demo-tile demo-tile-btn");
    watch.type = "button";
    watch.appendChild(el("span", "demo-tile-title", "Watch the finished films"));
    watch.appendChild(el("span", "demo-tile-sub", "Real renders made in this studio, below."));
    watch.addEventListener("click", scrollToFilms);
    side.appendChild(watch);

    var own = el("a", "demo-tile");
    own.href = REPO_URL;
    own.target = "_blank";
    own.rel = "noopener noreferrer";
    own.appendChild(el("span", "demo-tile-title", "Run your own studio"));
    own.appendChild(el("span", "demo-tile-sub", "Free and open source (AGPL-3.0). Everything, unlimited."));
    side.appendChild(own);

    grid.appendChild(side);
    panel.appendChild(grid);

    // the finished-films gallery: a control-free, view-only surface built entirely from rows we
    // render here (no management UI). #planner-history stays hidden in demo.
    var gallery = el("section", "demo-gallery");
    gallery.id = "demo-gallery";
    gallery.appendChild(el("h3", "demo-gallery-title", "Finished films"));
    gallery.appendChild(el("p", "demo-hint", "Real renders made in this studio. Press play."));
    var films = el("div", "demo-films");
    films.id = "demo-films";
    gallery.appendChild(films);
    panel.appendChild(gallery);

    main.insertBefore(panel, main.firstChild);
    loadScenes(render);
    loadGallery();
  }

  function scrollToFilms() {
    var g = document.getElementById("demo-gallery");
    if (g) g.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // --- finished-films gallery (Option B: control-free by construction) ---
  function loadGallery() {
    var wrap = document.getElementById("demo-films");
    if (!wrap) return;
    wrap.appendChild(el("p", "demo-hint", "Loading films..."));
    fetch("/api/storyboard/renders?limit=50")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var rows = (d && d.renders) || [];
        var films = rows.filter(function (r) { return r && r.status === "COMPLETED" && r.output_key; });
        wrap.textContent = "";
        if (!films.length) { wrap.appendChild(el("p", "demo-hint", "No finished films to show yet.")); return; }
        films.forEach(function (r) { wrap.appendChild(filmCard(r)); });
      })
      .catch(function () {
        wrap.textContent = "";
        wrap.appendChild(el("p", "demo-hint", "Could not load the finished films right now."));
      });
  }

  function filmCard(r) {
    var card = el("div", "demo-film");
    card.appendChild(el("span", "demo-film-title", r.label || r.project || "Untitled film"));
    var v = document.createElement("video");
    v.className = "demo-film-video";
    v.controls = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.src = artifactUrl(r.output_key);
    card.appendChild(v);
    if (r.quality_tier) card.appendChild(el("span", "demo-film-meta", String(r.quality_tier)));
    return card;
  }

  function loadScenes(render) {
    var wrap = document.getElementById("demo-scenes");
    if (!wrap) return;
    if (render.available === false) { wrap.appendChild(pausedNote()); return; }
    wrap.appendChild(el("p", "demo-hint", "Loading scenes..."));
    fetch("/api/demo/menu")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        wrap.textContent = "";
        if (!d || d.available === false) { wrap.appendChild(pausedNote()); return; }
        var scenes = (d && d.scenes) || [];
        if (!scenes.length) { wrap.appendChild(el("p", "demo-hint", "No demo scenes are available right now. Watch the finished films below.")); return; }
        scenes.forEach(function (s) { wrap.appendChild(sceneCard(s)); });
      })
      .catch(function () {
        wrap.textContent = "";
        wrap.appendChild(el("p", "demo-hint", "Could not load the scene menu. Watch the finished films below."));
      });
  }

  function pausedNote() {
    var p = el("div", "demo-paused");
    p.appendChild(el("p", "demo-hint", "Live renders are paused right now. Watch the finished films below."));
    var b = el("button", "demo-link-btn");
    b.type = "button";
    b.textContent = "Watch the finished films";
    b.addEventListener("click", scrollToFilms);
    p.appendChild(b);
    return p;
  }

  function sceneCard(s) {
    var card = el("div", "demo-scene");
    card.appendChild(el("span", "demo-scene-title", s.title || s.id));
    if (s.description) card.appendChild(el("span", "demo-scene-desc", s.description));
    var foot = el("div", "demo-scene-foot");
    if (s.seconds) foot.appendChild(el("span", "demo-scene-secs", s.seconds + "s clip"));
    var btn = el("button", "demo-scene-btn");
    btn.type = "button";
    btn.textContent = "Render this";
    btn.addEventListener("click", function () { startRender(s.id); });
    foot.appendChild(btn);
    card.appendChild(foot);
    return card;
  }

  var activeJob = false;

  function setScenesDisabled(disabled) {
    var btns = document.querySelectorAll("#demo-scenes .demo-scene-btn");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = disabled;
  }

  function live() { return document.getElementById("demo-render-live"); }

  function showLive(nodes) {
    var l = live();
    if (!l) return;
    l.hidden = false;
    l.textContent = "";
    if (Array.isArray(nodes)) nodes.forEach(function (n) { l.appendChild(n); });
    else if (nodes) l.appendChild(nodes);
  }

  function startRender(sceneId) {
    if (activeJob) return;
    activeJob = true;
    setScenesDisabled(true);
    showLive(el("p", "demo-status", "Submitting your render..."));
    fetch("/api/demo/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: sceneId }),
    })
      .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (res) {
        if (res.status >= 200 && res.status < 300 && res.body && res.body.jobId) {
          reportQueue(res.body);
          pollRender(res.body.jobId);
        } else {
          renderDone();
          showLive(submitError(res.body));
        }
      })
      .catch(function () {
        renderDone();
        showLive(friendlyBlock("Something went wrong submitting the render. Try again in a moment, or run your own studio.", true));
      });
  }

  function reportQueue(body) {
    var msg;
    if (body.status === "running") msg = "Rendering now on the GPU...";
    else {
      var pos = Number(body.position) || 0;
      var wait = fmtWait(body.waitSeconds);
      msg = pos > 0 ? "In line: position " + pos + ", " + wait + " to go." : "Next up, " + wait + " to go.";
    }
    showLive(el("p", "demo-status", msg));
  }

  function submitError(body) {
    var reason = body && body.reason;
    if (reason === "ip-cap")
      return friendlyBlock("That is your free clips for today. Run your own studio for unlimited renders.", true);
    if (reason === "global-cap")
      return friendlyBlock("The demo has hit its daily render budget. Watch the finished films below, or run your own studio.", true);
    if (reason === "queue-full")
      return friendlyBlock("The render queue is full right now. Try again in a few minutes.", false);
    if (reason === "paused") return pausedNote();
    return friendlyBlock((body && body.error) || "That render could not start. Try another scene, or run your own studio.", true);
  }

  function pollRender(jobId) {
    setTimeout(function () {
      fetch("/api/demo/render/" + encodeURIComponent(jobId))
        .then(function (r) {
          if (r.status === 404) return { status: "failed", error: "This render expired. Try another scene." };
          return r.ok ? r.json() : { status: "failed", error: "Lost contact with the render. Try again." };
        })
        .then(function (d) {
          if (!d) d = { status: "failed", error: "Lost contact with the render. Try again." };
          if (d.status === "done") { renderDone(); showDone(d.clipUrl); return; }
          if (d.status === "failed") {
            renderDone();
            showLive(friendlyBlock("This render did not finish: " + (d.error || "unknown error") + ". Try another scene, or run your own studio.", true));
            return;
          }
          reportQueue(d);
          pollRender(jobId);
        })
        .catch(function () { renderDone(); showLive(friendlyBlock("Lost contact with the render. Try again in a moment.", false)); });
    }, POLL_MS);
  }

  function showDone(clipUrl) {
    var nodes = [];
    var v = document.createElement("video");
    v.className = "demo-clip";
    v.controls = true;
    v.playsInline = true;
    v.src = clipUrl || "";
    nodes.push(v);
    nodes.push(el("p", "demo-done-note", "Rendered on a real GPU, in this browser tab. Run your own Vivijure to make films like this without limits."));
    var again = el("button", "demo-scene-btn demo-again-btn");
    again.type = "button";
    again.textContent = "Render another scene";
    again.addEventListener("click", function () { var l = live(); if (l) { l.hidden = true; l.textContent = ""; } });
    nodes.push(again);
    showLive(nodes);
  }

  function renderDone() {
    activeJob = false;
    setScenesDisabled(false);
  }

  function friendlyBlock(text, withRepo) {
    var d = el("div", "demo-friendly");
    d.appendChild(el("p", "demo-status", text));
    if (withRepo) {
      var a = el("a", "demo-link-btn");
      a.href = REPO_URL; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = "Run your own studio";
      d.appendChild(a);
    }
    return d;
  }

  // --- cast: read-only note (CSS hides the mutation controls) ---
  function buildCastNote() {
    var head = document.querySelector(".cast-header");
    if (!head || document.getElementById("demo-cast-note")) return;
    var note = el("div", "demo-cast-note");
    note.id = "demo-cast-note";
    note.appendChild(el("span", "demo-cast-note-text",
      "Read-only demo: browse the seeded cast. Run your own studio to create, generate, and train your own characters."));
    var a = el("a", "demo-link-btn");
    a.href = REPO_URL; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "Run your own studio";
    note.appendChild(a);
    head.appendChild(note);
  }

  // --- assistant: minimal chat launcher on demo pages (host.assistant present) ---
  function buildAssistant(assistant) {
    if (document.getElementById("demo-asst")) return;
    var launcher = el("button", "demo-asst-launch");
    launcher.type = "button";
    launcher.id = "demo-asst-launch";
    launcher.textContent = "Ask the studio assistant";

    var panel = el("section", "demo-asst");
    panel.id = "demo-asst";
    panel.hidden = true;

    var head = el("div", "demo-asst-head");
    head.appendChild(el("span", "demo-asst-title", "Studio assistant"));
    var close = el("button", "demo-asst-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close assistant");
    close.textContent = "×";
    head.appendChild(close);
    panel.appendChild(head);

    if (assistant.note) panel.appendChild(el("p", "demo-asst-note", assistant.note));

    var log = el("div", "demo-asst-log");
    log.id = "demo-asst-log";
    panel.appendChild(log);

    var row = el("div", "demo-asst-row");
    var input = el("textarea", "demo-asst-input");
    input.rows = 2;
    input.placeholder = "Ask about the studio...";
    var send = el("button", "demo-asst-send");
    send.type = "button";
    send.textContent = "Send";
    row.appendChild(input);
    row.appendChild(send);
    panel.appendChild(row);

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    launcher.addEventListener("click", function () { panel.hidden = false; launcher.hidden = true; input.focus(); });
    close.addEventListener("click", function () { panel.hidden = true; launcher.hidden = false; });

    var busy = false;
    function appendMsg(who, text) {
      var m = el("div", "demo-asst-msg demo-asst-" + who);
      m.textContent = text;
      log.appendChild(m);
      log.scrollTop = log.scrollHeight;
      return m;
    }
    function submit() {
      var msg = input.value.trim();
      if (!msg || busy) return;
      busy = true;
      appendMsg("user", msg);
      input.value = "";
      var pending = appendMsg("bot", "...");
      fetch("/api/demo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: msg }),
      })
        .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
        .then(function (res) {
          var b = res.body || {};
          if (res.status >= 200 && res.status < 300 && typeof b.reply === "string") pending.textContent = b.reply;
          else pending.textContent = b.error || "The assistant is unavailable right now. Try again in a moment.";
        })
        .catch(function () { pending.textContent = "The assistant is unavailable right now. Try again in a moment."; })
        .then(function () { busy = false; });
    }
    send.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });
  }
})();
