import { describe, it, expect } from "vitest";
import {
  buildMessages,
  parseEnhanced,
  mergeEnhanced,
  scenePrompts,
} from "../modules/plan-enhance/src/enhance";
import {
  pickProvider,
  opusModel,
  toAnthropic,
  extractAnthropicText,
  DEFAULT_OPUS_MODEL,
  type ProviderEnv,
} from "../modules/plan-enhance/src/provider";

// A ProviderEnv stub whose AI surface is never called by the pure functions under test.
const stubEnv = (over: Partial<ProviderEnv>): ProviderEnv =>
  ({ AI: { run: async () => ({}), gateway: () => ({ getUrl: async () => "" }) }, ...over });

describe("plan-enhance pure logic", () => {
  it("buildMessages produces a numbered user prompt of the right length", () => {
    const msgs = buildMessages(["a wide shot", "a close up"], "medium");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toContain("1. a wide shot");
    expect(msgs[1].content).toContain("2. a close up");
  });

  it("parseEnhanced accepts a clean array of the right length", () => {
    expect(parseEnhanced('["one","two"]', 2)).toEqual(["one", "two"]);
  });

  it("parseEnhanced tolerates a code fence and surrounding prose", () => {
    const raw = "Sure!\n```json\n[\"a\", \"b\"]\n```";
    expect(parseEnhanced(raw, 2)).toEqual(["a", "b"]);
  });

  it("parseEnhanced rejects wrong length, junk, empties, and non-strings", () => {
    expect(parseEnhanced('["one"]', 2)).toBeNull();
    expect(parseEnhanced("not json at all", 1)).toBeNull();
    expect(parseEnhanced('["ok",""]', 2)).toBeNull();
    expect(parseEnhanced('["ok",3]', 2)).toBeNull();
    expect(parseEnhanced(42, 1)).toBeNull();
  });

  it("parseEnhanced accepts a response that is already a string array", () => {
    expect(parseEnhanced(["a", "b"], 2)).toEqual(["a", "b"]);
    expect(parseEnhanced(["a"], 2)).toBeNull();
  });

  it("parseEnhanced falls back to a numbered or bulleted list", () => {
    expect(parseEnhanced("Here you go:\n1. first shot\n2. second shot", 2)).toEqual(["first shot", "second shot"]);
    expect(parseEnhanced("- alpha\n- beta\n- gamma", 3)).toEqual(["alpha", "beta", "gamma"]);
    expect(parseEnhanced("1. only one", 2)).toBeNull();
  });

  it("mergeEnhanced replaces prompts and preserves all other fields (no mutation)", () => {
    const sb = {
      title: "x",
      scenes: [
        { prompt: "old1", act: "opening" },
        { prompt: "old2", character_slots: ["A"] },
      ],
    };
    const out = mergeEnhanced(sb, ["new1", "new2"]);
    expect(out.scenes[0].prompt).toBe("new1");
    expect(out.scenes[0].act).toBe("opening");
    expect(out.scenes[1].character_slots).toEqual(["A"]);
    expect(out.title).toBe("x");
    expect(sb.scenes[0].prompt).toBe("old1");
  });

  it("scenePrompts returns null for an empty storyboard and coerces missing prompts", () => {
    expect(scenePrompts({ scenes: [] })).toBeNull();
    expect(scenePrompts({ scenes: [{ prompt: "a" }, {} as { prompt: string }] })).toEqual(["a", ""]);
  });
});

describe("plan-enhance provider selection", () => {
  it("picks opus only when BOTH gateway id and token are set", () => {
    expect(pickProvider(stubEnv({ GATEWAY_ID: "g", CF_AIG_TOKEN: "t" }))).toBe("opus");
    expect(pickProvider(stubEnv({ GATEWAY_ID: "g" }))).toBe("local");
    expect(pickProvider(stubEnv({ CF_AIG_TOKEN: "t" }))).toBe("local");
    expect(pickProvider(stubEnv({}))).toBe("local");
  });

  it("opusModel defaults to the latest Opus and honors an override (stripping the provider prefix)", () => {
    expect(opusModel(stubEnv({}))).toBe(DEFAULT_OPUS_MODEL);
    expect(opusModel(stubEnv({ ENHANCE_MODEL: "  " }))).toBe(DEFAULT_OPUS_MODEL);
    expect(opusModel(stubEnv({ ENHANCE_MODEL: "claude-opus-4-7" }))).toBe("claude-opus-4-7");
    expect(opusModel(stubEnv({ ENHANCE_MODEL: "anthropic/claude-opus-4-7" }))).toBe("claude-opus-4-7");
  });

  it("toAnthropic pulls system to a top-level field and keeps the user turn", () => {
    const out = toAnthropic(buildMessages(["a wide shot"], "medium"));
    expect(out.system).toContain("film director");
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
    expect(out.messages[0].content).toContain("1. a wide shot");
  });

  it("toAnthropic concatenates multiple system messages and omits system when there is none", () => {
    const out = toAnthropic([
      { role: "system", content: "one" },
      { role: "system", content: "two" },
      { role: "user", content: "hi" },
    ]);
    expect(out.system).toBe("one\n\ntwo");
    expect(toAnthropic([{ role: "user", content: "hi" }]).system).toBeUndefined();
  });

  it("extractAnthropicText concatenates text blocks and rejects empty / wrong shapes", () => {
    expect(extractAnthropicText({ content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] })).toBe(
      "hello world",
    );
    expect(extractAnthropicText({ content: [{ type: "image" }] })).toBeNull();
    expect(extractAnthropicText({ content: [] })).toBeNull();
    expect(extractAnthropicText({})).toBeNull();
    expect(extractAnthropicText("nope")).toBeNull();
  });
});
