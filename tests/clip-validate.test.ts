import { describe, it, expect, vi } from "vitest";
import {
  parseMoov, judgeClip, validateClipArtifact,
  CLIP_MIN_BYTES, CLIP_MIN_DURATION_S, CLIP_MAX_DURATION_S, CLIP_MAX_DIMENSION,
  type ClipValidateChecks,
} from "../src/clip-validate";
import { validateDoneClips } from "../src/render-orchestrator";
import type { ClipJob } from "../src/render-orchestrator";
import type { Env } from "../src/env";

// --- Minimal synthetic-mp4 builder (big-endian ISO-BMFF boxes). Only the fields the structural gate
// reads are populated; everything else is zero-filled to the right length. This is the "valid clip
// header" / "pure-noise buffer" / "zero-frame" fixture factory the task calls for. ---
function be32(n: number): number[] { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function ascii(s: string): number[] { return [...s].map((c) => c.charCodeAt(0)); }
function box(type: string, payload: number[]): number[] {
  const size = 8 + payload.length;
  return [...be32(size), ...ascii(type), ...payload];
}
function zeros(n: number): number[] { return new Array(n).fill(0); }

// mvhd (version 0): timescale + duration at offsets 12/16 of the payload.
function mvhd(timescale: number, duration: number): number[] {
  const p = zeros(100);
  [...be32(timescale)].forEach((b, i) => (p[12 + i] = b));
  [...be32(duration)].forEach((b, i) => (p[16 + i] = b));
  return box("mvhd", p);
}
// tkhd (version 0): width/height (16.16 fixed) at payload offsets 72/76.
function tkhd(width: number, height: number): number[] {
  // Spec-correct offsets (ISO 14496-12 v0 tkhd payload): width at 76, height at 80. NOTE: these must
  // match the parser, but a self-consistent synthetic fixture cannot PROVE the offset -- the real-bytes
  // test below is the independent guard against both moving together to the wrong place.
  const p = zeros(84);
  [...be32(width << 16)].forEach((b, i) => (p[76 + i] = b));
  [...be32(height << 16)].forEach((b, i) => (p[80 + i] = b));
  return box("tkhd", p);
}
// hdlr: handler_type at payload offset 8.
function hdlr(kind: string): number[] {
  const p = [...zeros(8), ...ascii(kind), ...zeros(12)];
  return box("hdlr", p);
}
// stsz: sample_count at payload offset 8.
function stsz(count: number): number[] {
  const p = [...zeros(8), ...be32(count)];
  return box("stsz", p);
}
function videoTrak(width: number, height: number, frames: number): number[] {
  const stbl = box("stbl", stsz(frames));
  const minf = box("minf", stbl);
  const mdia = box("mdia", [...hdlr("vide"), ...minf]);
  return box("trak", [...tkhd(width, height), ...mdia]);
}
function moov(opts: { timescale: number; duration: number; width: number; height: number; frames: number; video?: boolean }): number[] {
  const children = [...mvhd(opts.timescale, opts.duration)];
  if (opts.video !== false) children.push(...videoTrak(opts.width, opts.height, opts.frames));
  else children.push(...box("trak", [...tkhd(opts.width, opts.height), ...box("mdia", hdlr("soun"))]));
  return box("moov", children);
}
function ftyp(): number[] { return box("ftyp", [...ascii("isom"), ...be32(0x200), ...ascii("isommp42")]); }
function mdat(payloadBytes: number): number[] { return box("mdat", zeros(payloadBytes)); }

// A structurally-valid mp4. `mdatBytes` pads it past the size floor; `faststart` puts moov before mdat.
function buildMp4(o: { timescale?: number; duration?: number; width?: number; height?: number; frames?: number; video?: boolean; mdatBytes?: number; faststart?: boolean } = {}): Uint8Array {
  const m = moov({ timescale: o.timescale ?? 600, duration: o.duration ?? 1800, width: o.width ?? 512, height: o.height ?? 512, frames: o.frames ?? 48, video: o.video });
  const d = mdat(o.mdatBytes ?? 4000);
  const parts = o.faststart === false ? [...ftyp(), ...d, ...m] : [...ftyp(), ...m, ...d];
  return new Uint8Array(parts);
}

function fakeR2(bytes: Uint8Array | null): Env {
  return {
    R2_RENDERS: {
      head: async () => (bytes ? { size: bytes.length } : null),
      get: async (_k: string, opts?: { range?: { offset: number; length: number } }) => {
        if (!bytes) return null;
        const off = opts?.range?.offset ?? 0;
        const len = opts?.range?.length ?? bytes.length;
        const slice = bytes.slice(off, off + len);
        return { arrayBuffer: async () => slice.buffer };
      },
    },
  } as unknown as Env;
}

describe("parseMoov (pure mp4 box parse)", () => {
  it("reads duration, video track, dimensions, and frame count from a well-formed moov", () => {
    const m = new Uint8Array(moov({ timescale: 600, duration: 1800, width: 720, height: 480, frames: 49 }));
    // parseMoov takes the moov PAYLOAD (skip the 8-byte moov header).
    const info = parseMoov(m.subarray(8));
    expect(info.durationS).toBeCloseTo(3.0, 5);
    expect(info.hasVideoTrack).toBe(true);
    expect(info.frames).toBe(49);
    expect(info.width).toBe(720);
    expect(info.height).toBe(480);
  });
  it("reports no video track when the only track is audio", () => {
    const m = new Uint8Array(moov({ timescale: 600, duration: 1800, width: 0, height: 0, frames: 0, video: false }));
    const info = parseMoov(m.subarray(8));
    expect(info.hasVideoTrack).toBe(false);
  });
  it("never throws on a truncated moov (reports what it could read)", () => {
    const m = new Uint8Array(moov({ timescale: 600, duration: 1800, width: 512, height: 512, frames: 24 }));
    const info = parseMoov(m.subarray(8, 8 + 40)); // cut mid-box
    expect(info).toBeDefined();
  });
});

describe("judgeClip (pure verdict matrix)", () => {
  const base = (): ClipValidateChecks => ({ container: true, video_track: true, duration_s: 3, expected_s: 4, frames: 48, width: 512, height: 512, bytes: 5000 });
  it("passes a structurally-sound clip", () => {
    expect(judgeClip(base()).verdict).toBe("pass");
  });
  it("fails a clip under the byte floor (truncated/empty)", () => {
    const r = judgeClip({ ...base(), bytes: CLIP_MIN_BYTES - 1 });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toContain("bytes");
  });
  it("fails a non-mp4 body (no container)", () => {
    expect(judgeClip({ ...base(), container: false }).verdict).toBe("fail");
  });
  it("fails a zero-duration container", () => {
    expect(judgeClip({ ...base(), duration_s: 0 }).verdict).toBe("fail");
  });
  it("fails a runaway duration above the ceiling", () => {
    expect(judgeClip({ ...base(), duration_s: CLIP_MAX_DURATION_S + 1 }).verdict).toBe("fail");
  });
  it("fails a clip with no video track", () => {
    expect(judgeClip({ ...base(), video_track: false }).verdict).toBe("fail");
  });
  it("fails a zero-frame video track", () => {
    expect(judgeClip({ ...base(), frames: 0 }).verdict).toBe("fail");
  });
  it("fails an out-of-bounds dimension", () => {
    expect(judgeClip({ ...base(), width: CLIP_MAX_DIMENSION + 1 }).verdict).toBe("fail");
  });
  it("does NOT gate on expected vs actual duration (backends have fixed lengths)", () => {
    // requested 4s, actual 3s: a legit mismatch (CogVideoX/LTX emit a fixed frame count). Must pass.
    expect(judgeClip({ ...base(), expected_s: 4, duration_s: 3 }).verdict).toBe("pass");
    expect(judgeClip({ ...base(), expected_s: 4, duration_s: CLIP_MIN_DURATION_S + 0.01 }).verdict).toBe("pass");
  });
});

describe("validateClipArtifact (bounded R2 reads -> verdict)", () => {
  it("passes a valid faststart mp4", async () => {
    const r = await validateClipArtifact(fakeR2(buildMp4({ faststart: true })), "renders/p/clips/shot_01_i2v.mp4", 4);
    expect(r.verdict).toBe("pass");
    expect(r.checks).toMatchObject({ container: true, video_track: true, frames: 48, width: 512, height: 512 });
  });
  it("passes a valid mp4 whose moov is AFTER mdat (seek path)", async () => {
    const r = await validateClipArtifact(fakeR2(buildMp4({ faststart: false })), "k", 4);
    expect(r.verdict).toBe("pass");
    expect(r.checks.duration_s).toBeCloseTo(3.0, 5);
  });
  it("HONEST LIMIT: a structurally-valid but pure-noise clip PASSES Layer 1 (needs Layer 2 pixel decode)", async () => {
    // The local-16gb#35 corruption is valid mp4 structure with garbage pixels. Byte content is opaque to
    // the in-Worker gate by design; this test pins the documented boundary so nobody assumes it is caught.
    const noise = buildMp4({ mdatBytes: 411000 }); // same shape as the #35 411KB noise clip, valid header
    const r = await validateClipArtifact(fakeR2(noise), "k", 3);
    expect(r.verdict).toBe("pass");
  });
  it("fails a truncated/tiny body under the byte floor", async () => {
    const r = await validateClipArtifact(fakeR2(new Uint8Array(ftyp())), "k", 4);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toContain("bytes");
  });
  it("fails a non-mp4 body (no ftyp)", async () => {
    const junk = new Uint8Array(3000).fill(0x41); // 'AAAA...' -- not a box tree
    const r = await validateClipArtifact(fakeR2(junk), "k", 4);
    expect(r.verdict).toBe("fail");
    expect(r.checks.container).toBe(false);
  });
  it("fails a zero-frame clip", async () => {
    const r = await validateClipArtifact(fakeR2(buildMp4({ frames: 0 })), "k", 4);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toContain("zero frames");
  });
  it("fails a zero-duration clip", async () => {
    const r = await validateClipArtifact(fakeR2(buildMp4({ duration: 0 })), "k", 4);
    expect(r.verdict).toBe("fail");
  });
  it("SKIPS (never fails) when the artifact is unreadable -- an I/O blip must not reject a real render", async () => {
    const r = await validateClipArtifact(fakeR2(null), "k", 4);
    expect(r.verdict).toBe("skip");
  });
});

describe("validateDoneClips (the clip-job seam)", () => {
  function jobWith(clipKey: string): ClipJob {
    return {
      job_id: "clips-x", project: "p", motion_backend: "own-gpu", binding: "MODULE_OWN_GPU", created_at: 0,
      shots: [{ shot_id: "shot_01", keyframe_url: "u", prompt: "x", seconds: 4, status: "done", clip_key: clipKey }],
    };
  }
  it("flips a structurally-corrupt done clip to FAILED with a real reason (honest failure) + clears poll", async () => {
    const job = jobWith("renders/p/clips/shot_01_i2v.mp4");
    job.shots[0].poll = "tok";
    const changed = await validateDoneClips(fakeR2(buildMp4({ frames: 0 })), job);
    expect(changed).toBe(true);
    expect(job.shots[0].status).toBe("failed");
    expect(job.shots[0].validated).toBe("fail");
    expect(job.shots[0].error).toContain("output validation");
    expect(job.shots[0].poll).toBeUndefined(); // no orphan-cancel on a clip that already landed
  });
  it("passes a valid clip: stays done, validated=pass, no change", async () => {
    const job = jobWith("k");
    const changed = await validateDoneClips(fakeR2(buildMp4()), job);
    expect(changed).toBe(false);
    expect(job.shots[0].status).toBe("done");
    expect(job.shots[0].validated).toBe("pass");
  });
  it("is idempotent: a second pass does not re-read or re-emit", async () => {
    const job = jobWith("k");
    const env = fakeR2(buildMp4());
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await validateDoneClips(env, job);
    await validateDoneClips(env, job); // validated already set -> skipped
    const emits = spy.mock.calls.filter((c) => String(c[0]).includes("clip.validate")).length;
    spy.mockRestore();
    expect(emits).toBe(1);
  });
  it("emits a clip.validate structured event (smoke tests assert on the event, not prose)", async () => {
    const job = jobWith("k");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await validateDoneClips(fakeR2(buildMp4()), job);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("clip.validate"));
    spy.mockRestore();
    expect(line).toBeDefined();
    const ev = JSON.parse(line as string);
    expect(ev).toMatchObject({ ev: "clip.validate", job_id: "clips-x", shot_id: "shot_01", verdict: "pass" });
    expect(ev.checks).toMatchObject({ container: true, video_track: true });
  });
  it("leaves a shot untouched on skip (unreadable artifact)", async () => {
    const job = jobWith("k");
    const changed = await validateDoneClips(fakeR2(null), job);
    expect(changed).toBe(false);
    expect(job.shots[0].status).toBe("done");
    expect(job.shots[0].validated).toBe("skip");
  });
});


