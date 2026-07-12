import { describe, it, expect } from "vitest";
import { bundleKeyFor } from "../src/bundle-assembler";
import { isSafeBundleKey } from "../src/shared";

// #759: the bundle key was `bundles/<projectName>.tar.gz`, derived from the
// title alone, so two renders sharing a title (the default "Untitled", or the
// same project rendered twice concurrently) collided on ONE key and overwrote
// each other's tarball mid-render. The key is now content-addressed. These lock
// the two properties that fix depends on: distinct content -> distinct key (no
// collision), identical content -> identical key (idempotent dedupe preserved).

const bytes = (s: string) => new TextEncoder().encode(s);

describe("bundleKeyFor content-addressed bundle key (#759)", () => {
  it("same project + same content -> same key (idempotent dedupe)", async () => {
    const a = await bundleKeyFor("Untitled", bytes("tar-content-v1"));
    const b = await bundleKeyFor("Untitled", bytes("tar-content-v1"));
    expect(a).toBe(b);
  });

  it("same title but DIFFERENT content -> different keys (the collision fix)", async () => {
    const a = await bundleKeyFor("Untitled", bytes("render-one"));
    const b = await bundleKeyFor("Untitled", bytes("render-two"));
    expect(a).not.toBe(b);
  });

  it("different project titles -> different keys", async () => {
    const a = await bundleKeyFor("alpha", bytes("same-bytes"));
    const b = await bundleKeyFor("beta", bytes("same-bytes"));
    expect(a).not.toBe(b);
  });

  it("the derived key is a safe bundle key under bundles/", async () => {
    const key = await bundleKeyFor("my-project", bytes("x"));
    expect(key.startsWith("bundles/")).toBe(true);
    expect(key.endsWith(".tar.gz")).toBe(true);
    expect(isSafeBundleKey(key)).toBe(true);
  });

  it("the suffix is a 16-hex-char content hash", async () => {
    const key = await bundleKeyFor("proj", bytes("hello"));
    // bundles/proj-<16 hex>.tar.gz
    expect(key).toMatch(/^bundles\/proj-[0-9a-f]{16}\.tar\.gz$/);
  });
});
