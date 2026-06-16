// D1 helpers for the persisted cast (v0.46.0). One row per character per
// user_email; survives across storyboards / renders so a character drawn
// once is reusable in every project.
//
// All read paths filter on user_email; writes accept a user_email argument
// and embed it in the WHERE / VALUES so the route handler does not need to
// re-check ownership separately.

import type { Env } from "./env";

export interface CastRefImage {
  key: string;
  mime: string;
}

export type LoraStatus = "idle" | "training" | "ready" | "failed";

export interface CastMember {
  id: number;
  user_email: string;
  slug: string;
  name: string;
  bible: string | null;
  portrait_key: string | null;
  portrait_mime: string | null;
  ref_keys: CastRefImage[];
  // v0.90.0: persisted source/reference photos (the raw human material
  // the user uploaded; distinct from ref_keys which are the LoRA
  // training set derived from a portrait). Used by the cast portrait
  // generator as FLUX.2 multi-reference inputs (up to 4 per call).
  source_keys: CastRefImage[];
  created_at: string;
  updated_at: string;
  // v0.57.0: standalone LoRA training fields.
  lora_key: string | null;
  lora_status: LoraStatus;
  lora_job_id: string | null;
  lora_error: string | null;
  lora_trained_at: string | null;
}

interface CastRow {
  id: number;
  user_email: string;
  slug: string;
  name: string;
  bible: string | null;
  portrait_key: string | null;
  portrait_mime: string | null;
  ref_keys_json: string;
  // v0.90.0
  source_keys_json: string | null;
  created_at: string;
  updated_at: string;
  // v0.57.0
  lora_key: string | null;
  lora_status: string | null;
  lora_job_id: string | null;
  lora_error: string | null;
  lora_trained_at: string | null;
}

// Shared parser for the two JSON-array image-key columns (ref_keys_json
// and source_keys_json). They have the identical {key, mime}[] shape.
function parseImageKeyList(raw: string | null): CastRefImage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is CastRefImage =>
        r && typeof r === "object" && typeof r.key === "string" && typeof r.mime === "string"
      )
      .map((r) => ({ key: r.key, mime: r.mime }));
  } catch {
    return [];
  }
}

// Back-compat alias for any external caller that imported parseRefKeys.
function parseRefKeys(raw: string | null): CastRefImage[] {
  return parseImageKeyList(raw);
}

function normalizeLoraStatus(raw: string | null): LoraStatus {
  if (raw === "training" || raw === "ready" || raw === "failed") return raw;
  return "idle";
}

