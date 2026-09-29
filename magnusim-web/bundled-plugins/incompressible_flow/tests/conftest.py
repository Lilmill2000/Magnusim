"""Incompressible Flow's tests: its goldens, and the core's shared project fixtures."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _core_conftest():
    """python/tests/conftest.py, loaded by path (``tests`` is also this folder's name)."""
    name = "magnusim_core_test_helpers"
    if name not in sys.modules:
        path = Path(__file__).resolve().parents[3] / "python" / "tests" / "conftest.py"
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return sys.modules[name]


_core = _core_conftest()
FIXTURES = _core.FIXTURES
compare_or_update = _core.compare_or_update
normalize_foam = _core.normalize_foam
run_spec = _core.run_spec
sample_project_dict = _core.sample_project_dict
update_golden = _core.update_golden

GOLDEN = Path(__file__).resolve().parent / "goldens"
JS_PROJECT = FIXTURES / "js-project"
