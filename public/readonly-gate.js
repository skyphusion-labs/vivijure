// Vivijure studio -- demo read-only gate. A GATE, not a feature (mirrors auth-token.js: no nav
// entry, no page). It is a PROJECTION of the registry, never a hardcoded per-page demo branch:
// the sole signal is host.readonly on GET /api/modules (the core describing its own capability,
// the sibling of host.dispatch). On a normal deploy that field is absent and this shim is inert.
//
// When host.readonly is true (a demo deployment), the shim:
//   1. wraps window.fetch so every same-origin /api/* MUTATION (POST/PUT/PATCH/DELETE) is blocked
//      client-side BEFORE it hits the network, resolving a synthetic 403 carrying the honest
//      annotation. Safe methods (GET/HEAD/OPTIONS) pass through untouched, so browse works.
//      EXCEPTION: /api/demo/* is the sanctioned, server-capped demo write surface (render + chat),
//      so those POSTs pass through -- that is the one thing a demo visitor is meant to do.
//   2. shows a persistent banner that STEERS the visitor to what they CAN do (browse, render a free
//      clip, run their own studio) and carries the AGPL source offer.
//
// Loaded RIGHT AFTER auth-token.js on every studio page, so this wrapper is OUTERMOST: a blocked
// mutation never reaches the token shim (no spurious token prompt) and never touches the network.
// The server-side AUTH_MODE=demo gate is authoritative; this is the honest UX layer on top of it.
(function () {
  // Short, honest 403 body for a blocked studio mutation (pulses the banner too).
  var BLOCK_MSG = "Demo studio: that action is read-only here. Run your own studio to do this.";
  // The steering banner: what a visitor CAN do here, not a breakage notice.
  var BANNER_MSG = "Public demo: browse the real studio, render a free clip on a real GPU, or run your own for everything else.";
  // AGPL-3.0 section 13: a public network deployment must offer its source to users. The demo is
  // the studio running over a network, so every demo page carries this offer in the banner. Plain
  // repo link (no per-deploy tag to go stale); the frontend has no cheap studio-version signal.
  var REPO_URL = "https://github.com/skyphusion-labs/vivijure";
  var SAFE = { GET: 1, HEAD: 1, OPTIONS: 1 };

  // readonly: null until GET /api/modules resolves, then a fixed boolean. A mutation issued while
  // still null awaits the determination (below), so there is no open-window race on load.
  var readonly = null;
  var origFetch = window.fetch.bind(window);
  var ready = origFetch("/api/modules")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      readonly = !!(d && d.host && d.host.readonly);
      if (readonly) showBanner();
      return readonly;
    })
    .catch(function () { readonly = false; return false; });

  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return String(input);
    if (input && typeof input.url === "string") return input.url;
    return "";
  }
  function isApiUrl(url) {
    try {
      var u = new URL(url, window.location.href);
      return u.origin === window.location.origin && u.pathname.indexOf("/api/") === 0;
    } catch (e) {
      return false;
    }
  }
  // The sanctioned demo write surface: /api/demo/* (render + chat). Capped server-side; the whole
  // point of the demo, so it is NOT blocked by the read-only gate.
  function isDemoWrite(url) {
    try {
      var u = new URL(url, window.location.href);
      return u.origin === window.location.origin && u.pathname.indexOf("/api/demo/") === 0;
    } catch (e) {
      return false;
    }
  }
  function methodOf(input, init) {
    var m = (init && init.method) ||
      (input && typeof input === "object" && !(input instanceof URL) && input.method) ||
      "GET";
    return String(m).toUpperCase();
  }
  function blocked() {
    pulseBanner();
    try {
      document.dispatchEvent(new CustomEvent("vivijure:readonly-blocked"));
    } catch (e) {
      /* CustomEvent unsupported in odd embeds; the 403 body still carries the reason */
    }
    return new Response(JSON.stringify({ error: BLOCK_MSG }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  window.fetch = function (input, init) {
    var url = urlOf(input);
    if (!isApiUrl(url) || SAFE[methodOf(input, init)]) return origFetch(input, init);
    if (isDemoWrite(url)) return origFetch(input, init);
    if (readonly === false) return origFetch(input, init);
    if (readonly === true) return Promise.resolve(blocked());
    // Determination still pending: wait for it, then block or pass.
    return ready.then(function (ro) {
      return ro ? blocked() : origFetch(input, init);
    });
  };

  var bannerEl = null;
  function showBanner() {
    var build = function () {
      if (document.getElementById("vivijure-readonly-banner")) return;
      document.body.classList.add("demo-readonly");
      var bar = document.createElement("div");
      bar.id = "vivijure-readonly-banner";
      bar.className = "readonly-banner";
      bar.setAttribute("role", "status");
      var dot = document.createElement("span");
      dot.className = "readonly-dot";
      var msg = document.createElement("span");
      msg.className = "readonly-msg";
      msg.textContent = BANNER_MSG;
      bar.appendChild(dot);
      bar.appendChild(msg);
      // Steer link to the render entry point (the planner demo panel). On the planner page it just
      // scrolls to the panel; elsewhere it navigates there.
      var cta = document.createElement("a");
      cta.className = "readonly-cta";
      cta.href = "planner#demo-panel";
      cta.textContent = "Render a free clip →";
      bar.appendChild(cta);
      var src = document.createElement("a");
      src.className = "readonly-source";
      src.href = REPO_URL;
      src.target = "_blank";
      src.rel = "noopener noreferrer";
      src.textContent = "Source: github.com/skyphusion-labs/vivijure (AGPL-3.0)";
      bar.appendChild(src);
      document.body.insertBefore(bar, document.body.firstChild);
      bannerEl = bar;
    };
    if (document.body) build();
    else document.addEventListener("DOMContentLoaded", build);
  }
  function pulseBanner() {
    if (!bannerEl) return;
    bannerEl.classList.remove("readonly-pulse");
    // Force reflow so the animation restarts on a rapid second blocked click.
    void bannerEl.offsetWidth;
    bannerEl.classList.add("readonly-pulse");
  }
})();
