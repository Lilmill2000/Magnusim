"""analysis.plan_case: the report write_case gives, without writing anything
(prepare_run --validate-only)."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from cfddesk.project.run_inputs import gather_run_inputs
from cfddesk.registry import CaseContext, get_registry, load_all, reset_for_tests
from conftest import JS_PROJECT


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    shutil.copytree(JS_PROJECT, root)
    return root


def _files(root: Path) -> dict[str, int]:
    return {p.relative_to(root).as_posix(): p.stat().st_mtime_ns for p in root.rglob("*") if p.is_file()}


def test_plan_case_reports_the_case_and_writes_nothing(tmp_path: Path):
    root = _project(tmp_path)
    inputs = gather_run_inputs(root, run_id="r", require_mesh=False)
    before = _files(tmp_path)
    analysis = get_registry("analysis").get("incompressible_steady")
    out = analysis.plan_case(CaseContext(inputs=inputs, out_dir=None))
    assert out["ok"] is True
    assert out["run_id"] == "r"
    assert out["solver"] == "simpleFoam"
    assert out["transient"] is False and out["transient_control"] is None
    assert out["algorithm"] == "SIMPLE"
    rows = {row["name"]: row for row in out["bcs"]}
    assert set(rows) == {"velocity_inlet_1", "pressure_1"}
    inlet = rows["velocity_inlet_1"]
    assert (inlet["bc_type"], inlet["patch"], inlet["faces"], inlet["value"], inlet["unit"]) == (
        "Velocity Inlet",
        "velocity_inlet_1",
        ["face 1@Body1"],
        50.0,
        "m/s",
    )
    assert rows["pressure_1"]["patch"] == "pressure_1"
    assert out["wall_default"] == "No-slip"
    # Nothing was written: not in the project, and no case folder anywhere.
    assert _files(tmp_path) == before


def test_plan_case_of_a_run_that_is_not_ready(tmp_path: Path):
    root = _project(tmp_path)
    # The fixture has no generated mesh: a run that needs one is not ready.
    inputs = gather_run_inputs(root, run_id="r", require_mesh=True)
    before = _files(tmp_path)
    analysis = get_registry("analysis").get("incompressible_steady")
    out = analysis.plan_case(CaseContext(inputs=inputs, out_dir=None))
    assert out["ok"] is False
    assert isinstance(out["error"], str) and out["error"]
    assert set(out) == {"ok", "error"}
    assert _files(tmp_path) == before
