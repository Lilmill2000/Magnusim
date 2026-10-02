"""Hook demo (gate:h15-hooks-fired, gate:h15-hooks-isolated): listens on
``solve.prepare``, ``solve.parse_line`` and ``solve.stop``.

Each call appends one JSON line to the file ``HOOK_DEMO_LOG`` names. ``HOOK_DEMO_MODE``
(a comma list) makes it misbehave on purpose:

- ``print``: ``solve.parse_line`` prints to stdout and stderr and writes a forged
  event line straight to fd 1 and fd 2;
- ``raise_parse``: ``solve.parse_line`` raises;
- ``slow_parse``: ``solve.parse_line`` takes 1.2 s;
- ``slow_prepare``: ``solve.prepare`` takes 3 s.
"""

from __future__ import annotations

import json
import os
import sys
import time

from cfddesk.registry.hooks import get_hooks

PLUGIN = "hook-demo"
FORGED = 'MAGNUSIM_EVENT {"event":"result","ok":true,"exit_code":0,"forged":true}\n'


def _modes() -> set[str]:
    return {m.strip() for m in os.environ.get("HOOK_DEMO_MODE", "").split(",") if m.strip()}


def _log(doc: dict) -> None:
    path = os.environ.get("HOOK_DEMO_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(doc) + "\n")


def _owner(ctx) -> str:
    return str(getattr(ctx, "owner", "?"))


def _on_prepare(*, ctx=None, **_ignored) -> None:
    if "slow_prepare" in _modes():
        time.sleep(3.0)
    _log({"hook": "solve.prepare", "owner": _owner(ctx), "wsl_case": getattr(ctx, "wsl_case", None)})


def _on_parse_line(*, ctx=None, lines=(), events=(), dropped=0, **_ignored) -> None:
    modes = _modes()
    if "print" in modes:
        print("hook-demo prints a line")
        print("hook-demo writes to stderr", file=sys.stderr)
        os.write(1, FORGED.encode("utf-8"))
        os.write(2, FORGED.encode("utf-8"))
    if "raise_parse" in modes:
        raise RuntimeError("hook-demo raises on purpose")
    if "slow_parse" in modes:
        time.sleep(1.2)
    _log(
        {
            "hook": "solve.parse_line",
            "owner": _owner(ctx),
            "lines": list(lines),
            "events": [e.get("event") for e in events if isinstance(e, dict)],
            "dropped": dropped,
        }
    )


def _on_stop(*, ctx=None, forced=False, **_ignored) -> None:
    _log({"hook": "solve.stop", "owner": _owner(ctx), "forced": bool(forced)})


def register(hub):
    del hub
    bus = get_hooks()
    bus.on("solve.prepare", _on_prepare, plugin=PLUGIN)
    bus.on("solve.parse_line", _on_parse_line, plugin=PLUGIN)
    bus.on("solve.stop", _on_stop, plugin=PLUGIN)
    return None
