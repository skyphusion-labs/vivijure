// installed-modules: the persistent registry of modules installed via Workers-for-Platforms dynamic
// dispatch (docs/module-dispatch.md section 3.1 / 4.4).
//
// In the service-binding world a module is DISCOVERED from env (scan MODULE_*). A dispatch module has
// no per-module env binding -- every module lives behind ONE namespace binding (MODULE_DISPATCH) -- so
// the set of installed dispatch modules lives in D1 (the `installed_modules` table, migration 0006),
// one row per module. The manifest is captured AT INSTALL (after conformance passes, see the install
// route) rather than re-fetched every boot, because a dispatch module is not enumerable from env.
//
// This module owns the four admin operations (install / uninstall / disable / list). The READ side of
// discovery (reconstructing RegisteredModule[] from these rows) lives in registry.discoverDispatchModules
// so the pipeline's discovery stays in one place; here we own the writes + the admin list.

import type { Env } from "./env";

/** One row of the installed_modules table (the admin/list view; includes internal script_name +
 *  enabled, which the public /api/modules projection never carries). */
export interface InstalledModule {
  name: string;
  script_name: string;
  api: string;
  installed_at: number;
  enabled: boolean;
}

interface InstalledRow {
  name: string;
  script_name: string;
  manifest_json: string;
  api: string;
  installed_at: number;
  enabled: number;
}

function rowToInstalled(r: InstalledRow): InstalledModule {
  return {
    name: r.name,
    script_name: r.script_name,
    api: r.api,
    installed_at: r.installed_at,
    enabled: r.enabled === 1,
  };
}

/** Insert (or replace) an installed-module row. Called by the install route ONLY after conformance
 *  passes against the just-uploaded, resident script. INSERT OR REPLACE so a module RE-uploaded (a new
 *  version, having re-passed conformance) refreshes its stored manifest + script_name in place rather
 *  than duplicating -- the stored copy never silently drifts from what was gated. `enabled` defaults to
 *  1 on (re)install so a fresh install is live immediately; a re-install of a disabled module re-enables
 *  it (it just passed the gate again). */
export async function installModuleRow(
  env: Env,
  row: { name: string; script_name: string; manifest_json: string; api: string; installed_at: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO installed_modules (name, script_name, manifest_json, api, installed_at, enabled)
     VALUES (?1, ?2, ?3, ?4, ?5, 1)
     ON CONFLICT(name) DO UPDATE SET
       script_name = excluded.script_name,
       manifest_json = excluded.manifest_json,
       api = excluded.api,
       installed_at = excluded.installed_at,
       enabled = 1`,
  )
    .bind(row.name, row.script_name, row.manifest_json, row.api, row.installed_at)
    .run();
}

/** Remove an installed-module row (uninstall). The registry stops dispatching it on the next request;
 *  evicting the resident script from the namespace is a SEPARATE step the install CLI does AFTER this
 *  (row first, so an in-flight /poll is not torn out from under -- section 4.4). Returns whether a row
 *  was actually removed (false => it was not installed). */
export async function uninstallModuleRow(env: Env, name: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM installed_modules WHERE name = ?1`).bind(name).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Enable / disable an installed module without evicting it. Disable = one D1 write; the registry
 *  skips a disabled row (discoverDispatchModules reads WHERE enabled = 1) while the script stays
 *  resident for a quick re-enable. This is the v1 fast-kill for a misbehaving module (section 4.4 / 5).
 *  Returns whether a row matched. */
export async function setModuleEnabled(env: Env, name: string, enabled: boolean): Promise<boolean> {
  const res = await env.DB
    .prepare(`UPDATE installed_modules SET enabled = ?2 WHERE name = ?1`)
    .bind(name, enabled ? 1 : 0)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** List every installed dispatch module (admin view: name, script_name, api, installed_at, enabled).
 *  Distinct from the public GET /api/modules projection, which carries only the manifest and never the
 *  internal script_name / enabled flag. */
export async function listInstalledModules(env: Env): Promise<InstalledModule[]> {
  const res = await env.DB
    .prepare(`SELECT name, script_name, manifest_json, api, installed_at, enabled FROM installed_modules ORDER BY name`)
    .all<InstalledRow>();
  return (res.results ?? []).map(rowToInstalled);
}
