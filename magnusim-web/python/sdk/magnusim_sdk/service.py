"""A plugin's service: its backend, in its own environment and its own process.

The host starts it as ``<env python> -I -m magnusim_sdk.service <module>`` in
the plugin's folder the first time the app calls one of its methods
(``/api/plugin/<key>/<method>``). The module registers its methods with
:func:`method`::

    from magnusim_sdk.service import method

    @method("polar", timeout_s=120)
    def polar(params, scope):
        ...
        return {"cl": cl}

A method gets the call's ``params`` (the request's JSON body, or its query) and
its ``scope``: ``plugin``, ``project_id``, ``project_dir``, ``simulation_id``,
``geometry_id``. The plugin's own folder in the project is
``magnusim_sdk.data.PluginData(scope["project_dir"], scope["plugin"])``. A
method returns something JSON can carry; an exception becomes the call's error
(its message is what the app shows).

A method named ``migrate_study`` upgrades a study saved with an older
``schema_version`` of its kind: it gets ``{"study", "from_version",
"to_version"}`` and returns the upgraded record; the host stores it.

Protocol, one JSON object per line: the host writes requests to stdin,
``{"id", "method", "params": {"params", "scope"}}``, and the service answers each
on its reply stream, the original stdout. File descriptor 1 is pointed at
stderr before the module is imported, so prints and native writes land in the
log and can never corrupt a reply. The first line is
``{"method": "ready", "params": {"methods": {name: {"timeout_s"}}, ...}}``
(or ``"failed"`` with the import error). Calls run one at a time. The host stops
an idle service after 10 minutes, restarts it after a crash, and kills it when
a call outlives its timeout (30 s unless the method says otherwise, 600 s at
most).

Standard library only.
"""

from __future__ import annotations

import importlib
import json
import os
import re
import sys
import traceback
from collections.abc import Callable
from io import TextIOWrapper
from typing import Any, TextIO

from magnusim_sdk import SDK_VERSION

Handler = Callable[[dict[str, Any], dict[str, Any]], Any]

DEFAULT_TIMEOUT_S = 30.0
MAX_TIMEOUT_S = 600.0

METHOD_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}$")
MODULE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")

_METHODS: dict[str, tuple[Handler, float]] = {}


def method(name: str | None = None, *, timeout_s: float | None = None) -> Callable[[Handler], Handler]:
    """Register ``fn(params, scope)`` as the service method ``name`` (default: its own name)."""

    def register(fn: Handler) -> Handler:
        key = str(name or getattr(fn, "__name__", ""))
        if not METHOD_NAME.match(key) or ".." in key.split("/"):
            raise ValueError(f"not a method name: {key!r}")
        limit = DEFAULT_TIMEOUT_S if timeout_s is None else float(timeout_s)
        if not 0 < limit <= MAX_TIMEOUT_S:
            raise ValueError(f"timeout_s for {key!r} must be in (0, {MAX_TIMEOUT_S:g}]")
        _METHODS[key] = (fn, limit)
        return fn

    return register


def methods() -> dict[str, dict[str, float]]:
    """The registered methods and their timeouts, as the ready line reports them."""
    return {key: {"timeout_s": limit} for key, (_fn, limit) in sorted(_METHODS.items())}


def reset_for_tests() -> None:
    _METHODS.clear()


def _error(rid: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def handle(line: str) -> dict[str, Any]:
    """Answer one request line."""
    try:
        req = json.loads(line)
    except ValueError:
        return _error(None, -32700, "parse error")
    if not isinstance(req, dict):
        return _error(None, -32600, "a request is a JSON object")
    rid = req.get("id")
    name = str(req.get("method") or "")
    entry = _METHODS.get(name)
    if entry is None:
        return _error(rid, -32601, f"this plugin has no method {name!r}")
    body = req.get("params") if isinstance(req.get("params"), dict) else {}
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    scope = body.get("scope") if isinstance(body.get("scope"), dict) else {}
    try:
        result = entry[0](params, scope)
        json.dumps(result)
    except Exception as exc:  # noqa: BLE001 - every method error is the call's answer
        traceback.print_exc(file=sys.stderr)
        return _error(rid, -32000, str(exc) or type(exc).__name__)
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _private_reply_stream() -> TextIO:
    """Keep the real stdout for replies only; point fd 1 (and Windows' handle) at stderr."""
    sys.stdout.flush()
    reply_fd = os.dup(1)
    os.dup2(2, 1)
    if sys.platform == "win32":
        try:
            import ctypes
            import msvcrt

            std_output_handle = -11
            ctypes.windll.kernel32.SetStdHandle(std_output_handle, msvcrt.get_osfhandle(2))  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - best effort; fd 1 is already redirected
            pass
    return open(reply_fd, "w", encoding="utf-8")  # noqa: SIM115 - lives as long as the service


def _send(stream: TextIO, doc: dict[str, Any]) -> None:
    stream.write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")
    stream.flush()


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1 or not MODULE_NAME.match(args[0]):
        print("usage: python -m magnusim_sdk.service <module>", file=sys.stderr)
        return 2
    if isinstance(sys.stdin, TextIOWrapper):
        sys.stdin.reconfigure(encoding="utf-8")
    replies = _private_reply_stream()
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, TextIOWrapper):
            stream.reconfigure(encoding="utf-8", errors="replace")
    # The plugin's folder (the working directory) holds its module; -I left it off the path.
    here = os.getcwd()
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        importlib.import_module(args[0])
    except Exception as exc:  # noqa: BLE001 - reported to the host, which shows it
        traceback.print_exc(file=sys.stderr)
        _send(replies, {"jsonrpc": "2.0", "method": "failed", "params": {"error": f"{type(exc).__name__}: {exc}"}})
        return 1
    _send(
        replies,
        {
            "jsonrpc": "2.0",
            "method": "ready",
            "params": {
                "methods": methods(),
                "sdk": SDK_VERSION,
                "python": ".".join(str(n) for n in sys.version_info[:3]),
                "prefix": sys.prefix,
            },
        },
    )
    for line in sys.stdin:
        if line.strip():
            _send(replies, handle(line))
    return 0


if __name__ == "__main__":
    # Run as `-m`, this file is __main__; the plugin's `from magnusim_sdk.service
    # import method` loads the module itself. Serve from that one, so both see
    # the same registered methods.
    from magnusim_sdk import service as _service

    raise SystemExit(_service.main())