function rowToCast(row: CastRow): CastMember {
  return {
    id: row.id,
    user_email: row.user_email,
    slug: row.slug,
    name: row.name,
    bible: row.bible,
    portrait_key: row.portrait_key,
    portrait_mime: row.portrait_mime,
    ref_keys: parseImageKeyList(row.ref_keys_json),
    source_keys: parseImageKeyList(row.source_keys_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    lora_key: row.lora_key,
    lora_status: normalizeLoraStatus(row.lora_status),
    lora_job_id: row.lora_job_id,
    lora_error: row.lora_error,
    lora_trained_at: row.lora_trained_at,
  };
}

// URL-safe slug from a display name. Mirrors the projects-side slugify
// in src/index.ts. Empty / all-punctuation input falls back to "character".
export function slugifyCharacter(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "character";
}

// Allocate a slug unused by this user's other cast members. Bounded
// at 200 to surface pathological state instead of looping forever.
export async function allocateCastSlug(env: Env, userEmail: string, base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (suffix < 200) {
    const existing = await env.DB.prepare(
      `SELECT id FROM cast_members WHERE user_email = ? AND slug = ? LIMIT 1`
    )
      .bind(userEmail, candidate)
      .first();
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  throw new Error(`Could not allocate cast slug after 200 attempts (base='${base}')`);
}

// Bound the per-user cast list so it can never scan unboundedly (issue #12). Generous -- well past
// any realistic cast size -- so the newest-first list is effectively complete for real users while
// the query stays capped.
const CAST_LIST_LIMIT = 500;

export async function listCastForUser(env: Env, userEmail: string): Promise<CastMember[]> {
  const result = await env.DB.prepare(
    `SELECT id, user_email, slug, name, bible, portrait_key, portrait_mime,
            ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at
       FROM cast_members
      WHERE user_email = ?
      ORDER BY created_at DESC
      LIMIT ?`
  )
    .bind(userEmail, CAST_LIST_LIMIT)
    .all<CastRow>();
  return (result.results || []).map(rowToCast);
}

export async function getCastById(
  env: Env,
  id: number,
  userEmail: string,
): Promise<CastMember | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_email, slug, name, bible, portrait_key, portrait_mime,
            ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at
       FROM cast_members
      WHERE id = ? AND user_email = ?
      LIMIT 1`
  )
    .bind(id, userEmail)
    .first<CastRow>();
  return row ? rowToCast(row) : null;
}

export async function createCast(
  env: Env,
  userEmail: string,
  input: { name: string; bible?: string | null },
): Promise<CastMember> {
  const baseSlug = slugifyCharacter(input.name);
  const slug = await allocateCastSlug(env, userEmail, baseSlug);
  const result = await env.DB.prepare(
    `INSERT INTO cast_members (user_email, slug, name, bible)
     VALUES (?, ?, ?, ?)
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at`
  )
    .bind(userEmail, slug, input.name, input.bible ?? null)
    .first<CastRow>();
  if (!result) throw new Error("createCast: INSERT...RETURNING produced no row");
  return rowToCast(result);
}

export async function updateCast(
  env: Env,
  id: number,
  userEmail: string,
  patch: { name?: string; bible?: string | null },
): Promise<CastMember | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.bible !== undefined) {
    fields.push("bible = ?");
    values.push(patch.bible);
  }
  if (fields.length === 0) {
    return getCastById(env, id, userEmail);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id, userEmail);
  const result = await env.DB.prepare(
    `UPDATE cast_members SET ${fields.join(", ")}
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at`
  )
    .bind(...values)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

export async function deleteCast(
  env: Env,
  id: number,
  userEmail: string,
): Promise<CastMember | null> {
  // Caller is responsible for R2 cleanup of portrait_key + ref keys
  // BEFORE calling this; we return the row so the route handler can do it.
  const row = await getCastById(env, id, userEmail);
  if (!row) return null;
  await env.DB.prepare(
    `DELETE FROM cast_members WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .run();
  return row;
}

export async function setPortrait(
  env: Env,
  id: number,
  userEmail: string,
  key: string,
  mime: string,
): Promise<CastMember | null> {
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET portrait_key = ?, portrait_mime = ?, updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at`
  )
    .bind(key, mime, id, userEmail)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

export async function clearPortrait(
  env: Env,
  id: number,
  userEmail: string,
): Promise<CastMember | null> {
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET portrait_key = NULL, portrait_mime = NULL, updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at`
  )
    .bind(id, userEmail)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

// Full cast row column list returned by the CAS array-mutation helper (matches getCastById).
const CAST_ROW_COLUMNS =
  `id, user_email, slug, name, bible, portrait_key, portrait_mime,
   ref_keys_json, source_keys_json, created_at, updated_at,
   lora_key, lora_status, lora_job_id, lora_error, lora_trained_at`;

// Optimistic-concurrency update of one of a cast member's JSON-array image-key columns
// (ref_keys_json / source_keys_json). The old code was read-modify-write across two statements, so
// two concurrent addRef calls both read the same base array and the second clobbered the first --
// a ref silently lost (issue #12). Here we read the RAW column text, apply a pure mutator in JS, then
// write ONLY if the column still holds exactly what we read (a value-CAS in the WHERE clause; the
// second-resolution updated_at is too coarse to guard on, so we compare the value itself). On a
// concurrent write the CAS matches zero rows and we re-read + retry, so no update is silently lost.
// Bounded; on pathological contention it warns and returns the current row WITHOUT applying -- rare,
// and never a silent clobber. `column` is a fixed union (not caller input), so the interpolation is
// injection-safe.
type ImageListMutator = (current: CastRefImage[]) => { next: CastRefImage[]; changed: boolean };

async function casUpdateImageList(
  env: Env,
  column: "ref_keys_json" | "source_keys_json",
  id: number,
  userEmail: string,
  mutate: ImageListMutator,
  maxAttempts = 6,
): Promise<{ row: CastMember | null; changed: boolean; notFound: boolean }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cur = await env.DB.prepare(
      `SELECT ${column} AS raw FROM cast_members WHERE id = ? AND user_email = ?`
    )
      .bind(id, userEmail)
      .first<{ raw: string | null }>();
    if (!cur) return { row: null, changed: false, notFound: true };

    const { next, changed } = mutate(parseImageKeyList(cur.raw));
    if (!changed) {
      // Nothing to write (e.g. removing a key that is not present). Return the current row.
      const row = await getCastById(env, id, userEmail);
      return { row, changed: false, notFound: row === null };
    }

    // Value-CAS: apply only if the column is byte-for-byte what we read. `col IS ?` is null-safe,
    // so a legacy NULL column matches a NULL guard. A concurrent writer changes the text -> 0 rows.
    const updated = await env.DB.prepare(
      `UPDATE cast_members
          SET ${column} = ?, updated_at = datetime('now')
        WHERE id = ? AND user_email = ? AND ${column} IS ?
       RETURNING ${CAST_ROW_COLUMNS}`
    )
      .bind(JSON.stringify(next), id, userEmail, cur.raw)
      .first<CastRow>();
    if (updated) return { row: rowToCast(updated), changed: true, notFound: false };
    // CAS miss: the column changed under us between read and write -> re-read and retry.
  }
  console.warn(
    `cast ${column} update for id ${id} gave up after ${maxAttempts} CAS attempts under contention`
  );
  return { row: await getCastById(env, id, userEmail), changed: false, notFound: false };
}

