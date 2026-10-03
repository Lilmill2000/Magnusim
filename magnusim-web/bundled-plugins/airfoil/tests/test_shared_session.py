"""These tests run in the core's own pytest session (python/pyproject.toml lists this
folder in testpaths), so ``npm test`` and CI run them.

Two traps of a shared session, both seen:

- putting the plugin folder first on sys.path made the core's
  ``from tests.conftest import ...`` find this folder's conftest instead;
- Incompressible Flow's tests import their constants ``from conftest``, which is
  whichever folder-level conftest pytest loaded last. This folder's conftest must
  therefore load before theirs: its testpaths entry comes before Incompressible
  Flow's (and nothing here imports from ``conftest``).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
CORE_PY = PLUGIN_DIR.parents[1] / "python"
OWN = "../bundled-plugins/airfoil/tests"
IF = "../bundled-plugins/incompressible_flow/tests"


def _testpaths() -> list[str]:
    text = (CORE_PY / "pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r"^testpaths\s*=\s*\[([^\]]*)\]", text, re.MULTILINE)
    assert m, "python/pyproject.toml has no testpaths"
    return re.findall(r'"([^"]+)"', m.group(1))


def _core_test_using_its_conftest() -> Path | None:
    unit = CORE_PY / "tests" / "unit"
    for p in sorted(unit.glob("test_*.py")):
        if "from tests.conftest import" in p.read_text(encoding="utf-8", errors="replace"):
            return p
    return None


@pytest.fixture
def core():
    if not (CORE_PY / "tests" / "conftest.py").is_file() or not (CORE_PY / "pyproject.toml").is_file():
        pytest.skip("not inside the Magnusim checkout (no python/tests)")


def test_the_core_session_runs_these_tests_before_incompressible_flows(core):
    paths = _testpaths()
    assert OWN in paths, f"python/pyproject.toml testpaths does not list {OWN}: these tests would run nowhere by default"
    if IF in paths:
        assert paths.index(OWN) < paths.index(IF), "Incompressible Flow's `from conftest import` would get this folder's conftest"


def test_core_and_airfoil_tests_collect_in_one_session(core):
    """The testpaths in their order: one core test that imports tests.conftest stands for
    the core, the plugin folders in full."""
    first = _core_test_using_its_conftest()
    if first is None:
        pytest.skip("no core test imports tests.conftest")
    args: list[str] = []
    for p in _testpaths():
        if p == "tests":
            args.append(str(first))
        elif (CORE_PY / p).is_dir():
            args.append(p)
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    env.pop("PYTHONPATH", None)
    cmd = [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", *args]
    done = subprocess.run(cmd, cwd=str(CORE_PY), env=env, capture_output=True, text=True, timeout=300)
    out = done.stdout + done.stderr
    assert done.returncode == 0, out[-3000:]
    assert "test_shared_session.py::test_core_and_airfoil_tests_collect_in_one_session" in out
