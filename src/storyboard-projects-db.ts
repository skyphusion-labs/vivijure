// D1 helpers for persisted storyboard projects (v0.53.0). One row per
// project per user_email; holds a free-form prefs object and a snapshot
// of the last saved storyboard so the planner can resume across
// sessions and devices.
//
// Mirrors src/cast-db.ts shape: pure-row interface, user_email in every
// WHERE, slug allocation bounded at 200 attempts.

import type { Env } from "./env";

export interface StoryboardProject {
  id: number;
  user_email: string;
  slug: string;
  name: string;
  prefs: Record<string, unknown>;
  last_storyboard: unknown | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: number;
  user_email: string;
  slug: string;
  name: string;
  prefs_json: string;
  last_storyboard_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToProject(row: ProjectRow): StoryboardProject {
  return {
    id: row.id,
    user_email: row.user_email,
    slug: row.slug,
    name: row.name,
    prefs: parseJson<Record<string, unknown>>(row.prefs_json, {}),
    last_storyboard: row.last_storyboard_json
      ? parseJson<unknown>(row.last_storyboard_json, null)
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// URL-safe slug from a display name. Empty / all-punctuation falls
// back to "project". Matches the planner-side slug rules.
export function slugifyProject(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "project";
}

export async function allocateProjectSlug(
  env: Env,
  userEmail: string,
  base: string,
): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (suffix < 200) {
    const existing = await env.DB.prepare(
      `SELECT id FROM storyboard_projects WHERE user_email = ? AND slug = ? LIMIT 1`
    )
      .bind(userEmail, candidate)
      .first();
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  throw new Error(`Could not allocate project slug after 200 attempts (base='${base}')`);
}

export async function listProjectsForUser(
  env: Env,
  userEmail: string,
): Promise<StoryboardProject[]> {
  const result = await env.DB.prepare(
    `SELECT id, user_email, slug, name, prefs_json, last_storyboard_json,
            created_at, updated_at
       FROM storyboard_projects
      WHERE user_email = ?
      ORDER BY created_at DESC`
  )
    .bind(userEmail)
    .all<ProjectRow>();
  return (result.results || []).map(rowToProject);
}

export async function getProjectById(
  env: Env,
  id: number,
  userEmail: string,
): Promise<StoryboardProject | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_email, slug, name, prefs_json, last_storyboard_json,
            created_at, updated_at
       FROM storyboard_projects
      WHERE id = ? AND user_email = ?
      LIMIT 1`
  )
    .bind(id, userEmail)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function createProject(
  env: Env,
  userEmail: string,
  input: { name: string; prefs?: Record<string, unknown> },
): Promise<StoryboardProject> {
  const baseSlug = slugifyProject(input.name);
  const slug = await allocateProjectSlug(env, userEmail, baseSlug);
  const prefsJson = JSON.stringify(input.prefs ?? {});
  const row = await env.DB.prepare(
    `INSERT INTO storyboard_projects (user_email, slug, name, prefs_json)
     VALUES (?, ?, ?, ?)
     RETURNING id, user_email, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`
  )
    .bind(userEmail, slug, input.name, prefsJson)
    .first<ProjectRow>();
  if (!row) throw new Error("createProject: INSERT...RETURNING produced no row");
  return rowToProject(row);
}

export async function updateProjectMeta(
  env: Env,
  id: number,
  userEmail: string,
  patch: { name?: string; prefs?: Record<string, unknown> },
): Promise<StoryboardProject | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.prefs !== undefined) {
    fields.push("prefs_json = ?");
    values.push(JSON.stringify(patch.prefs));
  }
  if (fields.length === 0) {
    return getProjectById(env, id, userEmail);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id, userEmail);
  const row = await env.DB.prepare(
    `UPDATE storyboard_projects SET ${fields.join(", ")}
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`
  )
    .bind(...values)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function setLastStoryboard(
  env: Env,
  id: number,
  userEmail: string,
  storyboard: unknown,
): Promise<StoryboardProject | null> {
  const sbJson = JSON.stringify(storyboard);
  const row = await env.DB.prepare(
    `UPDATE storyboard_projects
        SET last_storyboard_json = ?, updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`
  )
    .bind(sbJson, id, userEmail)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function deleteProject(
  env: Env,
  id: number,
  userEmail: string,
): Promise<StoryboardProject | null> {
  const cur = await getProjectById(env, id, userEmail);
  if (!cur) return null;
  await env.DB.prepare(
    `DELETE FROM storyboard_projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .run();
  return cur;
}