// --- Independent guard against the self-consistent-fixture trap: a REAL moov box extracted from an
// ffmpeg-muxed mp4 (testsrc 320x240, 24 frames, 1.0s), asserted against what ffprobe reports. If a box
// offset in the parser drifts, THIS fails even though the synthetic builder above stays internally happy.
const REAL_MOOV_PAYLOAD_HEX =
  "0000006c6d766864000000000000000000000000000003e8000003e80001000001000000000000000000000000010000" +
  "000000000000000000000000000100000000000000000000000000004000000000000000000000000000000000000000" +
  "000000000000000000000002000003757472616b0000005c746b68640000000300000000000000000000000100000000" +
  "000003e80000000000000000000000000000000000010000000000000000000000000000000100000000000000000000" +
  "00000000400000000140000000f0000000000024656474730000001c656c73740000000000000001000003e800000400" +
  "00010000000002ed6d646961000000206d646864000000000000000000000000000030000000300055c400000000002d" +
  "68646c72000000000000000076696465000000000000000000000000566964656f48616e646c657200000002986d696e" +
  "6600000014766d68640000000100000000000000000000002464696e660000001c647265660000000000000001000000" +
  "0c75726c2000000001000002587374626c000000c0737473640000000000000001000000b06176633100000000000000" +
  "0100000000000000000000000000000000014000f00048000000480000000000000001154c61766336302e33312e3130" +
  "32206c696278323634000000000000000000000018ffff00000036617663430164000dffe100196764000dacd94141fb" +
  "011000000300100000030300f142996001000668ebe3cb22c0fdf8f80000000010706173700000000100000001000000" +
  "1462747274000000000000de080000de0800000018737474730000000000000001000000180000020000000014737473" +
  "73000000000000000100000001000000c063747473000000000000001600000001000004000000000100000a00000000" +
  "0100000400000000010000000000000001000002000000000100000a0000000001000004000000000100000000000000" +
  "01000002000000000100000a000000000100000400000000010000000000000001000002000000000100000a00000000" +
  "010000040000000001000000000000000100000200000000010000080000000002000002000000000100000800000000" +
  "020000020000000001000004000000001c73747363000000000000000100000001000000180000000100000074737473" +
  "7a00000000000000000000001800000ee9000001ea000000610000002f0000001a000001a9000000570000001d000000" +
  "2a000001e500000046000000280000001e000001990000005a0000001f000000200000012f0000002b00000022000000" +
  "fc000000320000001f00000091000000147374636f00000000000000010000003000000062756474610000005a6d6574" +
  "61000000000000002168646c7200000000000000006d6469726170706c0000000000000000000000002d696c73740000" +
  "0025a9746f6f0000001d6461746100000001000000004c61766636302e31362e313030";
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
describe("parseMoov against REAL ffmpeg mp4 bytes (anti-self-consistency guard)", () => {
  it("reads ffprobe-authoritative width=320, height=240, frames=24, duration=1.0s", () => {
    const info = parseMoov(hexToBytes(REAL_MOOV_PAYLOAD_HEX));
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.frames).toBe(24);
    expect(info.hasVideoTrack).toBe(true);
    expect(info.durationS).toBeCloseTo(1.0, 3);
  });
});
