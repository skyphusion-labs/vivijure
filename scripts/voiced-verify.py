#!/usr/bin/env python3
# BAR: VOICED = lipsync:v15 + non-silent audio per shot; FULL also requires upscale:2x.
"""voiced-verify: honest per-shot proof that a scatter render's shots actually lip-synced + carry
NON-SILENT audio -- not just nb_streams==2 (which keepClipAudio's silent-pad would pass).

Per shot, from the render's own finish_shots + the per-shot clip:
  - lipsync : `applied` contains `lipsync:v15` (the chain actually ran lip-sync; a noop/passthrough fails)
  - upscale : `applied` contains `upscale:2x` (CUDA upscale ran; a passthrough/degrade = silent fallback)
  - audio   : the shot's final clip has a real audio stream with content (ffmpeg volumedetect
              max_volume above a floor) -- a silent anullsrc pad fails

VOICED verdict = lipsync AND audio (the bug we fixed: shot_02 shipped silent).
FULL   verdict = lipsync AND upscale AND audio (the full live 4-step chain).

Read-only. No spend, no deploy. Usage: voiced-verify.py <scatter-id>
"""
import os, sys, json, subprocess, tempfile, re

LIPSYNC_OK = "lipsync:v15"
UPSCALE_OK = "upscale:2x"
# A real voiced clip's peak sits well above this; an anullsrc silent pad reports ~ -91 dB (or -inf).
MAX_VOLUME_FLOOR_DB = -60.0


def s3():
    import boto3
    return boto3.client(
        "s3", endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )


def get_json(cli, bucket, key):
    return json.loads(cli.get_object(Bucket=bucket, Key=key)["Body"].read())


def audio_report(cli, bucket, key):
    """Download the clip; return (has_audio, max_db, mean_db). max_db None when no audio stream."""
    if not key:
        return (False, None, None)
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=True) as tf:
            cli.download_fileobj(bucket, key, tf)
            tf.flush()
            # audio stream present?
            pr = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                 "stream=codec_type", "-of", "csv=p=0", tf.name],
                capture_output=True, text=True)
            if "audio" not in pr.stdout:
                return (False, None, None)
            vd = subprocess.run(
                ["ffmpeg", "-hide_banner", "-i", tf.name, "-af", "volumedetect",
                 "-f", "null", "-"], capture_output=True, text=True)
            err = vd.stderr
            mx = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?) dB", err)
            mn = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", err)
            max_db = float(mx.group(1)) if mx else None
            mean_db = float(mn.group(1)) if mn else None
            return (True, max_db, mean_db)
    except Exception as e:
        return (False, None, f"err:{e}")


def has_tag(applied, exact):
    return exact in (applied or [])


def main():
    if len(sys.argv) < 2:
        print("usage: voiced-verify.py <scatter-id>"); sys.exit(2)
    sid = sys.argv[1]
    cli = s3()
    bucket = os.environ["R2_BUCKET"]
    sj = get_json(cli, bucket, f"renders/{sid}/scatter-job.json")
    expected = sj.get("expected_shot_ids", [])
    shard_ids = sj.get("shard_film_ids", [])
    print(f"scatter {sid}")
    print(f"  phase={sj.get('phase')} has_dialogue={sj.get('has_dialogue')} "
          f"shards={len(shard_ids)} expected_shots={expected}\n")

    # shot_id -> finish_shot (applied, clip_key), gathered across every shard
    fs_by_shot = {}
    for fid in shard_ids:
        try:
            fj = get_json(cli, bucket, f"renders/{fid}/film-job.json")
        except Exception as e:
            print(f"  (warn) shard {fid} film-job.json unreadable: {e}")
            continue
        for fs in (fj.get("finish_shots") or []):
            fs_by_shot[fs.get("shot_id")] = fs

    rows = []
    for shot in expected:
        fs = fs_by_shot.get(shot)
        applied = (fs or {}).get("applied", [])
        clip_key = (fs or {}).get("clip_key")
        lip = has_tag(applied, LIPSYNC_OK)
        ups = has_tag(applied, UPSCALE_OK)
        has_audio, max_db, mean_db = audio_report(cli, bucket, clip_key)
        nonsilent = bool(has_audio and isinstance(max_db, (int, float)) and max_db > MAX_VOLUME_FLOOR_DB)
        voiced = lip and nonsilent
        full = lip and ups and nonsilent
        rows.append((shot, lip, ups, max_db, nonsilent, voiced, full, applied))

    w = max([len(r[0]) for r in rows] + [7])
    print(f"  {'shot'.ljust(w)}  lipsync  upscale  max_dB    nonsilent  VOICED  FULL")
    for (shot, lip, ups, max_db, ns, voiced, full, applied) in rows:
        mxs = f"{max_db:.1f}" if isinstance(max_db, (int, float)) else "n/a"
        print(f"  {shot.ljust(w)}  {'  ok   ' if lip else '  --   '}  "
              f"{'  ok   ' if ups else '  --   '}  {mxs.rjust(7)}  "
              f"{'   yes   ' if ns else '   NO    '}  "
              f"{' PASS ' if voiced else ' FAIL '}  {'PASS' if full else 'FAIL'}")
        if not (voiced and full):
            print(f"      applied={applied}")

    all_voiced = all(r[5] for r in rows) and len(rows) > 0
    all_full = all(r[6] for r in rows) and len(rows) > 0
    print()
    print(f"  VOICED (lipsync + non-silent audio, every shot): {'PASS' if all_voiced else 'FAIL'}")
    print(f"  FULL   (lipsync + upscale + audio, every shot) : {'PASS' if all_full else 'FAIL'}")
    sys.exit(0 if all_full else 1)


if __name__ == "__main__":
    main()
