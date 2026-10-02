"""Steady or transient, as Incompressible Flow writes it: mesh sizes, one Δt for the
preview and the case, the solver prepare_run reports, one copy of the run defaults."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import cfddesk
import pytest
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.transient import (
    STEADY_DEFAULTS,
    TRANSIENT_DEFAULTS,
    control_to_web,
    estimate_delta_t,
    load_mesh_meta,
)

PYTHON_ROOT = Path(cfddesk.__file__).resolve().parents[1]
FIX = JS_PROJECT


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


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
    """gate:h7-defaults-single-source (Python side): the control schema the analysis
    describes is the one copy of the run-control defaults; a blank time step is
    "auto" (null), not 0.001."""
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    for key, expected in (("incompressible_transient", TRANSIENT_DEFAULTS), ("incompressible_steady", STEADY_DEFAULTS)):
        defaults = {k: p.get("default") for k, p in rows[key]["control_schema"]["properties"].items()}
        assert defaults == expected, key
