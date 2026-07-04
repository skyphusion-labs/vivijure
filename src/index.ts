// Vivijure studio core: module host, render API router, planner/cast UI server.

import { discoverModules, modulesResponse, dispatchChain, servingForHook, validateManifest, cloudMotionModules, defaultGpuDoorModule, gpuDoorMotionModules, motionBackendPreflightError } from "./modules/registry";
import { runLiveConformance, allPass, failures } from "./modules/conformance";
import { installModuleRow, uninstallModuleRow, setModuleEnabled, listInstalledModules } from "./installed-modules";
import { resolveRenderPipeline, type RenderPipelineSelection } from "./modules/render-pipeline";
import { startClipJob, advanceClipJob, summarizeJob, type ClipShotInput } from "./render-orchestrator";
import { startFilmJob, advanceFilmJob, cancelFilmJob, startFilmFromKeyframes, summarizeFilm, type FilmScene, type FilmSummary } from "./film-orchestrator";
import {
  filmJobToPollView, filmRowFromJob, isFilmJobId, mapRenderOverridesToModuleConfigs,
  normalizeFilmScenes, filterScenesByShotIds,
} from "./film-render-bridge";
import { animateFromPreview, clipAnimateProgress } from "./finalize-from-keyframes";
import { resolveCastLoras, untrainedCastMessage } from "./cast-loras";
import { normalizeHybridBackends } from "./storyboard-validate";
import { startCastRefsJob, advanceCastRefsJob, summarizeCastRefs } from "./cast-image-orchestrator";
import type { PlanEnhanceInput, PlanEnhanceOutput, PlanEnhanceStoryboard } from "./modules/types";
import type { Env } from "./env";
import { isPublicId } from "./public-id";

import {
  listProjects, getProjectById, createProject, updateProjectMeta, setLastStoryboard, deleteProject,
  getProjectIdByPublicId, toPublicProject,
} from "./storyboard-projects-db";
import {
  listCast, getCastById, createCast, updateCast, deleteCast,
  clearPortrait, getCastIdByPublicId, toPublicCast,
} from "./cast-db";
import { handleCastLoraStatus, handleCastTrainLora } from "./cast-lora-train";
import { isValidVoiceId, VOICE_IDS, VOICE_CATALOG } from "./voices";
import { handleAdoptRender } from "./render-adopt";
import {
  handleCastPortraitUpload,
  handleCastRefAdd,
  handleCastRefRemove,
  handleCastSourceAdd,
  handleCastSourceRemove,
  deleteCastArtifacts,
} from "./cast-media";
import { exportCastBundle, importCastBundle } from "./cast-bundle";
import { gateApi } from "./auth-gate";
import { isSpendRoute, enforceSpendLimit } from "./rate-limit";
import { applyResponseSecurity } from "./asset-response";
import { chatImage, type ChatImageArgs } from "./chat-image";
import { findModel } from "./models";
import { isSafeBundleKey, isSafeRelKey, parseByteRange } from "./shared";
import {
  insertRender, updateRenderFromView, getRenderByIdForUser, listRendersForUser, listUserTags,
  setRenderLabel, setRenderLockedShots, setRenderFolder, setRenderTags, deleteRenderRow,
  normalizeLockedShots, normalizeFolderPath, normalizeTags,
  setCloudAnimateProgress, setHybridProgress, getRenderIdByPublicId, toPublicRenderRow,
  type NewRenderRow,
} from "./renders-db";
import { stageBundleInjectedKeyframes } from "./bundle-keyframes";
import { readBundleScenes } from "./bundle-storyboard";
import { dialogueLinesFromBundleScenes } from "./dialogue-lines";
import { readKeyframeDone } from "./render-progress";
import type { DialogueLine } from "./modules/types";
import {
  startScatterRender,
  advanceScatterJob,
  cancelScatterJob,
  scatterJobToPollView,
  isScatterJobId,
} from "./scatter-orchestrator";
import { sweepUnresolvedJobs } from "./render-sweep";
import { renderConfigProjection, parseModuleRenderOverrides } from "./render-module-config";
import {
  coerceQualityTier, deriveProjectFromBundleKey,
  type AudioAnalyzeRequest,
} from "./runpod-submit";
import { validateStoryboard, type StoryboardValidated } from "./storyboard-validate";
import { checkStoryboardShape, checkCastBindingsReady, summarize, type PreflightIssue } from "./preflight";
import {
  planStoryboard, refineStoryboard, chatComplete,
  type PlanStoryboardArgs, type RefineStoryboardArgs, type ChatCompleteArgs,
} from "./planner";
import { PLANNING_MODELS } from "./planner-catalog";
import { serializeStoryboardYaml } from "./planner-yaml";
import { emitMarkers, type MarkersFormat } from "./markers";
import { assembleBundle, type AssembleBundleArgs } from "./bundle-assembler";
import { presignR2Get, FILM_DOWNLOAD_TTL_SECONDS } from "./r2-presign";
import { getUserPrefs, setUserPrefs } from "./user-prefs";
import { loadInstallConfig, setInstallConfig, hasInstallConfig } from "./operator-config";
import { analyzeAudioBeats } from "./beat-analyze";
import { startScoreBedGenerate, pollScoreBedGenerate } from "./score-bed";
import { muxAudioOntoRender } from "./render-mux";

// Container DOs -- exported so the runtime registers them (bound in wrangler.toml).

// Local JSON response helper -- status as a plain number (shared.ts's json takes a ResponseInit).
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// --- error model ---------------------------------------------------------
class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
const badRequest = (m: string) => new HttpError(400, m);
const notFound = (m = "not found") => new HttpError(404, m);
// S9 (F13): the :id route param is an opaque public id (UUID v4), NEVER a sequential integer.
// Each resolver maps the public id to the internal integer PK the db layer keys on, or 404s. A bare
// integer is not a public id (isPublicId is false), so it never resolves -- enumeration is dead at
// the shape gate, and again at the unique-index lookup. The int PK never crosses the API boundary.
async function resolveCastId(env: Env, raw: string): Promise<number> {
  const id = isPublicId(raw) ? await getCastIdByPublicId(env, raw) : null;
  if (id === null) throw notFound("cast member");
  return id;
}
async function resolveProjectId(env: Env, raw: string): Promise<number> {
  const id = isPublicId(raw) ? await getProjectIdByPublicId(env, raw) : null;
  if (id === null) throw notFound("project");
  return id;
}
async function resolveRenderId(env: Env, raw: string): Promise<number> {
  const id = isPublicId(raw) ? await getRenderIdByPublicId(env, raw) : null;
  if (id === null) throw notFound("render");
  return id;
}
// A client-supplied project REFERENCE (?project_id filter, submit body projectId): an opaque public
// id resolved to the internal int, or null when absent/unknown. Null means "no project" (the render
// list + submit paths treat it as an unfiltered / project-less submit), so this never throws.
async function resolveProjectRef(env: Env, raw: unknown): Promise<number | null> {
  return isPublicId(raw) ? await getProjectIdByPublicId(env, raw) : null;
}
async function readBody<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw badRequest("invalid JSON body"); }
}

// --- routing -------------------------------------------------------------
type Handler = (req: Request, env: Env, ctx: ExecutionContext, p: Record<string, string>) => Promise<Response>;
interface Route { method: string; pattern: string; handler: Handler; }

// Pattern segments are a literal, ":name" (one segment), or a trailing "*name" catch-all that
// captures the rest of the path -- used for /api/artifact/*key, where the R2 key contains slashes.
function match(routes: Route[], method: string, pathname: string) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const pp = r.pattern.split("/"), sp = pathname.split("/");
    const star = pp.findIndex((seg) => seg[0] === "*");
    if (star === -1 ? pp.length !== sp.length : sp.length < pp.length) continue;
    const p: Record<string, string> = {}; let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i][0] === "*") { p[pp[i].slice(1)] = sp.slice(i).map(decodeURIComponent).join("/"); break; }
      else if (pp[i][0] === ":") p[pp[i].slice(1)] = decodeURIComponent(sp[i]);
      else if (pp[i] !== sp[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params: p };
  }
  return null;
}

// --- projects ------------------------------------------------------------
// Responses are wrapped by resource name ({projects}/{project}) -- the frontend reads data.projects
// / data.project. (Migration regression: these used to return bare rows, which crashed create.)
const hListProjects: Handler = async (req, env) => json({ projects: (await listProjects(env)).map(toPublicProject) });
const hCreateProject: Handler = async (req, env) => {
  const b = await readBody<{ name?: string; prefs?: Record<string, unknown> }>(req);
  if (!b.name) throw badRequest("name required");
  return json({ project: toPublicProject(await createProject(env, { name: b.name, prefs: b.prefs })) }, 201);
};
const hGetProject: Handler = async (req, env, _c, p) => {
  const row = await getProjectById(env, await resolveProjectId(env, p.id));
  if (!row) throw notFound("project");
  return json({ project: toPublicProject(row) });
};
const hPatchProject: Handler = async (req, env, _c, p) => {
  const id = await resolveProjectId(env, p.id);
  const b = await readBody<{ name?: string; prefs?: Record<string, unknown>; storyboard?: unknown }>(req);
  const row = b.storyboard !== undefined
    ? await setLastStoryboard(env, id, b.storyboard)
    : await updateProjectMeta(env, id, { name: b.name, prefs: b.prefs });
  if (!row) throw notFound("project");
  return json({ project: toPublicProject(row) });
};
const hDeleteProject: Handler = async (req, env, _c, p) => {
  const row = await deleteProject(env, await resolveProjectId(env, p.id));
  if (!row) throw notFound("project");
  return json({ ok: true, deleted: row.public_id });
};
const hSaveProjectStoryboard: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ storyboard?: unknown }>(req);
  if (b.storyboard === undefined) throw badRequest("storyboard required");
  const row = await setLastStoryboard(env, await resolveProjectId(env, p.id), b.storyboard);
  if (!row) throw notFound("project");
  return json({ project: toPublicProject(row) });
};

