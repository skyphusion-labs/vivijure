import { describe, it, expect } from "vitest";
import { emitTar } from "../src/tar-emit";
import { checkManifest, checkHookOutput, allPass, failures } from "../src/modules/conformance";
import { MANIFEST } from "../modules/cloud-keyframe/src/index";
import {
  MODELS,
  clampModel,
  clampDim,
  clampRefsPerSlot,
  composePrompt,
  keyframeKey,
  stageRefKey,
  stateKey,
  selectScenes,
  usedSlots,
  encodePoll,
  decodePoll,
  readOutput,
  type CloudKeyframeState,
} from "../modules/cloud-keyframe/src/keyframe";
import {
  parseScenes,
  parseStylePrefix,
  parseRegistry,
  refsForSlot,
  listTarNames,
  extractTarText,
  extractTarBytes,
} from "../modules/cloud-keyframe/src/bundle";
import {
  isFlux2,
  base64ToBytes,
  bytesToBase64,
  sniffImageMime,
  extractProxiedImageUrl,
  nearestAspectRatio,
  proxiedParams,
} from "../modules/cloud-keyframe/src/image-gen";

// A storyboard.yaml in the exact deterministic shape the core's serializeStoryboardYaml emits.
const STORYBOARD_YAML = [
  'title: "Neon Film"',
  'full_prompt: "a neon film"',
  'style_prefix: "cinematic, moody neon"',
  'style_category: "None"',
  'style_preset: "None"',
  "use_characters: [A, B]",
  'cast_rules: "one per shot"',
  "scenes:",
  '  - prompt: "wide street at night"',
  '    id: "shot_01"',
  "    character_slots: [A]",
  "    target_seconds: 4",
  '  - prompt: "two of them in a cafe"',
  '    id: "shot_02"',
  "    character_slots: [A, B]",
  '  - prompt: "empty landscape, no one"',
  '    id: "shot_03"',
  "    character_slots: []",
  "",
].join("\n");

const REGISTRY_JSON = JSON.stringify({
  characters: {
    A: { name: "Wren", prompt: "copper-red hair, freckles", image: "characters/char_A_Wren.png" },
    B: { name: "Cass", prompt: "dark buzzcut", image: "characters/char_B_Cass.png" },
  },
});

