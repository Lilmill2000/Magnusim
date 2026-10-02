"""H7: one time-dependency decision, one Δt, one set of defaults, an honest analysis key."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.project.web_adapter import run_time_dependency
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.analysis import analysis_key_for, analysis_supports_time_dependency
from cfddesk.registry.discovery import get_registry

# Incompressible Flow's half of H7 (mesh sizes, the one time step of the preview and
# the case, the solver prepare_run reports, the one copy of the run defaults) is
# tested with the plugin: bundled-plugins/incompressible_flow/tests/test_time_dependency.py.


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def _layout(tmp_path: Path, *, study_td: str, run_td: str | None, other_active_td: str | None = None) -> Path:
    """One geometry, one study with one run (plus, optionally, another study that is active)."""
    root = tmp_path / "proj"
    geom = root / "geometries" / "Geometry_part"
    _write(geom / "id.json", {"id": "geom-1", "kind": "geometry"})
    study = geom / "simulations" / "Study"
    _write(study / "id.json", {"id": "sim-a", "kind": "simulation", "time_dependency": study_td})
    run = study / "simulation_runs" / "Run_1"
    _write(run / "id.json", {"id": "run-1", "kind": "run"})
    _write(run / "run.json", {"id": "run-1", **({"time_dependency": run_td} if run_td else {})})
    if other_active_td:
        other = geom / "simulations" / "Other"
        _write(other / "id.json", {"id": "sim-b", "kind": "simulation", "time_dependency": other_active_td})
        # The project-level mirror is the *active* study (sim-b), not the run's.
        _write(root / "simulation.json", {"id": "sim-b", "time_dependency": other_active_td})
    return root


def test_run_stamp_wins_over_its_study(tmp_path: Path):
    # A run that solved Transient keeps that mode after its study is switched to Steady.
    root = _layout(tmp_path, study_td="Steady-state", run_td="Transient")
    assert run_time_dependency(root, "run-1", "sim-a") == "transient"


def test_unstamped_run_follows_its_study(tmp_path: Path):
    root = _layout(tmp_path, study_td="Transient", run_td=None)
    assert run_time_dependency(root, "run-1", "sim-a") == "transient"


def test_another_active_study_never_decides(tmp_path: Path):
    # Before H7 the project-level simulation.json mirror (the active study) made
    # every run transient: a queued steady run of another study solved pimpleFoam.
    root = _layout(tmp_path, study_td="Steady-state", run_td=None, other_active_td="Transient")
    assert run_time_dependency(root, "run-1", "sim-a") == "steady"


def test_analysis_key_follows_time_dependency():
    reg = get_registry("analysis")
    assert analysis_key_for("incompressible_steady", "Transient", reg) == "incompressible_transient"
    assert analysis_key_for("incompressible_transient", "Steady-state", reg) == "incompressible_steady"
    assert analysis_key_for("incompressible", "Transient", reg) == "incompressible_transient"
    assert analysis_key_for("", "Steady-state", reg) == "incompressible_steady"
    assert analysis_supports_time_dependency("incompressible_steady", "Transient", reg)


def test_analysis_without_sibling_is_refused_for_the_other_time_dependency():
    from dataclasses import replace

    reg = get_registry("analysis")
    steady = reg.get("incompressible_steady")
    reg.register(replace(steady, key="solo_steady", label="Solo"), plugin="h7-test")
    try:
        assert analysis_key_for("solo_steady", "Transient", reg) == "solo_steady"
        assert not analysis_supports_time_dependency("solo_steady", "Transient", reg)
        assert analysis_supports_time_dependency("solo_steady", "Steady-state", reg)
    finally:
        reg.drop_plugin("h7-test")
