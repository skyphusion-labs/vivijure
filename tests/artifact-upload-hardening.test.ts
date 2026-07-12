import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

// F4: /api/artifact key scoping + /api/upload mime bounding (stored-XSS + arbitrary-object serve).

function makeEnv() {
  const r2 = new Map<string, { bytes: Uint8Array; mime: string }>();
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    R2_RENDERS: {
      async get(key: string) {
        const o = r2.get(key);
        if (!o) return null;
        return {
          size: o.bytes.length,
          body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(o.bytes); c.close(); } }),
          httpMetadata: { contentType: o.mime },
        };
      },
      async put(key: string, bytes: ArrayBuffer | Uint8Array, opts?: any) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        r2.set(key, { bytes: u8, mime: opts?.httpMetadata?.contentType || "application/octet-stream" });
      },
    },
  } as unknown as Env;
  return { env, r2 };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const url = (path: string) => `https://studio.example${path}`;

describe("F4: /api/artifact serve scoping", () => {
  it("serves a real artifact under a known prefix, with nosniff", async () => {
    const { env, r2 } = makeEnv();
    r2.set("renders/abc.png", { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
    const res = await worker.fetch(new Request(url("/api/artifact/renders/abc.png")), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("404s a key outside the known artifact prefixes (no arbitrary-object serve)", async () => {
    const { env, r2 } = makeEnv();
    r2.set("secret/credentials.json", { bytes: new Uint8Array([9]), mime: "application/json" });
    const res = await worker.fetch(new Request(url("/api/artifact/secret/credentials.json")), env, ctx);
    expect(res.status).toBe(404);
  });

  it("404s a traversal key (encoded ../), never reaching R2", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request(url("/api/artifact/renders/%2e%2e%2fsecret")), env, ctx);
    expect(res.status).toBe(404);
  });
});

describe("F4: /api/upload mime bounding (stored-XSS)", () => {
  it("rejects a text/html upload (would be stored-XSS when served back)", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request(url("/api/upload"), { method: "POST", headers: { "content-type": "text/html" }, body: "<script>alert(1)</script>" }),
      env, ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an image/svg+xml upload (scriptable image)", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request(url("/api/upload"), { method: "POST", headers: { "content-type": "image/svg+xml" }, body: "<svg/>" }),
      env, ctx,
    );
    expect(res.status).toBe(400);
  });

  it("accepts a real image and keys it under uploads/", async () => {
    const { env, r2 } = makeEnv();
    const res = await worker.fetch(
      new Request(url("/api/upload"), { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) }),
      env, ctx,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; mime: string; size: number };
    expect(body.key.startsWith("uploads/")).toBe(true);
    expect(body.mime).toBe("image/png");
    // `size`, unified with the sibling upload routes per CONTRACT 2.10 (S40; was `bytes`).
    expect(body.size).toBe(3);
    expect(r2.has(body.key)).toBe(true);
  });

  it("rejects text/html on the character-ref upload too", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request(url("/api/storyboard/character-ref"), { method: "POST", headers: { "content-type": "text/html" }, body: "x" }),
      env, ctx,
    );
    expect(res.status).toBe(400);
  });
});