describe("cloud-keyframe pure logic", () => {
  it("clampModel accepts the known models and defaults to flux-2-klein-9b", () => {
    expect(clampModel("google/nano-banana-pro")).toBe("google/nano-banana-pro");
    expect(clampModel("@cf/black-forest-labs/flux-2-dev")).toBe("@cf/black-forest-labs/flux-2-dev");
    expect(clampModel("made-up-model")).toBe(MODELS[0]);
    expect(clampModel(undefined)).toBe(MODELS[0]);
  });

  it("clampDim clamps to [512,1536], rounds, and falls back on junk", () => {
    expect(clampDim(1344, 1344)).toBe(1344);
    expect(clampDim(100, 768)).toBe(512); // below min
    expect(clampDim(4000, 768)).toBe(1536); // above max
    expect(clampDim(768.6, 768)).toBe(769); // rounds
    expect(clampDim("nope", 768)).toBe(768);
    expect(clampDim(undefined, 1344)).toBe(1344);
  });

  it("clampRefsPerSlot clamps to [1,4], default 1", () => {
    expect(clampRefsPerSlot(1)).toBe(1);
    expect(clampRefsPerSlot(4)).toBe(4);
    expect(clampRefsPerSlot(9)).toBe(4);
    expect(clampRefsPerSlot(0)).toBe(1);
    expect(clampRefsPerSlot(undefined)).toBe(1);
  });

  it("composePrompt leads with style_prefix and folds in each shot character's identity", () => {
    const reg = parseRegistry(REGISTRY_JSON);
    const p = composePrompt("cinematic, moody neon", "two of them in a cafe", ["A", "B"], reg);
    expect(p).toContain("cinematic, moody neon. ");
    expect(p).toContain("two of them in a cafe");
    expect(p).toContain("Wren: copper-red hair, freckles");
    expect(p).toContain("Cass: dark buzzcut");
  });

  it("composePrompt handles a character-less shot (no style) cleanly", () => {
    const p = composePrompt("", "empty landscape, no one", [], {});
    expect(p).toBe("empty landscape, no one");
  });

  it("R2 key conventions match the contract (renders/<project>/keyframes/<shot>.png)", () => {
    expect(keyframeKey("neon_film", "shot_01")).toBe("renders/neon_film/keyframes/shot_01.png");
    expect(stageRefKey("neon_film", "job-7", "A", 1)).toBe("keyframe-stage/neon_film/job-7/ref_A_01.png");
    expect(stateKey("neon_film", "job-7")).toBe("keyframe-stage/neon_film/job-7.state.json");
  });

  it("selectScenes returns all when no subset, else only the requested shots", () => {
    const scenes = parseScenes(STORYBOARD_YAML);
    expect(selectScenes(scenes).map((s) => s.shot_id)).toEqual(["shot_01", "shot_02", "shot_03"]);
    expect(selectScenes(scenes, []).length).toBe(3);
    expect(selectScenes(scenes, ["shot_02"]).map((s) => s.shot_id)).toEqual(["shot_02"]);
    expect(selectScenes(scenes, ["nope"]).length).toBe(0);
  });

  it("usedSlots is the sorted distinct union of a scene set's character_slots", () => {
    const scenes = parseScenes(STORYBOARD_YAML);
    expect(usedSlots(scenes)).toEqual(["A", "B"]);
    expect(usedSlots(selectScenes(scenes, ["shot_01"]))).toEqual(["A"]);
    expect(usedSlots(selectScenes(scenes, ["shot_03"]))).toEqual([]);
  });

  it("encodePoll / decodePoll round-trips the pointer; rejects garbage", () => {
    const tok = encodePoll({ project: "neon_film", job_id: "job-7" });
    expect(decodePoll(tok)).toEqual({ project: "neon_film", job_id: "job-7" });
    expect(decodePoll("not-base64-$$")).toBeNull();
    expect(decodePoll(encodePoll({ project: "p" } as never))).toBeNull();
  });

  it("readOutput maps the finished state to the KeyframeOutput shape", () => {
    const state = {
      project: "neon_film",
      done: [{ shot_id: "shot_01", keyframe_key: "renders/neon_film/keyframes/shot_01.png" }],
    } as CloudKeyframeState;
    expect(readOutput(state)).toEqual({
      project: "neon_film",
      keyframes: [{ shot_id: "shot_01", keyframe_key: "renders/neon_film/keyframes/shot_01.png" }],
    });
  });
});

describe("cloud-keyframe bundle parsing", () => {
  it("parseScenes captures shot_id, prompt, and character_slots (incl. an empty slot list)", () => {
    expect(parseScenes(STORYBOARD_YAML)).toEqual([
      { shot_id: "shot_01", prompt: "wide street at night", slots: ["A"] },
      { shot_id: "shot_02", prompt: "two of them in a cafe", slots: ["A", "B"] },
      { shot_id: "shot_03", prompt: "empty landscape, no one", slots: [] },
    ]);
  });

  it("parseScenes falls back to positional shot ids and returns [] for no scenes", () => {
    const noIds = ['scenes:', '  - prompt: "a"', "    character_slots: [A]", ""].join("\n");
    expect(parseScenes(noIds)).toEqual([{ shot_id: "shot_01", prompt: "a", slots: ["A"] }]);
    expect(parseScenes("title: \"x\"\n")).toEqual([]);
  });

  it("parseStylePrefix reads the top-level style_prefix, '' when absent", () => {
    expect(parseStylePrefix(STORYBOARD_YAML)).toBe("cinematic, moody neon");
    expect(parseStylePrefix('title: "x"\n')).toBe("");
  });

  it("parseRegistry reads slot -> {name, prompt, image}; tolerant of junk", () => {
    expect(parseRegistry(REGISTRY_JSON).A).toEqual({
      name: "Wren",
      prompt: "copper-red hair, freckles",
      image: "characters/char_A_Wren.png",
    });
    expect(parseRegistry("not json")).toEqual({});
    expect(parseRegistry(JSON.stringify({ characters: 7 }))).toEqual({});
  });

  it("refsForSlot globs + sorts characters/refs/<SLOT>/ image files only", () => {
    const names = [
      "characters/refs/A/ref_02.png",
      "characters/refs/A/ref_01.jpg",
      "characters/refs/A/notes.txt",
      "characters/refs/B/ref_01.png",
    ];
    expect(refsForSlot(names, "A")).toEqual(["characters/refs/A/ref_01.jpg", "characters/refs/A/ref_02.png"]);
    expect(refsForSlot(names, "C")).toEqual([]);
  });

  it("the vendored tar walk reads back what the core's emitTar wrote (cross-check)", () => {
    const portraitBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // PNG-ish
    const tar = emitTar([
      { name: "storyboard.yaml", content: new TextEncoder().encode(STORYBOARD_YAML) },
      { name: "characters/registry.json", content: new TextEncoder().encode(REGISTRY_JSON) },
      { name: "characters/char_A_Wren.png", content: portraitBytes },
    ]);
    const names = listTarNames(tar);
    expect(names).toContain("storyboard.yaml");
    expect(names).toContain("characters/char_A_Wren.png");
    expect(extractTarText(tar, "storyboard.yaml")).toBe(STORYBOARD_YAML);
    expect(extractTarBytes(tar, "characters/char_A_Wren.png")).toEqual(portraitBytes);
    expect(extractTarBytes(tar, "nope.png")).toBeNull();
  });
});

