import { describe, it, expect } from "vitest";
import { renderCompleteEmail, escapeHtml, FROM } from "../modules/notify-email/src/notify";
import worker from "../modules/notify-email/src/index";

describe("notify-email composition", () => {
  it("renderCompleteEmail builds subject/text/html from the notify input", () => {
    const e = renderCompleteEmail({
      event: "render.complete", film_id: "film-1", project: "RUST", download_url: "https://r2/film.mp4?sig=abc",
    });
    expect(e.subject).toBe('Your film "RUST" is ready');
    expect(e.text).toContain("RUST");
    expect(e.text).toContain("https://r2/film.mp4?sig=abc");
    expect(e.html).toContain("RUST");
    expect(e.html).toContain('href="https://r2/film.mp4?sig=abc"');
  });

  it("escapeHtml neutralizes markup in the HTML body (subject stays plain text)", () => {
    expect(escapeHtml('<b>"x"&')).toBe("&lt;b&gt;&quot;x&quot;&amp;");
    const e = renderCompleteEmail({
      event: "render.complete", film_id: "f", project: "<script>", download_url: "https://r2/x?a=1&b=2",
    });
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.html).toContain("a=1&amp;b=2"); // url & escaped inside the href
    expect(e.subject).toBe('Your film "<script>" is ready'); // subject is plain text, never HTML
  });

  it("falls back to a sane title + empty url when fields are missing", () => {
    const e = renderCompleteEmail({ event: "render.complete", film_id: "f", project: "" });
    expect(e.subject).toBe('Your film "your film" is ready');
    expect(e.text).toContain("your film");
  });

  it("FROM is the Vivijure render identity", () => {
    expect(FROM.email).toBe("render@skyphusion.org");
  });
});


// The identity strip: the core sends NO recipient (NotifyInput has no user_email). The module's
// recipient is its OWN config field (notify_email), set by the operator on install. These lock that.
describe("notify-email delivery: recipient from the module config (not the input)", () => {
  function invoke(config: Record<string, unknown>, env: unknown) {
    return worker.fetch(
      new Request("https://m/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook: "notify",
          input: { event: "render.complete", film_id: "f", project: "RUST", download_url: "https://r2/x" },
          config,
          context: { project: "RUST", job_id: "f" },
        }),
      }),
      env as never,
    );
  }

  it("delivers to the address configured on the module", async () => {
    const sent: Array<{ to: unknown }> = [];
    const env = { EMAIL: { send: async (r: { to: unknown }) => { sent.push(r); return { messageId: "m1" }; } } };
    const res = await invoke({ notify_email: "ops@studio.test" }, env);
    const body = await res.json() as { ok: boolean; output: { delivered: string[] } };
    expect(body.ok).toBe(true);
    expect(body.output.delivered).toEqual(["email:ops@studio.test"]);
    expect(sent[0].to).toBe("ops@studio.test");
  });

  it("no-ops (delivered:[], not an error) when no recipient is configured", async () => {
    const env = { EMAIL: { send: async () => ({ messageId: "x" }) } };
    const res = await invoke({}, env);
    const body = await res.json() as { ok: boolean; output: { delivered: string[] } };
    expect(body.ok).toBe(true);
    expect(body.output.delivered).toEqual([]);
  });

  it("no-ops when the EMAIL binding is unset", async () => {
    const res = await invoke({ notify_email: "ops@studio.test" }, {});
    const body = await res.json() as { ok: boolean; output: { delivered: string[] } };
    expect(body.ok).toBe(true);
    expect(body.output.delivered).toEqual([]);
  });

  it("exposes notify_email in the manifest config_schema (operator-set recipient)", async () => {
    const res = await worker.fetch(new Request("https://m/module.json"), {} as never);
    const m = await res.json() as { config_schema?: Record<string, { type: string; scope?: string }> };
    expect(m.config_schema?.notify_email?.type).toBe("string");
    // projection-consistency lock: the recipient is operator-set-once install config, so the studio
    // settings UI (which reads the manifest) and the core's install-config store both key off this.
    expect(m.config_schema?.notify_email?.scope).toBe("install");
  });
});


// Ported from the retired core render-email.ts cleanup-17 suite: the SPECIFIC adversarial inputs that
// fixed real bugs in issue #17, re-asserted against the LIVE module composer so they cannot silently
// regress. (The encodeArtifactKey lock did not port: the notify path uses the core-presigned
// download_url, not an outputKey-built artifact URL; its equivalent is the URL & -escaping lock below.)
describe("notify-email composer: ported issue-#17 regression locks", () => {
  const inp = (over: Record<string, unknown>) =>
    ({ event: "render.complete", film_id: "f", project: "P", download_url: "", ...over }) as never;

  it("esc lock: escapes & < > and double-quote in the HTML body, but NOT single-quote", () => {
    const { html } = renderCompleteEmail(inp({ project: `a & b < c > d " e ' f` }));
    expect(html).toContain("a &amp; b &lt; c &gt; d &quot; e ' f");
    expect(html).not.toContain("&#39;");
    expect(html).not.toContain("&apos;");
  });

  it("URL & -escaping lock: the download URL's & is escaped inside the href", () => {
    const { html } = renderCompleteEmail(inp({ download_url: "https://r2/x?a=1&b=2" }));
    expect(html).toContain("a=1&amp;b=2");
  });

  it("clamp lock: truncates a runaway project name in subject AND html (#17 MAX_EMAIL_FIELD)", () => {
    const { subject, html } = renderCompleteEmail(inp({ project: "P".repeat(500) }));
    expect(subject).toContain("P".repeat(200) + "...");
    expect(subject).not.toContain("P".repeat(201));
    expect(html).toContain("P".repeat(200) + "...");
  });
});
