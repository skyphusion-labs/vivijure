import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { parseByteRange } from "../src/shared";

// #416: HTTP byte-range serving on /api/artifact so browsers can stream + seek planner films
// (Safari/iOS will not play media that cannot be range-requested; Chrome re-fetches from byte 0).

describe("parseByteRange (RFC 7233, single range)", () => {
  const SIZE = 1000;

  it("returns null for a missing / blank header (serve full 200)", () => {
    expect(parseByteRange(null, SIZE)).toBeNull();
    expect(parseByteRange(undefined, SIZE)).toBeNull();
    expect(parseByteRange("", SIZE)).toBeNull();
  });

  it("parses a closed range bytes=0-499", () => {
    expect(parseByteRange("bytes=0-499", SIZE)).toEqual({ offset: 0, length: 500, start: 0, end: 499 });
  });

  it("parses a mid closed range bytes=500-999", () => {
    expect(parseByteRange("bytes=500-999", SIZE)).toEqual({ offset: 500, length: 500, start: 500, end: 999 });
  });

  it("parses a single byte bytes=0-0", () => {
    expect(parseByteRange("bytes=0-0", SIZE)).toEqual({ offset: 0, length: 1, start: 0, end: 0 });
  });

  it("parses an open-ended range bytes=200- to the end", () => {
    expect(parseByteRange("bytes=200-", SIZE)).toEqual({ offset: 200, length: 800, start: 200, end: 999 });
  });

  it("parses a suffix range bytes=-100 (last 100 bytes)", () => {
    expect(parseByteRange("bytes=-100", SIZE)).toEqual({ offset: 900, length: 100, start: 900, end: 999 });
  });

  it("clamps a suffix larger than the object to the whole file", () => {
    expect(parseByteRange("bytes=-5000", SIZE)).toEqual({ offset: 0, length: 1000, start: 0, end: 999 });
  });

  it("clamps a closed end past the object to the last byte", () => {
    expect(parseByteRange("bytes=990-100000", SIZE)).toEqual({ offset: 990, length: 10, start: 990, end: 999 });
  });

  it("treats a whole-file range bytes=0- as satisfiable (206 of the full body)", () => {
    expect(parseByteRange("bytes=0-", SIZE)).toEqual({ offset: 0, length: 1000, start: 0, end: 999 });
  });

  it("returns unsatisfiable when the first byte is at/after the end", () => {
    expect(parseByteRange("bytes=1000-1100", SIZE)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=5000-", SIZE)).toBe("unsatisfiable");
  });

  it("returns unsatisfiable for the last 0 bytes (bytes=-0)", () => {
    expect(parseByteRange("bytes=-0", SIZE)).toBe("unsatisfiable");
  });

  it("returns unsatisfiable for any range against an empty object", () => {
    expect(parseByteRange("bytes=0-0", 0)).toBe("unsatisfiable");
  });

  it("ignores a reversed range (serve full 200)", () => {
    expect(parseByteRange("bytes=500-200", SIZE)).toBeNull();
  });

  it("ignores a malformed / non-numeric range", () => {
    expect(parseByteRange("bytes=abc-def", SIZE)).toBeNull();
    expect(parseByteRange("bytes=-", SIZE)).toBeNull();
    expect(parseByteRange("bytes=10", SIZE)).toBeNull();
    expect(parseByteRange("bytes=", SIZE)).toBeNull();
  });

  it("ignores a non-bytes unit", () => {
    expect(parseByteRange("items=0-10", SIZE)).toBeNull();
  });

  it("ignores a multi-range request (serve full 200, we do not do multipart)", () => {
    expect(parseByteRange("bytes=0-99,200-299", SIZE)).toBeNull();
  });
});

// --- end-to-end through the worker fetch handler --------------------------------------------------

function makeEnv() {
  const r2 = new Map<string, { bytes: Uint8Array; mime: string }>();
  const stream = (u8: Uint8Array) =>
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(u8); c.close(); } });
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    R2_RENDERS: {
      async head(key: string) {
        const o = r2.get(key);
        if (!o) return null;
        return { size: o.bytes.length, httpMetadata: { contentType: o.mime } };
      },
      async get(key: string, opts?: { range?: { offset: number; length: number } }) {
        const o = r2.get(key);
        if (!o) return null;
        const range = opts?.range;
        const bytes = range ? o.bytes.slice(range.offset, range.offset + range.length) : o.bytes;
        return { size: o.bytes.length, body: stream(bytes), httpMetadata: { contentType: o.mime } };
      },
    },
  } as unknown as Env;
  return { env, r2 };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const url = (path: string) => `https://studio.example${path}`;

