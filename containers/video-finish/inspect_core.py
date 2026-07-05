"""Pure content-inspection core for the video-finish container (#523 Layer 2).

Layer 1 (in the studio Worker) rejects STRUCTURAL clip corruption but cannot decode pixels, so a
structurally-valid clip of pure latent noise (local-16gb#35: CogVideoX on a vGPU) sails through. This
module is the pixel-content catch: it runs where ffmpeg already lives (this container), sampling a few
downscaled frames and judging whether the clip plausibly contains its conditioning keyframe's content.

Signals, in order of trust:
  1. keyframe similarity (PRIMARY, when the keyframe is provided -- production always has it): an i2v
     clip's first frame must resemble the SDXL keyframe it was conditioned on. Noise does not. This is
     robust and low-false-positive: a deliberately-abstract film still starts FROM its keyframe.
  2. chroma/structure ratio (FALLBACK, warn-only): pure latent noise is high-saturation chromatic mush
     with little luminance structure. Empirically (S12 evidence fixtures) the ratio sat_mean/gray_std is
     ~6.0 for the noise clips and <= 2.5 for every good clip (LTX, film, LoRA, high-motion). A wide gap,
     but a SMALL sample, so this only ever WARNS (degrade marker); it never hard-fails a render.

All thresholds are conservative and the default posture is WARN-AND-DEGRADE (the film still completes
with a `degraded` marker), never a silent pass and never an over-eager hard fail (#523 flags that
deliberately-abstract films exist). The pure functions here are unit-tested; the ffmpeg sampling is a
thin I/O wrapper.
"""
import subprocess

# --- Thresholds (empirically grounded against the S12 noise/good evidence; see #557). ---
# Keyframe similarity below this = the first frame does not resemble its conditioning keyframe.
KF_SIMILARITY_MIN = 0.20
# chroma/structure ratio above this = chromatic-noise signature (warn-only). Mid-gap: noise ~6.0, good <=2.5.
CHROMA_STRUCTURE_MAX = 4.0
SAMPLE_SIZE = 32   # downscale each sampled frame to SAMPLE_SIZE x SAMPLE_SIZE
SAMPLE_COUNT = 12  # frames sampled across the clip


def sample_frames_rgb(path, size=SAMPLE_SIZE, count=SAMPLE_COUNT):
    """Shell ffmpeg to extract up to `count` evenly-spaced frames, each downscaled to size x size rgb24.
    Returns a list of bytes objects (len == size*size*3 each). I/O; kept thin so the math stays testable."""
    # `thumbnail` picks representative frames; fall back to a plain decode if the filter yields nothing.
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf",
         f"scale={size}:{size},format=rgb24", "-f", "rawvideo", "-"],
        capture_output=True).stdout
    fsz = size * size * 3
    frames = [out[i * fsz:(i + 1) * fsz] for i in range(len(out) // fsz)]
    if not frames:
        return []
    if len(frames) <= count:
        return frames
    step = len(frames) / count
    return [frames[int(i * step)] for i in range(count)]


def frame_saturation(frame, size=SAMPLE_SIZE):
    """Mean per-pixel saturation (max(r,g,b) - min(r,g,b)) over an rgb24 frame. Pure."""
    n = size * size
    s = 0
    for i in range(n):
        r, g, b = frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]
        s += max(r, g, b) - min(r, g, b)
    return s / n if n else 0.0


def frame_gray_std(frame, size=SAMPLE_SIZE):
    """Population stddev of luma over an rgb24 frame (BT.601-ish gray). Pure."""
    n = size * size
    if not n:
        return 0.0
    grays = []
    for i in range(n):
        r, g, b = frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]
        grays.append(0.299 * r + 0.587 * g + 0.114 * b)
    mean = sum(grays) / n
    var = sum((x - mean) ** 2 for x in grays) / n
    return var ** 0.5


def clip_metrics(frames, size=SAMPLE_SIZE):
    """Aggregate content metrics over sampled frames. Pure."""
    if not frames:
        return {"sat_mean": 0.0, "gray_std_mean": 0.0, "chroma_structure_ratio": 0.0, "frames": 0}
    sats = [frame_saturation(f, size) for f in frames]
    stds = [frame_gray_std(f, size) for f in frames]
    sat_mean = sum(sats) / len(sats)
    gray_std_mean = sum(stds) / len(stds)
    ratio = sat_mean / max(gray_std_mean, 1.0)
    return {"sat_mean": round(sat_mean, 3), "gray_std_mean": round(gray_std_mean, 3),
            "chroma_structure_ratio": round(ratio, 3), "frames": len(frames)}


def frame_similarity(a, b, size=SAMPLE_SIZE):
    """Normalized cross-correlation of two same-size rgb24 frames' luma, in [0,1] (clamped). 1 = identical
    structure, ~0 = unrelated. Pure. Used for first-frame-vs-keyframe: an i2v first frame that ignored its
    conditioning keyframe (noise) scores near 0."""
    n = size * size
    if not n or len(a) < n * 3 or len(b) < n * 3:
        return 0.0
    ga, gb = [], []
    for i in range(n):
        ga.append(0.299 * a[i * 3] + 0.587 * a[i * 3 + 1] + 0.114 * a[i * 3 + 2])
        gb.append(0.299 * b[i * 3] + 0.587 * b[i * 3 + 1] + 0.114 * b[i * 3 + 2])
    ma, mb = sum(ga) / n, sum(gb) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(ga, gb))
    da = sum((x - ma) ** 2 for x in ga) ** 0.5
    db = sum((y - mb) ** 2 for y in gb) ** 0.5
    if da == 0 or db == 0:
        return 0.0
    corr = num / (da * db)
    return max(0.0, min(1.0, corr))


def judge(metrics, kf_similarity):
    """Turn metrics + optional keyframe similarity into a verdict. Pure.

    verdict: "ok" | "suspect" | "corrupt".
      - corrupt: keyframe similarity present AND below the floor -> the clip does not contain its
        conditioning keyframe (the #35 case). This is the confident hard signal.
      - suspect: no keyframe (or similarity ok) BUT the chroma/structure ratio trips the noise signature
        -> WARN only (the caller degrades, never hard-fails; the sample behind this threshold is small).
      - ok: neither fired.
    """
    if kf_similarity is not None and kf_similarity < KF_SIMILARITY_MIN:
        return {"verdict": "corrupt",
                "reason": f"first frame does not resemble its keyframe (similarity {kf_similarity:.3f} < {KF_SIMILARITY_MIN}); likely noise/garbage"}
    if metrics.get("chroma_structure_ratio", 0.0) > CHROMA_STRUCTURE_MAX:
        return {"verdict": "suspect",
                "reason": f"chromatic-noise signature (chroma/structure ratio {metrics['chroma_structure_ratio']} > {CHROMA_STRUCTURE_MAX})"}
    return {"verdict": "ok", "reason": ""}


def inspect(clip_path, keyframe_path=None):
    """Full content inspection: sample the clip (and keyframe), compute metrics + similarity, judge.
    Returns {verdict, reason, metrics, keyframe_similarity}. I/O orchestration over the pure core."""
    frames = sample_frames_rgb(clip_path)
    metrics = clip_metrics(frames)
    kf_similarity = None
    if keyframe_path:
        kf = sample_frames_rgb(keyframe_path, count=1)
        if frames and kf:
            kf_similarity = frame_similarity(frames[0], kf[0])
    result = judge(metrics, kf_similarity)
    result["metrics"] = metrics
    result["keyframe_similarity"] = None if kf_similarity is None else round(kf_similarity, 3)
    return result
