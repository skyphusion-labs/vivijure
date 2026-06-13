// Storyboard bundle assembler (v0.31.0).
//
// Takes a validated storyboard + per-slot character refs (either R2 keys
// or inline data URLs) and produces the .tar.gz the vivijure-serverless
// GPU worker pulls via r2_io.download_and_extract().
//
// Bundle layout (mirrors what characters.py and orchestrator.py expect):
//
//   storyboard.yaml                           film board (serializeStoryboardYaml)
//   characters/registry.json                  per-slot {name, prompt, image}
//   characters/char_<SLOT>_<safe-name>.png    canonical portrait
//                                              (registry's `image` field points here;
//                                               characters.slot_image_path convention)
//   characters/refs/<SLOT>/ref_NN.<ext>       training + IP-Adapter refs
//                                              (characters.list_character_references
//                                               globs this dir for the readiness
//                                               check that lora_train fires on)
//   start_image.png                           optional top-level film start;
//                                              auto-bootstrapped by the GPU worker
//                                              if absent
//   clips/<id>_keyframe.png                    optional per-scene start frame
//                                              (Phase 4b reverse bridge); the pod
//                                              reads it as scene <id>'s i2v start
//                                              image (core.py scene.start_image
//                                              fallback)
//
// Returns the R2 key at bundles/<projectName>.tar.gz on success.

import type { Env } from "./env";
import {
  validateStoryboard,
  type SlotId,
  type StoryboardValidated,
} from "./storyboard-validate";
import { serializeStoryboardYaml, parseShotDurations } from "./planner-yaml";
import { emitTar, readTar, type TarFile } from "./tar-emit";
import { presignR2Get, presignR2Put } from "./r2-presign";

// One training image, supplied either as a pre-staged R2 object key
// (preferred for large sets to avoid base64 inflation through the worker
// request body) or as an inline data URL (browser convenience).
export interface TrainingImage {
  key?: string;
  dataUrl?: string;
  // Optional override of the inner filename in characters/refs/<SLOT>/.
  // Default is ref_NN.<detected-ext>.
  filename?: string;
}

export interface CharacterRef {
  name: string;
  prompt: string;
  trainingImages: TrainingImage[];
  // Canonical portrait. Defaults to trainingImages[0] when omitted.
  portrait?: TrainingImage;
}

export interface AssembleBundleArgs {
  storyboard: StoryboardValidated;
  characterRefs: Partial<Record<SlotId, CharacterRef>>;
  startImage?: TrainingImage;
  // v0.148.0 (Phase 4b, the reverse bridge): per-scene start images keyed by
  // scene id ("shot_NN"). Each is written into the bundle at
  // clips/<id>_keyframe.png, which the GPU pod's i2v path reads as that scene's
  // motion start frame (vivijure-src/core.py: scene.start_image, falling back to
  // <project_dir>/clips/<id>_keyframe.png). This injects externally-authored
  // keyframes into the pod's Wan motion with no pod-side change. Keys must match
  // a scene id present in the storyboard.
  sceneStartImages?: Record<string, TrainingImage>;
}

export type AssembleBundleResult =
  | {
      ok: true;
      bundleKey: string;
      sizeBytes: number;
      fileCount: number;
    }
  | {
      ok: false;
      errors: string[];
    };

// Mirrors characters.slot_image_path's filename convention:
//   safe = name.strip().replace(" ", "_")[:40] or slot
//   "char_<SLOT>_<safe>.png"
// We use literal-space replacement (not \s+) so multi-space names match
// the Python str.replace(" ", "_") behavior byte-for-byte.
export function safeCharFilename(slot: SlotId, name: string): string {
  const trimmed = name.trim();
  const safe = trimmed.replace(/ /g, "_").slice(0, 40) || slot;
  return `char_${slot}_${safe}.png`;
}

// Sniff the image format from the first few bytes so the inner filename
// inside the tarball gets the right extension. The GPU side's
// list_character_references globs *.png, *.jpg, *.jpeg, *.webp; falling
// back to .png on an unrecognized signature is safe (the file is still
// readable by PIL, which the GPU side uses).
export function detectImageExt(bytes: Uint8Array): "png" | "jpg" | "webp" {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return "png";
}

