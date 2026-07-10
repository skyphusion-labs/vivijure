import { describe, it, expect } from "vitest";
import { runDemoChat, DEFAULT_DEMO_CHAT_CAPS, DEMO_CHAT_SYSTEM_PROMPT, type DemoChatDeps } from "../src/demo-chat";
import type { D1Like, D1StmtLike } from "../src/demo-render";

// Minimal D1 fake: only the demo_counter bump is exercised here.
function counterDb(): { db: D1Like; counters: Map<string, number> } {
  const counters = new Map<string, number>();
  const db: D1Like = {
    prepare(sql: string): D1StmtLike {
      let args: unknown[] = [];
      const s: D1StmtLike = {
        bind(...v: unknown[]) { args = v; return s; },
        async first<T = unknown>(): Promise<T | null> {
          if (sql.includes("INSERT INTO demo_counter")) {
            const bucket = args[0] as string;
            const n = (counters.get(bucket) ?? 0) + 1; counters.set(bucket, n);
            return { count: n } as T;
          }
          return null;
        },
        async run() { return {}; },
        async all<T = unknown>() { return { results: [] as T[] }; },
      };
      return s;
    },
  };
  return { db, counters };
}

const echoModel = async (a: { system: string; user: string; maxTokens: number }) => `demo says: ${a.user}`;

function deps(db: D1Like, model = echoModel, caps = DEFAULT_DEMO_CHAT_CAPS, now = 1_000_000): DemoChatDeps {
  return { db, model, caps, now };
}

describe("demo-chat capped assistant", () => {
  it("answers within cap and passes the demo-scoped system prompt", async () => {
    const { db } = counterDb();
    let seenSystem = "";
    const model = async (a: { system: string; user: string; maxTokens: number }) => { seenSystem = a.system; return "hi"; };
    const r = await runDemoChat(deps(db, model), { ip: "1.1.1.1", message: "what is this?" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.reply).toBe("hi");
    expect(seenSystem).toBe(DEMO_CHAT_SYSTEM_PROMPT);
  });

  it("rejects empty + over-long input before spending a token", async () => {
    const { db } = counterDb();
    let called = false;
    const model = async () => { called = true; return "x"; };
    expect((await runDemoChat(deps(db, model), { ip: "1.1.1.1", message: "   " })).ok).toBe(false);
    expect((await runDemoChat(deps(db, model), { ip: "1.1.1.1", message: "z".repeat(5000) })).ok).toBe(false);
    expect(called).toBe(false); // model never called on bad input
  });

  it("enforces the per-IP daily cap with an honest exhaustion message", async () => {
    const { db } = counterDb();
    const caps = { ...DEFAULT_DEMO_CHAT_CAPS, perIpDaily: 2 };
    expect((await runDemoChat(deps(db, echoModel, caps), { ip: "9.9.9.9", message: "a" })).ok).toBe(true);
    expect((await runDemoChat(deps(db, echoModel, caps), { ip: "9.9.9.9", message: "b" })).ok).toBe(true);
    const third = await runDemoChat(deps(db, echoModel, caps), { ip: "9.9.9.9", message: "c" });
    expect(!third.ok && third.reason).toBe("exhausted");
    expect(!third.ok && third.message).toContain("today");
  });

  it("enforces the global daily cap", async () => {
    const { db } = counterDb();
    const caps = { ...DEFAULT_DEMO_CHAT_CAPS, perIpDaily: 999, globalDaily: 1 };
    expect((await runDemoChat(deps(db, echoModel, caps), { ip: "1", message: "a" })).ok).toBe(true);
    const second = await runDemoChat(deps(db, echoModel, caps), { ip: "2", message: "b" });
    expect(!second.ok && second.reason).toBe("exhausted");
  });

  it("degrades a model throw to an honest error, never a silent blank", async () => {
    const { db } = counterDb();
    const model = async () => { throw new Error("gateway 500"); };
    const r = await runDemoChat(deps(db, model), { ip: "1.1.1.1", message: "hi" });
    expect(!r.ok && r.reason).toBe("error");
  });
});
