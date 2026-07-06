import { describe, it, expect } from "vitest";
import { finishChainForShot } from "../src/film-orchestrator";
import { finishStepInputHash } from "../src/finish-hash";
import { MODULE_API, type RegisteredModule } from "../src/modules/types";

// #584: for a DIALOGUE shot the finish chain must run the audio-consuming module (lip-sync) FIRST, on
// the native-fps clip, before interpolation; a NON-dialogue shot keeps the plain ui.order. The reorder
// is driven ONLY by the module self-declaration `finish_consumes_audio` (never a module name), and the
// #583 finishStepInputHash must differ across the two orderings on its own, with no special-case,
// because each step then sees a different INPUT clip (see docs/CONTRACT.md 3.3.1).

const mod = (name: string, order: number, consumesAudio: boolean): RegisteredModule => ({
  name,
  version: "0.0.0",
  api: MODULE_API,
  hooks: ["finish"],
  ui: { order },
  finish_consumes_audio: consumesAudio,
  binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`,
});

// serving is already ui.order-sorted (as servingForHook returns it): rife 10, lipsync 15, upscale 20.
const rife = mod("finish-rife", 10, false);
const lipsync = mod("finish-lipsync", 15, true);
const upscale = mod("finish-upscale", 20, false);
const serving = [rife, lipsync, upscale];

describe("finishChainForShot (#584 dialogue-aware finish order)", () => {
  it("NON-dialogue shot: keeps the plain ui.order (unchanged from before)", () => {
    const ordered = finishChainForShot(serving, false);
    expect(ordered.map((m) => m.name)).toEqual(["finish-rife", "finish-lipsync", "finish-upscale"]);
  });

  it("DIALOGUE shot: hoists the audio-consuming module (lip-sync) FIRST, ui.order preserved otherwise", () => {
    const ordered = finishChainForShot(serving, true);
    expect(ordered.map((m) => m.name)).toEqual(["finish-lipsync", "finish-rife", "finish-upscale"]);
  });

  it("the reorder neither drops nor duplicates a module (same set, both orderings)", () => {
    const dlg = finishChainForShot(serving, true).map((m) => m.name).sort();
    const non = finishChainForShot(serving, false).map((m) => m.name).sort();
    expect(dlg).toEqual(non);
    expect(dlg).toEqual(["finish-lipsync", "finish-rife", "finish-upscale"]);
  });

  it("is a STABLE partition: two audio-consumers keep their relative ui.order", () => {
    const lipA = mod("finish-lip-a", 15, true);
    const lipB = mod("finish-lip-b", 17, true);
    const ordered = finishChainForShot([rife, lipA, lipB, upscale], true);
    expect(ordered.map((m) => m.name)).toEqual(["finish-lip-a", "finish-lip-b", "finish-rife", "finish-upscale"]);
  });

  it("no audio-consumer declared: order is untouched even for a dialogue shot", () => {
    const plain = [rife, upscale];
    expect(finishChainForShot(plain, true).map((m) => m.name)).toEqual(["finish-rife", "finish-upscale"]);
  });
});

describe("#584 order change yields a different #583 finishStepInputHash, no special-case", () => {
  // The two orderings thread clip keys differently, so the lip-sync STEP sees a different input clip:
  //  - dialogue order   [lipsync, rife, upscale]: lip-sync consumes the RAW i2v clip (native fps).
  //  - non-dialogue ord [rife, lipsync, upscale]: lip-sync would consume RIFE`s interpolated output.
  // Same audio + same lip-sync config; only the INPUT clip etag differs -> the hash differs on its own.
  const audioEtag = "\"9e107d9d372bb6826bd81d3542a419d6\"";
  const lipsyncConfig = { version: "v15", bbox_shift: 0 };
  const rawClipEtag = "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"";       // the native-fps i2v clip
  const rifeOutClipEtag = "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"";   // RIFE`s interpolated output

  it("lip-sync step input hash differs when it consumes the raw clip vs the interpolated clip", async () => {
    const hashDialogue = await finishStepInputHash(rawClipEtag, audioEtag, lipsyncConfig);
    const hashNonDialogue = await finishStepInputHash(rifeOutClipEtag, audioEtag, lipsyncConfig);
    expect(hashDialogue).not.toBe(hashNonDialogue);
  });

  it("identical input clip + audio + config still hash identically (determinism, not order-tagged)", async () => {
    const a = await finishStepInputHash(rawClipEtag, audioEtag, lipsyncConfig);
    const b = await finishStepInputHash(rawClipEtag, audioEtag, lipsyncConfig);
    expect(a).toBe(b);
  });
});
