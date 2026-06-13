// Vivijure studio core: the module host + render API router (Phase 1, epic #25 / PR 2a).
//
// Wires the render / library / cast / project surface (modules present in this repo). The
// planning/authoring/bundle/beat routes (plan, yaml, markers, bundle, audio-upload, models) are NOT
// here -- their modules are still in the playground (PR 2b / Stage 1.5). A few routes that need
// scatter.ts's ScatterArgs or train-lora orchestration are marked TODO and return 501 for now.

import { discoverModules, modulesResponse } from "./modules/registry";
import { getUserEmail } from "./shared";
import type { Env } from "./env";

import {
  listProjectsForUser, getProjectById, createProject, updateProjectMeta, setLastStoryboard, deleteProject,
} from "./storyboard-projects-db";
import {
  listCastForUser, getCastById, createCast, updateCast, deleteCast,
  setPortrait, clearPortrait, addRef, removeRef, addSource, removeSource,
} from "./cast-db";
import {
  insertRender, updateRenderFromView, getRenderByIdForUser, listRendersForUser, listUserTags,
  setRenderLabel, setRenderLockedShots, setRenderFolder, setRenderTags, deleteRenderRow,
  normalizeProjectIdInput, normalizeLockedShots, normalizeFolderPath, normalizeTags,
  type NewRenderRow,
} from "./renders-db";
import {
  submitRenderJob, submitFinalizeJob, pollRenderJob, cancelRenderJob,
  coerceQualityTier, deriveProjectFromBundleKey, parseAudioBeatPlan,
  type RenderSubmitArgs, type FinalizeArgs, type AudioAnalyzeRequest,
} from "./runpod-submit";
import { validateStoryboard, type StoryboardValidated } from "./storyboard-validate";
// authoring (PR 2b)
import { planStoryboard, refineStoryboard, type PlanStoryboardArgs, type RefineStoryboardArgs } from "./planner";
import { PLANNING_MODELS } from "./planner-catalog";
import { serializeStoryboardYaml } from "./planner-yaml";
import { emitMarkers, type MarkersFormat } from "./markers";
import { assembleBundle, type AssembleBundleArgs } from "./bundle-assembler";
import { presignR2Get } from "./r2-presign";

// Container DOs -- exported so the runtime registers them (bound in wrangler.toml).
export { AudioBeatSyncContainer } from "./containers/audio-beat-sync";
export { ImagePrepContainer } from "./containers/image-prep";
export { VideoFinishContainer } from "./containers/video-finish";

// Local JSON response helper -- status as a plain number (shared.ts's json takes a ResponseInit).
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// --- error model ---------------------------------------------------------
class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
const badRequest = (m: string) => new HttpError(400, m);
const notFound = (m = "not found") => new HttpError(404, m);
const idParam = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest("invalid id");
  return n;
};
async function readBody<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw badRequest("invalid JSON body"); }
}

// --- routing -------------------------------------------------------------
type Handler = (req: Request, env: Env, ctx: ExecutionContext, p: Record<string, string>) => Promise<Response>;
interface Route { method: string; pattern: string; handler: Handler; }

function match(routes: Route[], method: string, pathname: string) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const pp = r.pattern.split("/"), sp = pathname.split("/");
    if (pp.length !== sp.length) continue;
    const p: Record<string, string> = {}; let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i][0] === ":") p[pp[i].slice(1)] = decodeURIComponent(sp[i]);
      else if (pp[i] !== sp[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params: p };
  }
  return null;
}

