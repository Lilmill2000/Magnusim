"""Long-lived JSON-RPC 2.0 worker (Phase 3)."""

from cfddesk.worker.rpc import RpcError, dispatch, handle_line, rpc

__all__ = ["RpcError", "dispatch", "handle_line", "rpc"]
