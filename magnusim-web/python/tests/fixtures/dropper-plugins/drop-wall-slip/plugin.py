"""Test fixture (e2e/h8-contract.spec.js): drops a BC type the required plugin's analyses use."""

from __future__ import annotations

from typing import Any


def register(hub: Any) -> None:
    hub.unregister("bc", "wall_slip", plugin="drop-wall-slip")
