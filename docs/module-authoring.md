# Writing a Vivijure module

> The SDK story. Vivijure is a **host, not a monolith**: the core owns only what is always true
> (project, storyboard, cast, bundle, the render spine, and a module registry). Every *capability*
> beyond that is an opt-in **module worker** that plugs into the pipeline through one typed contract.
> Install a module and its stage lights up, bringing its own settings; install none and you get a
> clean, honest, empty studio. This guide shows you how to write one.

See also [`module-api.md`](./module-api.md) for the contract design, and the reference module
[`modules/plan-enhance/`](../modules/plan-enhance) which this guide walks through.

## The shape of a module

A module is a standalone Cloudflare Worker. A synchronous module serves two endpoints; an async or
cancelable one serves up to four:

| Endpoint | Required | Purpose |
|---|---|---|
| `GET /module.json` | always | the module's **manifest** (which hooks it serves, its config, how it surfaces in the UI) |
| `POST /invoke` | always | run one hook: `{ hook, input, config, context }` in, an `InvokeResponse` out |
| `POST /poll` | **async modules** | when `/invoke` returns `{ ok: true, pending: true, poll }`, the core polls here with `{ poll }` until the job is terminal (a long RunPod render must be async so no Worker holds a request open) |
| `POST /cancel` | **`cancelable` modules** | stop an in-flight async job by its poll token, so a cancelled render or an adopted phase does not orphan GPU and bleed spend (#327/#328); best-effort + idempotent. Advertise it with `cancelable: true` in the manifest |

The core discovers your module from a `MODULE_<NAME>` service binding, reads your manifest, indexes
you by hook, and renders your stage in the studio UI from your `config_schema`. It invokes you when a
render reaches your hook. **The core never knows who answers** -- it just asks the hook.

### The trust boundary: your module is reachable ONLY through the core (HARD RULE)

The `MODULE_<NAME>` **service binding IS the authentication.** Service-binding calls are
worker-to-worker and never traverse the public internet, so your `/invoke` never needs (and must not
add) its own auth check -- the core is the only caller, and the core sits behind the studio auth gate.

That guarantee holds ONLY while your module has **no public surface.** In your `wrangler.toml` set
`workers_dev = false` and declare **no `route`** (every first-party module does). A module that
publishes a `workers.dev` host or a custom route exposes `/invoke` to the open internet with **zero
authentication** -- and modules wrap real spend (a public `motion.backend`/`keyframe` module is an
unauthenticated RunPod GPU-spend trigger; a public `notify` module is an open mail relay). Keep the
surface internal: the service binding is the boundary, do not punch a hole in it.

## The hooks (vivijure-module/2)

| Hook | Purpose | Cardinality |
|---|---|---|
| `keyframe` | storyboard -> start keyframes (SDXL on GPU) | **pick one** |
| `motion.backend` | keyframe (+ motion prompt) -> shot clip (GPU or cloud) | **pick one** per shot |
| `finish` | post-process a clip: interpolation / lip-sync / upscale / face restore | **chain** |
| `score` | add audio to a film: music / narration / beat-sync | **chain** |
| `dialogue` | per-shot dialogue lines -> speech audio (TTS); feeds the lip-sync finish module | **pick one** |
| `speech` | per-shot dialogue audio -> cleaned/enhanced audio (post-dialogue, pre-finish) | **chain** |
| `plan.enhance` | expand a storyboard before render (LLM auto-direction) | **chain** |
| `cast.image` | portrait + bible -> LoRA training reference images | **pick one** |
| `notify` | render-complete notification (email / webhook) | **chain** |
| `master` | assembled film's audio bed -> mastered audio (music upscale + loudness), pre-mux; fail-safe | **chain** |
| `film.finish` | assembled + muxed film -> title / credit cards (post-mux; runs on the single-film path AND the scatter finalize, #602) | **chain** |

`pick_one` resolves to a single module. The user picks; for most hooks an omitted choice defaults
to the `ui.order`-first serving module, EXCEPT `motion.backend` on a full render, where the choice
is REQUIRED -- an omitted or non-serving backend is rejected at submit with the installed list
(#500/#504), so a non-operational door can never be silently defaulted into. `chain` folds every
installed module in `ui.order`, each consuming the previous one's output.

## The 4-file template

A module is small. The reference `plan-enhance` module is four files:

```
modules/<your-module>/
  wrangler.toml        # name, compat date, and the bindings your /invoke needs
  src/contract.ts      # VENDORED copy of the contract shapes you use
  src/<logic>.ts       # your pure logic (so it unit-tests without the runtime)
  src/index.ts         # the worker: GET /module.json + POST /invoke
```

### 1. Vendor the contract

A module **vendors** the contract shapes it uses (copy them into `src/contract.ts`) so it stays
independent of the core's repo -- a module in another repo ships its own copy. Copy only what you
need from [`src/modules/types.ts`](../src/modules/types.ts): `MODULE_API`, the manifest types, the
`InvokeRequest`/`InvokeResponse` shapes, and your hook's payload types (e.g. `PlanEnhanceInput` /
`PlanEnhanceOutput`).

### 2. Declare your manifest

```ts
const MANIFEST: ModuleManifest = {
  name: "plan-enhance",
  version: "0.1.0",
  api: MODULE_API,                       // "vivijure-module/2"
  hooks: ["plan.enhance"],
  provides: [{ id: "auto-direction", label: "LLM auto-direction" }],
  config_schema: {                       // the UI renders a control per field
    intensity: { type: "enum", values: ["light", "medium", "bold"], default: "medium", label: "direction intensity" },
  },
  ui: { section: "plan", order: 10 },
};
```

`config_schema` fields (`int` / `float` / `bool` / `enum` / `string`, each with a `default`, and
`min`/`max` for numbers) are the single source of truth: the studio renders the control from them,
the core clamps the user's value against them before calling you, so your `/invoke` never has to
defend against junk.

### 3. Serve the two endpoints

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") {
      return json(MANIFEST);
    }
    if (request.method === "POST" && url.pathname === "/invoke") {
      const req = (await request.json()) as InvokeRequest<MyInput>;
      if (req.hook !== "plan.enhance") {
        return json({ ok: false, error: `unsupported hook ${req.hook}` });
      }
      return json(await run(env, req)); // your work -> InvokeResponse
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
```

### 4. Failures are DATA, never an exception

The single most important rule. A module failure must be a value, not a thrown error across the
wire, so the core degrades instead of crashing. Always return HTTP 200 with an `InvokeResponse`:

```ts
type InvokeResponse<O> = { ok: true; output: O } | { ok: false; error: string };
```

For a chain hook, prefer a **soft degrade** where it makes sense: if your work cannot run (an
upstream model is down, a reply is unparseable), return `{ ok: true, output: <input passed through>, ... }`
with a note, so the chain continues from a good value. A hard `{ ok: false }` is for "I cannot honor
this request at all"; the core records it and moves on.

## Wrapping a RunPod (or any cloud) worker

The template generalizes to any off-GPU or cloud capability: keep the same four files and make
`/invoke` proxy your backend instead of doing the work in the Worker.

```ts
async function run(env: Env, req: InvokeRequest<MotionInput>): Promise<InvokeResponse<MotionOutput>> {
  // 1. submit to your RunPod serverless endpoint
  const sub = await fetch(`https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ input: toBackendInput(req.input, req.config) }),
  });
  // 2. poll /status until COMPLETED (or stream), 3. map the result to your hook's output type
  // 4. on any failure return { ok: false, error } (or a soft passthrough for a chain hook)
}
```

That is the whole "community becomes the roadmap" play: the RunPod ready-to-deploy hub
(Wan2.2/SDXL/ComfyUI as `motion.backend`, Whisper STT as `score`, vLLM as a self-hosted
`plan.enhance`) is a catalog of modules waiting to be wrapped, each one the same four files.

## Bind it to the core

Deploy your module worker, then add a service binding to the core's `wrangler.toml`:

```toml
[[services]]
binding = "MODULE_<NAME>"            # the registry discovers any MODULE_* binding
service = "vivijure-module-<name>"   # your deployed worker's name
```

Redeploy the core. `GET /api/modules` now lists your module, the studio UI renders its stage, and
the core invokes it through your hook. Nothing else is hardcoded.

## Prove it conforms

Before you bind a module, run the **conformance harness** against it (see
[`src/modules/conformance.ts`](../src/modules/conformance.ts)) to confirm it honors the contract --
a valid manifest, a well-formed `InvokeResponse`, and graceful degradation on a bad request:

```
MODULE_URL=https://vivijure-module-<name>.<subdomain>.workers.dev \
  npx vitest run tests/conformance.live.test.ts
```

If that is green, your module will plug into the core cleanly.

## Checklist

- [ ] `GET /module.json` returns a manifest with `api: "vivijure-module/2"` (the `/1` window is
      CLOSED as of v0.12.0 -- a `/1` manifest is rejected at registration), a `name`, a `version`,
      and only known `hooks`.
- [ ] `config_schema` fields each have a valid `type` and a `default` consistent with it.
- [ ] `POST /invoke` returns HTTP 200 with a well-formed `InvokeResponse` for every input, including
      garbage (no thrown errors across the wire).
- [ ] Pure logic is split out and unit-tested; the worker is thin glue.
- [ ] Conformance harness is green against the deployed worker.
- [ ] A `[[services]]` binding named `MODULE_<NAME>` is added to the core and the core redeployed.

## Writing a module in Python (second on-ramp)

The contract is **language-agnostic** -- it is a typed JSON exchange over a service binding, so the
core does not care what language answers a hook. A module can be **TypeScript OR Python**. Python is a
good fit for **light control-plane logic** (`plan.enhance`, `score`, orchestration glue).

> Cloudflare Python Workers run on Pyodide and have **no torch/CUDA**, so a Python module **cannot**
> run the GPU render -- the heavy path stays on RunPod. CF Python Workers is currently **open beta**;
> treat Python modules as experimental and keep critical paths off them until GA.

The shape is identical: serve `GET /module.json` and `POST /invoke`. A minimal entrypoint:

```python
import json
from workers import Response, WorkerEntrypoint

MANIFEST = {"name": "my-module", "version": "0.1.0", "api": "vivijure-module/2", "hooks": ["plan.enhance"]}

def _json(body, status=200):
    return Response(json.dumps(body), status=status, headers={"content-type": "application/json"})

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        url, method = str(request.url), str(request.method)
        if method == "GET" and url.endswith("/module.json"):
            return _json(MANIFEST)
        if method == "POST" and url.endswith("/invoke"):
            req = (await request.json()).to_py()
            # ... run the hook; failure is DATA: return _json({"ok": False, "error": ...})
            return _json({"ok": True, "output": {}})
        return _json({"ok": False, "error": "not found"}, status=404)
```

Tooling is [pywrangler](https://github.com/cloudflare/workers-py) (the Python Workers CLI, needs
[`uv`](https://docs.astral.sh/uv/)): `uvx --from workers-py pywrangler dev` / `... deploy`. Declare
deps in `pyproject.toml` (bundled into `python_modules/` on deploy). `wrangler.toml` needs
`main = "src/entry.py"` and `compatibility_flags = ["python_workers"]`. The same conformance harness
applies -- a Python module passes `MODULE_URL=<url> npx vitest run tests/conformance.live.test.ts`
exactly like a TS one. This on-ramp was proven end-to-end by the now-retired `plan-enhance-py`
proof module (the deterministic Python sibling of the TS `plan-enhance`); see it in the git
history if you need a full worked example.
