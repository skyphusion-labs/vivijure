// Cast import / export as portable bundles (issue #324).
//
// A cast member is a whole character -- portrait + reference images + raw source photos + a trained
// LoRA + the bible/persona + voice. This module bundles all of that into ONE portable file and
// recreates it on another instance, enabling a community cast-sharing ecosystem (the same way
// AI-art communities share LoRAs) without any user/tenant coupling.
//
// Bundle format -- a single uncompressed USTAR tar (see src/tar.ts), conventional extension
// `.vvcast`, media type `application/x-tar`:
//
//   manifest.json            <- ALWAYS the first entry; schema-versioned (read it first)
//   assets/portrait.<ext>
//   assets/refs/<i>.<ext>    <- the LoRA training set
//   assets/sources/<i>.<ext> <- the raw human photos
//   assets/lora.safetensors  <- the trained LoRA (the heavy artifact, carried INLINE)
//
// Design decisions (see docs/CAST-BUNDLE.md for the full ICD):
//  - IDENTITY-FREE: the bundle carries the CHARACTER (name/bible/voice/face), never a user, tenant,
//    instance id, or R2 key. Asset paths are bundle-relative and re-keyed on import. This preserves
//    the single-operator / anti-SaaS model and lets a bundle move between instances freely.
//  - LoRA INLINE (not a hosted URL): a by-reference bundle dies when the exporting instance or its
//    URL goes away. Inline keeps the bundle fully self-contained and reproducible offline. The cost
//    is size; the import path enforces a documented size cap (CAST_BUNDLE_MAX_IMPORT_BYTES).
//  - SCHEMA-VERSIONED manifest so future fields never break old bundles; an unknown format or a
//    newer major schema fails LOUD (a bundle is a contract).

import type { Env } from "./env";
import type { CastMember, CastRefImage, LoraStatus } from "./cast-db";
import {
  getCastById,
  toPublicCast,
  createCast,
  setPortrait,
  addRefs,
  addSource,
  markLoraReady,
  updateCast,
} from "./cast-db";
import { isValidVoiceId } from "./voices";
import { extFromMime } from "./utils";
import { tarHeader, tarPadding, tarEof, parseTar } from "./tar";

export const CAST_BUNDLE_FORMAT = "vivijure-cast-bundle";
export const CAST_BUNDLE_SCHEMA_VERSION = 1;
export const CAST_BUNDLE_MEDIA_TYPE = "application/x-tar";
export const CAST_BUNDLE_EXT = "vvcast";

// Import size ceiling. A realistic cast is portrait (~1MB) + ~10 refs + a few sources + one LoRA
// (~50MB safetensors) -> well under this. The cap keeps the in-memory import parse bounded inside a
// Worker's memory; a larger bundle is rejected LOUD (never silently truncated). Streaming import is
// the documented future upgrade if casts ever outgrow this.
export const CAST_BUNDLE_MAX_IMPORT_BYTES = 80 * 1024 * 1024;

const MANIFEST_NAME = "manifest.json";

export interface CastBundleAssetRef {
  path: string; // bundle-relative tar entry name
  mime: string;
}

export interface CastBundleManifest {
  format: typeof CAST_BUNDLE_FORMAT;
  schema_version: number;
  exported_at?: string;
  // Optional attribution for shared casts (issue #324 licensing consideration). Free-form, advisory.
  creator?: string | null;
  cast: {
    name: string;
    slug?: string; // advisory only; the importer re-allocates a locally-unique slug
    bible: string | null;
    voice_id: string | null;
    lora_status: LoraStatus;
    lora_trained_at: string | null;
  };
  assets: {
    portrait: CastBundleAssetRef | null;
    refs: CastBundleAssetRef[];
    sources: CastBundleAssetRef[];
    lora: CastBundleAssetRef | null;
  };
}

// ---- error model (mirrors cast-media.ts: handlers return Response, never throw to the router) ----
class BundleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---- export -------------------------------------------------------------------------------------

// One planned bundle entry: the R2 key that feeds it and its bundle-relative path + mime.
interface ExportEntry {
  path: string;
  r2Key: string;
  mime: string;
}

