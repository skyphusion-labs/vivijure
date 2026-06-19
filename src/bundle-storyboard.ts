// Read storyboard.yaml out of a bundles/*.tar.gz in R2. Pure tar walk + gzip decompress;
// only storyboard.yaml is extracted (the bundle schema is fixed and small).

import type { Env } from "./env";
import { parseStoryboardScenes, type ParsedBundleScene } from "./planner-yaml";

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

/** Walk a gzip-decompressed ustar tar and return the named file as utf-8, or null. */
export function extractTarText(tar: Uint8Array, wantName: string): string | null {
  const bytes = extractTarBytes(tar, wantName);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

export async function readBundleStoryboardYaml(env: Env, bundleKey: string): Promise<string | null> {
  const obj = await env.R2_RENDERS.get(bundleKey);
  if (!obj) return null;
  const compressed = await obj.arrayBuffer();
  const tarStream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tarBuf = new Uint8Array(await new Response(tarStream).arrayBuffer());
  return extractTarText(tarBuf, "storyboard.yaml");
}

export async function readBundleScenes(env: Env, bundleKey: string, defaultSeconds = 4): Promise<ParsedBundleScene[]> {
  const yaml = await readBundleStoryboardYaml(env, bundleKey);
  if (!yaml) return [];
  return parseStoryboardScenes(yaml, defaultSeconds);
}
