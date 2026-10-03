"""The Airfoil plugin's own environment (requirements.lock) for the tests that need it.

Built on this PC, its interpreter is returned. Not built, those tests skip, except in
the full tier: MAGNUSIM_E2E_WSL=1 (the local tier, as the WSL e2e specs) or
MAGNUSIM_E2E_FULL=1, where a lock change is exactly when they must run, so they fail
and say how to build it. (A unique module name: the core's pytest collects these tests
in its own session, where ``conftest`` is whichever folder's pytest loaded last.)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
NOT_BUILT = (
    "the Airfoil plugin's environment is not built for this requirements.lock on this PC: "
    "build it in Settings → Plugins → Install dependencies"
)


def full_tier() -> bool:
    return os.environ.get("MAGNUSIM_E2E_WSL") == "1" or os.environ.get("MAGNUSIM_E2E_FULL") == "1"


def plugin_env_python() -> Path | None:
    """The plugin environment's interpreter, when it is built for the plugin's lock."""
    web = PLUGIN_DIR.parents[1]
    if str(web / "python") not in sys.path:
        sys.path.insert(0, str(web / "python"))
    try:
        from cfddesk.registry import plugin_env
        from cfddesk.registry.discovery import _parse_simple_toml
    except ImportError:
        return None
    meta = _parse_simple_toml((PLUGIN_DIR / "manifest.toml").read_text(encoding="utf-8"), source="manifest.toml")
    spec = plugin_env.python_env_from_meta(meta, PLUGIN_DIR)
    if plugin_env.env_status(web, "airfoil", spec).get("state") != "ready":
        return None
    py = plugin_env.env_python(plugin_env.env_dir(web, "airfoil", spec))
    return py if py.is_file() else None


def need_plugin_env() -> Path:
    """The interpreter, or skip (fail in the full tier) with how to build it."""
    py = plugin_env_python()
    if py is None:
        if full_tier():
            pytest.fail(f"{NOT_BUILT} (the full tier runs these tests; it does not skip them)")
        pytest.skip(NOT_BUILT)
    return py
