"""Unit tests for the secret-store map, #680 heal decision, and #675/#682 state honesty. No live
provider calls."""
import importlib.util
import pathlib
import re
import sys

import pytest

_HERE = pathlib.Path(__file__).parent
_REPO = _HERE.parent
_SPEC = importlib.util.spec_from_file_location("vivijure_deploy", _HERE / "vivijure_deploy.py")
vd = importlib.util.module_from_spec(_SPEC)
sys.modules["vivijure_deploy"] = vd
_SPEC.loader.exec_module(vd)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _secret_names_in_tomls() -> set:
    """The UNION of every `secret_name` bound across wrangler.toml.example + modules/*/wrangler.toml."""
    names = set()
    tomls = [_REPO / "wrangler.toml.example"] + sorted((_REPO / "modules").glob("*/wrangler.toml"))
    for f in tomls:
        for m in re.finditer(r'(?m)^\s*secret_name\s*=\s*"([^"]+)"', f.read_text()):
            names.add(m.group(1))
    return names


# ---- #658 secret map -----------------------------------------------------------------------------

def test_store_binding_names_equal_the_toml_union():
    """The seed manifest must be EXACTLY what the deployed workers bind -- no missing key (10182 at
    deploy) and no dead key (the old bare RUNPOD_ENDPOINT_ID nobody read)."""
    assert set(vd.STORE_BINDING_NAMES) == _secret_names_in_tomls()


def test_no_secret_name_seeded_twice():
    assert len(vd.STORE_BINDING_NAMES) == len(set(vd.STORE_BINDING_NAMES))
    assert not (set(vd.AUTO_STORE_NAMES) & set(vd.OPERATOR_STORE_NAMES))


def test_endpoint_secret_names_cover_every_endpoint():
    assert set(vd.ENDPOINT_SECRET_NAMES) == set(vd.RUNPOD_ENDPOINTS)
    # every per-endpoint store name is in the AUTO-seeded set
    for secname in vd.ENDPOINT_SECRET_NAMES.values():
        assert secname in vd.AUTO_STORE_NAMES


def test_resolved_values_map_each_endpoint_to_its_store_name():
    eps = {ep: f"{ep}-EPID" for ep in vd.RUNPOD_ENDPOINTS}
    cf = {"GATEWAY_ID": "gw", "R2_S3_ACCESS_KEY_ID": "ak", "R2_S3_SECRET_ACCESS_KEY": "sk"}
    vals = vd.resolved_secret_values("rp-key", cf, eps)
    # keys are exactly the auto-seeded set (no operator names leak in)
    assert set(vals) == set(vd.AUTO_STORE_NAMES)
    assert vals["BACKEND_RUNPOD_ENDPOINT_ID"] == "vivijure-backend-EPID"
    assert vals["MUSETALK_RUNPOD_ENDPOINT_ID"] == "vivijure-musetalk-EPID"
    assert vals["VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID"] == "vivijure-upscale-EPID"
    assert vals["AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID"] == "vivijure-audio-upscale-EPID"
    assert vals["RUNPOD_API_KEY"] == "rp-key"


# ---- #680 R2 mint-lost heal decision -------------------------------------------------------------

def test_r2_mint_lost_truth_table():
    # mint-lost: token id recorded, secret gone this run, and absent from the store
    assert vd._r2_mint_lost(token_id_in_state=True, secret_value="", secret_in_store=False) is True
    # healthy re-run: secret present in the store -> NOT lost (skip-empty guard keeps it)
    assert vd._r2_mint_lost(token_id_in_state=True, secret_value="", secret_in_store=True) is False
    # fresh mint this run (value in hand) -> not lost
    assert vd._r2_mint_lost(token_id_in_state=True, secret_value="sk", secret_in_store=False) is False
    # first run, nothing minted yet -> not lost
    assert vd._r2_mint_lost(token_id_in_state=False, secret_value="", secret_in_store=False) is False


