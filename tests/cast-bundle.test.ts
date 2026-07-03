import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory cast persistence shared between the cast-db mock and the test (vi.hoisted so the mock
// factory, which is hoisted above the imports, can reference it).
const store = vi.hoisted(() => {
  let nextId = 1;
  const map = new Map<number, any>();
  return {
    map,
    reset() {
      map.clear();
      nextId = 1;
    },
    seed(c: any) {
      map.set(c.id, c);
      if (c.id >= nextId) nextId = c.id + 1;
    },
    allocId() {
      return nextId++;
    },
  };
});

vi.mock("../src/cast-db", () => {
  const clone = (c: any) => JSON.parse(JSON.stringify(c));
  return {
    async getCastById(_e: any, id: number) {
      const c = store.map.get(id);
      return c ? clone(c) : null;
    },
    async createCast(_e: any, input: { name: string; bible?: string | null }) {
      const id = store.allocId();
      const c = {
        id,
        public_id: `cast-pub-${id}`,
        slug: `${input.name.toLowerCase().replace(/\s+/g, "-")}-${id}`,
        name: input.name,
        bible: input.bible ?? null,
        portrait_key: null,
        portrait_mime: null,
        ref_keys: [],
        source_keys: [],
        created_at: "t",
        updated_at: "t",
        lora_key: null,
        lora_status: "idle",
        lora_job_id: null,
        lora_error: null,
        lora_trained_at: null,
        voice_id: null,
      };
      store.map.set(id, c);
      return clone(c);
    },
    async setPortrait(_e: any, id: number, key: string, mime: string) {
      const c = store.map.get(id);
      c.portrait_key = key;
      c.portrait_mime = mime;
      return clone(c);
    },
    async addRefs(_e: any, id: number, refs: any[]) {
      const c = store.map.get(id);
      c.ref_keys.push(...refs);
      return clone(c);
    },
    async addSource(_e: any, id: number, src: any) {
      const c = store.map.get(id);
      c.source_keys.push(src);
      return clone(c);
    },
    async markLoraReady(_e: any, id: number, key: string) {
      const c = store.map.get(id);
      c.lora_status = "ready";
      c.lora_key = key;
      c.lora_trained_at = "now";
      return clone(c);
    },
    async updateCast(_e: any, id: number, patch: any) {
      const c = store.map.get(id);
      Object.assign(c, patch);
      return clone(c);
    },
    toPublicCast(row: any) {
      const { id, public_id, ...rest } = row;
      return { ...rest, id: public_id };
    },
  };
});

import {
  exportCastBundle,
  importCastBundle,
  validateManifest,
  CAST_BUNDLE_FORMAT,
  CAST_BUNDLE_SCHEMA_VERSION,
} from "../src/cast-bundle";
import { buildTar } from "../src/tar";

const enc = new TextEncoder();

// Minimal in-memory R2 bucket sufficient for the bundle export/import paths.
function makeR2() {
  const map = new Map<string, { bytes: Uint8Array; mime: string }>();
  return {
    map,
    async head(key: string) {
      const o = map.get(key);
      return o ? { size: o.bytes.length } : null;
    },
    async get(key: string) {
      const o = map.get(key);
      if (!o) return null;
      return {
        size: o.bytes.length,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(o.bytes);
            c.close();
          },
        }),
        httpMetadata: { contentType: o.mime },
      };
    },
    async put(key: string, bytes: ArrayBuffer | Uint8Array, opts?: any) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      map.set(key, { bytes: u8.slice(), mime: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

function makeEnv() {
  return { R2_RENDERS: makeR2() } as any;
}

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

const PORTRAIT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const REF0 = new Uint8Array(40).fill(11);
const SRC0 = new Uint8Array(24).fill(22);
const LORA = new Uint8Array(600).fill(0x5a);

function seedFullCast(env: any) {
  store.seed({
    id: 1,
    slug: "nova-the-pilot",
    name: "Nova the Pilot",
    bible: "A weary ace who flies the last courier run.",
    portrait_key: "cast/1/portrait.png",
    portrait_mime: "image/png",
    ref_keys: [{ key: "cast/1/refs/aaa.png", mime: "image/png" }],
    source_keys: [{ key: "cast/1/sources/bbb.jpg", mime: "image/jpeg" }],
    created_at: "t",
    updated_at: "t",
    lora_key: "loras/nova-original.safetensors",
    lora_status: "ready",
    lora_job_id: null,
    lora_error: null,
    lora_trained_at: "2026-01-01",
    voice_id: "luna",
  });
  env.R2_RENDERS.map.set("cast/1/portrait.png", { bytes: PORTRAIT, mime: "image/png" });
  env.R2_RENDERS.map.set("cast/1/refs/aaa.png", { bytes: REF0, mime: "image/png" });
  env.R2_RENDERS.map.set("cast/1/sources/bbb.jpg", { bytes: SRC0, mime: "image/jpeg" });
  env.R2_RENDERS.map.set("loras/nova-original.safetensors", { bytes: LORA, mime: "application/octet-stream" });
}

describe("validateManifest (the bundle is a contract -> bad metadata fails loud)", () => {
  const ok = {
    format: CAST_BUNDLE_FORMAT,
    schema_version: CAST_BUNDLE_SCHEMA_VERSION,
    cast: { name: "X", bible: null, voice_id: null, lora_status: "idle", lora_trained_at: null },
    assets: { portrait: null, refs: [], sources: [], lora: null },
  };

  it("accepts a well-formed manifest", () => {
    const m = validateManifest(ok);
    expect(m.format).toBe(CAST_BUNDLE_FORMAT);
    expect(m.cast.name).toBe("X");
  });

  it("rejects a non-vivijure format", () => {
    expect(() => validateManifest({ ...ok, format: "something-else" })).toThrow(/not a vivijure cast bundle/);
  });

  it("rejects a schema_version newer than this instance supports", () => {
    expect(() => validateManifest({ ...ok, schema_version: CAST_BUNDLE_SCHEMA_VERSION + 1 })).toThrow(/newer/);
  });

  it("rejects a missing cast name", () => {
    expect(() => validateManifest({ ...ok, cast: { ...ok.cast, name: "" } })).toThrow(/cast.name/);
  });

  it("rejects missing assets", () => {
    const { assets, ...noAssets } = ok;
    expect(() => validateManifest(noAssets)).toThrow(/assets missing/);
  });
});

describe("cast bundle export -> import round-trip", () => {
  beforeEach(() => store.reset());

  it("exports a `.vvcast` tar with a content-disposition filename", async () => {
    const env = makeEnv();
    seedFullCast(env);
    const res = await exportCastBundle(env, 1);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    expect(res.headers.get("content-disposition")).toContain("nova-the-pilot.vvcast");
  });

  it("recreates the cast on import with re-keyed assets and byte-identical artifacts", async () => {
    const env = makeEnv();
    seedFullCast(env);
    const bundle = await bytesOf(await exportCastBundle(env, 1));

    const res = await importCastBundle(env, bundle);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const imported = body.cast;

    // fresh local OPAQUE public id (never the exporter id, never a sequential int)
    expect(imported.id).toBe("cast-pub-2");
    expect(imported.name).toBe("Nova the Pilot");
    expect(imported.bible).toContain("weary ace");
    expect(imported.voice_id).toBe("luna");

    // assets re-keyed under the NEW id, not the exporter's keys
    expect(imported.portrait_key).toBe("cast/2/portrait.png");
    expect(imported.portrait_key).not.toBe("cast/1/portrait.png");
    expect(imported.ref_keys).toHaveLength(1);
    expect(imported.ref_keys[0].key.startsWith("cast/2/refs/")).toBe(true);
    expect(imported.source_keys[0].key.startsWith("cast/2/sources/")).toBe(true);
    expect(imported.lora_status).toBe("ready");
    expect(imported.lora_key.startsWith("loras/cast-2-")).toBe(true);

    // bytes preserved exactly through the round-trip
    const portraitOut = env.R2_RENDERS.map.get(imported.portrait_key);
    expect(Array.from(portraitOut.bytes)).toEqual(Array.from(PORTRAIT));
    const loraOut = env.R2_RENDERS.map.get(imported.lora_key);
    expect(Array.from(loraOut.bytes)).toEqual(Array.from(LORA));
    const refOut = env.R2_RENDERS.map.get(imported.ref_keys[0].key);
    expect(Array.from(refOut.bytes)).toEqual(Array.from(REF0));
  });

  it("export honestly degrades (drops + warns) when a referenced artifact is missing from R2", async () => {
    const env = makeEnv();
    seedFullCast(env);
    env.R2_RENDERS.map.delete("loras/nova-original.safetensors"); // LoRA vanished
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bundle = await bytesOf(await exportCastBundle(env, 1));
    warn.mockRestore();

    const res = await importCastBundle(env, bundle);
    const imported = ((await res.json()) as any).cast;
    // the cast still imports, just without a LoRA (no fake -- the artifact is honestly absent)
    expect(imported.lora_status).toBe("idle");
    expect(imported.lora_key).toBeNull();
    expect(imported.portrait_key).toBe("cast/2/portrait.png");
  });

  it("404s exporting a cast that does not exist", async () => {
    const res = await exportCastBundle(makeEnv(), 999);
    expect(res.status).toBe(404);
  });
});

describe("cast bundle import -> malformed bundles fail loud", () => {
  beforeEach(() => store.reset());

  it("rejects an empty body", async () => {
    const res = await importCastBundle(makeEnv(), new Uint8Array(0));
    expect(res.status).toBe(400);
  });

  it("rejects a tar with no manifest.json", async () => {
    const tar = buildTar([{ name: "assets/portrait.png", data: PORTRAIT }]);
    const res = await importCastBundle(makeEnv(), tar);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/manifest/);
  });

  it("rejects a manifest that references an asset the tar does not contain (and creates no cast)", async () => {
    const manifest = {
      format: CAST_BUNDLE_FORMAT,
      schema_version: CAST_BUNDLE_SCHEMA_VERSION,
      cast: { name: "Ghost", bible: null, voice_id: null, lora_status: "idle", lora_trained_at: null },
      assets: { portrait: { path: "assets/portrait.png", mime: "image/png" }, refs: [], sources: [], lora: null },
    };
    const tar = buildTar([{ name: "manifest.json", data: enc.encode(JSON.stringify(manifest)) }]);
    const res = await importCastBundle(makeEnv(), tar);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/no such entry/);
    // pre-validation runs before createCast, so no half-created row
    expect(store.map.size).toBe(0);
  });

  it("rejects non-tar garbage", async () => {
    const res = await importCastBundle(makeEnv(), new Uint8Array(50).fill(0x41));
    expect(res.status).toBe(400);
  });
});
