"""Unit tests for deploy adopt provenance + down skip behavior (#659). No live provider calls."""
import importlib.util
import pathlib
import sys
from io import StringIO

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


@pytest.fixture(autouse=True)
def _creds(monkeypatch):
    monkeypatch.setattr(vd, "collect_secrets", lambda **_: vd.Secrets("acct", "cf-tok", "rp-key"))


def test_adopt_records_provenance_in_state(repo):
    st = vd.State.load(repo)
    st.put_resource("d1_id", "foreign-uuid", adopted=True)
    assert st.resource_id("d1_id") == "foreign-uuid"
    assert st.is_adopted("d1_id") is True


def test_created_records_plain_string(repo):
    st = vd.State.load(repo)
    st.put_resource("d1_id", "ours-uuid", adopted=False)
    assert st.resource_id("d1_id") == "ours-uuid"
    assert st.is_adopted("d1_id") is False
    assert st.data["d1_id"] == "ours-uuid"


def test_legacy_state_treated_as_created(repo):
    st = vd.State.load(repo)
    st.put("d1_id", "legacy-uuid")
    assert st.is_adopted("d1_id") is False


def test_down_skips_adopted_runpod(repo, monkeypatch, capsys):
    st = vd.State.load(repo)
    st.put_resource("runpod_endpoint_vivijure-backend", "ep-adopted", adopted=True)
    deleted = []

    def fake_rp(method, path, key, body=None, **kw):
        deleted.append((method, path))
        return {}

    monkeypatch.setattr(vd, "rp_api", fake_rp)
    monkeypatch.setattr(vd, "module_dirs", lambda _r: [])
    monkeypatch.setattr(vd, "wrangler_delete_tolerant", lambda *a, **k: None)

    vd.cmd_down(repo, delete_data=False, noninteractive=True)
    out = capsys.readouterr().out
    assert "skipping adopted RunPod endpoint ep-adopted" in out
    assert not any(m == "DELETE" and "ep-adopted" in p for m, p in deleted)


def test_down_deletes_created_runpod(repo, monkeypatch, capsys):
    st = vd.State.load(repo)
    st.put_resource("runpod_endpoint_vivijure-backend", "ep-created", adopted=False)
    deleted = []

    def fake_rp(method, path, key, body=None, **kw):
        deleted.append((method, path))
        return {}

    monkeypatch.setattr(vd, "rp_api", fake_rp)
    monkeypatch.setattr(vd, "module_dirs", lambda _r: [])
    monkeypatch.setattr(vd, "wrangler_delete_tolerant", lambda *a, **k: None)

    vd.cmd_down(repo, delete_data=False, noninteractive=True)
    assert ("DELETE", "/endpoints/ep-created") in deleted


def test_down_include_adopted_deletes_adopted(repo, monkeypatch, capsys):
    st = vd.State.load(repo)
    st.put_resource("runpod_endpoint_vivijure-backend", "ep-adopted", adopted=True)
    deleted = []

    def fake_rp(method, path, key, body=None, **kw):
        deleted.append((method, path))
        return {}

    monkeypatch.setattr(vd, "rp_api", fake_rp)
    monkeypatch.setattr(vd, "module_dirs", lambda _r: [])
    monkeypatch.setattr(vd, "wrangler_delete_tolerant", lambda *a, **k: None)

    vd.cmd_down(repo, delete_data=False, noninteractive=True, include_adopted=True)
    out = capsys.readouterr().out
    assert "WARNING: --include-adopted" in out
    assert ("DELETE", "/endpoints/ep-adopted") in deleted


def test_create_if_absent_adopt_sets_adopted_flag(monkeypatch, repo):
    vd._ADOPT = True
    monkeypatch.setattr(vd, "cf_api", lambda *a, **k: [{"name": "vivijure", "uuid": "foreign"}]
                        if a[0] == "GET" else {"uuid": "new"})
    st = vd.State.load(repo)
    res = vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
        create_body={"name": "vivijure"}, name="vivijure", name_key="name", id_key="uuid", known_id=None)
    assert res.adopted is True
    st.put_resource("d1_id", res.rid, adopted=res.adopted)
    assert st.is_adopted("d1_id") is True
