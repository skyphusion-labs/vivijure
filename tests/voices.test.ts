import { describe, it, expect } from "vitest";

import {
  VOICE_IDS,
  VOICE_CATALOG,
  DEFAULT_VOICE_ID,
  DIALOGUE_TTS_MODEL,
  isValidVoiceId,
  coerceVoiceId,
  voiceLabel,
} from "../src/voices";

describe("voice catalog (aura-1 speakers)", () => {
  it("pins the model id", () => {
    expect(DIALOGUE_TTS_MODEL).toBe("@cf/deepgram/aura-1");
  });

  it("lists the 12 documented aura-1 speakers, default angus", () => {
    expect(VOICE_IDS).toHaveLength(12);
    expect(VOICE_IDS).toContain("asteria");
    expect(DEFAULT_VOICE_ID).toBe("angus");
    expect(VOICE_IDS).toContain(DEFAULT_VOICE_ID);
  });

  it("catalog mirrors VOICE_IDS with a capitalized label", () => {
    expect(VOICE_CATALOG.map((v) => v.id)).toEqual([...VOICE_IDS]);
    expect(voiceLabel("asteria")).toBe("Asteria");
  });

  it("isValidVoiceId accepts known speakers, rejects everything else", () => {
    expect(isValidVoiceId("orion")).toBe(true);
    expect(isValidVoiceId("Orion")).toBe(false); // case-sensitive: the wire value is lowercase
    expect(isValidVoiceId("nope")).toBe(false);
    expect(isValidVoiceId(null)).toBe(false);
    expect(isValidVoiceId(42)).toBe(false);
  });

  it("coerceVoiceId returns the id or null (unset stays distinguishable from default)", () => {
    expect(coerceVoiceId("hera")).toBe("hera");
    expect(coerceVoiceId("bogus")).toBeNull();
    expect(coerceVoiceId(undefined)).toBeNull();
  });
});
