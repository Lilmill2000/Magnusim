"""The ``incompressible_flow.write_run_case`` JobKind (API 1.5): Incompressible
Flow's own launch spec, live metrics and the job that writes a run's case."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cfddesk
import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.discovery import get_hub, get_registry
from conftest import GOLDEN, JS_PROJECT
from test_prepare_run_golden import _assert_golden

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = Path(cfddesk.__file__).resolve().parents[1]
TOOL = PLUGIN_ROOT / "incompressible_flow" / "jobs" / "write_run_case.py"
JOB = "incompressible_flow.write_run_case"

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
    paths = [str(PYTHON_ROOT), str(PYTHON_ROOT / "sdk")]
    env["PYTHONPATH"] = os.pathsep.join(paths + [p for p in [env.get("PYTHONPATH", "")] if p])
    env["PYTHONIOENCODING"] = "utf-8"
    for name in ("MAGNUSIM_PROJECT_DIR", "MAGNUSIM_CASE_DIR", "MAGNUSIM_SIMULATION_ID"):
        env.pop(name, None)
    env.update(extra)
    return env


def _project(tmp_path: Path, run_id: str = "r1") -> tuple[Path, Path]:
    """A copy of the fixture project with a run folder for ``run_id``: (project, its case folder)."""
    root = tmp_path / "project"
    shutil.copytree(JS_PROJECT, root)
    run = root / "simulation_runs" / "Run_1"
    run.mkdir(parents=True)
    (run / "id.json").write_text(json.dumps({"id": run_id, "name": "Run 1", "kind": "run"}), encoding="utf-8")
    return root, run / "case"


def _run(args: list[str], *, project: Path, case: Path) -> tuple[int, list[str], list[str], dict]:
    """(exit code, stage names, other output lines, the answer) of one run of the tool."""
    proc = subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True,
        text=True,
        check=False,
        cwd=str(PYTHON_ROOT.parent),
        env=_env(MAGNUSIM_PROJECT_DIR=str(project), MAGNUSIM_CASE_DIR=str(case), MAGNUSIM_PLUGIN_KEY="incompressible_flow"),
    )
    lines = proc.stdout.strip().splitlines()
    assert lines, proc.stderr
    stages = [json.loads(line.split(" ", 1)[1])["stage"] for line in lines if line.startswith("MAGNUSIM_EVENT ")]
    other = [line for line in lines[:-1] if not line.startswith("MAGNUSIM_EVENT ")]
    return proc.returncode, stages, other, json.loads(lines[-1])


# -- the analyses' contract fields ---------------------------------------------


@pytest.mark.parametrize(
    "key,app,keep,cells",
    [("incompressible_steady", "simpleFoam", "latest", 200_000), ("incompressible_transient", "pimpleFoam", "all", 50_000)],
)
def test_launch_spec_names_the_plugins_own_case_writer(key: str, app: str, keep: str, cells: int):
    analysis = get_registry("analysis").get(key)
    launch = contract.launch_spec(analysis, get_registry("solver"))
    assert (launch.app, launch.keep_frames, launch.process_names) == (app, keep, (app,))
    assert (launch.stop_strategy, launch.parallel) == ("stopAt_writeNow", True)
    assert launch.frame_fields == ("U", "p") and launch.kinematic_fields == ("p", "wallShearStress", "pMean")
    assert launch.log_parser.module == "incompressible_flow.parser"
    assert launch.serial_below_cells == cells
    assert launch.prepare_job == JOB == contract.effective_prepare_job(launch)
    # The same launch as the solver's own (before the plugin declared one), plus the 1.5 fields.
    legacy = contract.launch_spec(
        __import__("dataclasses").replace(analysis, key=f"x_{key}", launch=None), get_registry("solver")
    ).to_json()
    assert {k: v for k, v in launch.to_json().items() if k not in ("serial_below_cells", "prepare_job")} == {
        k: v for k, v in legacy.items() if k not in ("serial_below_cells", "prepare_job")
    }


def test_the_job_is_registered_by_the_plugin():
    jobs = get_hub().registry("job")
    job = jobs.get(JOB)
    assert jobs.owner(JOB) == "incompressible_flow"
    assert (job.tool, job.scope, job.python) == ("incompressible_flow/jobs/write_run_case.py", "study", "core")
    assert job.args_from_params == ("run_id", "mesh_id", "time_dependency", "n_procs", "transient", "restart")
    assert get_hub().job_package(JOB) == PLUGIN_ROOT


def test_live_metrics_in_the_registry():
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    assert rows["incompressible_steady"]["live_metrics"] == []
    assert rows["incompressible_transient"]["live_metrics"] == [
        {"key": "delta_t", "label": "Δt", "format": "time", "max_key": ""},
        {"key": "co_mean", "label": "Co", "format": "sig2", "max_key": "co_max"},
    ]
    golden = json.loads((PYTHON_ROOT.parent / "scripts" / "generated" / "registry.json").read_text(encoding="utf-8"))
    published = {r["key"]: r for r in golden["analysis"]}
    assert published["incompressible_transient"]["live_metrics"] == rows["incompressible_transient"]["live_metrics"]
    assert published["incompressible_steady"]["live_metrics"] == []


# -- the job tool --------------------------------------------------------------


@pytest.mark.parametrize("mode", ["steady", "transient"])
def test_the_job_writes_the_golden_case(tmp_path: Path, mode: str):
    """The same files test_prepare_run_golden and test_write_case_golden check."""
    project, case = _project(tmp_path)
    args = ["--run-id", "r1", "--n-procs", "1", "--no-require-mesh"]
    if mode == "transient":
        args += ["--time-dependency", "Transient", "--transient", json.dumps(TRANSIENT)]
    code, stages, _other, answer = _run(args, project=project, case=case)
    assert code == 0, answer
    assert stages == ["inputs", "mesh", "fields", "written"]
    assert answer["ok"] is True
    gdir = GOLDEN / ("js_transient" if mode == "transient" else "js_steady")
    assert not _assert_golden(case, gdir, update=False)
    sidecar = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert sidecar["analysis_key"] == ("incompressible_transient" if mode == "transient" else "incompressible_steady")
    report = sidecar["prepare_report"]
    assert report["algorithm"] == ("PIMPLE" if mode == "transient" else "SIMPLE")
    assert (report["transient_control"] is not None) == (mode == "transient")
    assert {b["name"] for b in report["bcs"]} == {"velocity_inlet_1", "pressure_1"}


def test_the_job_writes_what_prepare_run_writes(tmp_path: Path):
    """Byte for byte the files prepare_run --no-require-mesh writes for the same run."""
    project, case = _project(tmp_path)
    code, _stages, _other, _answer = _run(["--run-id", "r1", "--no-require-mesh"], project=project, case=case)
    assert code == 0
    other = tmp_path / "prepare_run"
    proc = subprocess.run(
        [sys.executable, str(PYTHON_ROOT / "tools" / "prepare_run.py"), "--project-dir", str(project), "--run-id", "r1"]
        + ["--out-dir", str(other), "--no-require-mesh"],
        capture_output=True,
        text=True,
        check=False,
        env=_env(),
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout

    def files(root: Path) -> dict[str, bytes]:
        return {
            p.relative_to(root).as_posix(): p.read_bytes()
            for p in root.rglob("*")
            if p.is_file() and p.name != "w27-case.json"
        }

    assert files(case) == files(other)


def test_the_written_case_holds_a_velocity_outlets_speed(tmp_path: Path):
    """A velocity outlet of 7 ft/s reaches 0/U as that outflow (it was always written as U = 0)."""
    project, case = _project(tmp_path)
    doc_path = project / "boundary_conditions.json"
    doc = json.loads(doc_path.read_text(encoding="utf-8"))
    doc["boundary_conditions"].append(
        {
            "name": "Vent 1",
            "bc_type": "Velocity outlet",
            "velocity_type": "Fixed",
            "value": 7,
            "unit": "ft/s",
            "direction": "Normal to face",
            "faces": ["face 3@Body1"],
            "simulation_id": "sim_1",
        }
    )
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    code, _stages, _other, answer = _run(["--run-id", "r1", "--no-require-mesh"], project=project, case=case)
    assert code == 0, answer
    u = (case / "0" / "U").read_text(encoding="utf-8")
    block = u.split("vent_1", 1)[1].split("}", 1)[0]
    assert "surfaceNormalFixedValue" in block
    assert " ".join(block.split()).find("refValue uniform 2.1336;") > 0  # 7 ft/s, out of the domain


@pytest.mark.parametrize("where", ["stray", "other_run", "run_folder"])
def test_a_case_dir_that_is_not_the_runs_is_refused(tmp_path: Path, where: str):
    project, case = _project(tmp_path)
    other_run = project / "simulation_runs" / "Run_2"
    other_run.mkdir()
    (other_run / "id.json").write_text(json.dumps({"id": "r2"}), encoding="utf-8")
    target = {"stray": tmp_path / "stray" / "case", "other_run": other_run / "case", "run_folder": case.parent}[where]
    before = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*"))
    code, stages, _other, answer = _run(["--run-id", "r1", "--no-require-mesh"], project=project, case=target)
    assert code == 2 and stages == []
    assert answer["ok"] is False and "case folder" in answer["error"]
    assert sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*")) == before


def _tool():
    """The job tool as a module (its main() is what the relay runs)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("ifw_write_run_case", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_run_that_is_not_ready_exits_3_with_the_readiness_text(tmp_path: Path, monkeypatch, capsys):
    from cfddesk.project import web_adapter

    project, case = _project(tmp_path)
    # The fixture project has no generated mesh: give the run one with the BCs' patches.
    mesh_case = tmp_path / "mesh_case"
    (mesh_case / "constant" / "polyMesh").mkdir(parents=True)

    def meshed(*_args, **_kwargs):
        return {
            "ok": True,
            "case_dir": mesh_case,
            "mesh_path": mesh_case / "constant" / "polyMesh",
            "n_cells": 1000,
            "patches": ["velocity_inlet_1", "pressure_1"],
            "mesh_id": "mesh_1",
            "mesh_name": "Mesh 1",
            "wsl_case": None,
        }

    monkeypatch.setattr(web_adapter, "resolve_mesh", meshed)
    # No fluid assigned: the first thing Incompressible Flow's validate_ready asks for.
    (project / "materials.json").write_text(json.dumps({"materials": []}), encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PROJECT_DIR", str(project))
    monkeypatch.setenv("MAGNUSIM_CASE_DIR", str(case))
    monkeypatch.delenv("MAGNUSIM_SIMULATION_ID", raising=False)
    code = _tool().main(["--run-id", "r1"])
    lines = capsys.readouterr().out.strip().splitlines()
    answer = json.loads(lines[-1])
    assert code == 3, answer
    assert answer["not_ready"] is True and answer["error"] == "Assign a fluid to a volume first"
    assert answer["fix"] == {"go": "material"}
    assert "Assign a fluid to a volume first" in lines[:-1]
    stages = [json.loads(line.split(" ", 1)[1])["stage"] for line in lines if line.startswith("MAGNUSIM_EVENT ")]
    assert stages == ["inputs", "mesh"]
    assert not case.exists()


def test_a_run_without_its_mesh_fails(tmp_path: Path):
    project, case = _project(tmp_path)
    code, _stages, _other, answer = _run(["--run-id", "r1"], project=project, case=case)
    assert code == 1 and answer["ok"] is False and answer["error"]
    assert not case.exists()


def test_the_job_continues_a_run_with_restart(tmp_path: Path):
    project, case = _project(tmp_path)
    base = ["--run-id", "r1", "--n-procs", "1", "--no-require-mesh"]
    assert _run(base, project=project, case=case)[0] == 0
    (case / "100").mkdir()
    for f in ("U", "p"):
        (case / "100" / f).write_text("saved", encoding="utf-8")
    code, stages, _other, answer = _run([*base, "--restart", json.dumps({"end_time": 300, "write_interval": 100})], project=project, case=case)
    assert code == 0, answer
    assert stages == ["inputs", "mesh", "fields", "written"]
    assert answer["restart"] == {"from_time": 100.0, "end_time": 300.0}
    assert (case / "100" / "U").read_text(encoding="utf-8") == "saved"
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert "startFrom       latestTime;" in control and "endTime         300;" in control
    assert json.loads((case / "w27-case.json").read_text(encoding="utf-8"))["prepare_report"]["restart"]["from_time"] == 100.0


@pytest.mark.parametrize("text", ["[1]", "{}", '{"end_time": 0}', '{"end_time": "x"}', '{"end_time": 10, "write_interval": -1}'])
def test_bad_restart_text_is_refused(tmp_path: Path, text: str):
    project, case = _project(tmp_path)
    code, _stages, _other, answer = _run(["--run-id", "r1", "--restart", text], project=project, case=case)
    assert code == 2 and answer["error"].startswith("restart: ")
    assert not case.exists()


def test_bad_transient_text_is_refused(tmp_path: Path):
    project, case = _project(tmp_path)
    code, _stages, _other, answer = _run(["--run-id", "r1", "--transient", "[1, 2]"], project=project, case=case)
    assert code == 2 and "transient" in answer["error"]
    assert not case.exists()
