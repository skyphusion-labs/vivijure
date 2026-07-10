"""Unit tests for the #244 instance-isolation seam: DEPLOY_PREFIX name derivation, the pure core-toml
transform, and the no-silent-adopt guard. Pure/mocked -- NO live provider calls.

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
    """Every test starts from the verbatim default and restores it."""
    p, a = vd.DEPLOY_PREFIX, vd._ADOPT
    vd.DEPLOY_PREFIX, vd._ADOPT = "", False
    yield
    vd.DEPLOY_PREFIX, vd._ADOPT = p, a


# --- prefixed() + state_file_name(): empty = verbatim, set = "<prefix>-<name>" -----------------------

def test_prefixed_empty_is_verbatim():
    assert vd.prefixed("vivijure-studio") == "vivijure-studio"
    assert vd.prefixed("vivijure") == "vivijure"


def test_prefixed_applies_when_set():
    vd.DEPLOY_PREFIX = "proving"
    assert vd.prefixed("vivijure-studio") == "proving-vivijure-studio"
    assert vd.prefixed("vivijure-module-keyframe") == "proving-vivijure-module-keyframe"


def test_prefixed_whitespace_treated_as_empty():
    vd.DEPLOY_PREFIX = "   "
    assert vd.prefixed("vivijure") == "vivijure"


def test_state_file_name():
    assert vd.state_file_name() == vd.STATE_FILE == ".vivijure-deploy.json"
    vd.DEPLOY_PREFIX = "proving"
    assert vd.state_file_name() == ".proving-vivijure-deploy.json"


# --- transform_core_toml(): the pure isolated-instance render --------------------------------------

SAMPLE = '''name = "vivijure-studio"
workers_dev = false
tail_consumers = [ { service = "vivijure-tail" } ]

[[r2_buckets]]
binding = "R2_RENDERS"
bucket_name = "vivijure"

[[r2_buckets]]
binding = "R2"
bucket_name = "skyphusion-llm"

[vars]
R2_S3_BUCKET = "vivijure"

[[d1_databases]]
binding = "DB"
database_id = "${D1_DATABASE_ID}"

[[migrations]]
tag = "v2-drop-cpu-containers"
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


def test_transform_empty_prefix_is_identity():
    assert vd.transform_core_toml(SAMPLE, prefix="", module_service_names=["vivijure-module-keyframe"],
                                  d1_id="x", store_id="y") == SAMPLE


def test_transform_isolated_render():
    out = vd.transform_core_toml(
        SAMPLE, prefix="proving",
        module_service_names=["vivijure-module-keyframe"],
        d1_id="d1-abc-123", store_id="store-xyz-9")
    # services repointed
    assert 'service = "proving-vivijure-module-keyframe"' in out
    assert 'service = "vivijure-module-keyframe"' not in out
    # both buckets rebound (binding + the S3 var)
    assert 'bucket_name = "proving-vivijure"' in out
    assert 'bucket_name = "proving-skyphusion-llm"' in out
    assert 'R2_S3_BUCKET = "proving-vivijure"' in out
    # ids injected
    assert 'database_id = "d1-abc-123"' in out
    assert 'store_id = "store-xyz-9"' in out
    assert "REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID" not in out
    # reachable without a domain
    assert "workers_dev = true" in out
    assert "workers_dev = false" not in out
    # dangling / inapplicable blocks stripped
    assert "[[routes]]" not in out
    assert "[[vpc_services]]" not in out
    assert "[[migrations]]" not in out
    assert "tail_consumers" not in out
    # untouched: the D1 binding block header survives (only the id line changed)
    assert "[[d1_databases]]" in out
    assert 'binding = "DB"' in out


# --- no-silent-adopt guard -------------------------------------------------------------------------

def _fake_cf_api(items):
    def _f(method, path, token, body=None):
        if method == "GET":
            return items
        return {"id": "newly-created", "uuid": "newly-created"}
    return _f


def test_adopt_refused_for_foreign_resource(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "foreign-id"}]))
    with pytest.raises(SystemExit):
        vd.create_if_absent(kind="D1 database", account="a", token="t",
            list_path="/x", create_path="/x", create_body={"name": "vivijure-studio"},
            name="vivijure-studio", name_key="name", id_key="uuid", known_id=None)


def test_recorded_resource_reconciles_silently(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "ours-id"}]))
    rid = vd.create_if_absent(kind="D1 database", account="a", token="t",
        list_path="/x", create_path="/x", create_body={"name": "vivijure-studio"},
        name="vivijure-studio", name_key="name", id_key="uuid", known_id="ours-id")
    assert rid == "ours-id"


def test_adopt_flag_allows_foreign(monkeypatch):
    vd._ADOPT = True
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "foreign-id"}]))
    rid = vd.create_if_absent(kind="D1 database", account="a", token="t",
        list_path="/x", create_path="/x", create_body={"name": "vivijure-studio"},
        name="vivijure-studio", name_key="name", id_key="uuid", known_id=None)
    assert rid == "foreign-id"


def test_absent_resource_is_created(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([]))
    rid = vd.create_if_absent(kind="D1 database", account="a", token="t",
        list_path="/x", create_path="/x", create_body={"name": "vivijure-studio"},
        name="vivijure-studio", name_key="name", id_key="uuid", known_id=None)
    assert rid == "newly-created"