// Build the asset plan for a cast: which R2 keys map to which bundle paths. Pure; the manifest is
// derived from the SAME plan so the manifest and the tar can never disagree.
function planExport(cast: CastMember): ExportEntry[] {
  const entries: ExportEntry[] = [];
  if (cast.portrait_key) {
    const ext = extFromMime(cast.portrait_mime || "image/png");
    entries.push({ path: `assets/portrait.${ext}`, r2Key: cast.portrait_key, mime: cast.portrait_mime || "image/png" });
  }
  cast.ref_keys.forEach((r, i) => {
    entries.push({ path: `assets/refs/${i}.${extFromMime(r.mime)}`, r2Key: r.key, mime: r.mime });
  });
  cast.source_keys.forEach((s, i) => {
    entries.push({ path: `assets/sources/${i}.${extFromMime(s.mime)}`, r2Key: s.key, mime: s.mime });
  });
  if (cast.lora_key) {
    entries.push({ path: `assets/lora.safetensors`, r2Key: cast.lora_key, mime: "application/octet-stream" });
  }
  return entries;
}

// Assemble the manifest from the (already-existence-checked) present entries, so the manifest only
// ever references assets that are actually in the tar.
function buildManifest(cast: CastMember, present: ExportEntry[], exportedAt: string): CastBundleManifest {
  const find = (pred: (e: ExportEntry) => boolean) => present.find(pred) || null;
  const portrait = find((e) => e.path.startsWith("assets/portrait."));
  const lora = find((e) => e.path === "assets/lora.safetensors");
  const refs = present.filter((e) => e.path.startsWith("assets/refs/"));
  const sources = present.filter((e) => e.path.startsWith("assets/sources/"));
  const ref = (e: ExportEntry | null): CastBundleAssetRef | null => (e ? { path: e.path, mime: e.mime } : null);
  return {
    format: CAST_BUNDLE_FORMAT,
    schema_version: CAST_BUNDLE_SCHEMA_VERSION,
    exported_at: exportedAt,
    creator: null,
    cast: {
      name: cast.name,
      slug: cast.slug,
      bible: cast.bible,
      voice_id: cast.voice_id,
      lora_status: cast.lora_status,
      lora_trained_at: cast.lora_trained_at,
    },
    assets: {
      portrait: ref(portrait),
      refs: refs.map((e) => ({ path: e.path, mime: e.mime })),
      sources: sources.map((e) => ({ path: e.path, mime: e.mime })),
      lora: ref(lora),
    },
  };
}

// Stream a cast as a `.vvcast` tar. The manifest goes first; each asset's bytes are streamed straight
// from R2 (the ~50MB LoRA is never fully buffered). HONEST soft-degrade: if a referenced artifact has
// vanished from R2 (e.g. a half-GC'd cast), it is DROPPED from the bundle + manifest with a WARN
// rather than 500-ing the export -- a missing polish artifact never fails the whole share. The
// manifest stays truthful about what the bundle actually contains.
export async function exportCastBundle(env: Env, id: number): Promise<Response> {
  const cast = await getCastById(env, id);
  if (!cast) return json({ error: "cast not found" }, 404);

  const planned = planExport(cast);
  const present: Array<ExportEntry & { size: number }> = [];
  for (const e of planned) {
    const head = await env.R2_RENDERS.head(e.r2Key);
    if (!head) {
      console.warn(`cast ${id} export: artifact ${e.r2Key} (${e.path}) missing from R2 -- dropped from bundle (degraded)`);
      continue;
    }
    present.push({ ...e, size: head.size });
  }

  const exportedAt = new Date().toISOString();
  const manifest = buildManifest(cast, present, exportedAt);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // manifest first
        controller.enqueue(tarHeader(MANIFEST_NAME, manifestBytes.length));
        controller.enqueue(manifestBytes);
        const mpad = tarPadding(manifestBytes.length);
        if (mpad.length) controller.enqueue(mpad);

        // assets, streamed
        for (const e of present) {
          const obj = await env.R2_RENDERS.get(e.r2Key);
          if (!obj) {
            // Raced with a delete between head() and get(); skip it -- the manifest already only
            // promised present assets at plan time, and import tolerates a manifest asset whose
            // bytes are absent only by failing loud, so we must NOT emit a header without a body.
            console.warn(`cast ${id} export: artifact ${e.r2Key} vanished mid-stream -- skipped`);
            continue;
          }
          controller.enqueue(tarHeader(e.path, obj.size));
          const reader = obj.body.getReader();
          let written = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            written += value.length;
          }
          const pad = tarPadding(written);
          if (pad.length) controller.enqueue(pad);
        }

        controller.enqueue(tarEof());
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const filename = `${cast.slug || "cast"}.${CAST_BUNDLE_EXT}`;
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": CAST_BUNDLE_MEDIA_TYPE,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