// Decode a "data:<mime>;base64,<...>" URL to raw bytes. Returns null if
// the URL is malformed or the base64 fails to decode.
export function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const m = dataUrl.match(/^data:([\w./+-]+);base64,(.+)$/);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function resolveImage(
  env: Env,
  img: TrainingImage,
  label: string,
): Promise<{ bytes: Uint8Array; ext: "png" | "jpg" | "webp" } | { error: string }> {
  if (img.dataUrl) {
    const bytes = decodeDataUrl(img.dataUrl);
    if (!bytes) return { error: `${label}: invalid data URL` };
    return { bytes, ext: detectImageExt(bytes) };
  }
  if (img.key) {
    // v0.39.1: staged character refs live in R2_RENDERS (the bucket the
    // GPU worker also reads + writes); this used to read env.R2 and miss
    // refs uploaded via the new /api/storyboard/character-ref path.
    const obj = await env.R2_RENDERS.get(img.key);
    if (!obj) return { error: `${label}: R2 object not found at key "${img.key}"` };
    const bytes = new Uint8Array(await obj.arrayBuffer());
    return { bytes, ext: detectImageExt(bytes) };
  }
  return { error: `${label}: must provide either { key } or { dataUrl }` };
}

// Stream a single Uint8Array through CompressionStream("gzip"). Workers
// expose this as a global; Node 18+ does too, which is what vitest runs
// the test pool under. No external dep, no codegen.
async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  // Fire-and-forget the write so the writer's close() can flush regardless
  // of the reader's pace. Errors propagate via the reader chain.
  void writer.write(bytes).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// v0.153.0: inverse of gzipBytes, for reading an existing bundle back to tar.
async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes).then(() => writer.close());
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// v0.153.0 (Phase 4 hybrid keyframe parity): build a NEW bundle = an existing
// bundle + per-scene start keyframes overlaid at clips/<id>_keyframe.png. The
// pod's finalize restores projects/<name>/state.tar.gz THEN extracts the bundle
// (rp_handler _restore_prior_state -> download_and_extract), so these entries
// overwrite the state-restored keyframes and i2v_only reuses these EXACT frames.
// Used by the hybrid GPU lane so it animates the parent row's keyframes (not
// whatever the project's last render left in the shared state.tar.gz). No
// storyboard/cast needed -- we read the source bundle and splice. Returns the
// new bundle key (in R2_RENDERS).
export async function overlayKeyframesIntoBundle(
  env: Env,
  srcBundleKey: string,
  outBundleKey: string,
  keyframes: Array<{ shot_id: string; key: string }>,
): Promise<{ ok: true; bundleKey: string } | { ok: false; error: string }> {
  const src = await env.R2_RENDERS.get(srcBundleKey);
  if (!src) return { ok: false, error: `source bundle not found: ${srcBundleKey}` };
  const tarBytes = await gunzipBytes(new Uint8Array(await src.arrayBuffer()));

  // Index existing entries by name so an injected keyframe replaces any prior
  // entry at the same path (and preserves the rest of the bundle verbatim).
  const byName = new Map<string, TarFile>();
  for (const e of readTar(tarBytes)) byName.set(e.name, e);

  for (const kf of keyframes) {
    if (!kf.shot_id || !kf.key) continue;
    const obj = await env.R2_RENDERS.get(kf.key);
    if (!obj) return { ok: false, error: `keyframe not found in R2: ${kf.key}` };
    const name = `clips/${kf.shot_id}_keyframe.png`;
    byName.set(name, { name, content: new Uint8Array(await obj.arrayBuffer()) });
  }

  const outGz = await gzipBytes(emitTar([...byName.values()]));
  await env.R2_RENDERS.put(outBundleKey, outGz, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { source: "skyphusion-hybrid-overlay" },
  });
  return { ok: true, bundleKey: outBundleKey };
}

// v0.154.0 (Phase 4 hybrid, slice-3): read the authored per-shot durations from
// a bundle's storyboard.yaml. The hybrid assembler beat-trims each clip (GPU and
// cloud) to its target_seconds; this surfaces them without re-running the pod's
// beat analysis. Best-effort: a missing bundle / storyboard / parse failure
// yields {} and the clips keep their native length (matching cloud_animate).
export async function readShotDurationsFromBundle(
  env: Env,
  bundleKey: string,
): Promise<Record<string, number>> {
  try {
    const src = await env.R2_RENDERS.get(bundleKey);
    if (!src) return {};
    const tarBytes = await gunzipBytes(new Uint8Array(await src.arrayBuffer()));
    for (const e of readTar(tarBytes)) {
      if (e.name === "storyboard.yaml") {
        return parseShotDurations(new TextDecoder().decode(e.content));
      }
    }
  } catch {
    // best-effort; fall through to no durations
  }
  return {};
}

// ---- image-prep container: background-remove a cast portrait ----
//
// Cast portraits go through the IMAGE_PREP Cloudflare Container (rembg) before
// landing in the bundle, so the renderer gets a clean alpha PNG instead of a
// backgrounded one. The cleaned result is content-addressed in R2
// (cast-clean/<sha256>.png) so repeat bundles of the same portrait reuse it.
// The container has no R2 binding: we presign a GET (source) + PUT (dest) and
// it streams both, then we read the cleaned bytes back to write into the tar.

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const b = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

