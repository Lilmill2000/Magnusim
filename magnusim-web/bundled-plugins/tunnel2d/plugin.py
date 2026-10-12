"""Magnusim 2D Wind Tunnel: a real-time 2D wind tunnel in its own workspace.

An optional bundled plugin. Everything it does runs in its workspace page
(workspace/, built from src/): the flow is solved on the GPU with WebGPU
compute shaders. It has no backend methods, no jobs and no Python environment;
manifest.toml declares the workspace and the "tunnel" study kind. This is the
only Python file in the plugin, and it imports nothing from the app.
"""

from __future__ import annotations

from typing import Any

# SPDX-License-Identifier: GPL-3.0-or-later

KEY = "tunnel2d"


def register(hub: Any) -> None:
    """Nothing to register: the host builds the manifest from manifest.toml."""
