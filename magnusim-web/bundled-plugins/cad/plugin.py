"""Magnusim CAD: the Part workspace (a parametric part modeler in a sandboxed frame).

An optional bundled plugin. Everything it does runs in its workspace page
(workspace/, built from src/): the OCCT kernel and the PlaneGCS sketch solver
are WebAssembly modules in the page's own workers. It has no backend methods,
no jobs and no Python environment; manifest.toml declares the workspace and the
"part" study kind. This is the only Python file in the plugin, and it imports
nothing from the app (python/tools/plugin_boundary.py).
"""

from __future__ import annotations

from typing import Any

KEY = "cad"


def register(hub: Any) -> None:
    """Nothing to register: the host builds the manifest from manifest.toml."""
