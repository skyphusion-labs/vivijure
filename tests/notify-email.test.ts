import { describe, it, expect } from "vitest";
import { renderCompleteEmail, escapeHtml, FROM } from "../modules/notify-email/src/notify";

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
