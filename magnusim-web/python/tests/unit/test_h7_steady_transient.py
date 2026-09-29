"""H7: one time-dependency decision, one Δt, one set of defaults, an honest analysis key."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from incompressible_flow.transient import (
    TRANSIENT_DEFAULTS,
    control_to_web,
    estimate_delta_t,
    load_mesh_meta,
)

from cfddesk.project.web_adapter import run_time_dependency
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.analysis import analysis_key_for, analysis_supports_time_dependency
from cfddesk.registry.discovery import get_registry
from tests.conftest import run_spec as load_run_spec

PYTHON_ROOT = Path(__file__).resolve().parents[2]
FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"


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


def test_mesh_meta_reads_checkmesh_volumes(tmp_path: Path):
    (tmp_path / "log.checkMesh").write_text(
        "    Min volume = 4.97e-09. Max volume = 1.2e-06.  Total volume = 0.0034.  Cell volumes OK.\n",
        encoding="utf-8",
    )
    _write(tmp_path / "standard-meta.json", {"sizing": {"surface_size_m": 0.004}})
    meta = load_mesh_meta(tmp_path)
    assert meta["min_cell_volume_m3"] == pytest.approx(4.97e-09)
    assert meta["total_volume_m3"] == pytest.approx(0.0034)
    assert meta["sizing"]["surface_size_m"] == 0.004
    assert load_mesh_meta(None) is None


def _case_with_mesh_meta(tmp_path: Path) -> Path:
    root = tmp_path / "js"
    shutil.copytree(FIX, root)
    # load_run_spec(require_mesh=False) solves on the project folder itself.
    (root / "log.checkMesh").write_text("Min volume = 8e-09. Max volume = 1e-06.\n", encoding="utf-8")
    return root


def test_written_delta_t_uses_real_mesh_and_inlet_speed(tmp_path: Path):
    """The bug: Python re-resolved Δt with speed 1.0 and no mesh sizes, so the
    written deltaT differed from the Run panel preview."""
    root = _case_with_mesh_meta(tmp_path)
    spec = load_run_spec(
        root,
        run_id="run-dt",
        require_mesh=False,
        time_dependency="Transient",
        transient_override={"end_time": 5, "write_count": 50},
    )
    assert spec.ok and spec.transient is not None
    assert spec.solver_app == "pimpleFoam"
    assert spec.analysis_key == "incompressible_transient"
    est = spec.transient.estimate or {}
    assert est["basis"] == "min_cell"
    assert est["u_ref"] > 1.0  # the fixture's inlet speed, not the old 1.0 placeholder
    expected = estimate_delta_t(mesh_meta={"min_cell_volume_m3": 8e-09}, speed_ref=est["u_ref"], max_co=1.0)
    assert spec.transient.delta_t == pytest.approx(expected["delta_t"])
    assert spec.transient.source["delta_t"] == "auto"


def test_preview_rpc_shows_the_delta_t_prepare_run_writes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """gate:h7-dt-preview-matches-case (unit level): the preview and the written case are one computation."""
    from cfddesk.worker import methods

    root = _case_with_mesh_meta(tmp_path)
    settings = {"end_time": 5, "write_count": 50}
    spec = load_run_spec(root, run_id="run-dt", require_mesh=False, time_dependency="Transient", transient_override=settings)
    written = control_to_web(spec.transient, settings)

    # The fixture has no generated mesh; solve on the project folder like prepare_run --no-require-mesh.
    from cfddesk.project import run_inputs

    real_gather = run_inputs.gather_run_inputs

    def _inputs_without_mesh(*args, **kwargs):
        kwargs["require_mesh"] = False
        return real_gather(*args, **kwargs)

    monkeypatch.setattr(run_inputs, "gather_run_inputs", _inputs_without_mesh)
    pv = methods.analysis_run_preview(project_dir=str(root), run_id="run-dt", time_dependency="Transient", settings=settings)
    assert pv["partial"] is False
    assert pv["control"]["delta_t"] == pytest.approx(written["delta_t"], rel=1e-12)
    assert pv["control"]["max_delta_t"] == pytest.approx(written["max_delta_t"], rel=1e-12)
    assert pv["control"]["write_interval"] == pytest.approx(written["write_interval"], rel=1e-12)


def test_prepare_run_reports_the_solver_it_wrote_for(tmp_path: Path):
    for td, app, key in (("Transient", "pimpleFoam", "incompressible_transient"), ("Steady-state", "simpleFoam", "incompressible_steady")):
        out = subprocess.run(
            [
                sys.executable,
                str(PYTHON_ROOT / "tools" / "prepare_run.py"),
                "--project-dir",
                str(FIX),
                "--run-id",
                "run-h7",
                "--out-dir",
                str(tmp_path / td),
                "--no-require-mesh",
                "--validate-only",
                "--time-dependency",
                td,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        doc = json.loads(out.stdout.strip().splitlines()[-1])
        assert doc["app"] == app
        assert doc["analysis_key"] == key
        assert doc["time_dependency"] == td
        assert (doc["transient_control"] is not None) == (td == "Transient")


def test_control_schema_defaults_are_the_one_copy():
    """gate:h7-defaults-single-source (Python side)."""
    row = {r["key"]: r for r in get_registry("analysis").describe()}["incompressible_transient"]
    defaults = {k: p.get("default") for k, p in row["control_schema"]["properties"].items()}
    assert defaults == TRANSIENT_DEFAULTS
