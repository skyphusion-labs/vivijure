import { describe, it, expect } from "vitest";
import { bundleKeyframeShotIds } from "../src/bundle-keyframes";

describe("bundleKeyframeShotIds", () => {
  it("finds injected keyframe paths in a tar listing", () => {
    expect(
      bundleKeyframeShotIds([
        "storyboard.yaml",
        "clips/shot_01_keyframe.png",
        "clips/shot_02_keyframe.png",
        "start_image.png",
      ]),
    ).toEqual(["shot_01", "shot_02"]);
  });
});
