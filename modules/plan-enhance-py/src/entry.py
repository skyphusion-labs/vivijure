# plan-enhance-py: a Vivijure module worker (vivijure-module/1) written in PYTHON.
#
# This is the SECOND on-ramp proof: modules honor a language-agnostic JSON contract over service
# bindings, so a module can be Python OR TypeScript. It serves the same two endpoints as a TS module:
#   GET  /module.json  -> the manifest (the core's registry discovers + indexes it)
#   POST /invoke       -> run the plan.enhance hook (deterministic, rule-based direction pass)
#
# A CF Python Worker (Pyodide, python_workers compat flag). It runs LIGHT control-plane logic only --
# no GPU (no torch/CUDA in Pyodide; the heavy render path stays on RunPod). Marked experimental:
# CF Python Workers is open beta, so this is an additive proof module; the render core and critical
# control-plane paths do NOT depend on it.
#
# Handler style: the canonical entrypoint-class (`Default(WorkerEntrypoint)` with `async def fetch`),
# the current CF Python Workers form (workers-py SDK). The typed JSON contract is identical to a TS
# module's; only the implementation language differs.
#
# A failure is DATA, never an exception across the wire: a bad request returns HTTP 200 { ok: False }.

import json

from workers import Response, WorkerEntrypoint

from enhance import run_enhance

MODULE_API = "vivijure-module/1"

# Distinct name from the TS reference module (`plan-enhance`) so both can be installed at once with no
# collision -- plan.enhance is a `chain` hook, so they both run in ui.order. This is the language-swap
# proof: same hook, two implementations, picked apart only by name.
MANIFEST = {
    "name": "plan-enhance-py",
    "version": "0.1.0",
    "api": MODULE_API,
    "hooks": ["plan.enhance"],
    "provides": [{"id": "auto-direction-py", "label": "Rule-based auto-direction (Python)"}],
    "config_schema": {
        "intensity": {
            "type": "enum",
            "values": ["light", "medium", "bold"],
            "default": "medium",
            "label": "direction intensity",
        },
    },
    # order 11: sit just after the TS plan-enhance (order 10) in the chain when both are installed.
    "ui": {"section": "plan", "order": 11},
}


def _json(body, status=200):
    return Response(
        json.dumps(body),
        status=status,
        headers={"content-type": "application/json"},
    )


def _to_py(obj):
    """The workers-py SDK returns native Python from request.json(); on a raw Pyodide proxy, coerce."""
    return obj.to_py() if hasattr(obj, "to_py") else obj


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        url = str(request.url)
        method = str(request.method)

        if method == "GET" and url.endswith("/module.json"):
            return _json(MANIFEST)

        if method == "POST" and url.endswith("/invoke"):
            try:
                req = _to_py(await request.json())
            except Exception:
                return _json({"ok": False, "error": "invalid JSON body"})
            if not isinstance(req, dict):
                return _json({"ok": False, "error": "invalid JSON body"})
            if req.get("hook") != "plan.enhance":
                return _json({"ok": False, "error": "unsupported hook " + str(req.get("hook"))})
            return _json(run_enhance(req.get("input"), req.get("config")))

        return _json({"ok": False, "error": "not found"}, status=404)