# ---- #675 create-500-after-success recovery ------------------------------------------------------

def test_rp_reconcile_recovers_from_create_500_after_success(monkeypatch):
    """A create that raises but whose resource shows up on re-list is recorded as ours, not orphaned."""
    calls = {"n": 0}

    def fake_rp(method, path, key, body=None, *, raise_on_error=False):
        if method == "GET":
            # empty pre-create, then the resource EXISTS on the post-error re-list
            return [] if calls["n"] == 0 else [{"name": "vivijure-backend-vol", "id": "vol-xyz"}]
        if method == "POST":
            calls["n"] = 1
            raise vd.DeployHTTPError("POST", path, 500)
        return {}

    monkeypatch.setattr(vd, "rp_api", fake_rp)
    res = vd.rp_reconcile(kind="network volume", key="k", list_path="/networkvolumes",
                          create_path="/networkvolumes",
                          create_body={"name": "vivijure-backend-vol"}, name="vivijure-backend-vol")
    assert res.rid == "vol-xyz"
    assert res.adopted is False


def test_rp_reconcile_dies_when_create_fails_and_nothing_appears(monkeypatch):
    def fake_rp(method, path, key, body=None, *, raise_on_error=False):
        if method == "GET":
            return []
        raise vd.DeployHTTPError("POST", path, 500)

    monkeypatch.setattr(vd, "rp_api", fake_rp)
    with pytest.raises(SystemExit):
        vd.rp_reconcile(kind="endpoint", key="k", list_path="/endpoints", create_path="/endpoints",
                        create_body={"name": "x"}, name="x")


# ---- #682 state honesty --------------------------------------------------------------------------

def test_state_remove_drops_the_entry(repo):
    st = vd.State.load(repo)
    st.put_resource("gateway_id", "gw-1")
    assert st.resource_id("gateway_id") == "gw-1"
    st.remove("gateway_id")
    assert st.resource_id("gateway_id") is None
    # persisted: a fresh load does not see it
    assert vd.State.load(repo).resource_id("gateway_id") is None


def test_down_removes_state_after_runpod_delete(repo, monkeypatch):
    st = vd.State.load(repo)
    st.put_resource("runpod_endpoint_vivijure-backend", "ep-1", adopted=False)

    def fake_rp(method, path, key, body=None, **kw):
        return {}

    monkeypatch.setattr(vd, "rp_api", fake_rp)
    monkeypatch.setattr(vd, "module_dirs", lambda _r: [])
    monkeypatch.setattr(vd, "wrangler_delete_tolerant", lambda *a, **k: None)
    monkeypatch.setattr(vd, "collect_secrets", lambda **_: vd.Secrets("a", "c", "r"))

    vd.cmd_down(repo, delete_data=False, noninteractive=True)
    # the deleted endpoint's state entry is gone -> a re-run would skip it
    assert vd.State.load(repo).resource_id("runpod_endpoint_vivijure-backend") is None


def test_down_tolerates_runpod_500_on_missing(repo, monkeypatch):
    st = vd.State.load(repo)
    st.put_resource("runpod_endpoint_vivijure-backend", "ep-gone", adopted=False)

    def fake_rp(method, path, key, body=None, *, raise_on_error=False):
        if method == "DELETE":
            raise vd.DeployHTTPError("DELETE", path, 500)  # RunPod's 500-on-missing
        return {}

    monkeypatch.setattr(vd, "rp_api", fake_rp)
    monkeypatch.setattr(vd, "module_dirs", lambda _r: [])
    monkeypatch.setattr(vd, "wrangler_delete_tolerant", lambda *a, **k: None)
    monkeypatch.setattr(vd, "collect_secrets", lambda **_: vd.Secrets("a", "c", "r"))

    # must NOT die; entry removed
    vd.cmd_down(repo, delete_data=False, noninteractive=True)
    assert vd.State.load(repo).resource_id("runpod_endpoint_vivijure-backend") is None