// ---- import -------------------------------------------------------------------------------------

// Validate the parsed manifest object against the schema contract. Throws BundleError(400) on
// anything malformed -- the bundle is a contract, so bad metadata fails LOUD before we touch D1/R2.
export function validateManifest(raw: unknown): CastBundleManifest {
  if (!raw || typeof raw !== "object") throw new BundleError(400, "bundle manifest is not an object");
  const m = raw as Record<string, unknown>;
  if (m.format !== CAST_BUNDLE_FORMAT) {
    throw new BundleError(400, `not a vivijure cast bundle (format=${JSON.stringify(m.format)})`);
  }
  if (typeof m.schema_version !== "number" || !Number.isInteger(m.schema_version)) {
    throw new BundleError(400, "bundle schema_version missing or not an integer");
  }
  if (m.schema_version > CAST_BUNDLE_SCHEMA_VERSION) {
    throw new BundleError(
      400,
      `bundle schema_version ${m.schema_version} is newer than this instance supports (${CAST_BUNDLE_SCHEMA_VERSION}); upgrade to import it`,
    );
  }
  const cast = m.cast as Record<string, unknown> | undefined;
  if (!cast || typeof cast.name !== "string" || !cast.name.trim()) {
    throw new BundleError(400, "bundle cast.name missing");
  }
  const assets = m.assets as Record<string, unknown> | undefined;
  if (!assets || typeof assets !== "object") throw new BundleError(400, "bundle assets missing");
  const refList = (v: unknown): CastBundleAssetRef[] => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new BundleError(400, "bundle asset list is not an array");
    return v.map((a) => {
      if (!a || typeof a !== "object" || typeof (a as { path?: unknown }).path !== "string") {
        throw new BundleError(400, "bundle asset entry missing path");
      }
      const ar = a as { path: string; mime?: unknown };
      return { path: ar.path, mime: typeof ar.mime === "string" ? ar.mime : "application/octet-stream" };
    });
  };
  const single = (v: unknown): CastBundleAssetRef | null => {
    if (v == null) return null;
    return refList([v])[0];
  };
  return {
    format: CAST_BUNDLE_FORMAT,
    schema_version: m.schema_version,
    exported_at: typeof m.exported_at === "string" ? m.exported_at : undefined,
    creator: typeof cast.creator === "string" ? (cast.creator as string) : (typeof m.creator === "string" ? m.creator : null),
    cast: {
      name: cast.name,
      slug: typeof cast.slug === "string" ? cast.slug : undefined,
      bible: typeof cast.bible === "string" ? cast.bible : null,
      voice_id: typeof cast.voice_id === "string" ? cast.voice_id : null,
      lora_status: normalizeLoraStatus(cast.lora_status),
      lora_trained_at: typeof cast.lora_trained_at === "string" ? cast.lora_trained_at : null,
    },
    assets: {
      portrait: single(assets.portrait),
      refs: refList(assets.refs),
      sources: refList(assets.sources),
      lora: single(assets.lora),
    },
  };
}

function normalizeLoraStatus(raw: unknown): LoraStatus {
  return raw === "training" || raw === "ready" || raw === "failed" ? raw : "idle";
}

// Recreate a cast member from a `.vvcast` bundle on THIS instance. Allocates a fresh local id + slug,
// re-keys every asset into this instance's R2 under cast/<newid>/..., inserts the D1 row, and (when
// the bundle carries a trained LoRA) preserves it so the imported cast renders identically.
//
// Malformed bundle = LOUD failure (BundleError -> 4xx): bad tar, missing/oversized body, manifest that
// references an asset whose bytes are absent. We do NOT half-import: the D1 row + R2 objects are only
// written after the manifest validates and every referenced asset is confirmed present in the tar.
export async function importCastBundle(env: Env, body: Uint8Array): Promise<Response> {
  return importInner(env, body).catch((e) => {
    if (e instanceof BundleError) return json({ error: e.message }, e.status);
    throw e;
  });
}

