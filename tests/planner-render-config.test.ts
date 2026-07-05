/// <reference types="node" />
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

// Registry-projected render-backend selector (public/planner-render-config.js). vivijure#501:
// with 2+ serving motion.backend doors the selector must NOT preselect one (the server order is
// locality-blind, so serving[0] can be a bound-but-non-operational door), and submit is blocked
// client-side until a door is picked. The single-backend case keeps the #502/S14 behavior (a
// hidden select carrying that one backend, so collect() still emits an explicit motion_backend).
// This file evals the REAL browser IIFE against a minimal hand-rolled document/window stub (no
// jsdom dep, matching the repo's Node-env test pattern) and asserts the shipped functions.

// ---- minimal DOM stub -------------------------------------------------------
function tokenOf(sel: string): string | null {
  return /^\.[\w-]+$/.test(sel) ? sel.slice(1) : null; // only simple ".class" selectors
}

class El {
  tagName: string;
  children: El[] = [];
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  className = "";
  id = "";
  _text = "";
  [k: string]: unknown;
  constructor(tag: string) {
    this.tagName = tag;
  }
  get classList() {
    const self = this;
    const toks = () => (self.className ? self.className.split(/\s+/).filter(Boolean) : []);
    return {
      add: (c: string) => { const t = toks(); if (!t.includes(c)) t.push(c); self.className = t.join(" "); },
      remove: (c: string) => { self.className = toks().filter((x) => x !== c).join(" "); },
      contains: (c: string) => toks().includes(c),
      toggle: (c: string, on?: boolean) => {
        const has = toks().includes(c);
        const want = on === undefined ? !has : on;
        if (want) self.classList.add(c); else self.classList.remove(c);
        return want;
      },
    };
  }
  set textContent(v: unknown) { this._text = String(v); }
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  appendChild(c: El) { this.children.push(c); return c; }
  insertBefore(c: El, ref: El) {
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener() {}
  get childNodes(): El[] { return this.children; }
  _descendants(): El[] {
    const out: El[] = [];
    const walk = (n: El) => { for (const c of n.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel: string): El | null {
    const t = tokenOf(sel);
    return t ? this._descendants().find((e) => e.classList.contains(t)) || null : null;
  }
  querySelectorAll(sel: string): El[] {
    const t = tokenOf(sel);
    return t ? this._descendants().filter((e) => e.classList.contains(t)) : [];
  }
}

class SelectEl extends El {
  options: El[] = [];
  _selIdx = -1;
  constructor() { super("select"); }
  appendChild(c: El) {
    super.appendChild(c);
    if (c.tagName === "option") {
      this.options.push(c);
      if (this._selIdx === -1 && this.options.length === 1) this._selIdx = 0; // browser default
    }
    return c;
  }
  get selectedIndex() { return this._selIdx; }
  set selectedIndex(i: number) { this._selIdx = i; }
  get value() {
    return this._selIdx >= 0 && this.options[this._selIdx] ? String(this.options[this._selIdx].value) : "";
  }
  set value(v: string) { this._selIdx = this.options.findIndex((o) => String(o.value) === v); }
}

function makeDocument(roots: El[]) {
  const find = (id: string): El | null => {
    for (const r of roots) {
      if (r.id === id) return r;
      const hit = r._descendants().find((e) => e.id === id);
      if (hit) return hit;
    }
    return null;
  };
  return {
    _roots: roots,
    createElement: (tag: string) => (tag === "select" ? new SelectEl() : new El(tag)),
    getElementById: (id: string) => find(id),
    dispatchEvent: () => true,
    querySelector: () => null,
    querySelectorAll: () => [] as El[], // collect()'s complex selector: no config inputs in these tests
  };
}

// ---- load the real IIFE once ------------------------------------------------
let mod: {
  renderBackendSelector: (mods: unknown[], wrap: El) => boolean;
  collectForSubmit: (expert?: string, opts?: { keyframesOnly?: boolean }) => unknown;
  collect: () => { motion_backend?: string };
  restore: (o: unknown) => void;
};

beforeAll(() => {
  // vitest runs from the repo root; read the browser IIFE source as a cwd-relative path.
  const src = readFileSync("public/planner-render-config.js", "utf8");
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.document = makeDocument([]);
  // vivijure#546: the IIFE now emits a CustomEvent on backend-change; node has no DOM, so
  // provide a minimal constructor for the eval scope (fake document.dispatchEvent is a no-op).
  g.CustomEvent = function () {};
  (0, eval)(src);
  mod = (g.window as Record<string, unknown>).plannerRenderConfig as typeof mod;
});

function backend(name: string, label: string) {
  return { name, provides: [{ label }], config_schema: {}, ui: {} };
}

function freshWrap(): El {
  const wrap = new El("div");
  wrap.id = "planner-motion-backend-wrap";
  (globalThis as Record<string, unknown>).document = makeDocument([wrap]);
  return wrap;
}

describe("renderBackendSelector (vivijure#501: no default when 2+ doors serve)", () => {
  it("renders 2 doors with NO preselection: select unselected, no radio checked", () => {
    const wrap = freshWrap();
    const shown = mod.renderBackendSelector([backend("a", "Door A"), backend("b", "Door B")], wrap);
    expect(shown).toBe(true);
    const doc = (globalThis as Record<string, unknown>).document as ReturnType<typeof makeDocument>;
    const sel = doc.getElementById("planner-motion-backend") as SelectEl;
    expect(sel).not.toBeNull();
    expect(sel.selectedIndex).toBe(-1);
    expect(sel.value).toBe(""); // the #501 core guarantee: serving[0] is NOT auto-picked
    const radios = wrap.querySelectorAll(".planner-backend-radio");
    expect(radios.length).toBe(2);
    expect(radios.some((r) => r.checked === true)).toBe(false);
  });

  it("single backend builds a hidden select carrying that backend, no radio (#502/S14 behavior)", () => {
    const wrap = freshWrap();
    const shown = mod.renderBackendSelector([backend("solo", "Solo")], wrap);
    expect(shown).toBe(false); // no CHOICE offered
    const doc = (globalThis as Record<string, unknown>).document as ReturnType<typeof makeDocument>;
    const sel = doc.getElementById("planner-motion-backend") as SelectEl;
    expect(sel).not.toBeNull();
    expect(sel.value).toBe("solo"); // explicit default preserved: only one serving backend
    expect(wrap.querySelectorAll(".planner-backend-radio").length).toBe(0); // nothing to pick
    // collect against the rendered single-backend state emits the explicit backend, never blocks
    expect(mod.collectForSubmit("")).toEqual({ motion_backend: "solo" });
  });

  it("2+ doors: caption carries a 'required' cue until a door is picked, then clears", () => {
    const wrap = freshWrap();
    mod.renderBackendSelector([backend("a", "Door A"), backend("b", "Door B")], wrap);
    const hint = wrap.querySelector(".planner-backend-caption-hint") as El;
    expect(hint).not.toBeNull();
    expect(hint.textContent).toMatch(/^Required: pick which backend/i);
    mod.restore({ motion_backend: "a" }); // pick a door via the real restore path
    expect(hint.textContent).not.toMatch(/Required/);
    expect(hint.textContent).toMatch(/^Pick which backend/i);
  });
});

describe("collectForSubmit (vivijure#501: block submit until a door is chosen)", () => {
  function selectDoc(value: string) {
    const sel = new SelectEl();
    const a = new El("option"); a.value = "a"; a.textContent = "Door A"; sel.appendChild(a);
    const b = new El("option"); b.value = "b"; b.textContent = "Door B"; sel.appendChild(b);
    sel.id = "planner-motion-backend";
    sel.value = value; // "" = the 2+ doors unpicked state
    (globalThis as Record<string, unknown>).document = {
      createElement: (t: string) => (t === "select" ? new SelectEl() : new El(t)),
      getElementById: (id: string) => (id === "planner-motion-backend" ? sel : null),
      querySelector: () => null,
      querySelectorAll: () => [] as El[],
    };
    return sel;
  }

  it("throws with both door labels when 2+ serve and none is picked", () => {
    selectDoc("");
    expect(() => mod.collectForSubmit("")).toThrow(/pick a render backend/i);
    try { mod.collectForSubmit(""); } catch (e) {
      expect((e as Error).message).toContain("Door A");
      expect((e as Error).message).toContain("Door B");
    }
  });

  it("does NOT throw once a door is picked; carries the choice through", () => {
    selectDoc("a");
    const out = mod.collectForSubmit("") as { motion_backend?: string };
    expect(out.motion_backend).toBe("a");
  });

  it("does NOT throw when the pick arrives via expert JSON", () => {
    selectDoc("");
    const out = mod.collectForSubmit('{"motion_backend":"b"}') as { motion_backend?: string };
    expect(out.motion_backend).toBe("b");
  });

  it("never blocks when zero backends are installed (no select rendered)", () => {
    (globalThis as Record<string, unknown>).document = {
      createElement: (t: string) => (t === "select" ? new SelectEl() : new El(t)),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [] as El[],
    };
    expect(mod.collectForSubmit("")).toBeUndefined();
  });

  it("does NOT block a keyframes-only submit even with 2+ unpicked doors (#500 exemption)", () => {
    selectDoc(""); // 2 doors, nothing picked
    // keyframes-only runs no motion leg, so the backend pick is not required
    expect(mod.collectForSubmit("", { keyframesOnly: true })).toBeUndefined();
    // and the full-render path with the same state still blocks
    expect(() => mod.collectForSubmit("", { keyframesOnly: false })).toThrow(/pick a render backend/i);
  });
});