// --- cast ----------------------------------------------------------------
// Wrapped by resource name ({cast}) -- the frontend reads data.cast (array for list, object for item).
const hListCast: Handler = async (_req, env) => json({ cast: (await listCast(env)).map(toPublicCast) });
// The dialogue voice catalog (aura-1 speakers). Static; the cast voice picker renders from it so the
// list of voices has one source of truth (src/voices.ts), not a hardcoded copy in the frontend.
const hListVoices: Handler = async () => json({ voices: VOICE_CATALOG });
const hCreateCast: Handler = async (req, env) => {
  const b = await readBody<{ name?: string; bible?: string | null }>(req);
  if (!b.name) throw badRequest("name required");
  return json({ cast: toPublicCast(await createCast(env, { name: b.name, bible: b.bible })) }, 201);
};
const hGetCast: Handler = async (req, env, _c, p) => {
  const row = await getCastById(env, await resolveCastId(env, p.id));
  if (!row) throw notFound("cast member");
  return json({ cast: toPublicCast(row) });
};
const hPatchCast: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ name?: string; bible?: string | null; voice_id?: string | null }>(req);
  const patch: { name?: string; bible?: string | null; voice_id?: string | null } = {
    name: b.name,
    bible: b.bible,
  };
  // voice_id is a known Aura-1 speaker; null/"" clears it. Reject anything else so a typo can never
  // persist a voice the dialogue TTS can't pronounce.
  if (b.voice_id !== undefined) {
    if (b.voice_id === null || b.voice_id === "") patch.voice_id = null;
    else if (isValidVoiceId(b.voice_id)) patch.voice_id = b.voice_id;
    else throw badRequest(`voice_id must be one of: ${VOICE_IDS.join(", ")}`);
  }
  const row = await updateCast(env, await resolveCastId(env, p.id), patch);
  if (!row) throw notFound("cast member");
  return json({ cast: toPublicCast(row) });
};
const hDeleteCast: Handler = async (req, env, _c, p) => {
  const row = await deleteCast(env, await resolveCastId(env, p.id));
  if (!row) throw notFound("cast member");
  // Issue #298: deleteCast returns the row (with its keys) precisely so the caller reclaims R2.
  // Best-effort, so a missing/transient-failing artifact never blocks the delete response.
  await deleteCastArtifacts(env, row);
  return json({ ok: true, deleted: row.public_id });
};
// portrait / ref / source: binary upload, staged {key,mime}, or {from_chat_artifact} copy.
const hSetPortrait: Handler = async (req, env, _c, p) =>
  handleCastPortraitUpload(req, env, await resolveCastId(env, p.id));
const hClearPortrait: Handler = async (_req, env, _c, p) => {
  const id = await resolveCastId(env, p.id);
  const cur = await getCastById(env, id);
  if (!cur) throw notFound("cast member");
  if (cur.portrait_key) {
    try { await env.R2_RENDERS.delete(cur.portrait_key); } catch { /* ignore */ }
  }
  const row = await clearPortrait(env, id);
  return json({ cast: row ? toPublicCast(row) : null });
};
const hAddRef: Handler = async (req, env, _c, p) =>
  handleCastRefAdd(req, env, await resolveCastId(env, p.id));
const hRemoveRef: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ key?: string }>(req).catch(() => ({} as { key?: string }));
  const key = b.key || p.refKey;
  if (!key) throw badRequest("key required");
  return handleCastRefRemove(env, await resolveCastId(env, p.id), key);
};
const hAddSource: Handler = async (req, env, _c, p) =>
  handleCastSourceAdd(req, env, await resolveCastId(env, p.id));
const hRemoveSource: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ key?: string }>(req).catch(() => ({} as { key?: string }));
  const key = b.key || p.sourceKey;
  if (!key) throw badRequest("key required");
  return handleCastSourceRemove(env, await resolveCastId(env, p.id), key);
};

// cast.image: generate a cast member's LoRA training reference set via the installed cast.image
// module (FLUX 2 / Nano Banana), then register the generated images onto the member. Async run/poll
// across requests (a 10-image set can't finish in one request) -- POST starts it, GET advances it.
const hGenerateCastRefs: Handler = async (req, env, _c, p) => {
  const id = await resolveCastId(env, p.id);
  const b = await readBody<{ config?: Record<string, unknown>; art_style?: string; source_keys?: string[]; choice?: string }>(req);
  const job = await startCastRefsJob(env, {
    castId: id, config: b.config, artStyle: b.art_style, sourceKeys: b.source_keys, choice: b.choice,
  });
  if (!job) throw notFound("cast member");
  return json({ ok: true, ...summarizeCastRefs(job) }, 201);
};
const hPollCastRefs: Handler = async (_req, env, _c, p) => {
  const id = await resolveCastId(env, p.id);
  const job = await advanceCastRefsJob(env, id, p.jobId);
  if (!job) throw notFound("cast refs job");
  return json({ ok: true, ...summarizeCastRefs(job) });
};

// Cast bundle import/export (issue #324): share a whole character (portrait + refs + sources +
// LoRA + bible + voice) as one portable `.vvcast` tar between users/instances. Export is
// side-effect-free (GET is canonical so the UI can use a plain download link; POST is also
// accepted to match the issue's speced verb). Import re-keys every asset into THIS instance and
// allocates a fresh local id.
const hExportCast: Handler = async (_req, env, _c, p) => exportCastBundle(env, await resolveCastId(env, p.id));
const hImportCast: Handler = async (req, env) => {
  const buf = new Uint8Array(await req.arrayBuffer());
  return importCastBundle(env, buf);
};

