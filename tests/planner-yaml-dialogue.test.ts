import { describe, it, expect } from "vitest";
import { serializeStoryboardYaml } from "../src/planner-yaml";
import type { StoryboardValidated, StoryboardScene } from "../src/storyboard-validate";

// Issue #307: emitScene dropped per-shot dialogue, so serializeStoryboardYaml (and therefore the
// bundle storyboard.yaml assembleBundle writes from it) serialized a SILENT board even when the
// authored storyboard carried dialogue on every shot. These lock the serializer fidelity: dialogue
// survives serialization, in the nested { slot, text } shape, and absent dialogue emits nothing.

function sb(scenes: StoryboardScene[]): StoryboardValidated {
  return {
    title: "Talking Test",
    projectName: "talking_test",
    full_prompt: "a talking-character scene",
    duration_seconds: undefined,
    clip_seconds: undefined,
    style_prefix: "",
    style_category: "None",
    style_preset: "None",
    use_characters: ["A", "B"],
    cast_rules: "",
    scenes,
  };
}

describe("serializeStoryboardYaml dialogue (issue #307)", () => {
  it("emits per-shot dialogue as a nested { slot, text } mapping", () => {
    const yaml = serializeStoryboardYaml(
      sb([
        {
          id: "shot_01",
          prompt: "A speaks to B",
          character_slots: ["A", "B"],
          dialogue: { slot: "A", text: "We have to move, now." },
        },
      ]),
    );
    expect(yaml).toContain("    dialogue:");
    expect(yaml).toContain("      slot: A");
    expect(yaml).toContain('      text: "We have to move, now."');
  });

  it("a silent shot (no dialogue) emits no dialogue key", () => {
    const yaml = serializeStoryboardYaml(
      sb([{ id: "shot_01", prompt: "an empty hallway", character_slots: ["A"] }]),
    );
    expect(yaml).not.toContain("dialogue:");
  });

  it("escapes dialogue text like every other free string (quotes / colons survive)", () => {
    const yaml = serializeStoryboardYaml(
      sb([
        {
          id: "shot_01",
          prompt: "A reads aloud",
          character_slots: ["A"],
          dialogue: { slot: "A", text: 'He said "run": then nothing.' },
        },
      ]),
    );
    expect(yaml).toContain('      text: "He said \\"run\\": then nothing."');
  });

  it("dialogue rides under its own shot in a multi-shot board (per-shot, not global)", () => {
    const yaml = serializeStoryboardYaml(
      sb([
        { id: "shot_01", prompt: "silent establishing", character_slots: ["A"] },
        {
          id: "shot_02",
          prompt: "A delivers the line",
          character_slots: ["A"],
          dialogue: { slot: "A", text: "Found it." },
        },
      ]),
    );
    // Only one dialogue block, and it appears after shot_02's id (not under shot_01).
    const dialogueCount = yaml.split("\n").filter((l) => l.trim() === "dialogue:").length;
    expect(dialogueCount).toBe(1);
    const idx02 = yaml.indexOf('id: "shot_02"');
    const idxDialogue = yaml.indexOf("dialogue:");
    expect(idxDialogue).toBeGreaterThan(idx02);
  });
});
