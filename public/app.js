// The studio frontend, Phase 0: render the UI from the live module registry.
//
// The whole point of the host architecture is that the frontend is a PROJECTION of what is
// installed. So this file does not hardcode features -- it asks the core `GET /api/modules` and
// draws whatever came back. Install a module, its section appears; install none, you get a clean,
// honest, empty studio. Vanilla JS, no framework, no build (house style).

const ALL_HOOKS = [
  { name: "motion.backend", blurb: "keyframe -> shot clip (GPU or cloud)" },
  { name: "finish", blurb: "interpolation / upscale / face restore" },
  { name: "score", blurb: "music / narration / beat-sync" },
  { name: "plan.enhance", blurb: "LLM auto-direction" },
];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function renderModules(modules) {
  const root = document.getElementById("modules");
  root.replaceChildren();
  if (!modules.length) {
    root.append(el("p", "empty", "No modules installed. The studio is a clean slate -- bind a module worker to light it up."));
    return;
  }
  for (const m of modules) {
    const card = el("div", "module");
    const head = el("div", "module-head");
    head.append(el("span", "module-name", m.name), el("span", "module-ver", `v${m.version}`));
    card.append(head);
    card.append(el("div", "module-hooks", m.hooks.join(" · ")));
    if (m.provides?.length) {
      const ul = el("ul", "provides");
      for (const p of m.provides) ul.append(el("li", null, p.label));
      card.append(ul);
    }
    root.append(card);
  }
}

function renderHooks(hooks) {
  const root = document.getElementById("hooks");
  root.replaceChildren();
  for (const h of ALL_HOOKS) {
    const serving = hooks[h.name] || [];
    const row = el("div", serving.length ? "hook hook-on" : "hook hook-off");
    row.append(el("span", "hook-name", h.name));
    row.append(el("span", "hook-blurb", h.blurb));
    row.append(el("span", "hook-fill", serving.length ? serving.join(", ") : "no module installed"));
    root.append(row);
  }
}

async function boot() {
  const status = document.getElementById("status");
  try {
    const res = await fetch("/api/modules");
    if (!res.ok) throw new Error(`/api/modules -> ${res.status}`);
    const data = await res.json();
    renderModules(data.modules || []);
    renderHooks(data.hooks || {});
    const n = (data.modules || []).length;
    status.textContent = `${n} module${n === 1 ? "" : "s"} installed · ${data.api}`;
  } catch (e) {
    status.textContent = "offline";
    document.getElementById("modules").textContent = `could not reach the registry: ${e.message}`;
  }
}

boot();
