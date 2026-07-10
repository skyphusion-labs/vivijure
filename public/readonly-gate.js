// Vivijure studio -- demo read-only gate. A GATE, not a feature (mirrors auth-token.js: no nav
// entry, no page). It is a PROJECTION of the registry, never a hardcoded per-page demo branch:
// the sole signal is host.readonly on GET /api/modules (the core describing its own capability,
// the sibling of host.dispatch). On a normal deploy that field is absent and this shim is inert.
//
// When host.readonly is true (a demo deployment), the shim:
//   1. wraps window.fetch so every same-origin /api/* MUTATION (POST/PUT/PATCH/DELETE) is blocked
//      client-side BEFORE it hits the network, resolving a synthetic 403 carrying the honest
//      annotation. Safe methods (GET/HEAD/OPTIONS) pass through untouched, so browse works.
//   2. shows a persistent banner with the approved annotation and pulses it on a blocked attempt.
//
// Loaded RIGHT AFTER auth-token.js on every studio page, so this wrapper is OUTERMOST: a blocked
// mutation never reaches the token shim (no spurious token prompt) and never touches the network.
// The server-side AUTH_MODE=demo gate is authoritative; this is the honest UX layer on top of it.
(function () {
  var ANNOTATION = "Demo studio: read-only. Run your own to render.";
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
    return new Response(JSON.stringify({ error: ANNOTATION }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  window.fetch = function (input, init) {
    var url = urlOf(input);
    if (!isApiUrl(url) || SAFE[methodOf(input, init)]) return origFetch(input, init);
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
      msg.textContent = ANNOTATION;
      bar.appendChild(dot);
      bar.appendChild(msg);
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