// --- artifact upload + serve --------------------------------------------
// The core has the R2_RENDERS binding, so it stores/serves bytes directly -- no presign round-trip
// needed for portrait-sized images. A client (browser OR the Discord bot, which has no R2 access)
// POSTs raw image bytes to /api/upload and gets back a { key }, then registers it on a cast member
// via the existing /api/cast/:id/{portrait,ref,source} endpoints. Artifacts are served back by key
// at /api/artifact/<key> (the studio is CF Access-gated, so serving by key is safe single-tenant).
const UPLOAD_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB -- portraits/refs are ~1-3MB; this is generous headroom
const MAX_AUDIO_UPLOAD_BYTES = 32 * 1024 * 1024;
const AUDIO_UPLOAD_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};
const hStoryboardAudioUpload: Handler = async (req, env) => {
  const mime = (req.headers.get("content-type") || "").split(";")[0].trim() || "audio/mpeg";
  const ext = AUDIO_UPLOAD_EXT[mime];
  if (!ext) throw badRequest(`unsupported audio content-type ${mime || "<missing>"}`);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) throw badRequest("empty upload body");
  if (bytes.byteLength > MAX_AUDIO_UPLOAD_BYTES) throw badRequest("upload too large (max 32MB)");
  const key = `audio/${crypto.randomUUID()}.${ext}`;
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  return json({ key, mime, size: bytes.byteLength }, 201);
};
const hStoryboardCharacterRef: Handler = async (req, env) => {
  const mime = (req.headers.get("content-type") || "").split(";")[0].trim() || "application/octet-stream";
  const ext = UPLOAD_EXT[mime];
  if (!ext) throw badRequest(`unsupported content-type ${mime || "<missing>"} (png/jpeg/webp/gif only)`);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) throw badRequest("empty upload body");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw badRequest("upload too large (max 25MB)");
  const key = `character-refs/${crypto.randomUUID()}.${ext}`;
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  return json({ key, mime, size: bytes.byteLength }, 201);
};
const hUpload: Handler = async (req, env) => {
  const mime = (req.headers.get("content-type") || "").split(";")[0].trim() || "application/octet-stream";
  const ext = UPLOAD_EXT[mime];
  if (!ext) throw badRequest(`unsupported content-type ${mime || "<missing>"} (png/jpeg/webp/gif only)`);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) throw badRequest("empty upload body");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw badRequest("upload too large (max 25MB)");
  const key = `uploads/${crypto.randomUUID()}.${ext}`;
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  return json({ key, mime, bytes: bytes.byteLength }, 201);
};
// F4: the known artifact namespaces. The serve route is scoped to these so it can only ever return a
// real artifact, not an arbitrary R2 object. ADD a prefix here when a feature introduces a new one
// (a served key outside this set is rejected).
const ARTIFACT_PREFIXES = [
  "audio/", "bundles/", "cast/", "cast-clean/", "cast-gen/", "character-refs/",
  "characters/", "clips/", "loras/", "out/", "renders/", "uploads/",
];
// F4: the fixed artifact response header set. cache-control is `private, max-age=300` (private = never
// edge-cached, so an authenticated artifact never leaks into a shared cache); accept-ranges advertises
// byte-range support; nosniff stops a stored content-type being MIME-sniffed into executable script in
// the operator's authenticated origin (defense-in-depth alongside the upload mime allowlist).
function artifactHeaders(contentType: string): Headers {
  const h = new Headers();
  h.set("content-type", contentType || "application/octet-stream");
  h.set("cache-control", "private, max-age=300");
  h.set("accept-ranges", "bytes");
  h.set("x-content-type-options", "nosniff");
  return h;
}
// #416: serve an artifact with HTTP byte-range support so browsers (Safari/iOS refuse to play media
// without it; Chrome re-fetches from byte 0 on every seek) can stream and seek planner films. Handles
// GET and HEAD: a plain GET streams the full body (advertising Accept-Ranges); a ranged request returns
// 206 + Content-Range for a satisfiable range, 416 + `Content-Range: bytes */size` for an out-of-bounds
// one, and a full 200 when the Range is absent / malformed / multi-range.
const hServeArtifact: Handler = async (req, env, _c, p) => {
  const key = p.key;
  // F4: the key is the untrusted URL tail. Reject an unsafe shape (traversal/absolute/scheme/control
  // bytes) and anything outside the known artifact namespaces -> 404 (not 400) so a probe learns
  // nothing. This bounds the serve to actual artifacts even if the edge Access gate ever fails.
  if (!key || !isSafeRelKey(key) || !ARTIFACT_PREFIXES.some((pre) => key.startsWith(pre))) {
    throw notFound("artifact");
  }
  const isHead = req.method === "HEAD";
  const rangeHeader = req.headers.get("range");

  // For a HEAD or any ranged GET, resolve the object size up front via head(): an R2 get() with an
  // out-of-bounds range returns null, indistinguishable from not-found, so the range must be validated
  // against the real size before any bytes are fetched.
  if (isHead || rangeHeader) {
    const meta = await env.R2_RENDERS.head(key);
    if (!meta) throw notFound("artifact");
    const ct = meta.httpMetadata?.contentType || "application/octet-stream";
    const parsed = parseByteRange(rangeHeader, meta.size);

    if (parsed === "unsatisfiable") {
      const h = artifactHeaders(ct);
      h.set("content-range", `bytes */${meta.size}`);
      return new Response(null, { status: 416, headers: h });
    }
    if (parsed) {
      // Satisfiable single range -> 206. HEAD carries the same headers with no body.
      const h = artifactHeaders(ct);
      h.set("content-range", `bytes ${parsed.start}-${parsed.end}/${meta.size}`);
      h.set("content-length", String(parsed.length));
      if (isHead) return new Response(null, { status: 206, headers: h });
      const obj = await env.R2_RENDERS.get(key, { range: { offset: parsed.offset, length: parsed.length } });
      if (!obj) throw notFound("artifact"); // deleted between head() and get()
      return new Response(obj.body, { status: 206, headers: h });
    }
    // No range (or one we ignore) -> full 200. HEAD carries the headers with no body.
    const h = artifactHeaders(ct);
    h.set("content-length", String(meta.size));
    if (isHead) return new Response(null, { status: 200, headers: h });
    const obj = await env.R2_RENDERS.get(key);
    if (!obj) throw notFound("artifact");
    return new Response(obj.body, { status: 200, headers: h });
  }

  // Plain GET, no Range: stream the full body and advertise range support for the next seek.
  const obj = await env.R2_RENDERS.get(key);
  if (!obj) throw notFound("artifact");
  const h = artifactHeaders(obj.httpMetadata?.contentType || "application/octet-stream");
  h.set("content-length", String(obj.size));
  return new Response(obj.body, { headers: h });
};

// --- renders (library / metadata) ----------------------------------------
const hListRenders: Handler = async (req, env) => {
  const url = new URL(req.url);
  // ?project_id is now the opaque project public id; resolve to the internal int (null = unfiltered).
  const projectId = await resolveProjectRef(env, url.searchParams.get("project_id"));
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
  const renders = await listRendersForUser(env, limit, projectId);
  return json({ renders: renders.map(toPublicRenderRow) });
};
const hListTags: Handler = async (_req, env) => json({ tags: await listUserTags(env) });
const hPatchRender: Handler = async (req, env, _c, p) => {
  const id = await resolveRenderId(env, p.id);
  const b = await readBody<{ label?: string | null; lockedShots?: unknown; folderPath?: unknown; tags?: unknown }>(req);
  let ok = false;
  if ("label" in b) ok = (await setRenderLabel(env, id, b.label ?? null)) || ok;
  if ("lockedShots" in b) ok = (await setRenderLockedShots(env, id, normalizeLockedShots(b.lockedShots))) || ok;
  if ("folderPath" in b) ok = (await setRenderFolder(env, id, normalizeFolderPath(b.folderPath))) || ok;
  if ("tags" in b) ok = (await setRenderTags(env, id, normalizeTags(b.tags))) || ok;
  if (!ok) throw notFound("render");
  const updated = await getRenderByIdForUser(env, id);
  return json(updated ? toPublicRenderRow(updated) : null);
};
const hDeleteRender: Handler = async (_req, env, _c, p) => {
  if (!(await deleteRenderRow(env, await resolveRenderId(env, p.id)))) throw notFound("render");
  return json({ ok: true });
};
const hAddRenderAudio: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ audioKey?: string }>(req);
  if (!b.audioKey?.trim()) throw badRequest("audioKey required");
  const r = await muxAudioOntoRender(env, await resolveRenderId(env, p.id), b.audioKey.trim());
  if (!r.ok) return json({ error: r.error }, 422);
  return json({ ok: true, output_key: r.output_key });
};
const hAddRenderNarration: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ text?: string; module?: string; config?: Record<string, unknown> }>(req);
  if (!b.text?.trim()) throw badRequest("text required");
  const started = await startScoreBedGenerate(env, {
    kind: "narration",
    text: b.text,
    module: b.module,
    config: b.config,
  });
  if (!started.ok) return json({ error: started.error }, 422);
  // Poll inline (narration is typically shorter than music; bounded wait).
  for (let i = 0; i < 40; i++) {
    const polled = await pollScoreBedGenerate(env, started.id, started.module);
    if (polled.status === "done" && polled.output_artifact?.key) {
      const muxed = await muxAudioOntoRender(env, await resolveRenderId(env, p.id), polled.output_artifact.key);
      if (!muxed.ok) return json({ error: muxed.error }, 422);
      return json({ ok: true, output_key: muxed.output_key, module: started.module, label: started.label });
    }
    if (polled.status === "failed") return json({ error: polled.job_error || "narration failed" }, 422);
    await new Promise((res) => setTimeout(res, 3000));
  }
  return json({ error: "narration timed out; try again later" }, 504);
};

async function animatePreviewHandler(
  env: Env,
  renderId: number,
  args: Omit<import("./finalize-from-keyframes").AnimateFromPreviewArgs, "parent">,
): Promise<Response> {
  const parent = await getRenderByIdForUser(env, renderId);
  if (!parent) throw notFound("render");
  const r = await animateFromPreview(env, { parent, ...args });
  if (!r.ok) return json({ ok: false, error: r.error }, r.status ?? 400);
  return json({ ok: true, ...r.view }, 201);
}

const hFinalizePreview: Handler = async (req, env, _c, p) => {
  let audioKey: string | undefined;
  try {
    const b = await readBody<{ audioKey?: string; castLoras?: Record<string, string> }>(req);
    audioKey = b.audioKey;
  } catch { /* empty body ok */ }
  // No motionBackend: animateFromPreview ignores it for "finalized" mode and resolves the gpu
  // door from the registry by locality (the old hardcoded "own-gpu" here was dead config).
  return animatePreviewHandler(env, await resolveRenderId(env, p.id), {
    deriveMode: "finalized",
    audioKey,
  });
};

const hAnimateCloud: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ model?: string; perShot?: Record<string, string>; audioKey?: string }>(req);
  return animatePreviewHandler(env, await resolveRenderId(env, p.id), {
    deriveMode: "cloud-finalized",
    motionBackend: b.model,
    perShotModels: b.perShot,
    audioKey: b.audioKey,
  });
};

const hAnimateHybrid: Handler = async (req, env, _c, p) => {
  const b = await readBody<{
    backends?: unknown;
    defaultBackend?: "gpu" | "cloud";
    defaultCloudModel?: string;
    audioKey?: string;
  }>(req);
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const allowed = new Set(cloudMotionModules(modules).map((m) => m.name));
  const normalized = normalizeHybridBackends(b.backends, allowed);
  if (normalized.errors.length) throw badRequest(normalized.errors.join("; "));
  return animatePreviewHandler(env, await resolveRenderId(env, p.id), {
    deriveMode: "cloud-finalized",
    hybridBackends: normalized.backends,
    defaultBackend: b.defaultBackend === "cloud" ? "cloud" : "gpu",
    defaultCloudModel: b.defaultCloudModel,
    audioKey: b.audioKey,
  });
};

