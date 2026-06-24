// Read a project bundle (bundles/*.tar.gz in R2) the GPUless way: gunzip, walk the ustar tar, and
// pull out the storyboard + cast portraits the keyframe gen conditions on. The tar walk + parsers are
// pure (unit-tested without the runtime); only gunzipBundle touches R2 + DecompressionStream.
//
// Bundle layout (built by the core's bundle-assembler, the contract we read against):
//   storyboard.yaml                          scenes (prompt + character_slots), style_prefix
//   characters/registry.json                 per-slot { name, prompt, image }
//   characters/char_<SLOT>_<safe>.png        canonical portrait (registry.image points here)
//   characters/refs/<SLOT>/ref_NN.<ext>      extra training / IP-adapter refs

// --- tar walk (vendored from the core's bundle-storyboard helpers; pure) -----------------------

function readTarString(header: Uint8Array, offset: number, width: number): string {
  let s = "";
  for (let i = 0; i < width; i++) {
    const c = header[offset + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function parseTarOctal(header: Uint8Array, offset: number, width: number): number {
  const raw = readTarString(header, offset, width).trim();
  if (!raw) return 0;
  return parseInt(raw, 8) || 0;
}

/** Walk a gzip-decompressed ustar tar and return all non-directory entry names. */
export function listTarNames(tar: Uint8Array): string[] {
  const names: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 512 > tar.length) break;
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readTarString(header, 0, 100);
    const size = parseTarOctal(header, 124, 12);
    offset += 512;
    if (offset + size > tar.length) break;
    offset += Math.ceil(size / 512) * 512;
    if (name) names.push(name);
  }
  return names;
}

/** Return raw bytes for a named tar entry, or null if missing. */
export function extractTarBytes(tar: Uint8Array, wantName: string): Uint8Array | null {
  let offset = 0;
  for (;;) {
    if (offset + 512 > tar.length) break;
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readTarString(header, 0, 100);
    const size = parseTarOctal(header, 124, 12);
    offset += 512;
    if (offset + size > tar.length) break;
    const content = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (name === wantName) return content;
  }
  return null;
}

/** Return the named tar entry as utf-8, or null. */
export function extractTarText(tar: Uint8Array, wantName: string): string | null {
  const bytes = extractTarBytes(tar, wantName);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

// --- storyboard + registry parsing (pure) ------------------------------------------------------

export interface BundleScene {
  shot_id: string;
  prompt: string;
  slots: string[]; // character_slots present in this shot (A-D); empty for a character-less shot
}

/** Parse `[A, B]` flow-list slots. */
function parseSlotList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Extract { shot_id, prompt, slots } per scene from an emitted storyboard.yaml. The format is the
 *  deterministic output of the core's serializeStoryboardYaml, so a targeted line scan is enough
 *  (no YAML dep). Mirrors the core's parseStoryboardScenes, but also captures character_slots. */
export function parseScenes(yaml: string): BundleScene[] {
  const out: BundleScene[] = [];
  let inScenes = false;
  let idx = 0;
  let curId: string | null = null;
  let curPrompt: string | null = null;
  let curSlots: string[] = [];
  const flush = (): void => {
    if (idx === 0 || curPrompt === null) return;
    const shot = curId || `shot_${String(idx).padStart(2, "0")}`;
    out.push({ shot_id: shot, prompt: curPrompt, slots: curSlots });
  };
  for (const line of yaml.split(/\r?\n/)) {
    if (!inScenes) {
      if (/^scenes:\s*$/.test(line)) inScenes = true;
      continue;
    }
    const promptM = line.match(/^ {2}- prompt: "((?:[^"\\]|\\.)*)"\s*$/);
    if (promptM) {
      flush();
      idx++;
      curId = null;
      curSlots = [];
      curPrompt = promptM[1].replace(/\\(.)/g, "$1");
      continue;
    }
    const idM = line.match(/^ {4}id:\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (idM) {
      curId = idM[1].replace(/\\(.)/g, "$1");
      continue;
    }
    const slotsM = line.match(/^ {4}character_slots:\s*(\[.*\])\s*$/);
    if (slotsM) {
      curSlots = parseSlotList(slotsM[1]);
    }
  }
  flush();
  return out;
}

/** The top-level style_prefix from a storyboard.yaml (empty when absent). Composed into each shot's
 *  prompt so cloud keyframes carry the project's intended style, the way the GPU path's
 *  background_prompt() leans on style_prefix. */
export function parseStylePrefix(yaml: string): string {
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^style_prefix:\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (m) return m[1].replace(/\\(.)/g, "$1");
  }
  return "";
}

export interface RegistryCharacter {
  name: string;
  prompt: string;
  image: string; // tar path of the canonical portrait, e.g. "characters/char_A_Wren.png"
}

/** Parse characters/registry.json -> slot -> { name, prompt, image }. Tolerant: malformed entries
 *  are dropped. */
export function parseRegistry(json: string): Record<string, RegistryCharacter> {
  const out: Record<string, RegistryCharacter> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  const chars = (parsed as { characters?: unknown })?.characters;
  if (!chars || typeof chars !== "object") return out;
  for (const [slot, v] of Object.entries(chars as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name : "";
    const prompt = typeof c.prompt === "string" ? c.prompt : "";
    const image = typeof c.image === "string" ? c.image : "";
    out[slot] = { name, prompt, image };
  }
  return out;
}

/** The extra ref images for a slot (characters/refs/<SLOT>/...), sorted, for multi-ref conditioning. */
export function refsForSlot(tarNames: string[], slot: string): string[] {
  const prefix = `characters/refs/${slot}/`;
  return tarNames.filter((n) => n.startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(n)).sort();
}

// --- R2 + gunzip (the only impure bit) ---------------------------------------------------------

interface R2GetBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** Fetch a bundle from R2 and gunzip it to raw tar bytes, or null if the object is missing. */
export async function gunzipBundle(bucket: R2GetBucket, bundleKey: string): Promise<Uint8Array | null> {
  const obj = await bucket.get(bundleKey);
  if (!obj) return null;
  const compressed = await obj.arrayBuffer();
  const tarStream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(tarStream).arrayBuffer());
}