export async function addRef(
  env: Env,
  id: number,
  userEmail: string,
  ref: CastRefImage,
): Promise<CastMember | null> {
  const { row } = await casUpdateImageList(env, "ref_keys_json", id, userEmail, (cur) => ({
    next: [...cur, ref],
    changed: true,
  }));
  return row;
}

// Append a batch of refs in one CAS update (not per ref). Used by the cast-image orchestrator to
// register a whole generated training set at the end of a run -- ten sequential addRef round-trips
// would be ten writes; one batch is one CAS write that cannot lose a concurrent append.
export async function addRefs(
  env: Env,
  id: number,
  userEmail: string,
  refs: CastRefImage[],
): Promise<CastMember | null> {
  if (refs.length === 0) return getCastById(env, id, userEmail);
  const { row } = await casUpdateImageList(env, "ref_keys_json", id, userEmail, (cur) => ({
    next: [...cur, ...refs],
    changed: true,
  }));
  return row;
}

export async function removeRef(
  env: Env,
  id: number,
  userEmail: string,
  refKey: string,
): Promise<{ row: CastMember | null; removedKey: string | null }> {
  const { row, changed, notFound } = await casUpdateImageList(
    env, "ref_keys_json", id, userEmail,
    (cur) => {
      const next = cur.filter((r) => r.key !== refKey);
      return { next, changed: next.length !== cur.length };
    },
  );
  if (notFound) return { row: null, removedKey: null };
  return { row, removedKey: changed ? refKey : null };
}

// v0.90.0: persisted source/reference photos. Mirror the addRef /
// removeRef shape but write to source_keys_json. Used by the cast
// portrait + training-set generators as FLUX.2 multi-reference inputs.

export async function addSource(
  env: Env,
  id: number,
  userEmail: string,
  src: CastRefImage,
): Promise<CastMember | null> {
  const { row } = await casUpdateImageList(env, "source_keys_json", id, userEmail, (cur) => ({
    next: [...cur, src],
    changed: true,
  }));
  return row;
}

export async function removeSource(
  env: Env,
  id: number,
  userEmail: string,
  srcKey: string,
): Promise<{ row: CastMember | null; removedKey: string | null }> {
  const { row, changed, notFound } = await casUpdateImageList(
    env, "source_keys_json", id, userEmail,
    (cur) => {
      const next = cur.filter((s) => s.key !== srcKey);
      return { next, changed: next.length !== cur.length };
    },
  );
  if (notFound) return { row: null, removedKey: null };
  return { row, removedKey: changed ? srcKey : null };
}

// v0.57.0: standalone LoRA training fields. setLoraJob is called when
// the user clicks "Train LoRA" on /cast (status -> 'training', job_id
// stored). markLoraReady is called by the poll route on COMPLETED
// (status -> 'ready', lora_key stored, trained_at set). markLoraFailed
// is called on FAILED / errored polls.

export async function setLoraJob(
  env: Env,
  id: number,
  userEmail: string,
  jobId: string,
): Promise<CastMember | null> {
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET lora_status = 'training',
            lora_job_id = ?,
            lora_error = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
               lora_key, lora_status, lora_job_id, lora_error, lora_trained_at`
  )
    .bind(jobId, id, userEmail)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

export async function markLoraReady(
  env: Env,
  id: number,
  userEmail: string,
  loraKey: string,
): Promise<CastMember | null> {
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET lora_status = 'ready',
            lora_key = ?,
            lora_trained_at = datetime('now'),
            lora_job_id = NULL,
            lora_error = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
               lora_key, lora_status, lora_job_id, lora_error, lora_trained_at`
  )
    .bind(loraKey, id, userEmail)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

export async function markLoraFailed(
  env: Env,
  id: number,
  userEmail: string,
  errorMessage: string,
): Promise<CastMember | null> {
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET lora_status = 'failed',
            lora_error = ?,
            lora_job_id = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
               lora_key, lora_status, lora_job_id, lora_error, lora_trained_at`
  )
    .bind(errorMessage.slice(0, 4000), id, userEmail)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}
