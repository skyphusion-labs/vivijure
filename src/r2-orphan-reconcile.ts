// Pure R2 cast-orphan reconciliation core (#309).
//
// No IO, no Node/Worker globals: this is plain data-in/data-out so it unit-tests
// under the CI tsc + vitest gate (tests/r2-orphan-reconcile.test.ts). The live
// IO (R2 list/delete, D1 query) lives in scripts/r2-orphan-gc.ts, which feeds
// this core and acts on its verdict.
//
// WHY (issue #298 -> #309): before #298, every cast deletion orphaned its R2
// artifacts (portrait, ref set, sources, trained LoRA). #298 stopped the bleed
// and GC'd one cast; this core sweeps the backlog SAFELY.
//
// HARD SAFETY RULE (the #298 near-miss): never delete on a slug/wildcard match
// alone. During the #298 GC a broad "wren" grep flagged loras/lora-wren-
// 1782248711/ for deletion -- but that LoRA is LIVE, owned by cast id 4. Only a
// verify-by-ID check spared it. So this core decides ownership against the live
// cast_members id set (and the keys/lora-dirs any live row OR any render
// references), never against a name pattern alone. A key is an orphan only when
// NO live owner is found; anything not provably cast-owned is left out-of-scope,
// never deleted.

export interface CastRowLite {
  id: number;
  portrait_key?: string | null;
  lora_key?: string | null;
  ref_keys_json?: string | null;
  source_keys_json?: string | null;
}

export interface R2ObjectLite {
  key: string;
  size: number;
}

export interface OwnerIndexInput {
  castRows: CastRowLite[];
  // lora DIR names (the segment after loras/) referenced by any render row, so
  // a LoRA a render still depends on is never swept. e.g. "fur_and_circuits".
  renderLoraDirs?: string[];
  // explicit, operator-authorized orphan prefixes that do not match the cast
  // naming schemes (e.g. "loras/wren_talks_test_2/"). Still gated on "not
  // referenced by a live owner" -- a seed never overrides a live reference.
  seedPrefixes?: string[];
}

export interface OwnerIndex {
  liveCastIds: Set<number>;
  referencedKeys: Set<string>;
  referencedLoraDirs: Set<string>;
  seedPrefixes: string[];
}

export type Decision = "keep" | "orphan" | "out-of-scope";

export interface Classification {
  key: string;
  size: number;
  decision: Decision;
  reason: string;
}

export interface ReconcileResult {
  orphans: Classification[];
  kept: Classification[];
  outOfScope: Classification[];
  orphanBytes: number;
  orphanCount: number;
}

// loras/<dir>/... -> "<dir>" (else null). The dir is the LoRA training run.
export function loraDirOf(key: string): string | null {
  const parts = key.split("/");
  if (parts.length >= 2 && parts[0] === "loras" && parts[1]) return parts[1];
  return null;
}

// cast/<id>/... or cast-gen/<id>/... -> id (else null). Id-based prefixes are
// the cast EDITOR assets (portrait, refs, sources), keyed on the cast row id.
function castTreeIdOf(key: string): number | null {
  const m = key.match(/^cast(?:-gen)?\/(\d+)\//);
  return m ? parseInt(m[1], 10) : null;
}

// The two cast-LoRA dir naming schemes the backend emits:
//   cast-<id>                 (early id-keyed)
//   lora-<slug>-<unix-ts>     (current: slug + 9+ digit timestamp)
// Anything else under loras/ is some other system's artifact (a film, a load
// test, a smoke fixture) and is OUT OF SCOPE for a cast reconciler.
const CAST_ID_LORA_DIR = /^cast-(\d+)$/;
const SLUG_TS_LORA_DIR = /^lora-.+-\d{9,}$/;

function parseImageKeys(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r === "object" && typeof r.key === "string")
      .map((r) => r.key as string);
  } catch {
    return [];
  }
}

export function buildOwnerIndex(input: OwnerIndexInput): OwnerIndex {
  const liveCastIds = new Set<number>();
  const referencedKeys = new Set<string>();
  const referencedLoraDirs = new Set<string>();

  for (const row of input.castRows) {
    if (typeof row.id === "number") liveCastIds.add(row.id);
    if (row.portrait_key) referencedKeys.add(row.portrait_key);
    if (row.lora_key) {
      referencedKeys.add(row.lora_key);
      const dir = loraDirOf(row.lora_key);
      if (dir) referencedLoraDirs.add(dir);
    }
    for (const k of parseImageKeys(row.ref_keys_json)) referencedKeys.add(k);
    for (const k of parseImageKeys(row.source_keys_json)) referencedKeys.add(k);
  }
  for (const dir of input.renderLoraDirs ?? []) {
    if (dir) referencedLoraDirs.add(dir);
  }

  return {
    liveCastIds,
    referencedKeys,
    referencedLoraDirs,
    seedPrefixes: (input.seedPrefixes ?? []).filter(Boolean),
  };
}

// Decide a single R2 object's fate. Order matters: a direct live reference
// always wins (keep); then explicit seeds; then the id-based cast trees; then
// the cast-LoRA dirs; anything unrecognized is out-of-scope (never deleted).
export function classifyKey(obj: R2ObjectLite, idx: OwnerIndex): Classification {
  const { key, size } = obj;
  const mk = (decision: Decision, reason: string): Classification => ({ key, size, decision, reason });

  if (idx.referencedKeys.has(key)) {
    return mk("keep", "referenced directly by a live cast_members row");
  }

  for (const prefix of idx.seedPrefixes) {
    if (key.startsWith(prefix)) {
      return mk("orphan", `explicit operator seed (${prefix}), no live reference`);
    }
  }

  const treeId = castTreeIdOf(key);
  if (treeId !== null) {
    return idx.liveCastIds.has(treeId)
      ? mk("keep", `under a live cast id ${treeId} tree`)
      : mk("orphan", `cast id ${treeId} has no live cast_members row`);
  }

  const dir = loraDirOf(key);
  if (dir !== null) {
    const idMatch = dir.match(CAST_ID_LORA_DIR);
    if (idMatch) {
      const id = parseInt(idMatch[1], 10);
      return idx.liveCastIds.has(id)
        ? mk("keep", `cast-${id} LoRA for a live cast`)
        : mk("orphan", `cast-${id} LoRA, cast id ${id} has no live row`);
    }
    if (SLUG_TS_LORA_DIR.test(dir)) {
      return idx.referencedLoraDirs.has(dir)
        ? mk("keep", `LoRA dir referenced by a live cast or render`)
        : mk("orphan", `cast-scheme LoRA dir with no live cast or render reference`);
    }
    return mk("out-of-scope", `non-cast-scheme LoRA dir (${dir}); not a cast reconciler target`);
  }

  return mk("out-of-scope", "unrecognized prefix; not a cast reconciler target");
}

export function reconcile(objects: R2ObjectLite[], idx: OwnerIndex): ReconcileResult {
  const orphans: Classification[] = [];
  const kept: Classification[] = [];
  const outOfScope: Classification[] = [];
  for (const obj of objects) {
    const c = classifyKey(obj, idx);
    if (c.decision === "orphan") orphans.push(c);
    else if (c.decision === "keep") kept.push(c);
    else outOfScope.push(c);
  }
  const orphanBytes = orphans.reduce((n, c) => n + (c.size || 0), 0);
  return { orphans, kept, outOfScope, orphanBytes, orphanCount: orphans.length };
}