// --- projects ------------------------------------------------------------
const hListProjects: Handler = async (req, env) => json(await listProjectsForUser(env, getUserEmail(req)));
const hCreateProject: Handler = async (req, env) => {
  const b = await readBody<{ name?: string; prefs?: Record<string, unknown> }>(req);
  if (!b.name) throw badRequest("name required");
  return json(await createProject(env, getUserEmail(req), { name: b.name, prefs: b.prefs }), 201);
};
const hGetProject: Handler = async (req, env, _c, p) => {
  const row = await getProjectById(env, idParam(p.id), getUserEmail(req));
  if (!row) throw notFound("project");
  return json(row);
};
const hPatchProject: Handler = async (req, env, _c, p) => {
  const id = idParam(p.id), email = getUserEmail(req);
  const b = await readBody<{ name?: string; prefs?: Record<string, unknown>; storyboard?: unknown }>(req);
  const row = b.storyboard !== undefined
    ? await setLastStoryboard(env, id, email, b.storyboard)
    : await updateProjectMeta(env, id, email, { name: b.name, prefs: b.prefs });
  if (!row) throw notFound("project");
  return json(row);
};
const hDeleteProject: Handler = async (req, env, _c, p) => {
  const row = await deleteProject(env, idParam(p.id), getUserEmail(req));
  if (!row) throw notFound("project");
  return json({ ok: true, deleted: row.id });
};

// --- cast ----------------------------------------------------------------
const hListCast: Handler = async (req, env) => json(await listCastForUser(env, getUserEmail(req)));
const hCreateCast: Handler = async (req, env) => {
  const b = await readBody<{ name?: string; bible?: string | null }>(req);
  if (!b.name) throw badRequest("name required");
  return json(await createCast(env, getUserEmail(req), { name: b.name, bible: b.bible }), 201);
};
const hGetCast: Handler = async (req, env, _c, p) => {
  const row = await getCastById(env, idParam(p.id), getUserEmail(req));
  if (!row) throw notFound("cast member");
  return json(row);
};
const hPatchCast: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ name?: string; bible?: string | null }>(req);
  const row = await updateCast(env, idParam(p.id), getUserEmail(req), b);
  if (!row) throw notFound("cast member");
  return json(row);
};
const hDeleteCast: Handler = async (req, env, _c, p) => {
  const row = await deleteCast(env, idParam(p.id), getUserEmail(req));
  if (!row) throw notFound("cast member");
  return json({ ok: true, deleted: row.id });
};
// portrait / ref / source accept an already-uploaded R2 key + mime (client presigns the PUT
// separately via r2-presign). TODO(typecheck): confirm CastRefImage field names.
const hSetPortrait: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ key?: string; mime?: string }>(req);
  if (!b.key || !b.mime) throw badRequest("key and mime required");
  const row = await setPortrait(env, idParam(p.id), getUserEmail(req), b.key, b.mime);
  if (!row) throw notFound("cast member");
  return json(row);
};
const hClearPortrait: Handler = async (req, env, _c, p) => {
  const row = await clearPortrait(env, idParam(p.id), getUserEmail(req));
  if (!row) throw notFound("cast member");
  return json(row);
};
const hAddRef: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ key?: string; mime?: string }>(req);
  if (!b.key || !b.mime) throw badRequest("key and mime required");
  const row = await addRef(env, idParam(p.id), getUserEmail(req), { key: b.key, mime: b.mime });
  if (!row) throw notFound("cast member");
  return json(row);
};
const hRemoveRef: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ key?: string }>(req);
  if (!b.key) throw badRequest("key required");
  const res = await removeRef(env, idParam(p.id), getUserEmail(req), b.key);
  if (!res.row) throw notFound("cast member or ref");
  return json(res.row);
};
const hAddSource: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ key?: string; mime?: string }>(req);
  if (!b.key || !b.mime) throw badRequest("key and mime required");
  const row = await addSource(env, idParam(p.id), getUserEmail(req), { key: b.key, mime: b.mime });
  if (!row) throw notFound("cast member");
  return json(row);
};
const hRemoveSource: Handler = async (req, env, _c, p) => {
  const b = await readBody<{ key?: string }>(req);
  if (!b.key) throw badRequest("key required");
  const res = await removeSource(env, idParam(p.id), getUserEmail(req), b.key);
  if (!res.row) throw notFound("cast member or source");
  return json(res.row);
};

