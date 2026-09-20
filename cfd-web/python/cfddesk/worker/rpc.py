"""JSON-RPC 2.0 dispatcher used by ``python -m cfddesk.worker``."""

from __future__ import annotations

import json
import traceback
from collections.abc import Callable
from typing import Any

Handler = Callable[..., Any]
_HANDLERS: dict[str, Handler] = {}


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            out["data"] = self.data
        return out


def rpc(name: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        _HANDLERS[name] = fn
        return fn

    return deco


def dispatch(method: str, params: Any = None) -> Any:
    if method not in _HANDLERS:
        raise RpcError(-32601, f"method not found: {method}")
    fn = _HANDLERS[method]
    if params is None:
        return fn()
    if isinstance(params, list):
        return fn(*params)
    if isinstance(params, dict):
        return fn(**params)
    return fn(params)


def handle_line(line: str) -> str | None:
    raw = (line or "").strip()
    if not raw:
        return None
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError as exc:
        return json.dumps(
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"parse error: {exc}"},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    if not isinstance(msg, dict):
        return json.dumps(
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32600, "message": "invalid request"},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    req_id = msg.get("id")
    method = str(msg.get("method") or "")
    params = msg.get("params")
    try:
        result = dispatch(method, params)
        return json.dumps(
            {"jsonrpc": "2.0", "id": req_id, "result": result},
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        )
    except RpcError as exc:
        return json.dumps(
            {"jsonrpc": "2.0", "id": req_id, "error": exc.to_dict()},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except TypeError as exc:
        return json.dumps(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": f"invalid params: {exc}"},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except Exception as exc:
        return json.dumps(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32000,
                    "message": str(exc),
                    "data": traceback.format_exc(limit=8),
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