// A 1000-byte artifact of ascending values (mod 256).
function seed1000(r2: Map<string, { bytes: Uint8Array; mime: string }>) {
  const bytes = new Uint8Array(1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  r2.set("renders/film.mp4", { bytes, mime: "video/mp4" });
  return bytes;
}

describe("#416 /api/artifact byte-range serving", () => {
  it("advertises Accept-Ranges on a plain full GET", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(new Request(url("/api/artifact/renders/film.mp4")), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
  });

  it("returns 206 + Content-Range for a satisfiable closed range", async () => {
    const { env, r2 } = makeEnv();
    const bytes = seed1000(r2);
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { headers: { Range: "bytes=100-199" } }),
      env, ctx,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(Array.from(body)).toEqual(Array.from(bytes.slice(100, 200)));
  });

  it("serves an open-ended range bytes=900- to the end as 206", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { headers: { Range: "bytes=900-" } }),
      env, ctx,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(res.headers.get("content-length")).toBe("100");
  });

  it("serves a suffix range bytes=-50 (last 50 bytes) as 206", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { headers: { Range: "bytes=-50" } }),
      env, ctx,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 950-999/1000");
    expect(res.headers.get("content-length")).toBe("50");
  });

  it("returns 416 + Content-Range for an out-of-bounds range", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { headers: { Range: "bytes=2000-3000" } }),
      env, ctx,
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("ignores a malformed Range and serves the full 200", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { headers: { Range: "bytes=abc" } }),
      env, ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("ignores a multi-range request and serves the full 200", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { headers: { Range: "bytes=0-99,200-299" } }),
      env, ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
  });

  it("answers HEAD with headers only (no body) and Accept-Ranges", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { method: "HEAD" }),
      env, ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(0);
  });

  it("answers HEAD with a satisfiable Range as 206 headers, no body", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { method: "HEAD", headers: { Range: "bytes=0-99" } }),
      env, ctx,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-99/1000");
    expect(res.headers.get("content-length")).toBe("100");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(0);
  });

  it("404s a ranged request for a missing artifact (never leaks not-found vs range)", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/missing.mp4"), { headers: { Range: "bytes=0-99" } }),
      env, ctx,
    );
    expect(res.status).toBe(404);
  });

  it("keeps the prefix guard on a ranged request (no arbitrary-object serve)", async () => {
    const { env, r2 } = makeEnv();
    r2.set("secret/creds.json", { bytes: new Uint8Array([1, 2, 3]), mime: "application/json" });
    const res = await worker.fetch(
      new Request(url("/api/artifact/secret/creds.json"), { headers: { Range: "bytes=0-1" } }),
      env, ctx,
    );
    expect(res.status).toBe(404);
  });
});

// --- #646: no render bucket bound (the zero-spend public demo) -> clean 404, never a 500 ------------
// A demo deploy binds no R2 (spend-impossible by construction) and its seeded rows carry absolute
// showcase URLs, so the frontend never hits this route. A manually-poked key still must get the honest
// answer -- there is no store, so there is no such artifact -- as a clean 404, not a thrown 500.
function makeEnvNoR2() {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    // R2_RENDERS deliberately absent -- this is the demo binding-absence shape.
  } as unknown as Env;
}

describe("#646 no-R2 deploy: /api/artifact serves an honest 404, not a 500", () => {
  it("GET a well-formed key with no binding -> 404 with steer-language body (no store)", async () => {
    const res = await worker.fetch(new Request(url("/api/artifact/renders/film.mp4")), makeEnvNoR2(), ctx);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "the artifact store is not available on this deployment" });
    // steer language, never breakage language: no "broken", no "internal", no stack noise.
    expect(body.error).not.toMatch(/broken|internal|stack|undefined|R2_RENDERS/i);
  });

  it("HEAD a well-formed key with no binding -> 404, no body, no throw", async () => {
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { method: "HEAD" }), makeEnvNoR2(), ctx,
    );
    expect(res.status).toBe(404);
  });

  it("a ranged GET with no binding -> 404 (never a 500)", async () => {
    const res = await worker.fetch(
      new Request(url("/api/artifact/renders/film.mp4"), { headers: { Range: "bytes=0-99" } }), makeEnvNoR2(), ctx,
    );
    expect(res.status).toBe(404);
  });

  it("WITH the binding present, serving is byte-identical (guard is a no-op on prod)", async () => {
    const { env, r2 } = makeEnv();
    seed1000(r2);
    const res = await worker.fetch(new Request(url("/api/artifact/renders/film.mp4")), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });
});