// --- renders (library / metadata) ----------------------------------------
const hListRenders: Handler = async (req, env) => {
  const email = getUserEmail(req);
  const projectId = normalizeProjectIdInput(new URL(req.url).searchParams.get("project_id"));
  return json(await listRendersForUser(env, email, 100, projectId));
};
const hListTags: Handler = async (req, env) => json(await listUserTags(env, getUserEmail(req)));
const hPatchRender: Handler = async (req, env, _c, p) => {
  const id = idParam(p.id), email = getUserEmail(req);
  const b = await readBody<{ label?: string | null; lockedShots?: unknown; folderPath?: unknown; tags?: unknown }>(req);
  let ok = false;
  if ("label" in b) ok = (await setRenderLabel(env, id, email, b.label ?? null)) || ok;
  if ("lockedShots" in b) ok = (await setRenderLockedShots(env, id, email, normalizeLockedShots(b.lockedShots))) || ok;
  if ("folderPath" in b) ok = (await setRenderFolder(env, id, email, normalizeFolderPath(b.folderPath))) || ok;
  if ("tags" in b) ok = (await setRenderTags(env, id, email, normalizeTags(b.tags))) || ok;
  if (!ok) throw notFound("render");
  return json(await getRenderByIdForUser(env, id, email));
};
const hDeleteRender: Handler = async (req, env, _c, p) => {
  if (!(await deleteRenderRow(env, idParam(p.id), getUserEmail(req)))) throw notFound("render");
  return json({ ok: true });
};

// --- render submission / lifecycle ---------------------------------------
const hSubmitRender: Handler = async (req, env) => {
  const email = getUserEmail(req);
  const b = await readBody<{
    project?: string; bundleKey?: string; qualityTier?: string;
    renderOverrides?: Record<string, unknown>; keyframesOnly?: boolean; audioKey?: string;
    pretrainedLoras?: Record<string, string>; processShotIds?: string[]; projectId?: unknown;
  }>(req);
  if (!b.bundleKey) throw badRequest("bundleKey required");
  const args: RenderSubmitArgs = {
    bundleKey: b.bundleKey, project: b.project, qualityTier: coerceQualityTier(b.qualityTier),
    renderOverrides: b.renderOverrides, keyframesOnly: b.keyframesOnly, audioKey: b.audioKey,
    pretrainedLoras: b.pretrainedLoras, processShotIds: b.processShotIds, userEmail: email,
  };
  const r = await submitRenderJob(env, args);
  if (!r.ok) return json({ error: r.error }, r.status ?? 502);
  const row: NewRenderRow = {
    userEmail: email, jobId: r.view.jobId,
    project: args.project ?? deriveProjectFromBundleKey(args.bundleKey),
    bundleKey: args.bundleKey, qualityTier: args.qualityTier ?? "final",
    renderOverrides: args.renderOverrides, status: r.view.status,
    mode: args.keyframesOnly ? "keyframes-only" : "full",
    projectId: normalizeProjectIdInput(b.projectId),
  };
  await insertRender(env, row);
  return json(r.view, 201);
};
const hFinalizeRender: Handler = async (req, env) => {
  const email = getUserEmail(req);
  const b = await readBody<{
    project?: string; bundleKey?: string; qualityTier?: string;
    renderOverrides?: Record<string, unknown>; processShotIds?: string[]; audioKey?: string;
    pretrainedLoras?: Record<string, string>; parentId?: number | null; projectId?: unknown;
  }>(req);
  if (!b.project || !b.bundleKey) throw badRequest("project and bundleKey required");
  const args: FinalizeArgs = {
    project: b.project, bundleKey: b.bundleKey, qualityTier: coerceQualityTier(b.qualityTier),
    renderOverrides: b.renderOverrides, processShotIds: b.processShotIds, audioKey: b.audioKey,
    pretrainedLoras: b.pretrainedLoras, userEmail: email,
  };
  const r = await submitFinalizeJob(env, args);
  if (!r.ok) return json({ error: r.error }, r.status ?? 502);
  await insertRender(env, {
    userEmail: email, jobId: r.view.jobId, project: b.project, bundleKey: b.bundleKey,
    qualityTier: args.qualityTier ?? "final", renderOverrides: args.renderOverrides,
    status: r.view.status, projectId: normalizeProjectIdInput(b.projectId), parentId: b.parentId ?? null,
  });
  return json(r.view, 201);
};
const hPollRender: Handler = async (_req, env, _c, p) => {
  const r = await pollRenderJob(env, p.jobId);
  if (!r.ok) return json({ error: r.error }, r.status ?? 502);
  await updateRenderFromView(env, r.view);
  return json(r.view);
};
const hCancelRender: Handler = async (_req, env, _c, p) => {
  const r = await cancelRenderJob(env, p.jobId);
  if (!r.ok) return json({ error: r.error }, r.status ?? 502);
  return json(r.view);
};
// TODO(PR 2a, needs scatter.ts ScatterArgs + parent/child row orchestration):
const hScatterRender: Handler = async () => json({ error: "scatter wiring TODO" }, 501);
// TODO(PR 2a): cast LoRA train (submitTrainLoraJob + setLoraJob) and renders/adopt.
const hTodo: Handler = async () => json({ error: "TODO" }, 501);