// Call the image-prep container with a cold-start guard. A cheap /health ping
// rides out the port-bind window, and we retry the heavier /portrait/prep on a
// 503 (a fully-cold container can 503 when a heavy request races its bind, as
// seen in live testing). backoffMs is injectable so tests don't actually wait.
// Returns the container Response, or null on a network error.
export async function callImagePrep(
  env: Env,
  payload: { inputUrl: string; outputUrl: string; outputKey: string; background: "alpha" | "black" },
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<Response | null> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const stub = env.IMAGE_PREP.get(env.IMAGE_PREP.idFromName("singleton"));
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  // Warm the singleton so the prep call below lands on a bound container.
  try {
    await stub.fetch("https://container/health");
  } catch {
    /* best effort; the retry loop below still covers a cold start */
  }
  let resp: Response | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await stub.fetch("https://container/portrait/prep", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503) return resp;
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, backoffMs)); // container still binding
    }
  }
  return resp;
}

// Background-remove one portrait. Returns cleaned RGBA PNG bytes, or null if the
// container path fails (the caller falls back to the original bytes rather than
// failing the whole bundle; today the pod still rembg's portraits, so an
// un-cleaned portrait degrades gracefully).
async function prepPortraitBytes(
  env: Env,
  bytes: Uint8Array,
  sourceKey: string | undefined,
): Promise<Uint8Array | null> {
  try {
    const hash = await sha256HexBytes(bytes);
    const cleanKey = `cast-clean/${hash}.png`;
    const cached = await env.R2_RENDERS.get(cleanKey);
    if (cached) return new Uint8Array(await cached.arrayBuffer());

    // The container fetches the source over HTTP, so it must be an R2 object.
    // Reuse the portrait's own R2 key when it has one; otherwise stage the bytes
    // (a portrait supplied as an inline data URL has no key to presign).
    let srcKey = sourceKey;
    if (!srcKey) {
      srcKey = `cast-clean/src/${hash}.png`;
      await env.R2_RENDERS.put(srcKey, bytes, { httpMetadata: { contentType: "image/png" } });
    }
    const inputUrl = await presignR2Get(env, srcKey, 300);
    const outputUrl = await presignR2Put(env, cleanKey, 300);
    const resp = await callImagePrep(env, {
      inputUrl,
      outputUrl,
      outputKey: cleanKey,
      background: "alpha",
    });
    if (!resp || !resp.ok) {
      console.warn(
        `image-prep failed (status ${resp ? resp.status : "network"}) for ${cleanKey}; using original portrait`,
      );
      return null;
    }
    const out = await env.R2_RENDERS.get(cleanKey);
    if (!out) {
      console.warn(`image-prep reported ok but ${cleanKey} missing in R2; using original portrait`);
      return null;
    }
    return new Uint8Array(await out.arrayBuffer());
  } catch (err) {
    console.warn(
      `image-prep threw (${err instanceof Error ? err.message : String(err)}); using original portrait`,
    );
    return null;
  }
}

