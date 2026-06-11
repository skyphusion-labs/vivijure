// v0.139.0: build the render-done notification email. Pure (no env, no I/O) so
// vitest can assert subject/body without a binding. The caller
// (maybeNotifyRenderDone) supplies the row facts + the public base URL and hands
// the result to env.EMAIL.send. House style: no em-dashes / en-dashes.

export interface RenderNotifyInfo {
  userEmail: string;
  project: string;
  status: string; // "COMPLETED" | "FAILED"
  outputKey: string | null;
  error: string | null;
  executionTimeMs: number | null;
  mode: string | null; // "full" | "keyframes-only" | "finalized"
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

function humanDuration(ms: number | null): string | null {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// baseUrl: the public origin (e.g. https://skyphusion.org), no trailing slash.
export function buildRenderEmail(info: RenderNotifyInfo, baseUrl: string): BuiltEmail {
  const base = baseUrl.replace(/\/+$/, "");
  const done = info.status === "COMPLETED";
  const proj = info.project && info.project.trim() ? info.project.trim() : "your project";
  const dur = humanDuration(info.executionTimeMs);
  const isPreview = info.mode === "keyframes-only";
  const kind = isPreview ? "keyframe preview" : "render";
  const historyUrl = `${base}/planner`;
  const watchUrl =
    done && info.outputKey ? `${base}/api/artifact/${info.outputKey}` : null;

  const subject = done
    ? `Your ${kind} "${proj}" is ready`
    : `Your ${kind} "${proj}" failed`;

  // Plain text.
  const tLines: string[] = [];
  if (done) {
    tLines.push(`Your Vivijure ${kind} "${proj}" finished.`);
    if (dur) tLines.push(`Render time: ${dur}.`);
    if (watchUrl) tLines.push(`Watch it: ${watchUrl}`);
    tLines.push(`Open it in your planner History: ${historyUrl}`);
  } else {
    tLines.push(`Your Vivijure ${kind} "${proj}" failed.`);
    if (info.error) tLines.push(`Reason: ${info.error}`);
    tLines.push(`Check it in your planner History: ${historyUrl}`);
  }
  tLines.push("");
  tLines.push(
    "You are getting this because render email notifications are on. Turn them off any time in Preferences.",
  );
  const text = tLines.join("\n");

  // HTML.
  const accent = done ? "#7c5cff" : "#e0566b";
  const statusWord = done ? "finished" : "failed";
  const bodyRows: string[] = [];
  bodyRows.push(
    `<p style="margin:0 0 14px;font-size:16px;color:#e8e8ef;">Your Vivijure ${esc(kind)} <strong style="color:#fff;">"${esc(proj)}"</strong> ${statusWord}.</p>`,
  );
  if (done && dur) {
    bodyRows.push(
      `<p style="margin:0 0 14px;font-size:14px;color:#a9a9be;">Render time: ${esc(dur)}.</p>`,
    );
  }
  if (!done && info.error) {
    bodyRows.push(
      `<p style="margin:0 0 14px;font-size:14px;color:#a9a9be;">Reason: ${esc(info.error)}</p>`,
    );
  }
  const btn = (href: string, label: string, primary: boolean): string =>
    `<a href="${esc(href)}" style="display:inline-block;padding:10px 18px;margin:4px 8px 4px 0;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;${primary ? `background:${accent};color:#fff;` : "background:#26263a;color:#cfcfe6;"}">${esc(label)}</a>`;
  const buttons: string[] = [];
  if (watchUrl) buttons.push(btn(watchUrl, "Watch the video", true));
  buttons.push(btn(historyUrl, "Open in History", !watchUrl));

  const html = `<!doctype html><html><body style="margin:0;background:#0c0c14;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#15151f;border:1px solid #26263a;border-radius:14px;padding:28px;">
    <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${accent};font-weight:700;margin-bottom:18px;">Vivijure</div>
    ${bodyRows.join("\n    ")}
    <div style="margin:18px 0 6px;">${buttons.join("")}</div>
    <hr style="border:none;border-top:1px solid #26263a;margin:22px 0 14px;">
    <p style="margin:0;font-size:12px;color:#6f6f86;">You are getting this because render email notifications are on. Turn them off any time in Preferences.</p>
  </div>
</body></html>`;

  return { subject, html, text };
}