// --- validation ----------------------------------------------------------
const hPreflight: Handler = async (req) => {
  const result = validateStoryboard(await readBody<unknown>(req));
  const okFlag = (result as { ok?: boolean }).ok;
  return json(result, okFlag === false ? 400 : 200);
};

// --- authoring: planning / yaml / markers / bundle / audio (PR 2b) -------
const hPlan: Handler = async (req, env) => {
  const a = await readBody<PlanStoryboardArgs>(req);
  if (!a.brief || !a.model) throw badRequest("brief and model required");
  const r = await planStoryboard(env, a);
  return json(r, r.ok ? 200 : 422);
};
const hRefine: Handler = async (req, env) => {
  const a = await readBody<RefineStoryboardArgs>(req);
  if (a.storyboard === undefined || !a.message || !a.model) throw badRequest("storyboard, message, model required");
  const r = await refineStoryboard(env, a);
  return json(r, r.ok ? 200 : 422);
};
const hModels: Handler = async () => json(PLANNING_MODELS);
const hYaml: Handler = async (req) => {
  const a = await readBody<{ storyboard?: StoryboardValidated }>(req);
  if (!a.storyboard) throw badRequest("storyboard required");
  return new Response(serializeStoryboardYaml(a.storyboard), {
    headers: { "content-type": "text/yaml; charset=utf-8", "content-disposition": "attachment; filename=\"storyboard.yaml\"" },
  });
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
const hAudioUpload: Handler = async (req, env) => {
  const a = await readBody<AudioAnalyzeRequest>(req);
  if (!a.audioKey) throw badRequest("audioKey required");
  const audioUrl = await presignR2Get(env, a.audioKey, 300);
  const stub = env.AUDIO_BEAT_SYNC.get(env.AUDIO_BEAT_SYNC.idFromName("singleton"));
  const resp = await stub.fetch("https://container/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioUrl, clipSeconds: a.clipSeconds, mode: a.mode, minSceneS: a.minSceneS, maxSceneS: a.maxSceneS, forceShots: a.forceShots }),
  });
  const plan = parseAudioBeatPlan(await resp.json());
  if (!plan) return json({ error: "beat-sync container returned an unrecognized plan" }, 502);
  return json(plan);
};

// --- misc planner endpoints ----------------------------------------------
const hWhoami: Handler = async (req) => json({ email: getUserEmail(req) });
// user-prefs.ts not migrated yet -- stub so the planner falls back to defaults (follow-up).
const hGetPrefs: Handler = async () => json({});
const hPutPrefs: Handler = async () => json({ ok: true });