// --- render submission / lifecycle ---------------------------------------
const hSubmitRender: Handler = async (req, env) => {
  const b = await readBody<{
    project?: string; bundleKey?: string; qualityTier?: string;
    renderOverrides?: Record<string, unknown>; keyframesOnly?: boolean; audioKey?: string;
    processShotIds?: string[]; projectId?: unknown;
    scenes?: unknown; motion_backend?: string;
    castLoras?: Record<string, unknown>;
    film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  }>(req);
  if (!b.bundleKey) throw badRequest("bundleKey required");
  // The key is caller-supplied and becomes a storage read downstream: require the canonical
  // bundle shape (safe relative key under bundles/), the same way the artifact serve route
  // scopes its key. Enforced once here, before the value is used anywhere.
  if (!isSafeBundleKey(b.bundleKey)) throw badRequest("bundleKey must be a plain relative key under bundles/");
  const tier = coerceQualityTier(b.qualityTier) ?? "final";
  const project = b.project ?? deriveProjectFromBundleKey(b.bundleKey);

  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  if (servingForHook(modules, "keyframe").length === 0) {
    return json({ error: "no keyframe module installed (bind MODULE_KEYFRAME)" }, 503);
  }
  const scenes = filterScenesByShotIds(normalizeFilmScenes(b.scenes), b.processShotIds);
  if (!scenes.length) throw badRequest("scenes[] required (storyboard shots with prompt and duration)");
  // #500: a full render must name an EXPLICIT, serving motion.backend. The old check only verified
  // that SOME module was installed, so an omitted motion_backend silently defaulted (via pickOneForHook)
  // to serving[0] -- which can be a bound-but-non-operational module (e.g. an unseeded local door): the
  // keyframes burn, then the motion phase yields zero clips and the film dies at assemble ("no clips
  // rendered to assemble"). Resolve the explicit choice (top-level or render_overrides, NEVER the
  // serving[0] default) and bounce at the door, BEFORE any keyframe dispatch. keyframesOnly has no
  // motion leg, so it is unaffected. (The serving[0] default in pickOneForHook is unchanged, but this
  // preflight makes it unreachable for a full render.)
  if (!b.keyframesOnly) {
    const explicitMotionBackend = b.motion_backend ?? parseModuleRenderOverrides(b.renderOverrides).motion_backend;
    const motionErr = motionBackendPreflightError(modules, explicitMotionBackend);
    if (motionErr) throw badRequest(motionErr);
  }

  // FAIL HARD on any bound character whose cast LoRA is not ready, instead of letting the GPU
  // silently inline-retrain it (the ~20-min, no-signal week-long bug). A character with NO bound
  // cast LoRA is unaffected -- the gate only fires when the planner sent {slot: cast_id} bindings
  // and one resolves to a not-ready row. Ready bindings are forwarded as pretrained_loras so the GPU
  // REUSES the banked adapter (the canonical cast-page Train LoRAs flow), and cast_loras lets the
  // orchestrator bank any freshly-trained adapter back onto the cast member. Mirrors the scatter path.
  const { pretrained, castIds, skipped, skippedDetail } = await resolveCastLoras(env, b.castLoras);
  if (skipped.length) throw badRequest(untrainedCastMessage(skippedDetail));

  const mapped = mapRenderOverridesToModuleConfigs(b.renderOverrides, tier, modules);
  const motionBackend = b.keyframesOnly
    ? undefined
    : (b.motion_backend ?? mapped.motion_backend);
  const job = await startFilmJob(env, {
    project,
    bundle_key: b.bundleKey,
    scenes,
    motion_backend: motionBackend,
    keyframe_backend: mapped.keyframe_backend,
    keyframe_config: mapped.keyframe_config,
    motion_config: mapped.motion_config,
    finish_config: mapped.finish_config,
    speech_config: mapped.speech_config,
    film_finish_config: mapped.film_finish_config,
    master_config: mapped.master_config,
    keyframes_only: !!b.keyframesOnly,
    audio_key: b.keyframesOnly ? undefined : b.audioKey,
    // Opening title + end-credit card TEXT (FilmTitleSpec / FilmCreditSpec); the film.finish chain
    // reads it off the job. Mirrors hStartFilm. Skipped on a keyframes-only preview (no assembled
    // film to card), exactly like audio_key above.
    film_titles: b.keyframesOnly ? undefined : b.film_titles,
    pretrained_loras: Object.keys(pretrained).length ? pretrained : undefined,
    cast_loras: Object.keys(castIds).length ? castIds : undefined,
  });
  const view = filmJobToPollView(job, null);
  const row: NewRenderRow = {
    jobId: view.jobId,
    project,
    bundleKey: b.bundleKey,
    qualityTier: tier,
    renderOverrides: b.renderOverrides,
    status: view.status,
    mode: b.keyframesOnly ? "keyframes-only" : "full",
    projectId: await resolveProjectRef(env, b.projectId),
  };
  await insertRender(env, row);
  return json(view, 201);
};
const hRenderFromKeyframes: Handler = async (req, env) => {
  const b = await readBody<{
    project?: string; bundleKey?: string; qualityTier?: string;
    renderOverrides?: Record<string, unknown>; audioKey?: string; projectId?: unknown;
    motion_backend?: string;
  }>(req);
  if (!b.bundleKey) throw badRequest("bundleKey required");
  // Same boundary check as hSubmitRender: canonical bundle shape before any use.
  if (!isSafeBundleKey(b.bundleKey)) throw badRequest("bundleKey must be a plain relative key under bundles/");
  const project = b.project ?? deriveProjectFromBundleKey(b.bundleKey);
  const tier = coerceQualityTier(b.qualityTier) ?? "final";

  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  if (servingForHook(modules, "motion.backend").length === 0) {
    return json({ error: "no motion.backend module installed" }, 503);
  }

  const parsedScenes = await readBundleScenes(env, b.bundleKey);
  if (!parsedScenes.length) {
    return json({ error: "bundle has no storyboard scenes" }, 400);
  }
  const scenes: FilmScene[] = parsedScenes.map((s) => ({
    shot_id: s.shot_id,
    prompt: s.prompt,
    seconds: s.seconds,
  }));

  const staged = await stageBundleInjectedKeyframes(env, b.bundleKey, project);
  if (!staged.length) {
    return json({ error: "bundle has no injected keyframes (clips/<id>_keyframe.png)" }, 400);
  }

  const mapped = mapRenderOverridesToModuleConfigs(b.renderOverrides, tier, modules);
  const motionBackend = b.motion_backend ?? mapped.motion_backend ?? defaultGpuDoorModule(modules)?.name;
  if (!motionBackend) {
    return json({ error: 'no gpu-door motion.backend module (ui.locality "byo"/"local") is installed' }, 400);
  }

  const job = await startFilmFromKeyframes(env, {
    project,
    bundle_key: b.bundleKey,
    scenes,
    keyframes: staged,
    motion_backend: motionBackend,
    motion_config: mapped.motion_config,
    finish_config: mapped.finish_config,
    speech_config: mapped.speech_config,
    film_finish_config: mapped.film_finish_config,
    master_config: mapped.master_config,
    derive_mode: "finalized",
    audio_key: b.audioKey,
  });
  if (job.phase === "failed") {
    return json({ error: job.error || "render from keyframes failed" }, 422);
  }
  const view = filmJobToPollView(job, null);
  await insertRender(env, {
    jobId: view.jobId,
    project,
    bundleKey: b.bundleKey,
    qualityTier: tier,
    renderOverrides: b.renderOverrides,
    status: view.status,
    mode: "finalized",
    projectId: await resolveProjectRef(env, b.projectId),
  });
  return json(view, 201);
};
const hRegenShot: Handler = async (req, env, _c, p) => {
  const renderId = await resolveRenderId(env, p.id);
  const b = await readBody<{ shotId?: string }>(req);
  const shotId = typeof b.shotId === "string" ? b.shotId.trim() : "";
  if (!shotId) throw badRequest("shotId required");

  const row = await getRenderByIdForUser(env, renderId);
  if (!row) throw notFound("render");
  if (row.status !== "COMPLETED") throw badRequest("render must be COMPLETED");
  if (!row.bundle_key) throw badRequest("render has no bundle_key");
  // The row value was written by our own submit paths (which now enforce the shape), but it is
  // about to become a storage read: re-check on read as well, cheap belt-and-suspenders.
  if (!isSafeBundleKey(row.bundle_key)) throw badRequest("render bundle_key is not a usable bundles/ key");

  const scenes = await readBundleScenes(env, row.bundle_key);
  const scene = scenes.find((s) => s.shot_id === shotId);
  if (!scene) throw badRequest(`shot ${shotId} not in bundle storyboard`);

  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  if (servingForHook(modules, "keyframe").length === 0) {
    return json({ ok: false, error: "no keyframe module installed (bind MODULE_KEYFRAME)" }, 503);
  }
  const tier = coerceQualityTier(row.quality_tier) ?? "final";
  const mapped = mapRenderOverridesToModuleConfigs(row.render_overrides, tier, modules);

  const job = await startFilmJob(env, {
    project: row.project,
    bundle_key: row.bundle_key,
    scenes: [{ shot_id: scene.shot_id, prompt: scene.prompt, seconds: scene.seconds }],
    keyframe_backend: mapped.keyframe_backend,
    keyframe_config: mapped.keyframe_config,
    keyframes_only: true,
  });
  if (job.phase === "failed") {
    return json({ ok: false, error: job.error || "regen submit failed" }, 422);
  }
  const view = filmJobToPollView(job, null);
  return json({ ok: true, jobId: view.jobId, status: view.status });
};
const hPollRender: Handler = async (_req, env, ctx, p) => {
  if (isScatterJobId(p.jobId)) {
    const view = await advanceScatterJob(env, p.jobId, ctx);
    if (!view) throw notFound("render job");
    return json(view);
  }
  if (!isFilmJobId(p.jobId)) {
    return json({ error: "unknown or legacy render job id (film-* or scatter-* only)", jobId: p.jobId }, 404);
  }
  const r = await advanceFilmJob(env, p.jobId);
  if (!r) throw notFound("render job");
  const kfDone = r.job.phase === "keyframe" && r.job.keyframe_job_id
    ? await readKeyframeDone(env, r.job.project, r.job.keyframe_job_id)
    : undefined; // #318: keyframe sub-progress from the GPU job's snapshot (best-effort)
  const view = filmJobToPollView(r.job, r.clipJob, kfDone);
  await updateRenderFromView(env, view, ctx);
  if (
    r.job.derive_mode === "cloud-finalized"
    && r.clipJob
    && r.job.phase !== "done"
    && r.job.phase !== "failed"
    && !r.job.cancelled
  ) {
    const modules = await discoverModules(env as unknown as Record<string, unknown>);
    const gpuDoors = new Set(gpuDoorMotionModules(modules).map((m) => m.name));
    const prog = clipAnimateProgress(r.clipJob, gpuDoors);
    if (prog.gpu.total > 0 && prog.cloud.total > 0) {
      await setHybridProgress(env, p.jobId, { gpu: prog.gpu, cloud: prog.cloud });
    } else if (prog.cloud.total > 0) {
      await setCloudAnimateProgress(env, p.jobId, prog.done, prog.total);
    }
  }
  return json(view);
};
const hCancelRender: Handler = async (_req, env, _c, p) => {
  if (isScatterJobId(p.jobId)) {
    const view = await cancelScatterJob(env, p.jobId);
    if (!view) throw notFound("render job");
    await updateRenderFromView(env, view);
    return json(view);
  }
  if (!isFilmJobId(p.jobId)) {
    return json({ error: "unknown or legacy render job id (film-* or scatter-* only)", jobId: p.jobId }, 404);
  }
  const job = await cancelFilmJob(env, p.jobId);
  if (!job) throw notFound("render job");
  const view = filmJobToPollView(job, null);
  await updateRenderFromView(env, view);
  return json(view);
};
const hScatterRender: Handler = async (req, env) => {
  const b = await readBody<{
    project?: string; bundleKey?: string; qualityTier?: string;
    shotIds?: string[]; shardCount?: number; castLoras?: Record<string, unknown>;
    renderOverrides?: Record<string, unknown>; audioKey?: string; projectId?: unknown;
    motion_backend?: string;
    film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  }>(req);
  if (!b.bundleKey) throw badRequest("bundleKey required");
  // Same boundary check as hSubmitRender: canonical bundle shape before any use.
  if (!isSafeBundleKey(b.bundleKey)) throw badRequest("bundleKey must be a plain relative key under bundles/");
  if (!Array.isArray(b.shotIds) || b.shotIds.length < 2) throw badRequest("shotIds[] required (>= 2)");
  const shardCount = typeof b.shardCount === "number" ? b.shardCount : 2;
  const project = b.project ?? deriveProjectFromBundleKey(b.bundleKey);
  const tier = coerceQualityTier(b.qualityTier) ?? "final";
  try {
    const job = await startScatterRender(env, {
      project,
      bundle_key: b.bundleKey,
      quality_tier: tier,
      shot_ids: b.shotIds,
      shard_count: shardCount,
      cast_loras: b.castLoras ?? {},
      render_overrides: b.renderOverrides,
      motion_backend: b.motion_backend,
      audio_key: b.audioKey,
      film_titles: b.film_titles,
        project_id: await resolveProjectRef(env, b.projectId),
    });
    const view = scatterJobToPollView(job);
    return json({ ok: true, jobId: view.jobId, status: view.status }, 201);
  } catch (e) {
    const msg = (e as Error).message || "scatter submit failed";
    return json({ ok: false, error: msg }, 422);
  }
};
const hTrainCastLora: Handler = async (req, env, _c, p) =>
  handleCastTrainLora(req, env, await resolveCastId(env, p.id));
