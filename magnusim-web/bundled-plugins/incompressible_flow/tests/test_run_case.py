"""cfddesk.registry.run_case on Incompressible Flow's fixture project (API 1.5):
plan_run is prepare_run --validate-only, prepare_run run as the builtin
solve.prepare job writes the golden case, and the analysis.plan_run RPC."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cfddesk
import pytest
from cfddesk.registry import load_all, reset_for_tests, run_case
from conftest import GOLDEN, JS_PROJECT
from test_prepare_run_golden import _assert_golden

PYTHON_ROOT = Path(cfddesk.__file__).resolve().parents[1]
PREPARE_RUN = PYTHON_ROOT / "tools" / "prepare_run.py"

# The settings the js_transient golden was written with (test_prepare_run_golden).
TRANSIENT = {
    "end_time": 5,
    "write_count": 50,
    "time_step_mode": "adjustable",
    "max_co": 1,
    "time_scheme": "Euler",
    "n_outer_correctors": 1,
    "n_correctors": 2,
    "n_non_orth_correctors": 0,
    "delta_t": 0.001,
    "max_delta_t": 0.1,
}


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _env(**extra: str) -> dict[str, str]:
    """This tree's core, SDK and plugin first (never another checkout's install)."""
    env = dict(os.environ)
    paths = [str(PYTHON_ROOT), str(PYTHON_ROOT / "sdk"), str(Path(__file__).resolve().parents[1])]
    env["PYTHONPATH"] = os.pathsep.join(paths + [p for p in [env.get("PYTHONPATH", "")] if p])
    env["PYTHONIOENCODING"] = "utf-8"
    for name in ("MAGNUSIM_PROJECT_DIR", "MAGNUSIM_CASE_DIR", "MAGNUSIM_SIMULATION_ID"):
        env.pop(name, None)
    env.update(extra)
    return env


def _project(tmp_path: Path, run_id: str) -> tuple[Path, Path]:
    """A copy of the fixture project with a run folder for ``run_id``: (project, its case folder)."""
    root = tmp_path / "project"
    shutil.copytree(JS_PROJECT, root)
    run = root / "simulation_runs" / "Run_1"
    run.mkdir(parents=True)
    (run / "id.json").write_text(json.dumps({"id": run_id, "name": "Run 1", "kind": "run"}), encoding="utf-8")
    return root, run / "case"


def _sorted_patches(doc: dict) -> dict:
    return {**doc, "patches": sorted(doc.get("patches") or [])}


@pytest.mark.parametrize("mode", ["steady", "transient"])
def test_plan_run_is_prepare_run_validate_only(tmp_path: Path, mode: str):
    td = "Transient" if mode == "transient" else "Steady-state"
    argv = [sys.executable, str(PREPARE_RUN), "--project-dir", str(JS_PROJECT), "--run-id", "run-plan"]
    argv += ["--out-dir", str(tmp_path / "unused"), "--no-require-mesh", "--validate-only", "--time-dependency", td]
    transient = TRANSIENT if mode == "transient" else None
    if transient is not None:
        settings = tmp_path / "transient.json"
        settings.write_text(json.dumps(transient), encoding="utf-8")
        argv += ["--transient-json", str(settings)]
    proc = subprocess.run(argv, capture_output=True, text=True, check=False, env=_env())
    assert proc.returncode == 0, proc.stderr + proc.stdout
    cli = json.loads(proc.stdout.strip().splitlines()[-1])

    planned = run_case.plan_run(
        JS_PROJECT, "run-plan", time_dependency=td, transient=transient, require_mesh=False
    )
    assert planned["ok"] is True
    # The plan lists the patches in set order, which differs from one process to the next.
    assert _sorted_patches(json.loads(json.dumps(run_case.validate_only_answer(planned)))) == _sorted_patches(cli)
    key = "incompressible_transient" if mode == "transient" else "incompressible_steady"
    assert (planned["analysis_key"], planned["plugin"], planned["time_dependency"]) == (key, "incompressible_flow", td)
    assert planned["app"] == planned["launch"]["app"] == ("pimpleFoam" if mode == "transient" else "simpleFoam")
    assert planned["plan"]["algorithm"] == ("PIMPLE" if mode == "transient" else "SIMPLE")
    assert (planned["plan"]["transient_control"] is not None) == (mode == "transient")
    assert not (tmp_path / "unused").exists()


def test_plan_run_of_a_run_without_a_mesh(tmp_path: Path):
    root, _case = _project(tmp_path, "r1")
    out = run_case.plan_run(root, "r1")
    assert out["ok"] is False and out["error"]
    assert "plan" not in out


@pytest.mark.parametrize("mode", ["steady", "transient"])
def test_prepare_run_as_the_builtin_job_writes_the_golden_case(tmp_path: Path, mode: str):
    root, case = _project(tmp_path, "r1")
    argv = [sys.executable, str(PREPARE_RUN), "--run-id", "r1", "--n-procs", "1", "--no-require-mesh"]
    if mode == "transient":
        argv += ["--time-dependency", "Transient", "--transient", json.dumps(TRANSIENT)]
    env = _env(MAGNUSIM_PROJECT_DIR=str(root), MAGNUSIM_CASE_DIR=str(case))
    proc = subprocess.run(argv, capture_output=True, text=True, check=False, env=env)
    assert proc.returncode == 0, proc.stderr + proc.stdout
    lines = proc.stdout.strip().splitlines()
    stages = [json.loads(line.split(" ", 1)[1])["stage"] for line in lines if line.startswith("MAGNUSIM_EVENT ")]
    assert stages == ["inputs", "written"]
    result = json.loads(lines[-1])
    assert result["ok"] is True
    gdir = GOLDEN / ("js_transient" if mode == "transient" else "js_steady")
    assert not _assert_golden(case, gdir, update=False)
    sidecar = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert sidecar["prepare_report"]["analysis_key"] == result["analysis_key"]
    assert sidecar["prepare_report"]["app"] == ("pimpleFoam" if mode == "transient" else "simpleFoam")


def test_analysis_plan_run_rpc(tmp_path: Path, monkeypatch):
    from cfddesk.worker import methods

    root, _case = _project(tmp_path, "r1")
    # Without a generated mesh the run is not ready, as the fixture is.
    blocked = methods.analysis_plan_run(project_dir=str(root), run_id="r1")
    assert blocked["ok"] is False and "prepare" not in blocked

    real = run_case.plan_run

    def without_mesh(*args, **kwargs):
        kwargs["require_mesh"] = False
        return real(*args, **kwargs)

    monkeypatch.setattr(run_case, "plan_run", without_mesh)
    out = methods.analysis_plan_run(
        project_dir=str(root), run_id="r1", time_dependency="Transient", transient=json.dumps(TRANSIENT), n_procs=4
    )
    assert out["ok"] is True
    assert out["analysis_key"] == "incompressible_transient" and out["plugin"] == "incompressible_flow"
    assert out["plan"]["n_procs"] == 4
    assert out["prepare"]["key"] == out["prepare_job"]
    assert out["serial_below_cells"] == 50_000
    # A Continue past its convergence is planned as written: its new end, its stops off.
    steady = methods.analysis_plan_run(project_dir=str(root), run_id="r1", restart={"end_time": 300, "stops_off": True})
    assert steady["ok"] is True and steady["plan"]["end_time"] == 300
    assert steady["plan"]["stops_off"] is True and "residual_control" not in steady["plan"]
    kept = methods.analysis_plan_run(project_dir=str(root), run_id="r1", restart='{"end_time": 300}')
    assert kept["plan"]["residual_control"] is True and "stops_off" not in kept["plan"]
    with pytest.raises(Exception, match="restart"):
        methods.analysis_plan_run(project_dir=str(root), run_id="r1", restart={"end_time": 0})
    with pytest.raises(Exception, match="run_id"):
        methods.analysis_plan_run(project_dir=str(root))
    with pytest.raises(Exception, match="transient"):
        methods.analysis_plan_run(project_dir=str(root), run_id="r1", transient="[1]")
