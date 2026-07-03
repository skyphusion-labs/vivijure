// R2 (S3-compatible) SigV4 query presigning (v0.107.0).
//
// Mints short-lived presigned GET/PUT URLs so a Cloudflare Container (which
// has no R2 binding) can fetch a source object and PUT a result directly over
// the public S3 endpoint, keeping credentials on the Worker. Shared by the
// audio beat-sync and image-prep containers.
//
// Requires four env values: R2_S3_ACCESS_KEY_ID + R2_S3_SECRET_ACCESS_KEY
// (secrets, from an R2 API token with Object Read+Write on the bucket),
// R2_S3_ENDPOINT (https://<accountid>.r2.cloudflarestorage.com) and
// R2_S3_BUCKET (the R2_RENDERS bucket name). Region is always "auto" for R2.

import type { Env } from "./env";
import { isPresignSafeKey } from "./shared";
import { secretValue } from "./secret-store";

const ENC = new TextEncoder();

// S3/R2 caps a presigned URL's lifetime at 7 days; clamp the caller's request into [1, 604800]s so a
// bad or hostile value can never sign a longer-lived (or malformed) URL. (security #6)
const MAX_EXPIRES_SECONDS = 604800;
function clampExpires(seconds: number): number {
  const n = Math.floor(Number(seconds));
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_EXPIRES_SECONDS, Math.max(1, n));
}

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", ENC.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, ENC.encode(data));
}

// RFC3986 percent-encoding. S3 canonical form encodes everything except the
// unreserved set; slashes in an object key are NOT encoded (encodeSlash=false),
// but slashes inside query values (e.g. the credential scope) ARE.
export function uriEncode(str: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of str) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      for (const byte of ENC.encode(ch)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

export type PresignMethod = "GET" | "PUT";

export interface R2PresignConfig {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string; // https://<accountid>.r2.cloudflarestorage.com
  bucket: string;
}

async function configFromEnv(env: Env): Promise<R2PresignConfig> {
  const accessKeyId = await secretValue(env.R2_S3_ACCESS_KEY_ID);
  const secretAccessKey = await secretValue(env.R2_S3_SECRET_ACCESS_KEY);
  const endpoint = env.R2_S3_ENDPOINT;
  const bucket = env.R2_S3_BUCKET;
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error(
      "R2 presign needs R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_S3_BUCKET",
    );
  }
  return { accessKeyId, secretAccessKey, endpoint, bucket };
}

// SigV4 query-string presign. `nowMs` is injectable for deterministic tests;
// defaults to the request-time clock.
export async function presignR2WithConfig(
  cfg: R2PresignConfig,
  method: PresignMethod,
  key: string,
  expiresSeconds = 300,
  nowMs?: number,
): Promise<string> {
  // Reject an unsafe key BEFORE signing: a "..", an absolute "/...", a "://" scheme, or control/
  // non-ASCII bytes must never be minted into a credentialed URL. Benign specials (space, "#") are
  // still allowed and uriEncode'd below. (security #6)
  if (!isPresignSafeKey(key)) {
    throw new Error("R2 presign: refusing to sign an unsafe object key");
  }
  expiresSeconds = clampExpires(expiresSeconds);

  const url = new URL(cfg.endpoint);
  const host = url.host;
  const region = "auto";
  const service = "s3";

  const now = new Date(nowMs ?? Date.now());
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const canonicalUri = "/" + uriEncode(cfg.bucket, true) + "/" + uriEncode(key, false);

  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(q)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(q[k], true)}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(ENC.encode("AWS4" + cfg.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return `${cfg.endpoint.replace(/\/$/, "")}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// F8: lifetime of a user-facing FILM DOWNLOAD link (the presigned GET emailed in the render-
// complete notification + returned in the poll summary). 6h covers same-day email reading while
// cutting the leaked-link window 4x vs the old 24h; the film persists in R2, so re-opening the
// render in the studio re-presigns a fresh link on expiry.
export const FILM_DOWNLOAD_TTL_SECONDS = 6 * 60 * 60; // 6h

export function presignR2Get(env: Env, key: string, expiresSeconds = 300): Promise<string> {
  return configFromEnv(env).then((cfg) => presignR2WithConfig(cfg, "GET", key, expiresSeconds));
}

export function presignR2Put(env: Env, key: string, expiresSeconds = 300): Promise<string> {
  return configFromEnv(env).then((cfg) => presignR2WithConfig(cfg, "PUT", key, expiresSeconds));
}