const hCastLoraStatus: Handler = async (_req, env, _c, p) =>
  handleCastLoraStatus(env, await resolveCastId(env, p.id));
const hAdoptRender: Handler = async (req, env) =>
  handleAdoptRender(req, env);

// --- validation ----------------------------------------------------------
// Pre-render preflight. The client (planner.js `runPreflight`) POSTs the
// envelope { storyboard, castBindings?, bundleKey?, audioKey? } and expects a
// PreflightResult { ok, counts, issues[] } (see ./preflight): it renders the
// issues, shows the counts, and gates the bundle button on counts.error.
//
// Two things this handler must get right (both were wrong before #242):
//   1. Unwrap `.storyboard` from the envelope. The previous code validated the
//      whole body, so `validateStoryboard` read `.title`/`.scenes` off the
//      wrapper (undefined) and 400'd on every valid storyboard.
//   2. A storyboard with problems is DATA, not an HTTP failure -- return 200
//      with `ok:false` + the issues so the client renders them. The previous
//      code returned 400, which made the client `throw` and show only
//      "HTTP 400" with no reasons (and never reach its own gate). Reserve
//      non-2xx for a genuinely malformed request (handled by readBody's 400).
const hPreflight: Handler = async (req, env) => {
  const body = await readBody<unknown>(req);
  const envelope = (body && typeof body === "object") ? (body as Record<string, unknown>) : {};

  // Hard shape gate first: title + scenes structure. Surface its errors as
  // preflight issues so the panel shows the actual reasons.
  const validated = validateStoryboard(envelope.storyboard);
  if (!validated.ok) {
    const issues: PreflightIssue[] = validated.errors.map((message) => ({
      level: "error" as const, scope: "storyboard", message,
    }));
    return json(summarize(issues), 200);
  }

  // Shape is valid -> run the semantic + cast-readiness checks.
  const issues: PreflightIssue[] = [...checkStoryboardShape(validated.value)];
  const bindings = (envelope.castBindings && typeof envelope.castBindings === "object")
    ? (envelope.castBindings as Record<string, number>)
    : null;
  // Only touch D1 when there are bindings to check.
  if (bindings && Object.keys(bindings).length > 0) {
    // #454: project the keyframe-stage backend label from the registry (the ui.order-first keyframe
    // module that declares one), so the cast-readiness message names the real backend instead of a
    // hardcoded "SDXL". No declaration -> the pure-function "SDXL" default covers it.
    const kfModules = servingForHook(
      await discoverModules(env as unknown as Record<string, unknown>, { cacheTtlMs: 60_000 }),
      "keyframe",
    );
    const keyframeLabel =
      kfModules.map((m) => m.keyframe_label).find((l) => typeof l === "string" && l.trim()) || "SDXL";
    issues.push(...checkCastBindingsReady(bindings, await listCast(env), keyframeLabel));
  }
  return json(summarize(issues), 200);
};

// --- authoring: planning / yaml / markers / bundle / audio ----------------
const hPlan: Handler = async (req, env) => {
  const a = await readBody<PlanStoryboardArgs>(req);
  if (!a.brief || !a.model) throw badRequest("brief and model required");
  // v0.165.0 (#143): a new project sends no characters field; default to []
  // so buildPlanningUserMessage does not throw "characters is not iterable".
  if (!Array.isArray(a.characters)) a.characters = [];
  const r = await planStoryboard(env, a);
  return json(r, r.ok ? 200 : 422);
};
const hRefine: Handler = async (req, env) => {
  const a = await readBody<RefineStoryboardArgs>(req);
  if (a.storyboard === undefined || !a.message || !a.model) throw badRequest("storyboard, message, model required");
  const r = await refineStoryboard(env, a);
  return json(r, r.ok ? 200 : 422);
};
const hChat: Handler = async (req, env) => {
  const a = await readBody<ChatCompleteArgs & ChatImageArgs>(req);
  if (!a.model || !a.user_input) throw badRequest("model and user_input required");
  const modelEntry = findModel(a.model);
  if (modelEntry?.type === "image") {
    const r = await chatImage(env, a);
    if (!r.ok) return json({ error: r.error, model: r.model }, 502);
    return json({
      model: r.model,
      model_type: "image",
      output: r.output,
      output_artifact: r.output_artifact,
      latency_ms: r.latency_ms,
      ai_gateway_log_id: r.ai_gateway_log_id,
    });
  }
  const r = await chatComplete(env, a);
  if (!r.ok) return json({ error: r.error, model: r.model }, 422);
  return json({ output: r.output, model: r.model, logId: r.logId });
};
const hScoreBedGenerate: Handler = async (req, env) => {
  const a = await readBody<{
    kind?: "music" | "narration";
    prompt?: string;
    text?: string;
    module?: string;
    storyboard?: PlanEnhanceStoryboard;
    seconds?: number;
    config?: Record<string, unknown>;
  }>(req);
  if (a.kind === "narration") {
    if (!a.text?.trim() && !a.storyboard) throw badRequest("text or storyboard required");
  } else if (!a.prompt?.trim()) {
    throw badRequest("prompt required");
  }
  const r = await startScoreBedGenerate(env, {
    kind: a.kind === "narration" ? "narration" : "music",
    prompt: a.prompt,
    text: a.text,
    module: a.module,
    storyboard: a.storyboard,
    seconds: a.seconds,
    config: a.config,
  });
  if (!r.ok) return json({ error: r.error }, 422);
  return json({ status: r.status, id: r.id, module: r.module, label: r.label });
};
const hPollScoreBed: Handler = async (req, env, _c, p) => {
  const module = new URL(req.url).searchParams.get("module")?.trim() || "";
  if (!module) throw badRequest("module query param required");
  return json(await pollScoreBedGenerate(env, p.id, module));
};