// --- route table (PR 2a) -------------------------------------------------
const API_ROUTES: Route[] = [
  { method: "GET",    pattern: "/api/storyboard/projects",                        handler: hListProjects },
  { method: "POST",   pattern: "/api/storyboard/projects",                        handler: hCreateProject },
  { method: "GET",    pattern: "/api/storyboard/projects/:id",                    handler: hGetProject },
  { method: "PATCH",  pattern: "/api/storyboard/projects/:id",                    handler: hPatchProject },
  { method: "DELETE", pattern: "/api/storyboard/projects/:id",                    handler: hDeleteProject },
  { method: "GET",    pattern: "/api/cast",                            handler: hListCast },
  { method: "POST",   pattern: "/api/cast",                            handler: hCreateCast },
  { method: "GET",    pattern: "/api/cast/:id",                        handler: hGetCast },
  { method: "PATCH",  pattern: "/api/cast/:id",                        handler: hPatchCast },
  { method: "DELETE", pattern: "/api/cast/:id",                        handler: hDeleteCast },
  { method: "POST",   pattern: "/api/cast/:id/portrait",               handler: hSetPortrait },
  { method: "DELETE", pattern: "/api/cast/:id/portrait",               handler: hClearPortrait },
  { method: "POST",   pattern: "/api/cast/:id/ref",                    handler: hAddRef },
  { method: "DELETE", pattern: "/api/cast/:id/ref",                    handler: hRemoveRef },
  { method: "POST",   pattern: "/api/cast/:id/source",                 handler: hAddSource },
  { method: "DELETE", pattern: "/api/cast/:id/source",                 handler: hRemoveSource },
  { method: "POST",   pattern: "/api/cast/:id/lora",                   handler: hTodo },
  { method: "POST",   pattern: "/api/storyboard/preflight",            handler: hPreflight },
  { method: "POST",   pattern: "/api/storyboard/plan",                 handler: hPlan },
  { method: "POST",   pattern: "/api/storyboard/refine",               handler: hRefine },
  { method: "GET",    pattern: "/api/storyboard/models",               handler: hModels },
  { method: "POST",   pattern: "/api/storyboard/yaml",                 handler: hYaml },
  { method: "POST",   pattern: "/api/storyboard/markers",              handler: hMarkers },
  { method: "POST",   pattern: "/api/storyboard/bundle",               handler: hBundle },
  { method: "POST",   pattern: "/api/audio/analyze",                   handler: hAudioUpload },
  { method: "POST",   pattern: "/api/storyboard/render",               handler: hSubmitRender },
  { method: "POST",   pattern: "/api/storyboard/render/scatter",       handler: hScatterRender },
  { method: "POST",   pattern: "/api/storyboard/render-from-keyframes", handler: hFinalizeRender },
  { method: "GET",    pattern: "/api/storyboard/render/:jobId",        handler: hPollRender },
  { method: "DELETE", pattern: "/api/storyboard/render/:jobId",        handler: hCancelRender },
  { method: "GET",    pattern: "/api/storyboard/renders",              handler: hListRenders },
  { method: "GET",    pattern: "/api/storyboard/renders/tags",         handler: hListTags },
  { method: "PATCH",  pattern: "/api/storyboard/renders/:id",          handler: hPatchRender },
  { method: "DELETE", pattern: "/api/storyboard/renders/:id",          handler: hDeleteRender },
  { method: "POST",   pattern: "/api/storyboard/renders/adopt",        handler: hTodo },
  { method: "GET",    pattern: "/api/whoami",                          handler: hWhoami },
  { method: "GET",    pattern: "/api/prefs",                           handler: hGetPrefs },
  { method: "PUT",    pattern: "/api/prefs",                           handler: hPutPrefs },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "vivijure-studio", phase: 1 });
    if (url.pathname === "/api/modules" && request.method === "GET") {
      const modules = await discoverModules(env as unknown as Record<string, unknown>);
      return json(modulesResponse(modules));
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
  },
};
