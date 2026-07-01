// Dev-only planner AI mock (issue #411 dev-parity).
//
// Lets the module-bound LOCAL dev env exercise the planner re-prompt UI/state machine
// (submit -> validator reject -> re-prompt -> resubmit) WITHOUT a live model call. Workers AI is
// remote-only and the crew dev token cannot create an edge-preview, so a fully-local dev fleet has no
// AI binding; this fills that one gap for the sweep.
//
// HONEST BY DESIGN: it replaces ONLY the network dispatch. The canned completion it returns still
// flows through the real extractOutput -> stripJsonFences -> JSON.parse -> validateStoryboard
// pipeline, so a "pass" is a genuinely valid storyboard and a "fail" is the genuine validator output.
// It is NOT a Workers AI stand-in -- deterministic canned responses, nothing more.
//
// GATED on the PLANNER_AI_MOCK var (dev only). UNSET in prod, so the live provider path is unchanged.

export function plannerAiMockEnabled(env: { PLANNER_AI_MOCK?: string }): boolean {
  return env.PLANNER_AI_MOCK === "1" || env.PLANNER_AI_MOCK === "true";
}

// The branch is driven from the planner UI via a sentinel in the brief / refine instruction:
//   contains "#mock-badjson" -> non-JSON output (drives the "model output was not valid JSON" branch)
//   contains "#mock-fail"    -> a storyboard that FAILS validation (drives the reject/re-prompt branch)
//   otherwise                -> a minimal VALID storyboard (the pass branch)
// Shaped as { response } -- the Workers AI text shape extractOutput already normalizes.
export function mockPlannerRaw(userMessage: string): { response: string } {
  const msg = (userMessage || "").toLowerCase();
  if (msg.includes("#mock-badjson")) {
    return { response: "Sure, here is your storyboard: (dev mock deliberately-not-JSON output)" };
  }
  if (msg.includes("#mock-fail")) {
    // scene 2 omits the required `prompt` -> real validateStoryboard structured failure.
    return {
      response: JSON.stringify({
        title: "Dev Mock Storyboard (reject branch)",
        scenes: [{ prompt: "A valid opening shot: a quiet harbor at dawn." }, { id: "s2" }],
      }),
    };
  }
  return {
    response: JSON.stringify({
      title: "Dev Mock Storyboard",
      scenes: [
        { prompt: "A wide establishing shot of a quiet harbor at dawn, mist on the water." },
        { prompt: "Close on a lone figure untying a small wooden boat, breath visible in the cold air." },
      ],
    }),
  };
}
