// notify-email: a `notify` module worker (vivijure-module/1). The email backend of the notify hook --
// on a render.complete event it mails the film owner a download link via native Cloudflare Email
// Service. SYNCHRONOUS (an email send is fast, well within a Worker request): /invoke sends + returns.
//   GET  /module.json -> manifest
//   POST /invoke      -> send the render-complete email, return { delivered: ["email:<to>"] }
// A failure is DATA (ok:false) -- the core treats notify failures as best-effort. No recipient or no
// EMAIL binding -> empty `delivered` (a no-op, not an error).

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type NotifyInput,
  type NotifyOutput,
  type EmailServiceBinding,
} from "./contract";
import { FROM, renderCompleteEmail } from "./notify";

interface Env {
  EMAIL?: EmailServiceBinding; // native CF Email Service send binding (send_email)
}

const MANIFEST: ModuleManifest = {
  name: "notify-email",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["notify"],
  provides: [{ id: "notify-email", label: "Email notification (Cloudflare Email Service)" }],
  // The recipient lives HERE (operator sets it on install), not in the notify input -- the core
  // sends completion facts only, no identity (the identity strip).
  config_schema: {
    // scope:"install" -- operator sets this once on the studio settings page; the core persists it in
    // the operator-config store and injects it at notify-invoke time (it is NOT a per-render field).
    notify_email: { type: "string", default: "", label: "Notify email address (render-done mail recipient)", scope: "install" },
  },
  ui: { section: "notify", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function notify(env: Env, req: InvokeRequest<NotifyInput>): Promise<InvokeResponse<NotifyOutput>> {
  const input = req.input;
  if (!input || input.event !== "render.complete") {
    return { ok: false, error: "notify-email: unsupported event " + String(input?.event) };
  }
  // Recipient comes from the module CONFIG (operator-set on install), never the input: the core
  // sends no identity. No recipient or no EMAIL binding -> nothing to deliver (a no-op, not a failure).
  const to = typeof req.config?.notify_email === "string" ? req.config.notify_email.trim() : "";
  if (!env.EMAIL || !to) return { ok: true, output: { delivered: [] } };
  try {
    const { subject, html, text } = renderCompleteEmail(input);
    await env.EMAIL.send({ to, from: FROM, subject, html, text });
    return { ok: true, output: { delivered: ["email:" + to] } };
  } catch (e) {
    return { ok: false, error: "notify-email: send failed: " + (e as Error).message };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);
    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<NotifyInput>;
      try {
        req = (await request.json()) as InvokeRequest<NotifyInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "notify") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await notify(env, req));
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
