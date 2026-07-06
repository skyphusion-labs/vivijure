import { describe, it, expect } from "vitest";
import { serializeStoryboardYaml, parseStoryboardScenes } from "../src/planner-yaml";
import { dialogueLinesFromBundleScenes, resolveExplicitLineVoices } from "../src/dialogue-lines";
import type { StoryboardValidated, StoryboardScene } from "../src/storyboard-validate";

// Issue #313: a bundle-only render must be able to derive dialogue_lines from the dialogue the bundle
// storyboard.yaml carries (round-tripped by #307). Two pieces: parseStoryboardScenes reads the dialogue
// block back out, and dialogueLinesFromBundleScenes turns it into the per-shot voiced batch.

function sb(scenes: StoryboardScene[]): StoryboardValidated {
  return {
    title: "T", projectName: "t", full_prompt: "p",
    duration_seconds: undefined, clip_seconds: undefined,
    style_prefix: "", style_category: "None", style_preset: "None",
    use_characters: ["A", "B"], cast_rules: "", scenes,
  };
}

describe("parseStoryboardScenes recovers dialogue (#313 round-trip of #307)", () => {
  it("a dialogue scene survives serializeStoryboardYaml -> parseStoryboardScenes", () => {
    const yaml = serializeStoryboardYaml(
      sb([
        { id: "shot_01", prompt: "A speaks", character_slots: ["A"], target_seconds: 4,
          dialogue: { slot: "A", text: "We move now." } },
        { id: "shot_02", prompt: "silent", character_slots: ["B"], target_seconds: 5 },
      ]),
    );
    const parsed = parseStoryboardScenes(yaml);
    expect(parsed.map((s) => s.shot_id)).toEqual(["shot_01", "shot_02"]);
    expect(parsed[0].dialogue).toEqual({ slot: "A", text: "We move now." });
    expect(parsed[1].dialogue).toBeUndefined(); // silent shot -> no dialogue
    expect(parsed[0].seconds).toBe(4); // dialogue parsing doesn't disturb seconds/prompt
  });

  it("recovers dialogue text with escaped quotes / colons", () => {
    const yaml = serializeStoryboardYaml(
      sb([{ id: "shot_01", prompt: "x", character_slots: ["A"],
            dialogue: { slot: "A", text: 'He said "run": go.' } }]),
    );
    const parsed = parseStoryboardScenes(yaml);
    expect(parsed[0].dialogue).toEqual({ slot: "A", text: 'He said "run": go.' });
  });
});

describe("dialogueLinesFromBundleScenes (#313)", () => {
  const scenes = [
    { shot_id: "shot_01", prompt: "a", seconds: 4, dialogue: { slot: "A", text: "Warn." } },
    { shot_id: "shot_02", prompt: "b", seconds: 4 }, // silent
    { shot_id: "shot_03", prompt: "c", seconds: 4, dialogue: { slot: "B", text: "Answer." } },
  ];

  it("builds one voiced line per speaking shot, skipping silent shots", () => {
    const lines = dialogueLinesFromBundleScenes(scenes, { A: "asteria", B: "orion" });
    expect(lines).toEqual([
      { shot_id: "shot_01", text: "Warn.", voice_id: "asteria" },
      { shot_id: "shot_03", text: "Answer.", voice_id: "orion" },
    ]);
  });

  it("defaults the voice for a slot with no resolved cast voice", () => {
    const lines = dialogueLinesFromBundleScenes(scenes, {}); // no voices resolved
    expect(lines.map((l) => l.voice_id)).toEqual(["angus", "angus"]); // DEFAULT_VOICE_ID
  });

  it("a bundle with no dialogue yields no lines (stays silent)", () => {
    expect(dialogueLinesFromBundleScenes([{ shot_id: "shot_01", prompt: "a", seconds: 4 }], {})).toEqual([]);
  });
});

// vivijure #582: EXPLICIT dialogue_lines without a voice_id used to fall straight to the default
// voice even when the shot's speaking slot resolves to a cast member WITH a voice (Wren, voice
// asteria, spoke as angus in film-08dd5777). resolveExplicitLineVoices maps a voiceless line's shot
// to its speaking slot (bundle storyboard dialogue) and the slot to its cast voice; an explicit
// line voice_id is never overwritten; the default applies only when nothing maps.
describe("resolveExplicitLineVoices (#582)", () => {
  const scenes = [
    { shot_id: "shot_01", prompt: "a", seconds: 4, dialogue: { slot: "A", text: "Warn." } },
    { shot_id: "shot_02", prompt: "b", seconds: 4 }, // silent in the storyboard
    { shot_id: "shot_03", prompt: "c", seconds: 4, dialogue: { slot: "B", text: "Answer." } },
  ];
  const voices = { A: "asteria" }; // B's cast member has no voice resolved

  it("the film-08dd5777 shape: a voiceless line gets the shot's CAST voice, not the default", () => {
    const out = resolveExplicitLineVoices([{ shot_id: "shot_01", text: "We move now." }], scenes, voices);
    expect(out).toEqual([{ shot_id: "shot_01", text: "We move now.", voice_id: "asteria" }]);
  });

  it("an explicit line voice_id ALWAYS wins -- never overwritten by the cast voice", () => {
    const out = resolveExplicitLineVoices(
      [{ shot_id: "shot_01", text: "x", voice_id: "orion" }], scenes, voices,
    );
    expect(out[0].voice_id).toBe("orion");
  });

  it("defaults ONLY when nothing maps: no slot dialogue for the shot, or a slot with no cast voice", () => {
    const out = resolveExplicitLineVoices(
      [
        { shot_id: "shot_02", text: "narration over a silent shot" }, // no storyboard dialogue -> no slot
        { shot_id: "shot_03", text: "y" }, // slot B resolves but carries no voice
      ],
      scenes, voices,
    );
    expect(out.map((l) => l.voice_id)).toEqual(["angus", "angus"]); // DEFAULT_VOICE_ID
  });

  it("a blank/whitespace voice_id counts as absent and resolves from the cast", () => {
    const out = resolveExplicitLineVoices([{ shot_id: "shot_01", text: "x", voice_id: "  " }], scenes, voices);
    expect(out[0].voice_id).toBe("asteria");
  });
});
