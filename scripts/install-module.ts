// install-module: the operator CLI that installs a Vivijure module into the Workers-for-Platforms
// dispatch namespace WITHOUT a core redeploy (docs/module-dispatch.md section 4). Reproducible,
// no-dashboard onboarding (the IaC doctrine): it is the one command an operator runs to add a module.
//
// Flow (matches the onboarding sequence diagram, section 4.1):
//   1. Upload the user Worker into the `vivijure-modules` dispatch namespace (CF WfP upload API), with
//      its backend secrets bound to THAT script (per-module creds -- the core never holds them).
//   2. Ask the core to install it: POST {core}/api/modules/install { script_name }. The core reaches the
//      just-uploaded, RESIDENT script through the dispatch binding, runs conformance, and INSERTs the
//      registry row ONLY on a green suite.
//   3. On conformance FAIL: roll back -- DELETE the resident script so nothing is half-installed -- and
//      report the failing checks. On PASS: the module is live on the next request, no core redeploy.
//
// This talks to real Cloudflare + the core; it is exercised end-to-end only once the namespace exists
// (a Phase 2 / operator step, gated on Conrad). Nothing here runs at deploy or in CI.
//
// Run:
//   node scripts/install-module.ts \
//     --script motion-foo --code ./dist/index.js --hook-name motion-foo \
//     --secrets ./motion-foo.env --core https://vivijure.skyphusion.org \
//     --namespace vivijure-modules --compat-date 2024-11-01
//
// Auth (env, never flags -- no secret on argv):
//   CLOUDFLARE_ACCOUNT_ID          the account that owns the namespace
//   CLOUDFLARE_API_TOKEN           a WfP-scoped token (Workers Scripts:Edit) for the upload/delete
//   CF_ACCESS_CLIENT_ID / _SECRET  the CF Access service token for the core admin route (if the core is
//                                  Access-gated, which production is)

import { readFileSync } from "node:fs";
import { basename } from "node:path";

// Node globals used below (fetch/FormData/Blob) are provided by the Node 18+ runtime; declare them
// locally so tsconfig.scripts.json (types: ["node"]) type-checks without pulling DOM libs.
declare const fetch: (input: string, init?: unknown) => Promise<{
  ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown>;
}>;
declare const FormData: { new (): { append(name: string, value: unknown, filename?: string): void } };
declare const Blob: { new (parts: unknown[], opts?: { type?: string }): unknown };
declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code?: number): never };

interface Args {
  script: string;
  code: string;
  secrets?: string;
  core: string;
  namespace: string;
  compatDate: string;
  name?: string;
}

function parseArgs(argv: string[]): Args {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith("--")) fail(`unexpected argument "${k}"`);
    m.set(k.slice(2), argv[i + 1] ?? "");
  }
  const req = (k: string): string => {
    const v = m.get(k);
    if (!v) fail(`missing required --${k}`);
    return v as string;
  };
  return {
    script: req("script"),
    code: req("code"),
    core: req("core").replace(/\/+$/, ""),
    secrets: m.get("secrets"),
    namespace: m.get("namespace") ?? "vivijure-modules",
    compatDate: m.get("compat-date") ?? "2024-11-01",
    name: m.get("name"),
  };
}

function fail(msg: string): never {
  console.error(`install-module: ${msg}`);
  process.exit(1);
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) fail(`missing env ${k}`);
  return v as string;
}

/** Parse a dotenv-style secrets file (KEY=VALUE per line, # comments) into WfP secret_text bindings.
 *  These bind to the UPLOADED user Worker, never the core (bounded blast radius, section 4.2). */
function secretBindings(path: string | undefined): { type: "secret_text"; name: string; text: string }[] {
  if (!path) return [];
  const out: { type: "secret_text"; name: string; text: string }[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out.push({ type: "secret_text", name: line.slice(0, eq).trim(), text: line.slice(eq + 1).trim() });
  }
  return out;
}

const CF_API = "https://api.cloudflare.com/client/v4";

/** PUT the user Worker into the dispatch namespace (WfP upload API). Multipart: a metadata part naming
 *  the ESM entrypoint + the secret bindings, and the module file itself. */
async function uploadScript(args: Args, accountId: string, token: string): Promise<void> {
  const code = readFileSync(args.code, "utf8");
  const mainModule = basename(args.code).endsWith(".js") ? basename(args.code) : "index.js";
  const metadata = { main_module: mainModule, compatibility_date: args.compatDate, bindings: secretBindings(args.secrets) };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(mainModule, new Blob([code], { type: "application/javascript+module" }), mainModule);
  const url = `${CF_API}/accounts/${accountId}/workers/dispatch/namespaces/${args.namespace}/scripts/${args.script}`;
  const res = await fetch(url, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: form });
  if (!res.ok) fail(`WfP upload -> ${res.status}: ${await res.text()}`);
  console.log(`uploaded ${args.script} into namespace ${args.namespace}`);
}

/** DELETE the resident script (rollback when conformance fails, or an explicit uninstall-evict). */
async function deleteScript(args: Args, accountId: string, token: string): Promise<void> {
  const url = `${CF_API}/accounts/${accountId}/workers/dispatch/namespaces/${args.namespace}/scripts/${args.script}`;
  const res = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) console.error(`rollback: DELETE script -> ${res.status}: ${await res.text()}`);
  else console.log(`rolled back: evicted ${args.script} from the namespace`);
}

/** Ask the core to install (conformance-gate + register) the resident script. */
async function coreInstall(args: Args): Promise<{ ok: boolean; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) { headers["CF-Access-Client-Id"] = id; headers["CF-Access-Client-Secret"] = secret; }
  const res = await fetch(`${args.core}/api/modules/install`, {
    method: "POST",
    headers,
    body: JSON.stringify({ script_name: args.script, name: args.name }),
  });
  return { ok: res.ok, body: await res.json() };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");

  await uploadScript(args, accountId, token);

  console.log(`gating ${args.script} via ${args.core} (conformance)...`);
  const { ok, body } = await coreInstall(args);
  if (!ok) {
    console.error(`conformance / install FAILED:\n${JSON.stringify(body, null, 2)}`);
    await deleteScript(args, accountId, token); // never leave a resident-but-unregistered script
    process.exit(1);
  }
  console.log(`installed: ${JSON.stringify(body)}`);
  console.log("live on the next request -- no core redeploy.");
}

main().catch((e) => fail((e as Error).message));
