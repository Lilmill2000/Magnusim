"""Only JSON-RPC replies may reach the worker's stdout.

Exporters print progress JSON and native code can write to fd 1; on the shared
pipe that used to interleave with replies.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[2]

NOISY_WORKER = """
import os, sys
from cfddesk.worker import rpc
from cfddesk.worker.__main__ import main

@rpc("test.noisy")
def _noisy():
    print('{"ok": true, "from": "print"}')
    sys.stdout.flush()
    os.write(1, b"native write to fd 1\\n")
    return {"done": True}

raise SystemExit(main())
"""


def test_prints_and_fd1_writes_never_reach_the_reply_pipe():
    reqs = "".join(
        json.dumps({"jsonrpc": "2.0", "id": i, "method": "test.noisy"}) + "\n" for i in (1, 2)
    )
    proc = subprocess.run(
        [sys.executable, "-c", NOISY_WORKER],
        input=reqs,
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(PY_ROOT),
        timeout=120,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    assert [json.loads(ln)["id"] for ln in lines] == [1, 2], proc.stdout
    assert all(json.loads(ln)["result"] == {"done": True} for ln in lines)
    assert "native write to fd 1" in proc.stderr
    assert '"from": "print"' in proc.stderr
