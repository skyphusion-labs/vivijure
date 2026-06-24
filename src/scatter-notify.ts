// Best-effort notify on scatter gather completion (mirrors film-orchestrator fireNotify).

import type { Env } from "./env";
import { discoverModules, invokeModule, servingForHook, validateConfig } from "./modules/registry";
import { loadInstallConfig } from "./operator-config";
import type { NotifyInput, NotifyOutput } from "./modules/types";
import { presignR2Get } from "./r2-presign";
import type { ScatterJob } from "./scatter-orchestrator-types";

interface FetcherLike { fetch(input: Request | string, init?: RequestInit): Promise<Response>; }
const asFetcher = (v: unknown): FetcherLike | null =>
  v && typeof (v as { fetch?: unknown }).fetch === "function" ? (v as FetcherLike) : null;

export async function fireNotifyForScatter(env: Env, job: ScatterJob): Promise<void> {
  if (!job.film_key) return;
  try {
    const envRec = env as unknown as Record<string, unknown>;
    const notifiers = servingForHook(await discoverModules(envRec), "notify");
    if (!notifiers.length) return;
    const download_url = await presignR2Get(env, job.film_key, 86400);
    const input: NotifyInput = {
      event: "render.complete",
      film_id: job.scatter_id,
      project: job.project,
      download_url,
    };
    const context = { project: job.project, job_id: job.scatter_id };
    for (const m of notifiers) {
      const fetcher = asFetcher(envRec[m.binding]);
      if (!fetcher) continue;
      try {
        // Inject the operator-set install-config (e.g. notify-email's notify_email recipient) as the
        // user config, then clamp through the contract; render-scope fields stay at their defaults.
        const installConfig = await loadInstallConfig(env, m.name, m.config_schema);
        await invokeModule<NotifyInput, NotifyOutput>(fetcher, {
          hook: "notify",
          input,
          config: validateConfig(m.config_schema ?? {}, installConfig),
          context,
        });
      } catch { /* best-effort */ }
    }
  } catch (e) {
    console.warn(`scatter notify failed for ${job.scatter_id}: ${(e as Error).message}`);
  }
}