export async function assembleBundle(
  env: Env,
  args: AssembleBundleArgs,
): Promise<AssembleBundleResult> {
  // Defensive re-validation. The caller may have skipped validateStoryboard
  // or the storyboard could have been edited between plan and bundle. We
  // accept the cost of re-running because validation is cheap and lets the
  // assembler refuse a board that would crash the GPU worker mid-render.
  const validation = validateStoryboard(args.storyboard);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors.map((e) => `storyboard: ${e}`) };
  }
  const storyboard = validation.value;
  const errors: string[] = [];
  const files: TarFile[] = [];

  // storyboard.yaml at top level.
  files.push({
    name: "storyboard.yaml",
    content: new TextEncoder().encode(serializeStoryboardYaml(storyboard)),
  });

  // Per-slot files + registry entries. Walk use_characters in the storyboard
  // (not Object.keys(characterRefs)) so a stray extra slot in characterRefs
  // does not end up in the registry, and a missing slot in characterRefs
  // surfaces as an error here rather than silently shipping an unloaded
  // slot to the GPU worker.
  const registryCharacters: Record<string, unknown> = {};
  for (const slot of storyboard.use_characters) {
    const ref = args.characterRefs[slot];
    if (!ref) {
      errors.push(
        `characterRefs missing entry for slot "${slot}" (referenced in storyboard.use_characters)`,
      );
      continue;
    }
    if (!ref.name || ref.name.trim().length === 0) {
      errors.push(`characterRefs[${slot}].name is required (non-empty string)`);
      continue;
    }
    if (!Array.isArray(ref.trainingImages) || ref.trainingImages.length === 0) {
      errors.push(
        `characterRefs[${slot}].trainingImages is required (non-empty array)`,
      );
      continue;
    }

    // Portrait: defaults to trainingImages[0] when omitted, matching how
    // a fresh project bootstrap on the GPU side picks the first ref.
    const portraitSrc = ref.portrait ?? ref.trainingImages[0];
    const portraitResolved = await resolveImage(
      env,
      portraitSrc,
      `characterRefs[${slot}].portrait`,
    );
    if ("error" in portraitResolved) {
      errors.push(portraitResolved.error);
      continue;
    }
    // Background-remove the portrait via the image-prep container before it
    // goes into the bundle. Best-effort: on container failure we fall back to
    // the original bytes rather than fail the whole bundle.
    const cleanedPortrait = await prepPortraitBytes(env, portraitResolved.bytes, portraitSrc.key);
    const portraitFilename = safeCharFilename(slot, ref.name);
    files.push({
      name: `characters/${portraitFilename}`,
      content: cleanedPortrait ?? portraitResolved.bytes,
    });

    // Training refs at characters/refs/<SLOT>/ref_NN.<ext>. Each image's
    // ext is sniffed independently so a mixed PNG/JPEG set comes through
    // intact. The order matches the input order (the GPU side's sorted glob
    // re-orders alphabetically anyway, so ref_01 ... ref_NN is stable).
    for (let i = 0; i < ref.trainingImages.length; i++) {
      const img = ref.trainingImages[i];
      const resolved = await resolveImage(
        env,
        img,
        `characterRefs[${slot}].trainingImages[${i}]`,
      );
      if ("error" in resolved) {
        errors.push(resolved.error);
        continue;
      }
      const num = String(i + 1).padStart(2, "0");
      const innerName = img.filename ?? `ref_${num}.${resolved.ext}`;
      files.push({
        name: `characters/refs/${slot}/${innerName}`,
        content: resolved.bytes,
      });
    }

    registryCharacters[slot] = {
      name: ref.name,
      prompt: ref.prompt ?? "",
      image: `characters/${portraitFilename}`,
    };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // characters/registry.json. Pretty-printed for human introspection
  // when debugging a bundle; the GPU side's json.load doesn't care.
  files.push({
    name: "characters/registry.json",
    content: new TextEncoder().encode(
      JSON.stringify({ characters: registryCharacters }, null, 2) + "\n",
    ),
  });

  // Optional top-level start_image.png.
  if (args.startImage) {
    const startResolved = await resolveImage(env, args.startImage, "startImage");
    if ("error" in startResolved) {
      return { ok: false, errors: [startResolved.error] };
    }
    files.push({
      name: "start_image.png",
      content: startResolved.bytes,
    });
  }

  // v0.148.0 (Phase 4b, the reverse bridge): per-scene start images at
  // clips/<id>_keyframe.png. The pod (vivijure-src/core.py) reads each scene's
  // start frame from scene.start_image, falling back to this path, so an
  // externally-authored keyframe here drives that scene's Wan i2v motion with no
  // pod change. Bytes are written raw (no background removal; these are full
  // frames, not portraits); the pod loads by content, not extension. Keys are
  // validated against the storyboard's scene ids so a typo cannot silently ship
  // a keyframe no scene will ever read.
  if (args.sceneStartImages) {
    const sceneIds = new Set(
      storyboard.scenes.map(
        (s, i) => s.id || `shot_${String(i + 1).padStart(2, "0")}`,
      ),
    );
    for (const [sceneId, img] of Object.entries(args.sceneStartImages)) {
      if (!sceneIds.has(sceneId)) {
        return {
          ok: false,
          errors: [`sceneStartImages: "${sceneId}" is not a scene id in the storyboard`],
        };
      }
      const resolved = await resolveImage(env, img, `sceneStartImages["${sceneId}"]`);
      if ("error" in resolved) {
        return { ok: false, errors: [resolved.error] };
      }
      files.push({
        name: `clips/${sceneId}_keyframe.png`,
        content: resolved.bytes,
      });
    }
  }

  // Emit tar, gzip, upload.
  const tarBytes = emitTar(files);
  const gz = await gzipBytes(tarBytes);
  const bundleKey = `bundles/${storyboard.projectName}.tar.gz`;
  // v0.39.1: bundles land in R2_RENDERS so the GPU worker (which reads
  // from its own R2_BUCKET) sees them. Pre-0.39.1 wrote to env.R2 and
  // the GPU could only pull bundles after a manual copy between buckets.
  await env.R2_RENDERS.put(bundleKey, gz, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { source: "skyphusion-planner" },
  });

  return {
    ok: true,
    bundleKey,
    sizeBytes: gz.length,
    fileCount: files.length,
  };
}
