// Pure email composition for the notify-email module: turn a render.complete NotifyInput into the
// email subject/html/text. No I/O here -- unit-tested without the runtime. The send lives in index.ts.

import type { NotifyInput } from "./contract";

/** The from-identity. Its domain must be onboarded for Email Sending (wrangler email sending enable). */
export const FROM = { email: "render@skyphusion.org", name: "Vivijure" } as const;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Bound a notification field so a runaway project name can't bloat the email (ported from the
// legacy render-email builder, issue #17). esc-not-single-quote + this clamp are the hardening
// the composer must keep now that it is the sole email logic.
const MAX_EMAIL_FIELD = 200;
function clampField(s: string): string {
  return s.length > MAX_EMAIL_FIELD ? `${s.slice(0, MAX_EMAIL_FIELD)}...` : s;
}

/** Build the render-complete email (subject/html/text) from the notify input. Pure. */
export function renderCompleteEmail(input: NotifyInput): { subject: string; html: string; text: string } {
  const title = clampField(input.project || "your film");
  const url = input.download_url || "";
  return {
    subject: `Your film "${title}" is ready`,
    text: `Your Vivijure render "${title}" is complete.\n\nDownload (link valid 24 hours):\n${url}\n`,
    html:
      `<p>Your Vivijure render <strong>"${escapeHtml(title)}"</strong> is complete. \u{1F3AC}</p>` +
      `<p><a href="${escapeHtml(url)}">Download your film</a> (link valid for 24 hours).</p>`,
  };
}
