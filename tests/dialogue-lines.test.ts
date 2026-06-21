import { describe, it, expect } from "vitest";
import { buildDialogueLines } from "../src/dialogue-lines";

const voices = { A: "orion", B: "hera" };

// Stored storyboard shape (D1 last_storyboard): scenes with optional id + dialogue {slot, text}.
const storyboard = {
  title: "t",
  scenes: [
    { id: "shot_01", prompt: "a", character_slots: ["A", "B"], dialogue: { slot: "A", text: "  We're here.  " } },
    { id: "shot_02", prompt: "b", character_slots: ["B"], dialogue: { slot: "B", text: "Are we?" } },
    { id: "shot_03", prompt: "c" },                        // silent shot, no dialogue
    { id: "shot_04", prompt: "d", dialogue: { slot: "C", text: "Uncast voice." } }, // slot has no cast voice
  ],
};

describe("buildDialogueLines", () => {
  it("builds a line per speaking shot, trims text, resolves voice from the slot map", () => {
    const lines = buildDialogueLines(storyboard, voices, ["shot_01", "shot_02", "shot_03", "shot_04"]);
    expect(lines).toEqual([
      { shot_id: "shot_01", text: "We're here.", voice_id: "orion" },
      { shot_id: "shot_02", text: "Are we?", voice_id: "hera" },
      { shot_id: "shot_04", text: "Uncast voice.", voice_id: "angus" }, // no cast voice -> default
    ]);
  });

  it("excludes shots not in the render set (e.g. a scatter shard)", () => {
    const lines = buildDialogueLines(storyboard, voices, ["shot_02"]);
    expect(lines.map((l) => l.shot_id)).toEqual(["shot_02"]);
  });

  it("returns [] for a storyboard with no dialogue, missing scenes, or junk input", () => {
    expect(buildDialogueLines({ scenes: [{ id: "shot_01", prompt: "a" }] }, voices, ["shot_01"])).toEqual([]);
    expect(buildDialogueLines({}, voices, ["shot_01"])).toEqual([]);
    expect(buildDialogueLines(null, voices, ["shot_01"])).toEqual([]);
    expect(buildDialogueLines("nope", voices, ["shot_01"])).toEqual([]);
  });

  it("skips a dialogue with a non-string slot/text or empty line", () => {
    const sb = { scenes: [
      { id: "shot_01", dialogue: { slot: "A", text: "   " } },     // empty after trim
      { id: "shot_02", dialogue: { slot: 5, text: "x" } },          // bad slot
      { id: "shot_03", dialogue: { text: "no slot" } },             // missing slot
    ] };
    expect(buildDialogueLines(sb, voices, ["shot_01", "shot_02", "shot_03"])).toEqual([]);
  });

  it("coerces shot ids by position when ids are absent (matches the bundle numbering)", () => {
    const sb = { scenes: [
      { prompt: "a", dialogue: { slot: "A", text: "one" } },        // -> shot_01
      { prompt: "b", dialogue: { slot: "B", text: "two" } },        // -> shot_02
    ] };
    const lines = buildDialogueLines(sb, voices, ["shot_01", "shot_02"]);
    expect(lines.map((l) => l.shot_id)).toEqual(["shot_01", "shot_02"]);
  });
});
