"""Heat Transfer's tests: their own settings file, fixtures and goldens.

Nothing here is imported by name (``from conftest import``): Incompressible Flow's
tests import their constants that way, and a shared pytest session holds one
``conftest`` module. Shared constants live in ``ht_inputs``.

The core (cfddesk) and Incompressible Flow's exported module are imported; both
pytest configs put them on the path, and this file covers any other way of
running these tests.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
IF_ROOT = PLUGIN_ROOT.parent / "incompressible_flow"
for _root in (PLUGIN_ROOT, IF_ROOT):
    if not any(p and Path(p).resolve() == _root for p in sys.path):
        sys.path.append(str(_root))


def pytest_configure(config):
    config.addinivalue_line("markers", "validation: the validation set (WSL, about two hours); runs only with -m validation")


def pytest_collection_modifyitems(config, items):
    """The validation set runs when asked for (``-m validation``, or HT_VALIDATION=1), not
    in every ``-m wsl`` run."""
    if "validation" in (config.getoption("markexpr", "") or "") or os.environ.get("HT_VALIDATION") == "1":
        return
    skip = pytest.mark.skip(reason="the validation set runs with -m validation (or HT_VALIDATION=1)")
    for item in items:
        if item.get_closest_marker("validation"):
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def _own_local_json(request, tmp_path_factory, monkeypatch):
    """Each test reads an empty settings file of its own, never this PC's (WSL tests keep
    the PC's file, which holds the toolchain settings they need)."""
    if request.node.get_closest_marker("wsl"):
        return
    monkeypatch.delenv("MAGNUSIM_LOCAL_JSON", raising=False)
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(tmp_path_factory.mktemp("local") / ".magnusim-local.json"))


@pytest.fixture
def update_golden() -> bool:
    return os.environ.get("CFDDESK_UPDATE_GOLDEN", "").strip() in ("1", "true", "yes")
