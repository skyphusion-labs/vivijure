"""Local unit tests for inspect_core (#523 Layer 2 content validation) -- stdlib only, no ffmpeg, no
network. Proves the pure content metrics and the verdict matrix. Mirrors test_url_guard.py's style.

Run:  python3 test_inspect.py
Exits non-zero on any failed assertion.
"""
import sys

import inspect_core as ic

SZ = 4  # tiny synthetic frames


def solid(r, g, b, size=SZ):
    return bytes([r, g, b] * (size * size))


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1
check.failed = 0


# --- pure metric functions ---
check("saturation is 0 on a gray frame", ic.frame_saturation(solid(128, 128, 128), SZ) == 0.0)
check("saturation is 255 on a pure-red frame", ic.frame_saturation(solid(255, 0, 0), SZ) == 255.0)
check("gray stddev is 0 on a flat frame", ic.frame_gray_std(solid(200, 200, 200), SZ) == 0.0)

_a = bytes([10, 20, 30, 200, 100, 50] * (SZ * SZ // 2))
check("similarity of a frame with itself is 1.0", ic.frame_similarity(_a, _a, SZ) == 1.0)
check("similarity of two flat frames is 0.0 (undefined corr guard)",
      ic.frame_similarity(solid(0, 0, 0), solid(0, 0, 0), SZ) == 0.0)

_m = ic.clip_metrics([solid(255, 0, 255)] * 5, SZ)  # saturated magenta, flat luma
check("saturated-flat-luma clip has a high chroma/structure ratio (noise signature)",
      _m["chroma_structure_ratio"] > ic.CHROMA_STRUCTURE_MAX)
check("empty frame list yields safe zero metrics",
      ic.clip_metrics([], SZ)["frames"] == 0 and ic.clip_metrics([], SZ)["chroma_structure_ratio"] == 0.0)

# --- judge verdict matrix ---
check("judge: CORRUPT when keyframe similarity is below the floor",
      ic.judge({"chroma_structure_ratio": 1.0}, 0.05)["verdict"] == "corrupt")
check("judge: OK when keyframe similarity is high even if ratio is borderline",
      ic.judge({"chroma_structure_ratio": 1.0}, 0.9)["verdict"] == "ok")
check("judge: SUSPECT (warn) on a high ratio with no keyframe",
      ic.judge({"chroma_structure_ratio": ic.CHROMA_STRUCTURE_MAX + 1.0}, None)["verdict"] == "suspect")
check("judge: OK on normal content with no keyframe",
      ic.judge({"chroma_structure_ratio": 2.0}, None)["verdict"] == "ok")

if check.failed:
    print(f"\n{check.failed} FAILED")
    sys.exit(1)
print("\nall inspect_core tests passed")
