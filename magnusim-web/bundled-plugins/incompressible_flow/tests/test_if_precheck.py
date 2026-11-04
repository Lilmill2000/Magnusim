"""Incompressible Flow's pre-run check (run health, RH2; contract API 1.9 RunModel.check):
the worker's analysis.run_check on a project, the inputs it reads of the run (its reference
speed and inlet, the velocity limit it is written with, its physics), the ranks it would get
and this PC's rate, and the same rows in its plan at Start (prepare_run.checks)."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.precheck import check_inputs

PISO_100 = {"end_time": 10, "write_count": 60, "max_co": 100, "n_outer_correctors": 1, "n_correctors": 2}


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The JS fixture project; it has no generated mesh, so its runs solve on its folder (as
    prepare_run --no-require-mesh does)."""
    from cfddesk.project import run_inputs

    root = tmp_path / "js"
    shutil.copytree(JS_PROJECT, root)
    real = run_inputs.gather_run_inputs

    def _without_mesh(*args, **kwargs):
        kwargs["require_mesh"] = False
        return real(*args, **kwargs)

    monkeypatch.setattr(run_inputs, "gather_run_inputs", _without_mesh)
    return root


def test_the_run_model_has_the_check_hook():
    for key in ("incompressible_transient", "incompressible_steady"):
        model = contract.run_model(get_registry("analysis").get(key))
        assert model is not None and model.check is not None


def test_check_inputs_read_the_run_as_its_case_is_written(project: Path):
    spec = load_run_spec(project, run_id="run-x", require_mesh=False, time_dependency="Transient", transient_override=PISO_100)
    inputs = check_inputs(spec, PISO_100, {"ranks": 8, "kept": ["still_start"]}, transient=True)
    assert inputs["time_dependency"] == "transient"
    assert inputs["settings"]["max_co"] == 100 and inputs["settings"]["n_outer_correctors"] == 1
    # The velocity limit the case is written with: 10x the reference speed, at least 50 m/s.
    assert inputs["velocity_cap"] == pytest.approx(max(50.0, 10.0 * inputs["speed"]))
    assert inputs["inlet"] and inputs["inlet_driven"] is True
    # The model in the plugin's own words (the core names none).
    words = inputs["turbulence"]
    assert words["label"] and words["laminar"] is (spec.physics.turbulence_model == "laminar")
    assert words["any_yplus"] == {"label": "k-omega SST", "key": "turbulence_model", "value": "kOmegaSST"}
    assert inputs["kept"] == ["still_start"] and inputs["ranks"] == 8
    assert inputs["steady_copy"] is True
    # A steady run: its study's relaxation, no velocity limit.
    steady = check_inputs(spec, {"end_time": 200}, {}, transient=False)
    assert steady["velocity_cap"] is None
    assert set(steady["numerics"]) == {"relax_p", "relax_u", "simplec", "n_non_orthogonal", "numerics_preset"}


def test_the_rpc_merges_ranks_and_rate_and_checks_proposed_settings(project: Path):
    from cfddesk.worker import methods

    out = methods.analysis_run_check(
        project_dir=str(project),
        run_id="run-x",
        time_dependency="Transient",
        settings=PISO_100,
        cores=4,
        rank_cap=8,
        s_per_cell_step=2e-5,
        rate_source="measured",
    )
    assert out["ok"] is True and out["checked"] is True
    assert out["analysis_key"] == "incompressible_transient"
    assert out["ranks"] == 4
    rows = {r["code"]: r for r in out["checks"]}
    assert rows["piso_high_co"]["level"] == "warn"
    assert rows["piso_high_co"]["fix"]["values"] == [{"key": "transient.n_outer_correctors", "value": 3}, {"key": "transient.max_co", "value": 5}]
    assert all(r["level"] in ("error", "warn", "info") for r in out["checks"])
    # The what-if clears the Courant rows; the estimate line is always there.
    what_if = methods.analysis_run_check(project_dir=str(project), run_id="run-x", time_dependency="Transient", settings={**PISO_100, "n_outer_correctors": 3, "max_co": 5}, rank_cap=8)
    assert not {"piso_high_co", "pimple_co_vs_outer"} & {r["code"] for r in what_if["checks"]}
    assert isinstance(what_if["estimate"]["line"], str) and what_if["estimate"]["line"]


def test_the_plan_at_start_reports_the_same_rows(project: Path):
    from cfddesk.registry import run_case

    planned = run_case.plan_run(project, "run-x", time_dependency="Transient", transient=PISO_100, require_mesh=False, check={"rank_cap": 8, "s_per_cell_step": 2e-5, "rate_source": "measured"})
    assert planned["ok"] is True, planned
    codes = [c["code"] for c in planned["plan"]["checks"]]
    assert "piso_high_co" in codes
    # A plan without the check context (the case writer, a Continue) reports none.
    plain = run_case.plan_run(project, "run-x", time_dependency="Transient", transient=PISO_100, require_mesh=False)
    assert "checks" not in plain["plan"]
