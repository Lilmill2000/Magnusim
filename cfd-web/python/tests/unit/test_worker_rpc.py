"""In-process JSON-RPC worker protocol."""

from __future__ import annotations

import json

import cfddesk.worker.methods  # noqa: F401  — register RPCs
from cfddesk.worker import handle_line


def _rpc(method: str, params=None, req_id: int = 1) -> dict:
    msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        msg["params"] = params
    return json.loads(handle_line(json.dumps(msg)))


def test_worker_ping():
    out = _rpc("worker.ping")
    assert out["result"]["ok"] is True
    assert out["result"]["worker"] == "cfddesk.worker"


def test_unknown_method_32601():
    out = _rpc("nope.missing")
    assert out["error"]["code"] == -32601
    assert "nope.missing" in out["error"]["message"]


def test_filter_warmup_volume_requires_case():
    out = _rpc("filter.warmup_volume", {})
    assert out["error"]["code"] == -32602


def test_filter_release_volume_clears_cache():
    out = _rpc("filter.release_volume", {})
    assert out["result"]["ok"] is True
    assert out["result"]["released"] is True
    assert "n_cleared" in out["result"]


def test_filter_particle_trace_requires_case():
    out = _rpc("filter.particle_trace", {"out_dir": "/tmp/pt"})
    assert out["error"]["code"] == -32602


def test_filter_cut_plane_requires_case():
    out = _rpc("filter.cut_plane", {"out_dir": "/tmp/cut"})
    assert out["error"]["code"] == -32602


def test_worker_stdio_unicode_survives_windows_legacy_codepage():
    import os
    import subprocess
    import sys

    unknown = "missing.\u6e29\u5ea6"
    request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": unknown}, ensure_ascii=False)
    result = subprocess.run(
        [sys.executable, "-m", "cfddesk.worker"],
        input=(request + "\n").encode("utf-8"),
        capture_output=True,
        env={**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"},
        timeout=30,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    response = json.loads(result.stdout.decode("utf-8"))
    assert response["error"]["code"] == -32601
    assert unknown in response["error"]["message"]
