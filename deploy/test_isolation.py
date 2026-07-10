"""Unit tests for the #244 installer live-fixes + isolation seam: DEPLOY_PREFIX name derivation, the
pure core/module toml renders (base-install, media-less), the no-silent-adopt guard, and the
partial-safe teardown delete. Pure/mocked -- NO live provider calls.

Run: python3 -m pytest deploy/test_isolation.py
"""
import importlib.util
import pathlib
import sys

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "vivijure_deploy", pathlib.Path(__file__).parent / "vivijure_deploy.py")
vd = importlib.util.module_from_spec(_SPEC)
sys.modules["vivijure_deploy"] = vd  # so dataclass module lookup resolves
_SPEC.loader.exec_module(vd)


@pytest.fixture(autouse=True)
def _reset():
    p, a = vd.DEPLOY_PREFIX, vd._ADOPT
    vd.DEPLOY_PREFIX, vd._ADOPT = "", False
    yield
    vd.DEPLOY_PREFIX, vd._ADOPT = p, a


# --- prefixed() + state_file_name() ----------------------------------------------------------------

def test_prefixed_empty_is_verbatim():
    assert vd.prefixed("vivijure-studio") == "vivijure-studio"


def test_prefixed_applies_when_set():
    vd.DEPLOY_PREFIX = "proving"
    assert vd.prefixed("vivijure-studio") == "proving-vivijure-studio"


def test_prefixed_whitespace_is_empty():
    vd.DEPLOY_PREFIX = "   "
    assert vd.prefixed("vivijure") == "vivijure"


def test_state_file_name():
    assert vd.state_file_name() == vd.STATE_FILE == ".vivijure-deploy.json"
    vd.DEPLOY_PREFIX = "proving"
    assert vd.state_file_name() == ".proving-vivijure-deploy.json"


# --- render_core_toml() + render_module_toml(): base-install (media-less) render (F1) --------------

SAMPLE = '''name = "vivijure-studio"
workers_dev = false
tail_consumers = [ { service = "vivijure-tail" } ]

[vars]
AUTH_MODE = "${AUTH_MODE}"
R2_S3_ENDPOINT = "${R2_S3_ENDPOINT}"
R2_S3_BUCKET = "${R2_S3_BUCKET}"

[[r2_buckets]]
binding = "R2_RENDERS"
bucket_name = "vivijure"

[[d1_databases]]
binding = "DB"
database_id = "${D1_DATABASE_ID}"

[[migrations]]
tag = "v2"
deleted_classes = ["VideoFinishContainer"]

[[vpc_services]]
binding = "VIDEO_FINISH_VPC"
service_id = "${VPC_VIDEO_FINISH_ID}"

[[secrets_store_secrets]]
binding = "RUNPOD_API_KEY"
store_id = "REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID"

[[services]]
binding = "MODULE_KEYFRAME"
service = "vivijure-module-keyframe"

[[routes]]
pattern = "vivijure.skyphusion.org"
custom_domain = true
'''


def _render(prefix=""):
    return vd.render_core_toml(SAMPLE, account_id="acct123", d1_id="d1-abc", store_id="store-xyz",
                               primary_bucket="vivijure", prefix=prefix,
                               module_service_names=["vivijure-module-keyframe"])


def test_render_base_install_media_less():
    out = _render(prefix="")
    assert 'AUTH_MODE = "token"' in out
    assert 'R2_S3_ENDPOINT = "https://acct123.r2.cloudflarestorage.com"' in out
    assert 'R2_S3_BUCKET = "vivijure"' in out
    assert "${" not in out
    assert 'database_id = "d1-abc"' in out
    assert 'store_id = "store-xyz"' in out
    assert "REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID" not in out
    assert "workers_dev = true" in out and "workers_dev = false" not in out
    for gone in ("[[routes]]", "[[vpc_services]]", "[[migrations]]", "tail_consumers"):
        assert gone not in out, gone
    # no prefixing when empty
    assert 'bucket_name = "vivijure"' in out
    assert 'service = "vivijure-module-keyframe"' in out


def test_render_isolated_adds_prefix():
    out = _render(prefix="proving")
    assert 'bucket_name = "proving-vivijure"' in out
    assert 'R2_S3_BUCKET = "proving-vivijure"' in out
    assert 'service = "proving-vivijure-module-keyframe"' in out
    assert "[[vpc_services]]" not in out and 'database_id = "d1-abc"' in out


def test_render_module_toml_strips_vpc():
    mod = '''name = "vivijure-module-audio-master"
[[vpc_services]]
binding = "AUDIO_MASTER_VPC"
service_id = "REPLACE_WITH_VPC_AUDIO_MASTER_ID"

[[services]]
binding = "X"
'''
    out = vd.render_module_toml(mod)
    assert "[[vpc_services]]" not in out
    assert 'name = "vivijure-module-audio-master"' in out
    assert "[[services]]" in out


def test_wrangler_delete_tolerant_skips_missing(monkeypatch):
    import subprocess as _sp
    class R:
        returncode = 1
        stdout = "This Worker does not exist on your account. [code: 10007]"
        stderr = ""
    monkeypatch.setattr(_sp, "run", lambda *a, **k: R())
    vd.wrangler_delete_tolerant(["delete", "-c", "x"], cwd=vd.Path("."), cf_env={}, label="worker x")


# --- no-silent-adopt guard -------------------------------------------------------------------------

def _fake_cf_api(items):
    def _f(method, path, token, body=None):
        if method == "GET":
            return items
        return {"id": "newly-created", "uuid": "newly-created"}
    return _f


def test_adopt_refused_for_foreign(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "foreign"}]))
    with pytest.raises(SystemExit):
        vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
            create_body={"name": "vivijure-studio"}, name="vivijure-studio", name_key="name",
            id_key="uuid", known_id=None)


def test_recorded_reconciles(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "ours"}]))
    assert vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
        create_body={"name": "vivijure-studio"}, name="vivijure-studio", name_key="name",
        id_key="uuid", known_id="ours").rid == "ours"


def test_adopt_flag_allows(monkeypatch):
    vd._ADOPT = True
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "foreign"}]))
    assert vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
        create_body={"name": "vivijure-studio"}, name="vivijure-studio", name_key="name",
        id_key="uuid", known_id=None).rid == "foreign"


def test_absent_is_created(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([]))
    assert vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
        create_body={"name": "vivijure-studio"}, name="vivijure-studio", name_key="name",
        id_key="uuid", known_id=None).rid == "newly-created"