// --- module-host: run the plan.enhance chain over a storyboard (invoke-from-core). The core does
// not know who answers: it discovers the installed modules and folds the plan.enhance chain. With
// no module installed the storyboard returns unchanged (applied empty) -- a lean studio still works.
// --- module-host: resolve the render pipeline from the installed registry + the user's selection
// (render-flow dispatch, core half). Returns which module serves each render hook with its clamped
// config; EXECUTION of those hooks is the backend's job. Null/empty when nothing is installed.
const hRenderPlan: Handler = async (req, env) => {
  const a = await readBody<{ selection?: RenderPipelineSelection }>(req);
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  return json({ ok: true, plan: resolveRenderPipeline(modules, a.selection ?? {}) });
};

// --- render-execution: orchestrate the motion.backend module per shot (async run/poll, across
// requests). POST starts the job + submits each shot; GET advances it (polls the pending shots).
const hStartClips: Handler = async (req, env) => {
  const a = await readBody<{ project?: string; shots?: ClipShotInput[]; motion_backend?: string; config?: Record<string, unknown> }>(req);
  if (!Array.isArray(a.shots) || a.shots.length === 0) throw badRequest("shots[] required");
  const job = await startClipJob(env, { project: a.project ?? "clips", shots: a.shots, motion_backend: a.motion_backend, config: a.config });
  return json({
    ok: true, job_id: job.job_id, motion_backend: job.motion_backend, ...summarizeJob(job),
    shots: job.shots.map((sh) => ({ shot_id: sh.shot_id, status: sh.status, error: sh.error })),
  });
};
const hPollClips: Handler = async (_req, env, _c, p) => {
  const job = await advanceClipJob(env, p.id);
  if (!job) throw notFound("clip job");
  return json({
    ok: true, job_id: job.job_id, motion_backend: job.motion_backend, ...summarizeJob(job),
    shots: job.shots.map((sh) => ({ shot_id: sh.shot_id, status: sh.status, clip_key: sh.clip_key, error: sh.error })),
  });
};

// Film orchestrator: the keyframe -> clip handoff. POST starts it (runs the keyframe module), GET
// advances it across the keyframe -> clips phases. See film-orchestrator.ts.
/** Attach a presigned download URL to a film summary once the film is assembled (phase "done").
 *  film_key lives in the private R2 render bucket; a presigned GET (24h) lets a caller without CF
 *  Access (e.g. the Slate Discord bot posting into a channel) fetch/share the mp4 directly, with no
 *  size limit and no extra API surface. Absent until the film is done. */
async function withFilmDownloadUrl(env: Env, summary: FilmSummary): Promise<FilmSummary & { download_url?: string }> {
  if (summary.phase === "done" && summary.film_key) {
    return { ...summary, download_url: await presignR2Get(env, summary.film_key, FILM_DOWNLOAD_TTL_SECONDS) };
  }
  return summary;
}
const hStartFilm: Handler = async (req, env) => {
  const a = await readBody<{ project?: string; bundle_key?: string; scenes?: FilmScene[]; motion_backend?: string; keyframe_backend?: string; keyframe_config?: Record<string, unknown>; motion_config?: Record<string, unknown>; finish_config?: Record<string, Record<string, unknown>>; speech_config?: Record<string, Record<string, unknown>>; film_finish_config?: Record<string, Record<string, unknown>>; master_config?: Record<string, Record<string, unknown>>; audio_key?: string; film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } }; dialogue_lines?: DialogueLine[]; cast_loras?: Record<string, string> }>(req);
  if (!a.bundle_key) throw badRequest("bundle_key required");
  // Same boundary check as hSubmitRender: canonical bundle shape before any use.
  if (!isSafeBundleKey(a.bundle_key)) throw badRequest("bundle_key must be a plain relative key under bundles/");
  if (!Array.isArray(a.scenes) || a.scenes.length === 0) throw badRequest("scenes[] required");

  // Bundle-only voicing (#313): when the caller passed NO explicit dialogue_lines, derive them from the
  // bundle storyboard's per-shot dialogue (round-tripped by #307), resolving each speaking slot's voice
  // from the cast (cast_loras) when given and defaulting otherwise. So a hand-authored dialogue bundle
  // with no D1 project and no dialogue_lines arg still renders VOICED. Explicit lines always win; a
  // bundle with no dialogue stays silent (derived lines are []).
  // S9 (F13): resolve the planner castLoras ({ slot: <opaque cast public id> }) to the INTERNAL cast
  // ids ONCE, at this boundary. The int castIds map is what the film job persists (the keyframe LoRA
  // bank-back keys off it); the per-slot voices ride the same resolve for bundle-derived dialogue. A
  // browser never hands the internal int across the wire, and never gets it back.
  const resolvedLoras = (a.cast_loras && Object.keys(a.cast_loras).length)
    ? await resolveCastLoras(env, a.cast_loras)
    : null;
  const castIds = resolvedLoras && Object.keys(resolvedLoras.castIds).length ? resolvedLoras.castIds : undefined;

  let dialogue_lines = a.dialogue_lines;
  if (!dialogue_lines || !dialogue_lines.length) {
    const bundleScenes = await readBundleScenes(env, a.bundle_key);
    if (bundleScenes.some((s) => s.dialogue)) {
      dialogue_lines = dialogueLinesFromBundleScenes(bundleScenes, resolvedLoras?.voices ?? {});
    }
  }
  // project is optional; default it from the bundle key (mirrors hSubmitRender) so a caller that
  // only has a bundle (e.g. the Slate bot) lands in the same project namespace the monolith uses.
  const project = a.project ?? deriveProjectFromBundleKey(a.bundle_key);
  const job = await startFilmJob(env, {
    project, bundle_key: a.bundle_key, scenes: a.scenes,
    motion_backend: a.motion_backend, keyframe_backend: a.keyframe_backend, keyframe_config: a.keyframe_config, motion_config: a.motion_config,
    // audio_key: a staged bed (score-bed music/narration) to mux after assemble. startFilmJob runs it
    // through resolveStagedAudioKey; without forwarding it here the mux phase is skipped and the film is
    // silent even when the caller supplied a bed (the scored/narrated render path).
    finish_config: a.finish_config, speech_config: a.speech_config, film_finish_config: a.film_finish_config, master_config: a.master_config, audio_key: a.audio_key, film_titles: a.film_titles,
    // dialogue_lines (#296 explicit arg, #313 bundle-derived): the per-shot lines for the dialogue/
    // TTS+lip-sync stage (enterDialogueOrFinish) and the subtitle module (buildCaptionCues), both of
    // which read job.dialogue_lines. cast_loras carries the speaking cast (slot -> cast id) so the
    // LoRA write-back + voice resolution have it.
    dialogue_lines, cast_loras: castIds,
  });
  // Write a renders-table row so this film shows in the history panel (#164), the same way
  // hSubmitRender / hRenderFromKeyframes already do for the storyboard render path. hPollFilm
  // keeps the row's status in sync as the job advances.
  await insertRender(env, filmRowFromJob(job));
  return json({ ok: true, ...(await withFilmDownloadUrl(env, summarizeFilm(job, null))) }, 201);
};
const hPollFilm: Handler = async (_req, env, ctx, p) => {
  const r = await advanceFilmJob(env, p.id);
  if (!r) throw notFound("film job");
  // Insert-if-missing (ON CONFLICT(job_id) DO NOTHING) so a film started before history
  // unification -- or via a path that did not insert -- still surfaces in history on its next
  // poll/sweep tick; then sync the live status/output exactly like hPollRender (#164).
  await insertRender(env, filmRowFromJob(r.job));
  // #318: during the keyframe phase, fold the GPU job's live keyframe_done tally into the poll view so
  // the bar/ETA subdivide the keyframe band (instead of pinning scene_index=1). Best-effort.
  const kfDone = r.job.phase === "keyframe" && r.job.keyframe_job_id
    ? await readKeyframeDone(env, r.job.project, r.job.keyframe_job_id)
    : undefined;
  await updateRenderFromView(env, filmJobToPollView(r.job, r.clipJob, kfDone), ctx);
  return json({ ok: true, ...(await withFilmDownloadUrl(env, summarizeFilm(r.job, r.clipJob))) });
};

