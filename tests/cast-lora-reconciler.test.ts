import { describe, it, expect, vi, beforeEach } from "vitest";

// Issue #295: a cast LoRA training row could wedge in lora_status='training' forever when its RunPod
// job aged out of the retention window before any poll observed a terminal status -- the poll kept
// returning 404 (non-terminal), the row never moved, and the train-lora route 409'd every retry. The
// reconciler force-fails such a row (HONEST degrade, clear lora_error) once a 404 is past the grace
// window, or the row is past the max-age ceiling.

vi.mock("../src/runpod-submit", async (orig) => {
  const actual = await orig<typeof import("../src/runpod-submit")>();
  return { ...actual, pollRenderJob: vi.fn() };
});

import { pollRenderJob } from "../src/runpod-submit";
import {
  refreshTrainingLora,
  decideStuckTraining,
  trainingAgeSeconds,
  sqliteUtcToMs,
  LORA_TRAIN_404_GRACE_SECONDS,
  LORA_TRAIN_MAX_AGE_SECONDS,
} from "../src/cast-lora-train";
import type { CastMember } from "../src/cast-db";
import type { Env } from "../src/env";

const polled = vi.mocked(pollRenderJob);

// Mutable single-row fake D1: getCastById (SELECT ... RETURNING the row) and markLoraFailed
// (UPDATE ... SET lora_status='failed' ... RETURNING). Tracks the row so a reconcile is observable.
function fakeEnv(row: Record<string, unknown>) {
  const state = { ...row };
  const env = {
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first<T>(): Promise<T | null> {
            if (/UPDATE cast_members/i.test(sql) && /lora_status = 'failed'/i.test(sql)) {
              state.lora_status = "failed";
              state.lora_error = bound[0];
              state.lora_job_id = null;
              state.updated_at = "2026-06-24 09:99:99";
            }
            return state as unknown as T;
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, state };
}

function trainingRow(updated_at: string): Record<string, unknown> {
  return {
    id: 6, public_id: "companion-0000-4000-8000-000000000006", slug: "companion-robot", name: "Companion", bible: null,
    portrait_key: null, portrait_mime: null, ref_keys_json: null, source_keys_json: null,
    created_at: "2026-06-24 00:00:00", updated_at,
    lora_key: null, lora_status: "training", lora_job_id: "01fd7d02-aged-e2",
    lora_error: null, lora_trained_at: null, voice_id: null,
  };
}

const cast = (over: Partial<CastMember> = {}): CastMember => ({
  id: 6, public_id: "companion-0000-4000-8000-000000000006", slug: "companion-robot", name: "Companion", bible: null,
  portrait_key: null, portrait_mime: null, ref_keys: [], source_keys: [],
  created_at: "2026-06-24 00:00:00", updated_at: "2026-06-24 00:00:00",
  lora_key: null, lora_status: "training", lora_job_id: "01fd7d02-aged-e2",
  lora_error: null, lora_trained_at: null, voice_id: null, ...over,
});

beforeEach(() => polled.mockReset());

describe("sqliteUtcToMs", () => {
  it("parses a SQLite datetime('now') string as UTC", () => {
    expect(sqliteUtcToMs("2026-06-24 00:00:00")).toBe(Date.parse("2026-06-24T00:00:00Z"));
  });
  it("returns null for missing / unparseable", () => {
    expect(sqliteUtcToMs(null)).toBeNull();
    expect(sqliteUtcToMs("not a date")).toBeNull();
  });
});

describe("trainingAgeSeconds", () => {
  it("measures from updated_at to now", () => {
    const base = Date.parse("2026-06-24T00:00:00Z");
    expect(trainingAgeSeconds(cast({ updated_at: "2026-06-24 00:00:00" }), base + 600_000)).toBe(600);
  });
});

describe("decideStuckTraining (pure)", () => {
  const notFound = { ok: false as const, status: 404 };
  it("does NOT reconcile a fresh 404 inside the grace window", () => {
    expect(decideStuckTraining(notFound, LORA_TRAIN_404_GRACE_SECONDS - 1).reconcile).toBe(false);
  });
  it("reconciles a 404 past the grace window", () => {
    const d = decideStuckTraining(notFound, LORA_TRAIN_404_GRACE_SECONDS + 1);
    expect(d.reconcile).toBe(true);
    expect(d.reason).toMatch(/404|not found/i);
  });
  it("reconciles any row past the max-age ceiling (backstop, even without a 404)", () => {
    const d = decideStuckTraining({ ok: true }, LORA_TRAIN_MAX_AGE_SECONDS + 1);
    expect(d.reconcile).toBe(true);
    expect(d.reason).toMatch(/max age/i);
  });
  it("does NOT reconcile a healthy in-progress poll inside the ceiling", () => {
    expect(decideStuckTraining({ ok: true }, 300).reconcile).toBe(false);
  });
  it("never reconciles when the age is unknown (unparseable timestamp)", () => {
    expect(decideStuckTraining(notFound, null).reconcile).toBe(false);
  });
});

describe("refreshTrainingLora reconciles a wedged row (D1 fixture, #295)", () => {
  const base = Date.parse("2026-06-24T00:00:00Z");

  it("an aged-out job that polls 404 past grace -> row flips to failed with an honest error", async () => {
    polled.mockResolvedValue({ ok: false, error: "RunPod poll failed: HTTP 404", status: 404 });
    const { env, state } = fakeEnv(trainingRow("2026-06-24 00:00:00"));
    const result = await refreshTrainingLora(env, cast(), base + 30 * 60 * 1000); // 30 min later
    expect(result?.lora_status).toBe("failed");
    expect(result?.lora_job_id).toBeNull();
    expect(String(result?.lora_error)).toMatch(/404|not found/i);
    expect(state.lora_status).toBe("failed");
  });

  it("a just-submitted job that briefly 404s within grace -> stays training (no false-fail)", async () => {
    polled.mockResolvedValue({ ok: false, error: "RunPod poll failed: HTTP 404", status: 404 });
    const { env } = fakeEnv(trainingRow("2026-06-24 00:00:00"));
    const result = await refreshTrainingLora(env, cast(), base + 30 * 1000); // 30s later, inside grace
    expect(result?.lora_status).toBe("training");
  });

  it("a row past the max-age ceiling reconciles even while the poll still says in-progress", async () => {
    polled.mockResolvedValue({
      ok: true,
      view: { jobId: "01fd7d02-aged-e2", status: "IN_PROGRESS", statusRaw: "IN_PROGRESS" },
    });
    const { env } = fakeEnv(trainingRow("2026-06-24 00:00:00"));
    const result = await refreshTrainingLora(env, cast(), base + 90 * 60 * 1000); // 90 min later
    expect(result?.lora_status).toBe("failed");
    expect(String(result?.lora_error)).toMatch(/max age/i);
  });

  it("a healthy in-progress poll inside the ceiling stays training", async () => {
    polled.mockResolvedValue({
      ok: true,
      view: { jobId: "01fd7d02-aged-e2", status: "IN_PROGRESS", statusRaw: "IN_PROGRESS" },
    });
    const { env } = fakeEnv(trainingRow("2026-06-24 00:00:00"));
    const result = await refreshTrainingLora(env, cast(), base + 5 * 60 * 1000); // 5 min later
    expect(result?.lora_status).toBe("training");
  });
});
