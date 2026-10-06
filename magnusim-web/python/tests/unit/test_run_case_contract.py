"""API 1.5: LaunchSpec.serial_below_cells / prepare_job, AnalysisType.live_metrics,
the builtin solve.prepare JobKind and cfddesk.registry.run_case's guards.

Incompressible Flow's own answers (its launch spec, live metrics and case-writing
job) and plan_run on a project are tested with the plugin:
bundled-plugins/incompressible_flow/tests/test_run_case.py.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from cfddesk.registry import contract, load_all, reset_for_tests, run_case
from cfddesk.registry.contract import ContractError, LaunchSpec
from cfddesk.registry.discovery import get_hub, get_registry
from cfddesk.registry.jobs import JobKind


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _steady():
    from cfddesk.registry import DEFAULT_STEADY_KEY

    return get_registry("analysis").get(DEFAULT_STEADY_KEY)


def _spec(**kw) -> LaunchSpec:
    app = str(get_registry("solver").get(_steady().default_solver).application)
    return LaunchSpec(app, "latest", (app,), "sigterm", True, contract.GENERIC_LOG_PARSER, **kw)


# -- LaunchSpec ---------------------------------------------------------------


def test_launch_spec_new_fields_default_to_the_legacy_rules():
    spec = _spec()
    assert spec.serial_below_cells is None and spec.prepare_job == ""
    doc = spec.to_json()
    assert doc["serial_below_cells"] is None and doc["prepare_job"] == ""
    assert contract.effective_prepare_job(spec) == contract.BUILTIN_PREPARE_JOB == "solve.prepare"
    assert contract.serial_below_cells(spec, "steady") == 200_000
    assert contract.serial_below_cells(spec, "Transient") == 50_000
    assert contract.serial_below_cells(_spec(serial_below_cells=0), "transient") == 0
    assert contract.serial_below_cells(_spec(serial_below_cells=1234), "steady") == 1234


@pytest.mark.parametrize("cells", [-1, True, 1.5, "100"])
def test_a_bad_serial_below_cells_is_refused(cells):
    with pytest.raises(ContractError, match="serial_below_cells"):
        contract.check_launch_spec(_spec(serial_below_cells=cells), get_registry("solver"))


@pytest.mark.parametrize("job", [None, 3, "bad job", "../x", "-x"])
def test_a_malformed_prepare_job_is_refused(job):
    with pytest.raises(ContractError, match="prepare_job"):
        contract.check_launch_spec(_spec(prepare_job=job), get_registry("solver"))


def test_a_prepare_job_must_be_registered_and_the_analysis_plugins():
    jobs = get_hub().registry("job")
    jobs.register(JobKind("plug_a.write", "w.py", "study"), plugin="plug_a")
    solvers = get_registry("solver")
    with pytest.raises(ContractError, match="not a registered JobKind"):
        contract.check_launch_spec(_spec(prepare_job="nope.write"), solvers, jobs=jobs)
    with pytest.raises(ContractError, match="belongs to 'plug_a'"):
        contract.check_launch_spec(_spec(prepare_job="plug_a.write"), solvers, jobs=jobs, owner="plug_b")
    contract.check_launch_spec(_spec(prepare_job="plug_a.write"), solvers, jobs=jobs, owner="plug_a")


def test_launch_spec_refuses_an_unregistered_prepare_job():
    spec = _spec(prepare_job="nope.write")
    analysis = replace(_steady(), key="x_badjob", launch=lambda **_: spec)
    get_registry("analysis").register(analysis, plugin="plug_x")
    with pytest.raises(ContractError, match="not a registered JobKind"):
        contract.launch_spec(analysis, get_registry("solver"))


def test_a_clone_from_another_plugin_is_prepared_by_the_builtin_job():
    """An analysis cloned with dataclasses.replace keeps its source's launch hook;
    that hook's prepare_job belongs to the source's plugin, so the clone's runs are
    written by solve.prepare (its own write_case), as before 1.5."""
    jobs = get_hub().registry("job")
    jobs.register(JobKind("plug_a.write", "w.py", "study"), plugin="plug_a")
    spec = _spec(prepare_job="plug_a.write", serial_below_cells=10)
    own = replace(_steady(), key="a_steady", launch=lambda **_: spec)
    clone = replace(own, key="b_steady")
    analyses = get_registry("analysis")
    analyses.register(own, plugin="plug_a")
    analyses.register(clone, plugin="plug_b")
    solvers = get_registry("solver")
    assert contract.launch_spec(own, solvers).prepare_job == "plug_a.write"
    cloned = contract.launch_spec(clone, solvers)
    assert cloned.prepare_job == ""
    assert contract.effective_prepare_job(cloned) == "solve.prepare"
    assert cloned.serial_below_cells == 10


def test_the_builtin_prepare_job_is_registered():
    job = get_hub().registry("job").get("solve.prepare")
    assert get_hub().registry("job").owner("solve.prepare") == "builtin"
    assert (job.tool, job.scope, job.python) == ("prepare_run.py", "study", "core")
    assert job.args_from_params == ("run_id", "mesh_id", "simulation_id", "time_dependency", "n_procs", "transient")
    tool = Path(__file__).resolve().parents[2] / "tools" / job.tool
    assert tool.is_file()


# -- live_metrics -------------------------------------------------------------


def test_live_metrics_not_declared_is_none_and_published_so():
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    bare = replace(_steady(), key="x_bare", live_metrics=None)
    assert contract.live_metrics(bare) is None
    assert contract.describe_extra(bare)["live_metrics"] is None
    assert all("live_metrics" in row for row in rows.values())


def test_live_metrics_are_checked_and_normalized():
    spec = replace(
        _steady(),
        key="x_metrics",
        live_metrics=(
            {"key": "delta_t", "label": "Δt", "format": "time"},
            {"key": "co_mean", "label": "Co", "format": "sig2", "max_key": "co_max"},
        ),
    )
    assert contract.live_metrics(spec) == [
        {"key": "delta_t", "label": "Δt", "format": "time", "max_key": ""},
        {"key": "co_mean", "label": "Co", "format": "sig2", "max_key": "co_max"},
    ]
    assert contract.describe_extra(spec)["live_metrics"][1]["max_key"] == "co_max"
    assert contract.live_metrics(replace(spec, live_metrics=())) == []


@pytest.mark.parametrize(
    "rows,match",
    [
        ("delta_t", "tuple of dicts"),
        ({"key": "delta_t"}, "tuple of dicts"),
        (("delta_t",), "rows must be dicts"),
        (({"key": "delta_t", "format": "time", "colour": "red"},), "unknown field"),
        (({"key": "1x", "format": "time"},), "key"),
        (({"key": "delta_t", "format": "pct"},), "format"),
        (({"key": "delta_t", "label": "a\nb", "format": "time"},), "label"),
        (({"key": "delta_t", "label": "x" * 33, "format": "time"},), "label"),
        (({"key": "co", "format": "sig2", "max_key": "co max"},), "max_key"),
        (({"key": "co", "format": "sig2"}, {"key": "co", "format": "time"}), "twice"),
    ],
)
def test_bad_live_metrics_are_refused(rows, match):
    with pytest.raises(ContractError, match=match):
        contract.live_metrics(replace(_steady(), key="x_bad_metrics", live_metrics=rows))


# -- run_case guards ----------------------------------------------------------


def _run_folder(project: Path, run_id: str, *, name: str = "Run_1", where: str = "id.json") -> Path:
    run = project / "studies" / "Study_1" / "simulation_runs" / name
    run.mkdir(parents=True)
    (run / where).write_text(json.dumps({"id": run_id}), encoding="utf-8")
    return run


def test_case_dir_problem_accepts_only_the_runs_own_case(tmp_path: Path):
    project = tmp_path / "p"
    run = _run_folder(project, "r1")
    other = _run_folder(project, "r2", name="Run_2", where="run.json")
    case = run / "case"
    assert run_case.case_dir_problem(project, "r1", case) is None
    assert run_case.case_dir_problem(project, "r2", other / "case") is None
    assert "not the case folder of run r2" in str(run_case.case_dir_problem(project, "r2", case))
    assert "not a run's case folder" in str(run_case.case_dir_problem(project, "r1", run / "other"))
    assert "not a run's case folder" in str(run_case.case_dir_problem(project, "r1", run))
    elsewhere = tmp_path / "q" / "simulation_runs" / "Run_1"
    elsewhere.mkdir(parents=True)
    (elsewhere / "id.json").write_text(json.dumps({"id": "r1"}), encoding="utf-8")
    assert "not inside the project" in str(run_case.case_dir_problem(project, "r1", elsewhere / "case"))
    assert "MAGNUSIM_PROJECT_DIR" in str(run_case.case_dir_problem("", "r1", case))
    assert "MAGNUSIM_CASE_DIR" in str(run_case.case_dir_problem(project, "r1", ""))
    assert run_case.case_dir_problem(project, "", case) is not None


def test_transient_arg():
    assert run_case.transient_arg("") is None and run_case.transient_arg(None) is None
    assert run_case.transient_arg("null") is None
    assert run_case.transient_arg('{"end_time": 2}') == {"end_time": 2}
    with pytest.raises(ValueError):
        run_case.transient_arg("[1]")


def test_restart_arg():
    assert run_case.restart_arg("") is None and run_case.restart_arg(None) is None
    assert run_case.restart_arg("null") is None
    assert run_case.restart_arg('{"end_time": 200}') == {"end_time": 200.0, "write_interval": None}
    assert run_case.restart_arg('{"end_time": 2.5, "write_interval": 0.1}') == {"end_time": 2.5, "write_interval": 0.1}
    for bad in ("[1]", "{}", '{"end_time": 0}', '{"end_time": true}', '{"end_time": 5, "write_interval": "x"}'):
        with pytest.raises(ValueError):
            run_case.restart_arg(bad)


def test_run_inputs_carry_the_restart(tmp_path: Path):
    from cfddesk.project.run_inputs import RunInputs

    assert RunInputs.__dataclass_fields__["restart"].default is None
    inputs = run_case.run_inputs(tmp_path, run_id="r1", require_mesh=False, restart={"end_time": 300.0, "write_interval": 50.0})
    assert inputs.restart == {"end_time": 300.0, "write_interval": 50.0}
    assert run_case.run_inputs(tmp_path, run_id="r1", require_mesh=False).restart is None


def test_exit_codes():
    assert run_case.exit_code({"ok": True}) == 0
    assert run_case.exit_code({"ok": False, "error": "x"}) == 1
    assert run_case.exit_code({"ok": False, "not_ready": True}) == 3


def test_prepare_job_refuses_a_case_dir_outside_the_run(tmp_path: Path, monkeypatch, capsys):
    """Run as solve.prepare (no --out-dir), prepare_run writes only into the run's
    own case folder: a case folder elsewhere exits 2 and writes nothing."""
    import prepare_run

    project = tmp_path / "p"
    run = _run_folder(project, "r1")
    stray = tmp_path / "stray" / "case"
    monkeypatch.setenv("MAGNUSIM_PROJECT_DIR", str(project))
    for case in (stray, run / "case"):
        monkeypatch.setenv("MAGNUSIM_CASE_DIR", str(case))
        code = prepare_run.main(["--run-id", "r2" if case != stray else "r1"])
        assert code == 2
        line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert line["ok"] is False and "case folder" in line["error"]
        assert not case.exists()
