"""Hook reserved: registers ``mesh.result``, a reserved name that never fires in
API 1.3. Registering it stays legal; the host logs it once."""

from __future__ import annotations

from cfddesk.registry.hooks import get_hooks

PLUGIN = "hook-reserved"


def _on_mesh_result(**_ignored) -> None:
    return None


def register(hub):
    del hub
    get_hooks().on("mesh.result", _on_mesh_result, plugin=PLUGIN)
    return None
