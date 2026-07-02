// Vivijure studio -- API token shim (#423). An AUTH GATE, not a feature: no nav entry, no page.
//
// When a deploy runs AUTH_MODE=token, every /api/* call must carry the studio API token. This
// shim (loaded FIRST on every studio page) does three things:
//   1. wraps window.fetch so every same-origin /api/* request carries
//      Authorization: Bearer <token> from localStorage;
//   2. mirrors the token into a `vivijure_token` cookie (Secure; SameSite=Strict; Path=/api/) so
//      media elements (img/video/audio src on /api/artifact/*, which cannot send headers) keep
//      working with #416 Range streaming intact -- the worker honors the cookie for GET/HEAD
//      ONLY; every mutation needs the bearer header this shim attaches to fetch calls;
//   3. when the API answers 403 with a token-shaped error, shows a minimal paste-once prompt,
//      stores the token, and reloads.
// On an Access-mode deploy no token is ever stored and the shim is inert (Access rides the CF
// edge cookie; its 403 reasons never match the token prompt trigger).
(function () {
  var KEY = "vivijure_api_token";
  var COOKIE = "vivijure_token";

  function getToken() {
    try {
      return (localStorage.getItem(KEY) || "").trim();
    } catch (e) {
      return "";
    }
  }

  function syncCookie(token) {
    // Path=/api/ keeps the cookie off page/asset requests; SameSite=Strict stops cross-site
    // auto-send. No Max-Age: a session cookie re-mirrored from localStorage on every page load.
    try {
      if (token) {
        document.cookie = COOKIE + "=" + encodeURIComponent(token) + "; Path=/api/; Secure; SameSite=Strict";
      } else {
        document.cookie = COOKIE + "=; Path=/api/; Secure; SameSite=Strict; Max-Age=0";
      }
    } catch (e) {
      /* cookie write can fail in odd embeds; the bearer header still covers fetch calls */
    }
  }

  function saveToken(token) {
    try {
      localStorage.setItem(KEY, token);
    } catch (e) {
      /* ignore */
    }
    syncCookie(token);
  }

  syncCookie(getToken());

  function isApiUrl(url) {
    try {
      var u = new URL(url, window.location.href);
      return u.origin === window.location.origin && u.pathname.indexOf("/api/") === 0;
    } catch (e) {
      return false;
    }
  }

  var prompted = false;
  function promptForToken(message) {
    if (prompted || document.getElementById("vivijure-token-gate")) return;
    prompted = true;
    var build = function () {
      var overlay = document.createElement("div");
      overlay.id = "vivijure-token-gate";
      overlay.className = "token-gate-overlay";

      var panel = document.createElement("div");
      panel.className = "token-gate-panel";

      var h = document.createElement("h2");
      h.textContent = "Studio API token";
      var p = document.createElement("p");
      p.textContent =
        message ||
        "This studio requires its API token (printed once at the end of deploy.sh). Paste it to continue; it is kept in this browser only.";
      var input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "paste your token";
      input.className = "token-gate-input";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Unlock studio";
      btn.className = "token-gate-btn";

      function submit() {
        var v = (input.value || "").trim();
        if (!v) {
          input.focus();
          return;
        }
        saveToken(v);
        window.location.reload();
      }
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") submit();
      });

      panel.appendChild(h);
      panel.appendChild(p);
      panel.appendChild(input);
      panel.appendChild(btn);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      input.focus();
    };
    if (document.body) build();
    else document.addEventListener("DOMContentLoaded", build);
  }

  function watchAuthFailure(res) {
    if (res && res.status === 403) {
      res
        .clone()
        .json()
        .then(function (body) {
          var reason = body && typeof body.error === "string" ? body.error : "";
          // Only token-mode denials prompt. A stored-but-stale token gets a fresh paste prompt too.
          if (/api token|STUDIO_API_TOKEN/i.test(reason)) {
            promptForToken(
              getToken()
                ? "The stored API token was rejected. Paste the current token (from deploy.sh) to continue."
                : null,
            );
          }
        })
        .catch(function () {
          /* non-JSON 403: not ours */
        });
    }
    return res;
  }

  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? String(input)
          : input && typeof input.url === "string"
            ? input.url
            : "";
    if (!isApiUrl(url)) return origFetch(input, init);
    var token = getToken();
    if (!token) return origFetch(input, init).then(watchAuthFailure);
    var request = new Request(input, init);
    if (!request.headers.has("authorization")) {
      request.headers.set("authorization", "Bearer " + token);
    }
    return origFetch(request).then(watchAuthFailure);
  };
})();
