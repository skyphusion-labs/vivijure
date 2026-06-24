// R2 cast-orphan GC reconciler -- IO glue around the pure core (#309).
//
// Enumerates the cast-related R2 prefixes, classifies every object against the
// live D1 owner set via src/r2-orphan-reconcile.ts (VERIFY BY ID -- see the
// loras/lora-wren-1782248711 near-miss documented there), and either reports
// the orphan set (default, DRY RUN) or deletes it (--apply), with per-delete
// logging and a re-list-empty verification pass.
//
// Run (dry run, the default):
//   node scripts/r2-orphan-gc.ts --owners /tmp/owners.json
// Apply (irreversible; only after a human eyeballs the dry-run list):
//   node scripts/r2-orphan-gc.ts --owners /tmp/owners.json --apply
//
// R2 access is via an rclone remote (default "r2", bucket "vivijure"); set
// R2_REMOTE / R2_BUCKET to override. The owner set comes from a JSON file
// (--owners) shaped { castRows, renderLoraDirs?, seedPrefixes? } -- produced
// from a D1 query of cast_members + a renders lora-ref scan. A future --cf mode
// can fetch it live from the D1 HTTP API; the JSON path keeps the GC auditable
// (the exact owner snapshot is recorded alongside the dry-run).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  buildOwnerIndex,
  reconcile,
  type CastRowLite,
  type R2ObjectLite,
  type Classification,
} from "../src/r2-orphan-reconcile.ts";

interface OwnersFile {
  castRows: CastRowLite[];
  renderLoraDirs?: string[];
  seedPrefixes?: string[];
}

const REMOTE = process.env.R2_REMOTE || "r2";
const BUCKET = process.env.R2_BUCKET || "vivijure";
const SCAN_PREFIXES = (process.env.R2_SCAN_PREFIXES || "cast/,cast-gen/,loras/")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");

function rclone(args: string[]): string {
  return execFileSync("rclone", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// List every object under a prefix as { key, size } (key is bucket-absolute).
function listPrefix(prefix: string): R2ObjectLite[] {
  const out = rclone(["lsjson", "--files-only", "--recursive", `${REMOTE}:${BUCKET}/${prefix}`]);
  const rows = JSON.parse(out || "[]") as Array<{ Path: string; Size: number }>;
  return rows.map((r) => ({ key: prefix + r.Path, size: r.Size }));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function loadOwners(): OwnersFile {
  const path = arg("--owners");
  if (!path) {
    console.error("error: --owners <json> is required (the D1 owner snapshot)");
    process.exit(2);
  }
  return JSON.parse(readFileSync(path as string, "utf8")) as OwnersFile;
}

function main(): void {
  const owners = loadOwners();
  const idx = buildOwnerIndex({
    castRows: owners.castRows,
    renderLoraDirs: owners.renderLoraDirs,
    seedPrefixes: owners.seedPrefixes,
  });

  console.log(`# R2 cast-orphan GC -- ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`bucket: ${REMOTE}:${BUCKET}   scan: ${SCAN_PREFIXES.join(" ")}`);
  console.log(`owners: ${idx.liveCastIds.size} live cast ids, ${idx.referencedKeys.size} referenced keys, ` +
    `${idx.referencedLoraDirs.size} referenced lora dirs, ${idx.seedPrefixes.length} seed(s)\n`);

  const objects: R2ObjectLite[] = [];
  for (const p of SCAN_PREFIXES) objects.push(...listPrefix(p));
  const r = reconcile(objects, idx);

  console.log(`scanned ${objects.length} objects: ${r.orphans.length} orphan, ${r.kept.length} kept, ${r.outOfScope.length} out-of-scope\n`);

  // Out-of-scope LoRA dirs surfaced so nothing is silently dropped.
  const oosDirs = Array.from(new Set(
    r.outOfScope.map((c) => c.key).filter((k) => k.startsWith("loras/")).map((k) => k.split("/").slice(0, 2).join("/")),
  )).sort();
  if (oosDirs.length) {
    console.log(`out-of-scope LoRA dirs left intact (not cast-scheme): ${oosDirs.length}`);
    for (const d of oosDirs) console.log(`  . ${d}/`);
    console.log("");
  }

  console.log(`ORPHANS (${r.orphanCount} objects, ${fmtBytes(r.orphanBytes)}):`);
  const byReason = new Map<string, Classification[]>();
  for (const c of r.orphans) {
    const list = byReason.get(c.reason) || [];
    list.push(c);
    byReason.set(c.reason, list);
  }
  for (const [reason, list] of [...byReason.entries()].sort()) {
    const bytes = list.reduce((n, c) => n + c.size, 0);
    console.log(`  [${reason}] -- ${list.length} obj, ${fmtBytes(bytes)}`);
    for (const c of list.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`    DELETE ${c.key}  (${fmtBytes(c.size)})`);
    }
  }
  console.log("");

  if (!APPLY) {
    console.log("DRY RUN -- nothing deleted. Re-run with --apply to GC the orphan set above.");
    return;
  }
  if (r.orphanCount === 0) {
    console.log("nothing to delete.");
    return;
  }

  console.log(`APPLY -- deleting ${r.orphanCount} objects...`);
  const deleted: string[] = [];
  for (const c of r.orphans) {
    try {
      rclone(["deletefile", `${REMOTE}:${BUCKET}/${c.key}`]);
      deleted.push(c.key);
      console.log(`  deleted ${c.key}`);
    } catch (e) {
      console.log(`  FAILED ${c.key}: ${(e as Error).message} (best-effort; continuing)`);
    }
  }

  // Re-list and re-classify: assert no orphan survived.
  const after: R2ObjectLite[] = [];
  for (const p of SCAN_PREFIXES) after.push(...listPrefix(p));
  const survivors = reconcile(after, idx).orphans;
  console.log(`\ndeleted ${deleted.length}/${r.orphanCount}; re-list verification: ${survivors.length} orphan(s) remain`);
  if (survivors.length) {
    for (const c of survivors) console.log(`  STILL PRESENT ${c.key}`);
    process.exit(1);
  }
  console.log("verified: orphan set is empty.");
}

main();
