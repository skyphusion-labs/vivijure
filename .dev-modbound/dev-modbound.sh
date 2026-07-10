#!/usr/bin/env bash
# dev-modbound.sh -- stand up a MODULE-BOUND local vivijure studio dev env (issue #411 dev-parity fix).
#
# WHY: a stripped `wrangler dev --local` drops every MODULE_* service binding, so GET /api/modules
# returns modules:[] and no render/audio/module-dependent flow can be driven. This runs the core +
# every in-tree module worker together as ONE multi-worker local dev, so the registry discovers the
# REAL catalog from each module static GET /module.json manifest.
#
# SAFETY (by construction):
#   - Fully LOCAL: local D1 + local R2, zero remote bindings. Prod D1/R2 are NOT reachable.
#   - ZERO GPU / provider spend: module dev configs are binding-FREE, so a module serves its real
#     manifest (real config_schema -> full projection) but has NO RunPod key / AI / R2. Any accidental
#     POST /invoke is inert and fails safe. No job can reach a GPU from here.
#
# STUBBED (intentional): AI binding (plan-validator LLM re-prompt -- Workers AI is remote-only and the
#   crew token cannot edge-preview); module invoke backends; the 4 VPC finish services; tail consumer;
#   ratelimits; crons; MODULE_DISPATCH.
#
# USAGE:  bash .dev-modbound/dev-modbound.sh [PORT]   (default 8790) -- run from repo root, needs npx+python3.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PORT="${1:-8790}"
D="$(pwd)/.dev-modbound"; mkdir -p "$D/mods"

python3 - <<PY
import pathlib
src = pathlib.Path("wrangler.toml.example").read_text().splitlines()
drop = {"[[ratelimits]]","[triggers]","[[vpc_services]]","[[routes]]","[[migrations]]","[ai]"}
out, skip = [], False
for ln in src:
    s = ln.strip()
    if s.startswith("tail_consumers"): continue
    if s in drop: skip = True; continue
    if skip:
        if s == "" or (s.startswith("[") and s not in drop):
            skip = False
            if not (s.startswith("[") and s not in drop): continue
        else: continue
    out.append(ln)
t = "\n".join(out)
t = t.replace("\${D1_DATABASE_ID}","dev-local-modbound")
t = t.replace("\${AUTH_MODE}","").replace("\${ACCESS_TEAM_DOMAIN}","").replace("\${ACCESS_AUD}","")
t = t.replace("[vars]\n","[vars]\nALLOW_UNAUTHENTICATED = \"true\"\nPLANNER_AI_MOCK = \"true\"\n",1)
pathlib.Path("wrangler.toml").write_text(t); print("rendered ./wrangler.toml")
PY

python3 - "$D" <<PY
import pathlib, re, sys
D = pathlib.Path(sys.argv[1])
services = set(re.findall(r"^service = \"([^\"]+)\"", pathlib.Path("wrangler.toml").read_text(), re.M))
made=[]
for cfg in sorted(pathlib.Path("modules").glob("*/wrangler.toml")):
    txt=cfg.read_text()
    name=re.search(r"^name = \"([^\"]+)\"",txt,re.M); main=re.search(r"^main = \"([^\"]+)\"",txt,re.M)
    cdate=re.search(r"^compatibility_date = \"([^\"]+)\"",txt,re.M); cflags=re.search(r"^compatibility_flags = (\[[^\]]*\])",txt,re.M)
    if not (name and main) or name.group(1) not in services or main.group(1).endswith(".py"): continue
    abs_main=(cfg.parent/main.group(1)).resolve()
    lines=[f"name = \"{name.group(1)}\"", f"main = \"{abs_main}\""]
    if cdate: lines.append(f"compatibility_date = \"{cdate.group(1)}\"")
    if cflags: lines.append(f"compatibility_flags = {cflags.group(1)}")
    lines.append("workers_dev = false")
    (D/"mods"/(name.group(1)+".toml")).write_text("\n".join(lines)+"\n"); made.append(name.group(1))
print(f"generated {len(made)} module dev configs")
PY

npx wrangler d1 migrations apply DB --local >/dev/null 2>&1 || true
FLAGS=""; for f in "$D"/mods/*.toml; do FLAGS="$FLAGS -c $f"; done
echo "launching module-bound dev on http://127.0.0.1:$PORT ..."
exec npx wrangler dev -c wrangler.toml $FLAGS --port "$PORT" --ip 127.0.0.1