const hEnhance: Handler = async (req, env) => {
  const a = await readBody<{
    storyboard?: PlanEnhanceStoryboard;
    brief?: string;
    project?: string;
    config?: Record<string, unknown>;
  }>(req);
  if (!a.storyboard || !Array.isArray(a.storyboard.scenes)) {
    throw badRequest("storyboard with scenes required");
  }
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const seed: PlanEnhanceInput = { storyboard: a.storyboard, brief: a.brief };
  const result = await dispatchChain<PlanEnhanceInput, PlanEnhanceOutput>(
    envRec,
    modules,
    "plan.enhance",
    seed,
    { project: a.project || "enhance", job_id: crypto.randomUUID() },
    {
      nextInput: (prev) => ({ storyboard: prev.storyboard, brief: a.brief }),
      configFor: () => a.config,
    },
  );
  return json({
    ok: true,
    storyboard: result.output?.storyboard ?? a.storyboard,
    applied: result.applied,
    errors: result.errors,
    notes: result.output?.notes ?? [],
  });
};
const hModels: Handler = async () => json({ models: PLANNING_MODELS });
const hYaml: Handler = async (req) => {
  const a = await readBody<{ storyboard?: StoryboardValidated }>(req);
  if (!a.storyboard) throw badRequest("storyboard required");
  // The planner fetches this and reads { ok, yaml } as JSON (yaml preview + auto-direct refresh).
  // Returning raw text/yaml made the client's resp.json() throw "unexpected keyword at line 1".
  return json({ ok: true, yaml: serializeStoryboardYaml(a.storyboard) });
};
const hMarkers: Handler = async (req) => {
  const a = await readBody<{ storyboard?: unknown; format?: MarkersFormat; fps?: number }>(req);
  if (!a.storyboard || !a.format) throw badRequest("storyboard and format required");
  const out = emitMarkers(a.storyboard as Parameters<typeof emitMarkers>[0], a.format, a.fps);
  return new Response(out.body, {
    headers: { "content-type": out.contentType, "content-disposition": "attachment; filename=\"" + out.filename + "\"" },
  });
};
const hBundle: Handler = async (req, env) => {
  const a = await readBody<AssembleBundleArgs>(req);
  if (!a.storyboard || !a.characterRefs) throw badRequest("storyboard and characterRefs required");
  const r = await assembleBundle(env, a);
  return json(r, r.ok ? 201 : 400);
};
const hAudioAnalyze: Handler = async (req, env) => {
  const a = await readBody<AudioAnalyzeRequest & { module?: string }>(req);
  if (!a.audioKey) throw badRequest("audioKey required");
  const result = await analyzeAudioBeats(env, a, a.module?.trim() || undefined);
  if (!result.ok) return json({ ok: false, error: result.error }, 502);
  return json({ ok: true, output: result.plan, module: result.module });
};

// --- misc planner endpoints ----------------------------------------------
const hWhoami: Handler = async () => json({ user: "studio" });
const hGetPrefs: Handler = async (req, env) => {
  const prefs = await getUserPrefs(env);
  return json({ ok: true, prefs });
};
const hPatchPrefs: Handler = async (req, env) => {
  const body = await readBody<Record<string, unknown>>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a prefs object");
  const prefs = await setUserPrefs(env, body);
  return json({ ok: true, prefs });
};

// --- operator install-config (per-module, instance-scoped; backs config_schema scope:"install") ----
// GET/PATCH the operator-set-once config for one module (e.g. notify-email's notify_email). The
// VALUE lives only here, never on the unauthenticated /api/modules projection; only the schema marker
// crosses there. Render-scope / unknown keys are rejected by the store's install-subschema clamp.
async function resolveModuleByName(env: Env, name: string) {
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  return modules.find((m) => m.name === name) ?? null;
}
const hGetModuleConfig: Handler = async (_req, env, _ctx, p) => {
  const mod = await resolveModuleByName(env, p.name);
  if (!mod) throw notFound("module");
  if (!hasInstallConfig(mod.config_schema)) throw notFound("module has no install-scope config");
  const config = await loadInstallConfig(env, mod.name, mod.config_schema);
  return json({ ok: true, module: mod.name, config });
};
const hPatchModuleConfig: Handler = async (req, env, _ctx, p) => {
  const mod = await resolveModuleByName(env, p.name);
  if (!mod) throw notFound("module");
  if (!hasInstallConfig(mod.config_schema)) throw notFound("module has no install-scope config");
  const body = await readBody<Record<string, unknown>>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a config object");
  const config = await setInstallConfig(env, mod.name, mod.config_schema, body);
  return json({ ok: true, module: mod.name, config });
};

