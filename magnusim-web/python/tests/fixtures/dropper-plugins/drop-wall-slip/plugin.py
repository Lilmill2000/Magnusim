"""Test fixture (e2e/h8-contract.spec.js): drops a BC type the required plugin's analyses use.

Incompressible Flow protects its BC types, so this fixture lifts that protection
first: it stands for a plugin that gets around it and knocks the required
plugin out at load.
"""

from __future__ import annotations

from typing import Any

from cfddesk.registry import base


def register(hub: Any) -> None:
    base._PLUGIN_PROTECTED.discard(("bc", "wall_slip"))
    hub.unregister("bc", "wall_slip", plugin="drop-wall-slip")
