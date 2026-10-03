"""The Airfoil plugin's tests: its own package on the path, a scratch project with a study."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
TESTS_DIR = Path(__file__).resolve().parent
# Appended, never put first: the plugin folder also has a ``tests`` folder, which
# must not hide the core's ``tests.conftest`` when the core's pytest runs these tests
# in its own session (python/pyproject.toml testpaths). For the same reason no test
# here imports from ``conftest``: in a shared session that name is whichever
# conftest pytest loaded last.
for _p in (PLUGIN_DIR, PLUGIN_DIR.parents[1] / "python" / "sdk"):
    if not any(p and Path(p).resolve() == _p for p in sys.path):
        sys.path.append(str(_p))

FAKE_XFOIL = TESTS_DIR / "fake_xfoil.py"


@pytest.fixture
def project(tmp_path):
    """(PluginData, scope, study id) of a new Airfoil analysis study in a scratch project."""
    from magnusim_sdk.data import PluginData

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    data = PluginData(project_dir, "airfoil")
    rec = data.create_study("airfoil_analysis", "Airfoil analysis 1", plugin_name="Airfoil", plugin_version="0.1.0")
    scope = {"plugin": "airfoil", "project_id": "proj", "project_dir": str(project_dir)}
    return data, scope, rec["id"]


@pytest.fixture
def fake_xfoil():
    """The command that runs the stand-in XFOIL (tests/fake_xfoil.py)."""
    return [sys.executable, str(FAKE_XFOIL)]


def pytest_configure(config):
    # The core's pytest declares it too (python/pyproject.toml); run from this folder, this does.
    config.addinivalue_line("markers", "wsl: needs WSL + OpenFOAM (deselect with -m 'not wsl')")
