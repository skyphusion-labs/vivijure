// Unguessable public resource ids (security finding F13, sprint S9).
//
// The externally-addressable resources (storyboard_projects, cast_members, renders) expose a
// `public_id` -- a canonical UUID v4 (122 bits of entropy) -- as the ONLY id that leaves the core
// over the API. The internal INTEGER PK stays the join/FK key; public_id is what every `:id` route
// accepts and resolves. A bare sequential integer is not a valid public id, so it can never address
// a row: the enumeration attack (walk 1, 2, 3) is dead at the shape level and again at the lookup.
//
// One format serves both freshly-inserted rows (crypto.randomUUID() here) and rows backfilled by
// migration 0010 (a pure-SQL v4 generator emitting the identical 8-4-4-4-12 canonical shape).

/** Mint a new public id for a row insert. Canonical lowercase UUID v4 from the platform CSPRNG. */
export function newPublicId(): string {
  return crypto.randomUUID();
}

// Canonical UUID v4: 8-4-4-4-12 lowercase hex, version nibble 4, variant nibble in [89ab]. Matches
// both crypto.randomUUID() and the migration 0010 backfill expression.
const PUBLIC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True iff `raw` is shaped like a public id. A bare integer (or any non-UUID string) is false, so a
 *  route can reject an enumeration probe (e.g. "5") with a 404 before touching the database. This is
 *  a cheap shape gate, NOT the security boundary -- the authoritative check is that the public_id
 *  matches a stored row (resolve* in the db layer). */
export function isPublicId(raw: unknown): raw is string {
  return typeof raw === "string" && PUBLIC_ID_RE.test(raw);
}
