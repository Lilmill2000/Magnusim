"""A plugin with full workspaces (gate:h13-*): its backend methods run in-process.

The workspace (workspace/index.html) reaches them through the bridge's
service.call; it cannot reach the app's API itself.
"""

from __future__ import annotations

PLUGIN = "ws-demo"


def _echo(params, scope):
    return {"echo": params.get("text"), "project_id": scope.get("project_id")}


def register(hub):
    hub.register_method(PLUGIN, "echo", _echo)
    return None
