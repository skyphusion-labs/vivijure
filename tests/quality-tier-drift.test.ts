// Quality-tier drift guard (issue #124).
//
// The render quality tier set (draft / standard / final) is core render knowledge: QUALITY_TIERS in
// render-module-config.ts is the single source of truth, and the core INJECTS it into the keyframe
// module (as quality_tier) and motion.backend modules (as quality) -- see injectQualityTier. But each
// such module ALSO declares its own enum in its config_schema, because a module is a standalone worker
// that vendors the contract and cannot import the core constant at runtime. That leaves two copies
// that must agree: if a module's enum drifts from QUALITY_TIERS, validateConfig SILENTLY DROPS the
// injected tier (an enum value not in `values` is rejected) and that module renders at its schema
// default instead of the chosen tier -- a silent, user-affecting bug.
//
// There is no runtime coupling to prevent this (and there shouldn't be -- modules stay portable). So
// this test is the guard: it imports the core set AND each tier-carrying module manifest and fails CI
// the moment they diverge. Adding a tier to QUALITY_TIERS without updating a module's enum (or vice
// versa) turns this red. This is the control-plane analogue of the backend's config->engine mapping
// meta-test (#20).
import { describe, it, expect } from "vitest";
import { QUALITY_TIERS } from "../src/render-module-config";
import { MANIFEST as KEYFRAME_MANIFEST } from "../modules/keyframe/src/index";
import { MANIFEST as OWN_GPU_MANIFEST } from "../modules/own-gpu/src/index";
import type { ConfigField, ModuleManifest } from "../src/modules/types";

const CORE_TIERS = QUALITY_TIERS.map((t) => t.value).slice().sort();

/** Pull the `values` of an enum config field, or null if the field is absent / not an enum. */
function enumValues(manifest: ModuleManifest, field: string): string[] | null {
  const f = manifest.config_schema?.[field] as ConfigField | undefined;
  if (!f || f.type !== "enum") return null;
  return f.values.slice().sort();
}

// Every module-side enum the core injects a tier into, by (manifest, field-name). If the core starts
// injecting the tier into another module/field, add it here so the guard covers it.
const TIER_ENUMS: { name: string; manifest: ModuleManifest; field: string }[] = [
  { name: "keyframe.quality_tier", manifest: KEYFRAME_MANIFEST, field: "quality_tier" },
  { name: "own-gpu.quality", manifest: OWN_GPU_MANIFEST, field: "quality" },
];

describe("quality-tier drift guard (#124)", () => {
  it("the core set is exactly draft/standard/final (canary on the source of truth)", () => {
    expect(CORE_TIERS).toEqual(["draft", "final", "standard"]); // sorted
  });

  for (const { name, manifest, field } of TIER_ENUMS) {
    it(`${name} enum matches the core QUALITY_TIERS set`, () => {
      const values = enumValues(manifest, field);
      expect(values, `${name}: expected an enum field "${field}" in the manifest config_schema`).not.toBeNull();
      // The module's enum must offer exactly the core tiers -- no missing tier (would silently drop
      // the injected value) and no extra (would accept a tier the core never injects).
      expect(values, `${name} drifted from core QUALITY_TIERS`).toEqual(CORE_TIERS);
    });

    it(`${name} default is one of the core tiers`, () => {
      const f = manifest.config_schema?.[field] as Extract<ConfigField, { type: "enum" }>;
      expect(CORE_TIERS).toContain(f.default);
    });
  }
});