describe("cloud-keyframe image-gen helpers", () => {
  it("isFlux2 distinguishes the direct multipart path from proxied", () => {
    expect(isFlux2("@cf/black-forest-labs/flux-2-klein-9b")).toBe(true);
    expect(isFlux2("google/nano-banana-pro")).toBe(false);
  });

  it("base64 round-trips and sniffImageMime reads magic bytes", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]); // JPEG
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(sniffImageMime(bytes)).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual({ mime: "image/png", ext: "png" });
  });

  it("extractProxiedImageUrl pulls the url from either response shape", () => {
    expect(extractProxiedImageUrl({ result: { image: "https://x/y.png" } })).toBe("https://x/y.png");
    expect(extractProxiedImageUrl({ image: "https://a/b.png" })).toBe("https://a/b.png");
    expect(extractProxiedImageUrl({})).toBeNull();
  });

  it("nearestAspectRatio snaps WxH to a supported ratio string", () => {
    expect(nearestAspectRatio(1344, 768)).toBe("16:9"); // 1.75 -> nearest 16:9
    expect(nearestAspectRatio(1024, 1024)).toBe("1:1");
    expect(nearestAspectRatio(768, 1344)).toBe("9:16");
  });

  it("proxiedParams sends image_input + aspect_ratio for google, capped to 3", () => {
    const p = proxiedParams("google/nano-banana-pro", "a prompt", ["a", "b", "c", "d"], 1344, 768);
    expect(p.aspect_ratio).toBe("16:9");
    expect(p.output_format).toBe("png");
    expect((p.image_input as string[]).length).toBe(3);
  });
});

describe("cloud-keyframe conformance (the contract is the law)", () => {
  it("the manifest passes module conformance", () => {
    const checks = checkManifest(MANIFEST);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });

  it("declares exactly the keyframe hook, pick_one, GPUless provides", () => {
    expect(MANIFEST.hooks).toEqual(["keyframe"]);
    expect(MANIFEST.name).toBe("cloud-keyframe");
    expect(MANIFEST.api).toBe("vivijure-module/2");
  });

  it("a well-formed KeyframeOutput passes checkHookOutput('keyframe')", () => {
    const output = {
      project: "neon_film",
      keyframes: [
        { shot_id: "shot_01", keyframe_key: "renders/neon_film/keyframes/shot_01.png" },
        { shot_id: "shot_02", keyframe_key: "renders/neon_film/keyframes/shot_02.png" },
      ],
    };
    const check = checkHookOutput("keyframe", output);
    expect(check.pass, check.detail).toBe(true);
  });

  it("a malformed keyframe output is rejected by conformance", () => {
    expect(checkHookOutput("keyframe", { project: "p", keyframes: [{ shot_id: "x" }] }).pass).toBe(false);
    expect(checkHookOutput("keyframe", { keyframes: [] }).pass).toBe(false);
  });
});