def test_wrangler_delete_warn_gated_on_reality(repo, monkeypatch, capsys):
    """A non-zero wrangler exit whose worker actually vanished logs a success, not a WARN (#682)."""
    class P:
        returncode = 1
        stdout = "some noise"
        stderr = ""
    monkeypatch.setattr(vd.subprocess, "run", lambda *a, **k: P())
    vd.wrangler_delete_tolerant(["delete"], cwd=repo, cf_env={}, label="core worker",
                                verify_gone=lambda: True)
    out = capsys.readouterr().out
    assert "WARN" not in out
    assert "verified via API" in out


# ---- #684 state bound to the Cloudflare account ---------------------------------------------------

def test_state_records_account_on_first_write(repo):
    st = vd.State.load(repo)
    vd.bind_state_to_account(st, vd.Secrets("acct-A", "cf", "rp"))
    assert st.get("cf_account_id") == "acct-A"
    # persisted
    assert vd.State.load(repo).get("cf_account_id") == "acct-A"


def test_state_same_account_is_a_noop(repo):
    st = vd.State.load(repo)
    st.put("cf_account_id", "acct-A")
    vd.bind_state_to_account(st, vd.Secrets("acct-A", "cf", "rp"))  # must not die
    assert st.get("cf_account_id") == "acct-A"


def test_state_second_account_dies_loud(repo):
    st = vd.State.load(repo)
    st.put("cf_account_id", "acct-A")
    with pytest.raises(SystemExit):
        vd.bind_state_to_account(st, vd.Secrets("acct-B", "cf", "rp"))


# ---- #680 heal tolerates an already-revoked stale token ------------------------------------------

def test_revoke_token_tolerant_404_is_already_gone(monkeypatch):
    def fake_http(method, url, token, body=None, *, raise_on_error=False):
        raise vd.DeployHTTPError("DELETE", url, 404)
    monkeypatch.setattr(vd, "http_json", fake_http)
    vd.revoke_token_tolerant("acct", "tok", "tok-gone")  # must NOT raise


def test_revoke_token_tolerant_invalid_id_envelope_is_already_gone(monkeypatch):
    def fake_http(method, url, token, body=None, *, raise_on_error=False):
        return {"success": False, "errors": [{"code": 1000, "message": "Invalid API token id"}]}
    monkeypatch.setattr(vd, "http_json", fake_http)
    vd.revoke_token_tolerant("acct", "tok", "tok-bad")  # must NOT raise


def test_revoke_token_tolerant_real_error_dies(monkeypatch):
    def fake_http(method, url, token, body=None, *, raise_on_error=False):
        raise vd.DeployHTTPError("DELETE", url, 403)  # e.g. permissions -- a real failure
    monkeypatch.setattr(vd, "http_json", fake_http)
    with pytest.raises(SystemExit):
        vd.revoke_token_tolerant("acct", "tok", "tok-live")


def test_down_tolerates_already_revoked_r2_token(repo, monkeypatch):
    """down must not die if the recorded R2 token was revoked out-of-band (#682)."""
    st = vd.State.load(repo)
    st.put("r2_token_id", "rtok-gone")

    def fake_http(method, url, token, body=None, *, raise_on_error=False):
        if method == "DELETE" and "/tokens/" in url:
            raise vd.DeployHTTPError("DELETE", url, 404)
        return {}

    monkeypatch.setattr(vd, "http_json", fake_http)
    monkeypatch.setattr(vd, "rp_api", lambda *a, **k: {})
    monkeypatch.setattr(vd, "module_dirs", lambda _r: [])
    monkeypatch.setattr(vd, "wrangler_delete_tolerant", lambda *a, **k: None)
    monkeypatch.setattr(vd, "collect_secrets", lambda **_: vd.Secrets("a", "c", "r"))

    vd.cmd_down(repo, delete_data=False, noninteractive=True)  # must NOT raise
    assert vd.State.load(repo).resource_id("r2_token_id") is None
