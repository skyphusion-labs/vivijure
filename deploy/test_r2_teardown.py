"""Unit tests for #686: `down --delete-data` must EMPTY a non-empty R2 bucket before deleting it
(Cloudflare refuses a non-empty bucket delete, HTTP 409 code 10008). No live provider calls."""
import importlib.util
import pathlib
import sys

import pytest

_HERE = pathlib.Path(__file__).parent
_SPEC = importlib.util.spec_from_file_location("vivijure_deploy", _HERE / "vivijure_deploy.py")
vd = importlib.util.module_from_spec(_SPEC)
sys.modules["vivijure_deploy"] = vd
_SPEC.loader.exec_module(vd)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_empty_r2_bucket_paginates_and_deletes_every_object(monkeypatch):
    pages = [
        {"success": True, "result": [{"key": "a.txt"}, {"key": "dir/b.txt"}], "result_info": {"cursor": "C1"}},
        {"success": True, "result": [{"key": "c.txt"}], "result_info": {"cursor": None}},
    ]
    seen_urls = []
    calls = {"n": 0}

    def fake_http_json(method, url, token, body=None, **kw):
        seen_urls.append(url)
        page = pages[calls["n"]]
        calls["n"] += 1
        return page

    deleted = []

    def fake_cf_api(method, path, token, body=None):
        if method == "DELETE":
            deleted.append(path)
        return {}

    monkeypatch.setattr(vd, "http_json", fake_http_json)
    monkeypatch.setattr(vd, "cf_api", fake_cf_api)

    n = vd.empty_r2_bucket("acct", "tok", "bkt")
    assert n == 3
    assert len(deleted) == 3
    assert any("dir%2Fb.txt" in d for d in deleted)
    assert any("cursor=C1" in u for u in seen_urls)


def test_empty_r2_bucket_already_empty_is_zero_and_no_delete(monkeypatch):
    monkeypatch.setattr(vd, "http_json", lambda *a, **k: {"success": True, "result": [], "result_info": {}})
    called = []
    monkeypatch.setattr(vd, "cf_api", lambda m, p, t, body=None: called.append((m, p)) or {})
    assert vd.empty_r2_bucket("a", "t", "b") == 0
    assert called == []


def test_cmd_down_delete_data_empties_before_bucket_delete(repo, monkeypatch):
    st = vd.State.load(repo)
    st.put("r2_buckets", ["vivijure"])

    order = []
    monkeypatch.setattr(vd, "empty_r2_bucket", lambda acct, tok, b: order.append(f"empty:{b}") or 2)

    def fake_cf_api(method, path, token, body=None):
        if method == "DELETE" and "/r2/buckets/" in path:
            order.append("delbucket:" + path.rsplit("/", 1)[-1])
        return {}

    monkeypatch.setattr(vd, "cf_api", fake_cf_api)
    monkeypatch.setattr(vd, "rp_api", lambda *a, **k: {})
    monkeypatch.setattr(vd, "module_dirs", lambda _r: [])
    monkeypatch.setattr(vd, "wrangler_delete_tolerant", lambda *a, **k: None)
    monkeypatch.setattr(vd, "collect_secrets", lambda **_: vd.Secrets("acct", "tok", "r2"))
    monkeypatch.setattr(vd, "bind_state_to_account", lambda _st, _s: None)

    vd.cmd_down(repo, delete_data=True, noninteractive=True)

    assert "empty:vivijure" in order and "delbucket:vivijure" in order
    assert order.index("empty:vivijure") < order.index("delbucket:vivijure")