async function importInner(env: Env, body: Uint8Array): Promise<Response> {
  if (body.length === 0) throw new BundleError(400, "empty bundle body");
  if (body.length > CAST_BUNDLE_MAX_IMPORT_BYTES) {
    throw new BundleError(
      413,
      `bundle too large (${body.length} bytes > ${CAST_BUNDLE_MAX_IMPORT_BYTES} cap)`,
    );
  }

  let files;
  try {
    files = parseTar(body);
  } catch (e) {
    throw new BundleError(400, `not a readable tar bundle: ${(e as Error).message}`);
  }
  const byName = new Map(files.map((f) => [f.name, f.data]));
  const manifestRaw = byName.get(MANIFEST_NAME);
  if (!manifestRaw) throw new BundleError(400, `bundle missing ${MANIFEST_NAME}`);

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestRaw));
  } catch {
    throw new BundleError(400, `bundle ${MANIFEST_NAME} is not valid JSON`);
  }
  const manifest = validateManifest(manifestJson);

  // Confirm EVERY asset the manifest references is actually present in the tar BEFORE we touch
  // D1/R2 -- a malformed/tampered bundle fails loud up front and never half-creates a cast row.
  const allRefs: CastBundleAssetRef[] = [
    ...(manifest.assets.portrait ? [manifest.assets.portrait] : []),
    ...manifest.assets.refs,
    ...manifest.assets.sources,
    ...(manifest.assets.lora ? [manifest.assets.lora] : []),
  ];
  for (const a of allRefs) {
    if (!byName.has(a.path)) {
      throw new BundleError(400, `bundle manifest references ${a.path} but the tar has no such entry`);
    }
  }

  // Resolve a manifest asset to its tar bytes, failing loud if the manifest references something the
  // tar does not actually contain (a malformed/tampered bundle).
  const resolve = (a: CastBundleAssetRef): Uint8Array => {
    const data = byName.get(a.path);
    if (!data) throw new BundleError(400, `bundle manifest references ${a.path} but the tar has no such entry`);
    return data;
  };

  // 1) the D1 row (allocates a fresh local id + unique slug from the name).
  const created = await createCast(env, { name: manifest.cast.name, bible: manifest.cast.bible });
  const id = created.id;

  // 2) portrait
  if (manifest.assets.portrait) {
    const a = manifest.assets.portrait;
    const bytes = resolve(a);
    const key = `cast/${id}/portrait.${extFromMime(a.mime)}`;
    await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: a.mime } });
    await setPortrait(env, id, key, a.mime);
  }

  // 3) refs (the LoRA training set) -- one batched D1 write.
  if (manifest.assets.refs.length) {
    const refs: CastRefImage[] = [];
    for (const a of manifest.assets.refs) {
      const bytes = resolve(a);
      const key = `cast/${id}/refs/${crypto.randomUUID()}.${extFromMime(a.mime)}`;
      await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: a.mime } });
      refs.push({ key, mime: a.mime });
    }
    await addRefs(env, id, refs);
  }

  // 4) sources (raw human photos)
  for (const a of manifest.assets.sources) {
    const bytes = resolve(a);
    const key = `cast/${id}/sources/${crypto.randomUUID()}.${extFromMime(a.mime)}`;
    await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: a.mime } });
    await addSource(env, id, { key, mime: a.mime });
  }

  // 5) LoRA -- preserved under loras/ so the LoRA picker reuses it (cast-loras.ts requires the
  //    "loras/" prefix). markLoraReady because the bytes are present and renderable on this instance.
  if (manifest.assets.lora) {
    const bytes = resolve(manifest.assets.lora);
    const key = `loras/cast-${id}-${crypto.randomUUID()}.safetensors`;
    await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    await markLoraReady(env, id, key);
  }

  // 6) voice -- only persist a voice this instance's TTS actually knows; a stale/unknown voice from
  //    another instance is dropped (degraded) rather than poisoning the dialogue path.
  if (manifest.cast.voice_id && isValidVoiceId(manifest.cast.voice_id)) {
    await updateCast(env, id, { voice_id: manifest.cast.voice_id });
  } else if (manifest.cast.voice_id) {
    console.warn(`cast import ${id}: bundle voice_id "${manifest.cast.voice_id}" unknown on this instance -- dropped`);
  }

  const row = await getCastById(env, id);
  return json({ cast: row ? toPublicCast(row) : null, imported_from_schema: manifest.schema_version }, 201);
}
