// Cast portrait / ref / source uploads: binary, staged keys, or chat-artifact copy.

import type { Env } from "./env";
import {
  getCastById,
  setPortrait,
  addRef,
  removeRef,
  addSource,
  removeSource,
} from "./cast-db";
import type { CastMember } from "./cast-db";
import { toPublicCast } from "./cast-db";
import { extFromMime } from "./utils";

export const CAST_IMAGE_MIME_RE = /^image\/(png|jpe?g|webp)$/i;
export const CAST_MAX_BYTES = 16 * 1024 * 1024;

class HttpError extends Error {
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

function wrap(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((e) => {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    throw e;
  });
}

/** Copy a chat-side artifact (env.R2) into R2_RENDERS under destPrefix.<ext>. */
export async function copyChatArtifactToRenders(
  env: Env,
  srcKey: string,
  destPrefix: string,
): Promise<{ key: string; mime: string }> {
  const obj = await env.R2.get(srcKey);
  if (!obj) throw new HttpError(404, `source artifact not found: ${srcKey}`);
  const mime = obj.httpMetadata?.contentType || "image/png";
  if (!CAST_IMAGE_MIME_RE.test(mime)) {
    throw new HttpError(400, `source mime ${mime} not allowed (png/jpeg/webp only)`);
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.length > CAST_MAX_BYTES) {
    throw new HttpError(413, "source image too large (16 MB max)");
  }
  const key = `${destPrefix}.${extFromMime(mime)}`;
  await env.R2_RENDERS.put(key, bytes, {
    httpMetadata: { contentType: mime },
  });
  return { key, mime };
}

export async function handleCastPortraitUpload(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  return wrap(async () => {
    const cur = await getCastById(env, id);
    if (!cur) throw new HttpError(404, "cast not found");

    const contentType = (request.headers.get("content-type") || "").toLowerCase();

    if (contentType.startsWith("application/json")) {
      let body: { key?: string; mime?: string; from_chat_artifact?: unknown };
      try {
        body = await request.json();
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }

      if (typeof body.from_chat_artifact === "string" && body.from_chat_artifact) {
        if (cur.portrait_key) {
          try { await env.R2_RENDERS.delete(cur.portrait_key); } catch { /* ignore */ }
        }
        const { key, mime } = await copyChatArtifactToRenders(
          env,
          body.from_chat_artifact,
          `cast/${id}/portrait`,
        );
        const row = await setPortrait(env, id, key, mime);
        return json({ cast: row ? toPublicCast(row) : null });
      }

      if (!body.key || !body.mime) throw new HttpError(400, "key and mime required");
      const row = await setPortrait(env, id, body.key, body.mime);
      if (!row) throw new HttpError(404, "cast not found");
      return json({ cast: row ? toPublicCast(row) : null });
    }

    if (!CAST_IMAGE_MIME_RE.test(contentType)) {
      throw new HttpError(
        400,
        `content-type must be image/png, image/jpeg, or image/webp (got ${contentType || "<missing>"})`,
      );
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, "empty body");
    if (buf.byteLength > CAST_MAX_BYTES) throw new HttpError(413, "image too large (16 MB max)");
    if (cur.portrait_key) {
      try { await env.R2_RENDERS.delete(cur.portrait_key); } catch { /* ignore */ }
    }
    const key = `cast/${id}/portrait.${extFromMime(contentType)}`;
    await env.R2_RENDERS.put(key, new Uint8Array(buf), {
      httpMetadata: { contentType },
    });
    const row = await setPortrait(env, id, key, contentType);
    return json({ cast: row ? toPublicCast(row) : null });
  });
}

export async function handleCastRefAdd(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  return wrap(async () => {
    const cur = await getCastById(env, id);
    if (!cur) throw new HttpError(404, "cast not found");

    const contentType = (request.headers.get("content-type") || "").toLowerCase();

    if (contentType.startsWith("application/json")) {
      let body: { key?: string; mime?: string; from_chat_artifact?: unknown };
      try {
        body = await request.json();
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }

      if (typeof body.from_chat_artifact === "string" && body.from_chat_artifact) {
        const { key, mime } = await copyChatArtifactToRenders(
          env,
          body.from_chat_artifact,
          `cast/${id}/refs/${crypto.randomUUID()}`,
        );
        const row = await addRef(env, id, { key, mime });
        return json({ cast: row ? toPublicCast(row) : null });
      }

      if (!body.key || !body.mime) throw new HttpError(400, "key and mime required");
      const row = await addRef(env, id, { key: body.key, mime: body.mime });
      if (!row) throw new HttpError(404, "cast not found");
      return json({ cast: row ? toPublicCast(row) : null });
    }

    if (!CAST_IMAGE_MIME_RE.test(contentType)) {
      throw new HttpError(400, "content-type must be image/png, image/jpeg, or image/webp");
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, "empty body");
    if (buf.byteLength > CAST_MAX_BYTES) throw new HttpError(413, "image too large (16 MB max)");
    const key = `cast/${id}/refs/${crypto.randomUUID()}.${extFromMime(contentType)}`;
    await env.R2_RENDERS.put(key, new Uint8Array(buf), {
      httpMetadata: { contentType },
    });
    const row = await addRef(env, id, { key, mime: contentType });
    return json({ cast: row ? toPublicCast(row) : null });
  });
}

export async function handleCastRefRemove(
  env: Env,
  id: number,
  refKey: string,
): Promise<Response> {
  const result = await removeRef(env, id, refKey);
  if (!result.row) return json({ error: "cast not found" }, 404);
  if (!result.removedKey) return json({ error: "ref key not in this cast member's set" }, 404);
  try { await env.R2_RENDERS.delete(result.removedKey); } catch { /* ignore */ }
  return json({ cast: result.row ? toPublicCast(result.row) : null });
}

export async function handleCastSourceAdd(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  return wrap(async () => {
    const cur = await getCastById(env, id);
    if (!cur) throw new HttpError(404, "cast not found");

    const contentType = (request.headers.get("content-type") || "").toLowerCase();

    if (contentType.startsWith("application/json")) {
      let body: { key?: string; mime?: string; from_chat_artifact?: unknown };
      try {
        body = await request.json();
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }

      if (typeof body.from_chat_artifact === "string" && body.from_chat_artifact) {
        const { key, mime } = await copyChatArtifactToRenders(
          env,
          body.from_chat_artifact,
          `cast/${id}/sources/${crypto.randomUUID()}`,
        );
        const row = await addSource(env, id, { key, mime });
        return json({ cast: row ? toPublicCast(row) : null });
      }

      if (!body.key || !body.mime) throw new HttpError(400, "key and mime required");
      const row = await addSource(env, id, { key: body.key, mime: body.mime });
      if (!row) throw new HttpError(404, "cast not found");
      return json({ cast: row ? toPublicCast(row) : null });
    }

    if (!CAST_IMAGE_MIME_RE.test(contentType)) {
      throw new HttpError(400, "content-type must be image/png, image/jpeg, or image/webp");
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, "empty body");
    if (buf.byteLength > CAST_MAX_BYTES) throw new HttpError(413, "image too large (16 MB max)");
    const key = `cast/${id}/sources/${crypto.randomUUID()}.${extFromMime(contentType)}`;
    await env.R2_RENDERS.put(key, new Uint8Array(buf), {
      httpMetadata: { contentType },
    });
    const row = await addSource(env, id, { key, mime: contentType });
    return json({ cast: row ? toPublicCast(row) : null });
  });
}

export async function handleCastSourceRemove(
  env: Env,
  id: number,
  srcKey: string,
): Promise<Response> {
  const result = await removeSource(env, id, srcKey);
  if (!result.row) return json({ error: "cast not found" }, 404);
  if (!result.removedKey) return json({ error: "source key not in this cast member's set" }, 404);
  try { await env.R2_RENDERS.delete(result.removedKey); } catch { /* ignore */ }
  return json({ cast: result.row ? toPublicCast(result.row) : null });
}

// Issue #298: deleting a cast member must reclaim ALL of its R2 artifacts, not just the D1 row.
// Mirrors the per-key best-effort delete the portrait/ref/source handlers already use. Collects the
// portrait, every ref (the LoRA training set), every source (raw uploads), and the trained lora_key,
// then issues one delete per key. Each delete is best-effort: an already-absent key is not a failure
// (R2 delete is idempotent), and one transient miss must not abort the rest of the cleanup.
export async function deleteCastArtifacts(env: Env, cast: CastMember): Promise<void> {
  const keys = [
    cast.portrait_key,
    ...cast.ref_keys.map((r) => r.key),
    ...cast.source_keys.map((s) => s.key),
    cast.lora_key,
  ].filter((k): k is string => typeof k === "string" && k.length > 0);
  for (const key of keys) {
    try { await env.R2_RENDERS.delete(key); } catch { /* ignore: best-effort GC */ }
  }
}
