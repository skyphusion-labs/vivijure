// Shared topbar helper (v0.66.0, modernized v0.120.0).
//
// Loaded on pages that do NOT pull in app.js (planner.html, cast.html).
// Two jobs, both dependency-free and idempotent on element existence:
//
//   1. Fill the signed-in user's email (#account-email in the account menu, or the legacy
//      #wv-topbar-user-email pill). Fetches /api/whoami once per page load.
//   2. Wire the .account-menu popover (open/close on the #account-toggle
//      button, close on outside-click / Escape) for pages that have it but
//      no app.js controller.

(function () {
  // --- 1. user email ---
  const emailEl =
    document.getElementById("account-email") ||
    document.getElementById("wv-topbar-user-email");
  if (emailEl) {
    fetch("/api/whoami", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((data) => {
        const user = typeof data?.user === "string" ? data.user.trim() : "";
        if (user) {
          emailEl.textContent = user;
          emailEl.classList.remove("wv-topbar-user-empty");
        } else {
          emailEl.textContent = "(unknown)";
        }
      })
      .catch(() => {
        emailEl.textContent = "(offline)";
      });
  }

  // --- 2. account-menu popover ---
  const accountToggle = document.getElementById("account-toggle");
  const accountMenu = document.getElementById("account-menu");
  if (accountToggle && accountMenu) {
    accountToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      accountMenu.hidden = !accountMenu.hidden;
      accountToggle.setAttribute("aria-expanded", accountMenu.hidden ? "false" : "true");
    });
    document.addEventListener("click", (e) => {
      if (
        !accountMenu.hidden &&
        !accountMenu.contains(e.target) &&
        !accountToggle.contains(e.target)
      ) {
        accountMenu.hidden = true;
        accountToggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      accountMenu.hidden = true;
      accountToggle.setAttribute("aria-expanded", "false");
    });
  }

  // --- 3. user preferences (v0.139.0) ---
  // The first User Preferences control: email-notifications toggle. Loads the
  // current value from GET /api/prefs and PATCHes on change. Idempotent on
  // element existence (pages without the control just skip this).
  const emailPref = document.getElementById("pref-email-notifications");
  const emailPrefStatus = document.getElementById("pref-email-status");
  if (emailPref) {
    const setStatus = (on) => {
      if (!emailPrefStatus) return;
      emailPrefStatus.textContent = on
        ? "You'll get an email when renders finish"
        : "No emails when renders finish";
    };
    fetch("/api/prefs", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((data) => {
        const on = !!(data && data.prefs && data.prefs.emailNotifications);
        emailPref.checked = on;
        setStatus(on);
      })
      .catch(() => {
        if (emailPrefStatus) emailPrefStatus.textContent = "(could not load preferences)";
      });
    emailPref.addEventListener("change", () => {
      const want = emailPref.checked;
      emailPref.disabled = true;
      if (emailPrefStatus) emailPrefStatus.textContent = "saving…";
      fetch("/api/prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emailNotifications: want }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
        .then((data) => {
          const on = !!(data && data.prefs && data.prefs.emailNotifications);
          emailPref.checked = on;
          setStatus(on);
        })
        .catch(() => {
          emailPref.checked = !want; // revert on failure
          if (emailPrefStatus) emailPrefStatus.textContent = "(save failed; try again)";
        })
        .finally(() => {
          emailPref.disabled = false;
        });
    });
  }
})();
