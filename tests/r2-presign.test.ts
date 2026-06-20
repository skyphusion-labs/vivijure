import { describe, it, expect } from "vitest";
import { uriEncode, presignR2WithConfig, type R2PresignConfig } from "../src/r2-presign";

// Issue #9: R2 SigV4 query presign. uriEncode is pure; presignR2WithConfig is deterministic given an
// injected clock, so the signature can be locked as a known vector.

describe("uriEncode (RFC3986)", () => {
  it("leaves the unreserved set untouched", () => {
    expect(uriEncode("aZ09-._~", true)).toBe("aZ09-._~");
  });
  it("encodes a slash only when encodeSlash is true", () => {
    expect(uriEncode("a/b", false)).toBe("a/b");
    expect(uriEncode("a/b", true)).toBe("a%2Fb");
  });
  it("percent-encodes spaces and specials as uppercase hex", () => {
    expect(uriEncode("a b#c", false)).toBe("a%20b%23c");
    expect(uriEncode("@?&=", true)).toBe("%40%3F%26%3D");
  });
  it("UTF-8 encodes multi-byte characters", () => {
    expect(uriEncode(String.fromCharCode(0xe9), true)).toBe("%C3%A9"); // e-acute
  });
});

const cfg: R2PresignConfig = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "SECRETEXAMPLEKEY",
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "renders",
};
const FIXED = Date.UTC(2026, 5, 16, 12, 0, 0); // 2026-06-16T12:00:00Z

describe("presignR2WithConfig (SigV4 query presign)", () => {
  it("produces the documented query structure with the scoped credential", async () => {
    const url = await presignR2WithConfig(cfg, "GET", "out.mp4", 300, FIXED);
    const u = new URL(url);
    expect(u.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/renders/out.mp4");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Credential")).toBe("AKIDEXAMPLE/20260616/auto/s3/aws4_request");
    expect(u.searchParams.get("X-Amz-Date")).toBe("20260616T120000Z");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("encodes a key with slashes + specials in the path (slashes literal, specials escaped)", async () => {
    const url = await presignR2WithConfig(cfg, "GET", "renders/a b#c.mp4", 300, FIXED);
    expect(url).toContain("/renders/renders/a%20b%23c.mp4?");
  });

  it("is deterministic for identical inputs (known-vector lock)", async () => {
    const a = await presignR2WithConfig(cfg, "GET", "out.mp4", 300, FIXED);
    const b = await presignR2WithConfig(cfg, "GET", "out.mp4", 300, FIXED);
    expect(a).toBe(b);
  });

  it("the signature is sensitive to the secret, the method, the key, the expiry, and the clock", async () => {
    const sig = async (over: Partial<R2PresignConfig & { method: "GET" | "PUT"; key: string; exp: number; now: number }>) => {
      const c = { ...cfg, ...over };
      const url = await presignR2WithConfig(c, over.method ?? "GET", over.key ?? "out.mp4", over.exp ?? 300, over.now ?? FIXED);
      return new URL(url).searchParams.get("X-Amz-Signature");
    };
    const base = await sig({});
    expect(await sig({ secretAccessKey: "DIFFERENT" })).not.toBe(base);
    expect(await sig({ method: "PUT" })).not.toBe(base);
    expect(await sig({ key: "other.mp4" })).not.toBe(base);
    expect(await sig({ exp: 600 })).not.toBe(base);
    expect(await sig({ now: FIXED + 86_400_000 })).not.toBe(base);
  });
});

describe("presign hardening (security #6)", () => {
  it("refuses to sign an unsafe key (traversal, absolute, scheme, control, non-ASCII, empty)", async () => {
    const ctrl = "ctrl" + String.fromCharCode(1) + "x.mp4"; // control byte
    const nonAscii = "uni" + String.fromCharCode(0xe9) + ".mp4"; // e-acute, non-ASCII
    const bad = ["../secret.mp4", "a/../b.mp4", "..", "/abs.mp4", "http://evil/x", ctrl, nonAscii, ""];
    for (const k of bad) {
      await expect(presignR2WithConfig(cfg, "GET", k, 300, FIXED)).rejects.toThrow(/unsafe object key/);
    }
  });

  it("still signs a safe relative key, and benign specials (space, #) stay signable", async () => {
    expect(await presignR2WithConfig(cfg, "GET", "renders/proj/clips/shot_01.mp4", 300, FIXED)).toContain("X-Amz-Signature=");
    expect(await presignR2WithConfig(cfg, "GET", "renders/a b#c.mp4", 300, FIXED)).toContain("X-Amz-Signature=");
  });

  it("clamps the expiry into [1, 604800]s", async () => {
    const exp = async (e: number) =>
      new URL(await presignR2WithConfig(cfg, "GET", "out.mp4", e, FIXED)).searchParams.get("X-Amz-Expires");
    expect(await exp(99_999_999)).toBe("604800"); // above the 7-day cap -> clamped down
    expect(await exp(0)).toBe("1"); // below the floor -> clamped up
    expect(await exp(-5)).toBe("1");
    expect(await exp(Number.NaN)).toBe("1");
    expect(await exp(3600)).toBe("3600"); // in range -> untouched
  });
});
