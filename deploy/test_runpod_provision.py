"""Unit tests for the RunPod provisioning shape (#676/#677/#678). No live provider calls -- rp_reconcile
is monkeypatched to capture the create bodies."""
import importlib.util
import pathlib
import sys

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "vivijure_deploy", pathlib.Path(__file__).parent / "vivijure_deploy.py")
vd = importlib.util.module_from_spec(_SPEC)
sys.modules["vivijure_deploy"] = vd
_SPEC.loader.exec_module(vd)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _capture_reconcile(calls):
    def fake(*, kind, key, list_path, create_path, create_body, name,
             name_key="name", id_key="id", known_id=None):
        calls.append((kind, name, create_body))
        return vd.ReconcileResult(f"{name}-id", adopted=False)
    return fake


def test_runpod_images_cover_every_endpoint():
    imgs = vd.runpod_images()
    assert set(imgs) == set(vd.RUNPOD_ENDPOINTS)
    for ep, (image, tag) in imgs.items():
        assert image.startswith("ghcr.io/skyphusion-labs/"), ep
        assert tag and tag != "latest", ep
        assert tag[0].isdigit(), f"{ep}: tag must be bare semver, not a v-prefixed git tag ({tag!r})"


def test_audio_upscale_is_a_first_class_endpoint():
    assert "vivijure-audio-upscale" in vd.RUNPOD_ENDPOINTS


def test_provision_runpod_per_endpoint_image_serverless_no_volume(repo, monkeypatch):
    monkeypatch.setattr(vd, "GPU_TYPE_IDS", ["NVIDIA H100 80GB HBM3"])
    calls = []
    monkeypatch.setattr(vd, "rp_reconcile", _capture_reconcile(calls))
    st = vd.State.load(repo)
    s = vd.Secrets("acct", "cf-tok", "rp-key")
    cf = {"R2_S3_ACCESS_KEY_ID": "ak", "R2_S3_SECRET_ACCESS_KEY": "sk",
          "R2_S3_ENDPOINT": "https://acct.r2.cloudflarestorage.com"}

    eps = vd.provision_runpod(repo, s, st, cf)

    # all four endpoints, none left on the backend image
    assert set(eps) == {"vivijure-backend", "vivijure-upscale", "vivijure-musetalk", "vivijure-audio-upscale"}
    # NO network volume reconcile happened
    assert not any(kind == "network volume" for kind, _, _ in calls)

    tmpls = {name: body for kind, name, body in calls if kind == "template"}
    endpoints = {name: body for kind, name, body in calls if kind == "endpoint"}

    # each satellite template pins its OWN image + is a serverless template (#677/#678)
    assert tmpls["vivijure-upscale-tmpl"]["imageName"].startswith("ghcr.io/skyphusion-labs/vivijure-upscale:")
    assert tmpls["vivijure-musetalk-tmpl"]["imageName"].startswith("ghcr.io/skyphusion-labs/vivijure-musetalk:")
    assert tmpls["vivijure-audio-upscale-tmpl"]["imageName"].startswith("ghcr.io/skyphusion-labs/vivijure-audio-upscale:")
    assert tmpls["vivijure-backend-tmpl"]["imageName"].startswith("ghcr.io/skyphusion-labs/vivijure-backend:")
    assert all(b.get("isServerless") is True for b in tmpls.values())

    # no endpoint carries a networkVolumeId (#676)
    assert all("networkVolumeId" not in b for b in endpoints.values())

    # state persisted endpoint + template ids, and NO volume key
    assert st.resource_id("runpod_endpoint_vivijure-audio-upscale") == "vivijure-audio-upscale-id"
    assert st.resource_id("runpod_template_vivijure-musetalk") == "vivijure-musetalk-tmpl-id"
    assert st.resource_id("runpod_volume_vivijure-backend") is None


def test_provision_runpod_missing_gpu_dies(repo, monkeypatch):
    monkeypatch.setattr(vd, "GPU_TYPE_IDS", [])
    monkeypatch.setattr(vd, "rp_reconcile", _capture_reconcile([]))
    st = vd.State.load(repo)
    s = vd.Secrets("a", "c", "r")
    with pytest.raises(SystemExit):
        vd.provision_runpod(repo, s, st, {"R2_S3_ACCESS_KEY_ID": "ak"})


def test_provision_runpod_unpinned_tag_dies(repo, monkeypatch):
    monkeypatch.setattr(vd, "GPU_TYPE_IDS", ["gpu"])
    monkeypatch.setattr(vd, "UPSCALE_IMAGE_TAG", "latest")
    monkeypatch.setattr(vd, "rp_reconcile", _capture_reconcile([]))
    st = vd.State.load(repo)
    s = vd.Secrets("a", "c", "r")
    with pytest.raises(SystemExit):
        vd.provision_runpod(repo, s, st, {"R2_S3_ACCESS_KEY_ID": "ak"})
