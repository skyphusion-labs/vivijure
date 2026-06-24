import { describe, it, expect } from "vitest";
import { buildTar, parseTar, tarHeader, tarPadding, tarEof, TAR_BLOCK } from "../src/tar";

const enc = new TextEncoder();

describe("tar (USTAR) writer/reader", () => {
  it("round-trips a set of files byte-for-byte", () => {
    const files = [
      { name: "manifest.json", data: enc.encode('{"hello":"world"}') },
      { name: "assets/portrait.png", data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: "assets/lora.safetensors", data: new Uint8Array(1000).fill(7) },
    ];
    const tar = buildTar(files);
    const parsed = parseTar(tar);
    expect(parsed.map((f) => f.name)).toEqual(files.map((f) => f.name));
    parsed.forEach((f, i) => {
      expect(Array.from(f.data)).toEqual(Array.from(files[i].data));
    });
  });

  it("pads every entry + the archive to 512-byte block boundaries", () => {
    const tar = buildTar([{ name: "a.bin", data: new Uint8Array([9]) }]);
    // header(512) + data padded to 512 + EOF(1024)
    expect(tar.length % TAR_BLOCK).toBe(0);
    expect(tar.length).toBe(TAR_BLOCK + TAR_BLOCK + TAR_BLOCK * 2);
  });

  it("an empty-file entry survives the round-trip", () => {
    const parsed = parseTar(buildTar([{ name: "empty", data: new Uint8Array(0) }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].data).toHaveLength(0);
  });

  it("tarPadding rounds up to the next block and is empty on a boundary", () => {
    expect(tarPadding(0).length).toBe(0);
    expect(tarPadding(512).length).toBe(0);
    expect(tarPadding(1).length).toBe(511);
    expect(tarPadding(513).length).toBe(511);
  });

  it("writes a valid USTAR magic + checksum in the header", () => {
    const h = tarHeader("x.txt", 5);
    expect(h.length).toBe(TAR_BLOCK);
    expect(new TextDecoder().decode(h.subarray(257, 262))).toBe("ustar");
    // recompute the checksum with the chksum field blanked to spaces and compare
    const copy = h.slice();
    for (let i = 148; i < 156; i++) copy[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) sum += copy[i];
    const stored = parseInt(new TextDecoder().decode(h.subarray(148, 154)).trim(), 8);
    expect(stored).toBe(sum);
  });

  it("rejects an entry name longer than 100 bytes (loud, no PAX fallback)", () => {
    expect(() => tarHeader("a/".repeat(60), 0)).toThrow(/name too long/);
  });

  it("throws on a truncated archive (declared size runs past the buffer)", () => {
    const tar = buildTar([{ name: "big", data: new Uint8Array(2000).fill(1) }]);
    // lop off the final data + EOF so the declared size overshoots
    const truncated = tar.subarray(0, TAR_BLOCK + 100);
    expect(() => parseTar(truncated)).toThrow(/truncated/);
  });

  it("stops cleanly at the end-of-archive zero blocks", () => {
    const tar = buildTar([{ name: "only", data: enc.encode("hi") }]);
    expect(tarEof().length).toBe(TAR_BLOCK * 2);
    // trailing garbage after EOF must not be parsed as another entry
    const withTrailer = new Uint8Array(tar.length + TAR_BLOCK);
    withTrailer.set(tar, 0);
    withTrailer.set(enc.encode("junk-not-a-real-header"), tar.length);
    expect(parseTar(withTrailer).map((f) => f.name)).toEqual(["only"]);
  });
});
