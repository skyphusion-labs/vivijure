// Extract per-scene injected keyframes (clips/<id>_keyframe.png) from a bundle tar and stage
// them in R2 for the film orchestrator (startFilmFromKeyframes presigns by R2 key).

import type { Env } from "./env";
import { extractTarBytes, listTarNames } from "./bundle-storyboard";

const KF_PATH = /^clips\/(.+)_keyframe\.png$/;

export interface StagedBundleKeyframe {
  shot_id: string;
  keyframe_key: string;
}

/** List injected keyframe shot ids present in a bundle (without staging). */
export function bundleKeyframeShotIds(tarNames: string[]): string[] {
  const out: string[] = [];
  for (const name of tarNames) {
    const m = name.match(KF_PATH);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Read bundle tar.gz from R2, stage each clips/<id>_keyframe.png to a stable R2 key, return refs. */
export async function stageBundleInjectedKeyframes(
  env: Env,
  bundleKey: string,
  project: string,
): Promise<StagedBundleKeyframe[]> {
  const obj = await env.R2_RENDERS.get(bundleKey);
  if (!obj) return [];
  const compressed = await obj.arrayBuffer();
  const tarStream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tarBuf = new Uint8Array(await new Response(tarStream).arrayBuffer());
  const names = listTarNames(tarBuf);
  const shotIds = bundleKeyframeShotIds(names);
  const out: StagedBundleKeyframe[] = [];
  const safeProject = project.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "project";

  for (const shot_id of shotIds) {
    const tarPath = `clips/${shot_id}_keyframe.png`;
    const bytes = extractTarBytes(tarBuf, tarPath);
    if (!bytes) continue;
    const keyframe_key = `renders/${safeProject}/bundle-kf/${shot_id}.png`;
    await env.R2_RENDERS.put(keyframe_key, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    out.push({ shot_id, keyframe_key });
  }
  return out;
}