// --- WfP dispatch: module install / admin (docs/module-dispatch.md 4.4) ------------------------------
// Operator-gated by CF Access (every /api/* request is, F2): these routes install / uninstall / disable
// / list modules that live as user Workers in the `vivijure-modules` dispatch namespace -- WITHOUT a
// core redeploy. The install CLI (scripts/install-module.ts) uploads the user Worker into the namespace
// (the WfP upload API, holding the scoped install token), then calls POST /api/modules/install here; the
// core runs conformance against the just-uploaded, RESIDENT script (reached through MODULE_DISPATCH) and
// INSERTs the registry row ONLY on a green suite. A resident-but-failing module is never installed and
// never dispatched. Gate SCOPE (see runLiveConformance): it proves the contract WIRING -- manifest +
// invoke/degrade envelope + (for a synchronous hook) typed output. It does NOT re-run an ASYNC hook's
// typed output (that would trigger the module's real GPU work at install); that stays the module's own
// conformance CI.
const hListInstalledModules: Handler = async (_req, env) => {
  return json({ ok: true, modules: await listInstalledModules(env) });
};
const hInstallModule: Handler = async (req, env) => {
  if (!env.MODULE_DISPATCH) throw badRequest("dispatch is not enabled on this host (no MODULE_DISPATCH namespace bound)");
  const body = await readBody<{ script_name?: string }>(req);
  const script = typeof body?.script_name === "string" ? body.script_name.trim() : "";
  if (!script) throw badRequest("script_name required");
  let fetcher: Fetcher;
  try {
    fetcher = env.MODULE_DISPATCH.get(script);
  } catch (e) {
    throw badRequest(`script "${script}" is not resident in the namespace: ${(e as Error).message}`);
  }
  // Capture the exact manifest that gets gated + stored (so the row never drifts from what passed).
  let manifestText: string;
  try {
    const res = await fetcher.fetch("https://module/module.json");
    if (!res.ok) throw badRequest(`GET /module.json -> ${res.status}`);
    manifestText = await res.text();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest(`module unreachable: ${(e as Error).message}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(manifestText); } catch { throw badRequest("module.json is not valid JSON"); }
  const manifest = validateManifest(raw);
  if (typeof manifest === "string") return json({ ok: false, error: `invalid manifest: ${manifest}` }, 422);
  // The conformance gate: run the live suite over the SAME dispatch transport it will serve on.
  const checks = await runLiveConformance(fetcher);
  if (!allPass(checks)) return json({ ok: false, error: "conformance failed", checks: failures(checks) }, 422);
  await installModuleRow(env, {
    name: manifest.name,
    script_name: script,
    manifest_json: manifestText,
    api: manifest.api,
    installed_at: Date.now(),
  });
  return json({ ok: true, module: manifest.name, script_name: script, checks }, 201);
};
const hUninstallModule: Handler = async (_req, env, _ctx, p) => {
  // Row FIRST (the next request stops dispatching it); the CLI evicts the resident script from the
  // namespace AFTER, so an in-flight /poll is not torn out from under it (section 4.4).
  const removed = await uninstallModuleRow(env, p.name);
  if (!removed) throw notFound("module not installed");
  return json({ ok: true, module: p.name, removed: true });
};
const hSetModuleEnabled: Handler = async (req, env, _ctx, p) => {
  const body = await readBody<{ enabled?: unknown }>(req);
  if (typeof body?.enabled !== "boolean") throw badRequest("body needs a boolean `enabled`");
  const matched = await setModuleEnabled(env, p.name, body.enabled);
  if (!matched) throw notFound("module not installed");
  return json({ ok: true, module: p.name, enabled: body.enabled });
};

// --- route table ---------------------------------------------------------
const API_ROUTES: Route[] = [
  { method: "GET",    pattern: "/api/storyboard/projects",                        handler: hListProjects },
  { method: "POST",   pattern: "/api/storyboard/projects",                        handler: hCreateProject },
  { method: "GET",    pattern: "/api/storyboard/projects/:id",                    handler: hGetProject },
  { method: "PATCH",  pattern: "/api/storyboard/projects/:id",                    handler: hPatchProject },
  { method: "POST",   pattern: "/api/storyboard/projects/:id/storyboard",         handler: hSaveProjectStoryboard },
  { method: "DELETE", pattern: "/api/storyboard/projects/:id",                    handler: hDeleteProject },
  { method: "GET",    pattern: "/api/voices",                          handler: hListVoices },
  { method: "GET",    pattern: "/api/cast",                            handler: hListCast },
  { method: "POST",   pattern: "/api/cast",                            handler: hCreateCast },
  { method: "GET",    pattern: "/api/cast/export/:id",                 handler: hExportCast },
  { method: "POST",   pattern: "/api/cast/export/:id",                 handler: hExportCast },
  { method: "POST",   pattern: "/api/cast/import",                     handler: hImportCast },
  { method: "GET",    pattern: "/api/cast/:id",                        handler: hGetCast },
  { method: "PATCH",  pattern: "/api/cast/:id",                        handler: hPatchCast },
  { method: "DELETE", pattern: "/api/cast/:id",                        handler: hDeleteCast },
  { method: "POST",   pattern: "/api/cast/:id/portrait",               handler: hSetPortrait },
  { method: "DELETE", pattern: "/api/cast/:id/portrait",               handler: hClearPortrait },
  { method: "POST",   pattern: "/api/cast/:id/ref",                    handler: hAddRef },
  { method: "DELETE", pattern: "/api/cast/:id/ref",                    handler: hRemoveRef },
  { method: "DELETE", pattern: "/api/cast/:id/refs/*refKey",           handler: hRemoveRef },
  { method: "POST",   pattern: "/api/cast/:id/source",                 handler: hAddSource },
  { method: "DELETE", pattern: "/api/cast/:id/source",                 handler: hRemoveSource },
  { method: "DELETE", pattern: "/api/cast/:id/source/*sourceKey",      handler: hRemoveSource },
  { method: "POST",   pattern: "/api/cast/:id/generate-refs",          handler: hGenerateCastRefs },
  { method: "GET",    pattern: "/api/cast/:id/refs-job/:jobId",        handler: hPollCastRefs },
  { method: "POST",   pattern: "/api/cast/:id/train-lora",             handler: hTrainCastLora },
  { method: "GET",    pattern: "/api/cast/:id/lora-status",            handler: hCastLoraStatus },
  { method: "POST",   pattern: "/api/upload",                          handler: hUpload },
  { method: "GET",    pattern: "/api/artifact/*key",                   handler: hServeArtifact },
  { method: "HEAD",   pattern: "/api/artifact/*key",                   handler: hServeArtifact },
  { method: "POST",   pattern: "/api/storyboard/preflight",            handler: hPreflight },
  { method: "POST",   pattern: "/api/storyboard/plan",                 handler: hPlan },
  { method: "POST",   pattern: "/api/storyboard/refine",               handler: hRefine },
  { method: "POST",   pattern: "/api/chat",                            handler: hChat },
  { method: "POST",   pattern: "/api/storyboard/score-bed",            handler: hScoreBedGenerate },
  { method: "POST",   pattern: "/api/storyboard/music-generate",       handler: hScoreBedGenerate },
  { method: "GET",    pattern: "/api/job/:id",                         handler: hPollScoreBed },
  { method: "POST",   pattern: "/api/storyboard/enhance",              handler: hEnhance },
  { method: "GET",    pattern: "/api/storyboard/models",               handler: hModels },
  { method: "POST",   pattern: "/api/storyboard/yaml",                 handler: hYaml },
  { method: "POST",   pattern: "/api/storyboard/markers",              handler: hMarkers },
  { method: "POST",   pattern: "/api/storyboard/bundle",               handler: hBundle },
  { method: "POST",   pattern: "/api/storyboard/audio-upload",         handler: hStoryboardAudioUpload },
  { method: "POST",   pattern: "/api/storyboard/character-ref",        handler: hStoryboardCharacterRef },
  { method: "POST",   pattern: "/api/audio/analyze",                   handler: hAudioAnalyze },
  { method: "POST",   pattern: "/api/storyboard/render",               handler: hSubmitRender },
  { method: "POST",   pattern: "/api/storyboard/render-plan",          handler: hRenderPlan },
  { method: "POST",   pattern: "/api/render/clips",                     handler: hStartClips },
  { method: "GET",    pattern: "/api/render/clips/:id",                 handler: hPollClips },
  { method: "POST",   pattern: "/api/render/film",                      handler: hStartFilm },
  { method: "GET",    pattern: "/api/render/film/:id",                  handler: hPollFilm },
  { method: "POST",   pattern: "/api/storyboard/renders/:id/regen-shot", handler: hRegenShot },
  { method: "POST",   pattern: "/api/storyboard/render/scatter",       handler: hScatterRender },
  { method: "POST",   pattern: "/api/storyboard/render-from-keyframes", handler: hRenderFromKeyframes },
  { method: "GET",    pattern: "/api/storyboard/render/:jobId",        handler: hPollRender },
  { method: "DELETE", pattern: "/api/storyboard/render/:jobId",        handler: hCancelRender },
  { method: "GET",    pattern: "/api/storyboard/renders",              handler: hListRenders },
  { method: "GET",    pattern: "/api/storyboard/renders/tags",         handler: hListTags },
  { method: "PATCH",  pattern: "/api/storyboard/renders/:id",          handler: hPatchRender },
  { method: "DELETE", pattern: "/api/storyboard/renders/:id",          handler: hDeleteRender },
  { method: "POST",   pattern: "/api/storyboard/renders/:id/add-audio", handler: hAddRenderAudio },
  { method: "POST",   pattern: "/api/storyboard/renders/:id/add-narration", handler: hAddRenderNarration },
  { method: "POST",   pattern: "/api/storyboard/renders/:id/finalize", handler: hFinalizePreview },
  { method: "POST",   pattern: "/api/storyboard/renders/:id/animate-cloud", handler: hAnimateCloud },
  { method: "POST",   pattern: "/api/storyboard/renders/:id/animate-hybrid", handler: hAnimateHybrid },
  { method: "POST",   pattern: "/api/storyboard/renders/adopt",        handler: hAdoptRender },
  { method: "GET",    pattern: "/api/whoami",                          handler: hWhoami },
  { method: "GET",    pattern: "/api/prefs",                           handler: hGetPrefs },
  { method: "PATCH",  pattern: "/api/prefs",                           handler: hPatchPrefs },
  { method: "GET",    pattern: "/api/modules/installed",              handler: hListInstalledModules },
  { method: "POST",   pattern: "/api/modules/install",                handler: hInstallModule },
  { method: "DELETE", pattern: "/api/modules/install/:name",          handler: hUninstallModule },
  { method: "PATCH",  pattern: "/api/modules/install/:name",          handler: hSetModuleEnabled },
  { method: "GET",    pattern: "/api/modules/:name/config",            handler: hGetModuleConfig },
  { method: "PATCH",  pattern: "/api/modules/:name/config",            handler: hPatchModuleConfig },
];

// Pretty studio page paths (vivijure.skyphusion.org/planner, /cast, /modules). Served
// from public/*.html so nav works even before a deploy picks up new worker code.
// /welcome is the public marketing landing page (welcome.html); it is the only path here
// meant to be reachable without CF Access (it gets a public Access bypass on the /welcome
// prefix), so it carries no studio data and links into the gated app rather than embedding it.
const STUDIO_PAGE_ASSETS: Record<string, string> = {
  // index.html was a byte-identical copy of modules.html (removed in the 2026-07 truth pass);
  // the modules/pipeline page IS the landing page, served from the single source file.
  "/": "/modules.html",
  "/index.html": "/modules.html",
  "/welcome": "/welcome.html",
  "/welcome/": "/welcome.html",
  "/planner": "/planner.html",
  "/planner/": "/planner.html",
  "/cast": "/cast.html",
  "/cast/": "/cast.html",
  "/modules": "/modules.html",
  "/modules/": "/modules.html",
  "/settings": "/settings.html",
  "/settings/": "/settings.html",
};

function serveStudioAsset(env: Env, request: Request, url: URL, assetPath: string): Promise<Response> {
  return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
}

export default {
  // Single security-header chokepoint: EVERY response routeRequest returns is stamped with the right
  // headers for its class (CF's zone-wide managed transform is off; the worker owns headers, #370).
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return applyResponseSecurity(await routeRequest(request, env, ctx), request, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepUnresolvedJobs(env, ctx));
  },
};

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "vivijure-studio", phase: 1 });
    // F2/#423: fail-CLOSED auth for the whole data plane. /health (above) + static pages/assets
    // (below) stay open; every /api/* request must pass the AUTH_MODE gate -- the studio bearer
    // token (token mode) or a valid Access JWT (access mode / legacy unset). The dev opt-out
    // stays ALLOW_UNAUTHENTICATED, legacy path only. See src/auth-gate.ts.
    if (url.pathname.startsWith("/api/")) {
      const gate = await gateApi(request, env);
      if (!gate.ok) return json({ error: gate.reason }, gate.status);
    }
    if (url.pathname === "/api/modules" && request.method === "GET") {
      // Cache discovery for 60s per isolate so a refresh storm does not re-fetch every module's
      // manifest each request (issue #17 follow-up). Only this route opts in; dispatch stays fresh.
      const modules = await discoverModules(env as unknown as Record<string, unknown>, { cacheTtlMs: 60_000 });
      // Advertise the host's transport capability (the CORE describing itself, orthogonal to the module
      // `api` version): `dispatch` is true when this deploy binds the WfP namespace, so an operator /
      // the studio UI can tell an install-without-redeploy host from a service-binding-only one.
      return json(modulesResponse(modules, renderConfigProjection(), { dispatch: !!env.MODULE_DISPATCH }));
    }
    const studioPage = STUDIO_PAGE_ASSETS[url.pathname];
    if (studioPage && (request.method === "GET" || request.method === "HEAD")) {
      return serveStudioAsset(env, request, url, studioPage);
    }
    // F3 + S4 + S9(F7): rate-limit the GPU/spend routes (denial-of-wallet) and enforce the optional
    // daily submission ceiling. Default posture fails CLOSED on a BROKEN check (unbound/throwing
    // limiter -> 503 deny); a healthy limiter is unaffected. SPEND_LIMIT_FAIL_CLOSED="false" opts
    // back to fail-open. An explicit over-limit/over-ceiling verdict is a 429 with Retry-After.
    // See src/rate-limit.ts.
    if (isSpendRoute(request.method, url.pathname)) {
      const rl = await enforceSpendLimit(request, env);
      if (!rl.ok) {
        const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
        if (rl.retryAfter !== undefined) headers["retry-after"] = String(rl.retryAfter);
        return new Response(JSON.stringify({ error: rl.message }), { status: rl.status, headers });
      }
    }
    const hit = match(API_ROUTES, request.method, url.pathname);
    if (hit) {
      try {
        return await hit.handler(request, env, ctx, hit.params);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error("router error", url.pathname, e);
        return json({ error: "internal error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
}
