# Pure plan.enhance logic for the Python plan-enhance module (vivijure-module/1).
#
# Deliberately dependency-free and runtime-free: no `workers`/Pyodide imports here, so it runs under
# plain CPython for unit tests AND inside the Worker. The Worker entry (entry.py) imports these.
#
# This is the LANGUAGE-SWAP PROOF of the module on-ramp: it serves the SAME plan.enhance hook as the
# TS reference module (modules/plan-enhance), but with deterministic, rule-based cinematic direction
# instead of an LLM pass -- so the round-trip is fully offline and reproducible. The typed JSON
# contract is identical; only the implementation language differs.

# Direction cues appended to each shot prompt, by intensity. Deterministic so a render is reproducible
# and the conformance round-trip needs no model. "light" nudges, "bold" leans in.
_CUES = {
    "light": ["soft natural light", "steady framing"],
    "medium": ["cinematic lighting", "shallow depth of field", "deliberate camera move"],
    "bold": [
        "dramatic chiaroscuro lighting",
        "bold composition, rule-of-thirds",
        "expressive camera move (push-in / arc)",
        "rich color grade",
    ],
}

_VALID_INTENSITIES = ("light", "medium", "bold")


def normalize_intensity(value):
    """Coerce a config intensity to a known value; default 'medium' (mirrors the schema default)."""
    return value if value in _VALID_INTENSITIES else "medium"


def _already_directed(prompt, cues):
    """True if the prompt already ends with the directed cue suffix (idempotent re-runs / chains)."""
    low = (prompt or "").lower()
    return all(cue.lower() in low for cue in cues)


def enhance_prompt(prompt, intensity):
    """Append the intensity's direction cues to one shot prompt. Idempotent: never double-applies, and
    a blank prompt is returned unchanged (nothing to direct)."""
    base = (prompt or "").strip()
    if not base:
        return base
    cues = _CUES[normalize_intensity(intensity)]
    if _already_directed(base, cues):
        return base
    sep = "" if base.endswith((".", ",", ";")) else ","
    return base + sep + " " + ", ".join(cues)


def enhance_storyboard(storyboard, intensity):
    """Rewrite scenes[].prompt with direction cues, preserving every other field on the storyboard and
    each scene (structural passthrough, per the plan.enhance contract). Returns (new_storyboard, count)
    where count is the number of scenes actually changed."""
    if not isinstance(storyboard, dict):
        return storyboard, 0
    scenes = storyboard.get("scenes")
    if not isinstance(scenes, list):
        return storyboard, 0

    intensity = normalize_intensity(intensity)
    changed = 0
    new_scenes = []
    for scene in scenes:
        if not isinstance(scene, dict):
            new_scenes.append(scene)
            continue
        new_scene = dict(scene)  # preserve all other fields
        before = scene.get("prompt", "")
        after = enhance_prompt(before, intensity)
        new_scene["prompt"] = after
        if after != before:
            changed += 1
        new_scenes.append(new_scene)

    new_storyboard = dict(storyboard)
    new_storyboard["scenes"] = new_scenes
    return new_storyboard, changed


def run_enhance(input_obj, config):
    """Pure core of the plan.enhance hook: take the InvokeRequest's `input` + `config`, return the
    InvokeResponse body (a plain dict). Failure is DATA, never an exception: a missing/invalid
    storyboard returns { ok: False, error }, mirroring the TS reference module. A storyboard with no
    scenes to direct passes through unchanged with a note (the chain never breaks on this stage)."""
    input_obj = input_obj or {}
    storyboard = input_obj.get("storyboard")
    if not isinstance(storyboard, dict) or not isinstance(storyboard.get("scenes"), list):
        return {"ok": False, "error": "plan.enhance: input.storyboard has no scenes"}

    intensity = normalize_intensity((config or {}).get("intensity"))
    new_storyboard, changed = enhance_storyboard(storyboard, intensity)
    if changed == 0:
        note = "enhancement skipped: no shot prompts to direct (passed through unchanged)"
    else:
        note = "enhanced " + str(changed) + " shot(s) at " + intensity + " intensity (python module)"
    return {"ok": True, "output": {"storyboard": new_storyboard, "notes": [note]}}
