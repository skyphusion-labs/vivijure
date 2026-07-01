import { describe, it, expect } from "vitest";
import { plannerAiMockEnabled, mockPlannerRaw } from "../src/planner-ai-mock";
import { extractOutput } from "../src/output-extract";
import { stripJsonFences } from "../src/planner-prompt";
import { validateStoryboard } from "../src/storyboard-validate";

// The dev-only planner AI mock (#411). These assert the gate + that each canned branch drives the
// REAL extract/parse/validate pipeline to the intended outcome (pass / validation-fail / bad-JSON),
// which is exactly what the planner re-prompt sweep needs to exercise in the AI-less local dev env.

describe("plannerAiMockEnabled", () => {
  it("is off unless the var is 1/true", () => {
    expect(plannerAiMockEnabled({})).toBe(false);
    expect(plannerAiMockEnabled({ PLANNER_AI_MOCK: "" })).toBe(false);
    expect(plannerAiMockEnabled({ PLANNER_AI_MOCK: "0" })).toBe(false);
    expect(plannerAiMockEnabled({ PLANNER_AI_MOCK: "1" })).toBe(true);
    expect(plannerAiMockEnabled({ PLANNER_AI_MOCK: "true" })).toBe(true);
  });
});

function runPipeline(userMessage: string) {
  const raw = mockPlannerRaw(userMessage);
  const parsedish = stripJsonFences(extractOutput(raw));
  try {
    return validateStoryboard(JSON.parse(parsedish));
  } catch {
    return { ok: false as const, errors: ["not valid JSON"] };
  }
}

describe("mockPlannerRaw branches", () => {
  it("default -> a genuinely valid storyboard (pass branch)", () => {
    const v = runPipeline("a quiet harbor short");
    expect(v.ok).toBe(true);
  });
  it("#mock-fail -> a genuine validator failure (reject/re-prompt branch)", () => {
    const v = runPipeline("a harbor short #mock-fail");
    expect(v.ok).toBe(false);
    expect((v as { errors: string[] }).errors.join(" ")).toMatch(/missing prompt/i);
  });
  it("#mock-badjson -> non-JSON output (parse-failure branch)", () => {
    const v = runPipeline("a harbor short #mock-badjson");
    expect(v.ok).toBe(false);
  });
});
