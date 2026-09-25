"""Phase 6: every turbulence model the study panel lists writes a case that runs.

Write checks run everywhere. The ``wsl`` tests mesh a small channel with blockMesh
and run simpleFoam / pimpleFoam for two steps per model; they need WSL + OpenFOAM
(``pytest -m wsl -k turbulence``).
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest

from cfddesk.project.study_physics import (
    TURBULENCE_MODELS,
    normalize_turbulence,
    physics_from_record,
)
from cfddesk.project.web_adapter import load_run_spec
from cfddesk.registry.analysis import write_run_case

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"

# 0/ turbulence fields each model must have, and the ones it must not.
EXPECTED_FIELDS = {
    "laminar": set(),
    "kEpsilon": {"k", "epsilon", "nut"},
    "kOmegaSST": {"k", "omega", "nut"},
    "LRR": {"k", "epsilon", "R", "nut"},
    "SSG": {"k", "epsilon", "R", "nut"},
}
SOLVED = {
    "laminar": (),
    "kEpsilon": ("k", "epsilon"),
    "kOmegaSST": ("k", "omega"),
    "LRR": ("R", "epsilon"),
    "SSG": ("R", "epsilon"),
}
ALL_TURB = {"k", "omega", "epsilon", "R", "nut"}


def _project(tmp_path: Path, record: dict) -> Path:
    root = tmp_path / "project"
    shutil.copytree(FIX, root)
    rec = {"id": "sim_1", "name": "Incompressible", "time_dependency": "Steady-state", **record}
    (root / "simulation.json").write_text(json.dumps(rec), encoding="utf-8")
    (root / "simulations.json").write_text(
        json.dumps({"active_id": "sim_1", "simulations": [rec]}), encoding="utf-8"
    )
    return root


def _write(tmp_path: Path, record: dict, *, transient: dict | None = None, mesh_dir: Path | None = None) -> Path:
    root = _project(tmp_path, record)
    spec = load_run_spec(root, run_id="run-t", require_mesh=False, n_procs=1, transient_override=transient)
    assert spec.ok, spec.error
    if mesh_dir is not None:
        spec.mesh_case_dir = mesh_dir
    case = tmp_path / "case"
    result = write_run_case(spec, case)
    assert result["ok"]
    return case


def _text(case: Path, rel: str) -> str:
    return (case / rel).read_text(encoding="utf-8")


def test_panel_lists_exactly_the_five_models():
    from cfddesk.builtin.incompressible import build_incompressible_steady

    field = next(f for f in build_incompressible_steady().settings_schema if f.key == "turbulence_model")
    assert tuple(field.choices) == TURBULENCE_MODELS
    assert field.description


@pytest.mark.parametrize(
    ("raw", "want"),
    [("k-omega SST", "kOmegaSST"), ("kOmegaSST", "kOmegaSST"), ("k-epsilon", "kEpsilon"), ("Laminar", "laminar"), ("lrr", "LRR"), ("SSG", "SSG"), ("nope", None)],
)
def test_normalize_turbulence(raw, want):
    assert normalize_turbulence(raw) == want


def test_v010_record_without_panel_keys_keeps_sst_and_the_old_numbers():
    ph = physics_from_record({"turbulence_model_key": "kOmegaSST", "defaults": {"turbulence_model": "k-omega SST"}})
    assert (ph.turbulence_model, ph.residual_u, ph.residual_p, ph.relax_u, ph.relax_p, ph.n_non_orthogonal) == (
        "kOmegaSST", 1e-4, 1e-4, 0.7, 0.3, 3,
    )


def test_bad_numbers_fall_back_instead_of_writing_nonsense():
    ph = physics_from_record({"residual_u": "abc", "relax_p": 1.5, "relax_u": 0, "n_non_orthogonal": -1})
    assert (ph.residual_u, ph.relax_p, ph.relax_u, ph.n_non_orthogonal) == (1e-4, 0.3, 0.7, 3)


@pytest.mark.parametrize("model", TURBULENCE_MODELS)
def test_steady_case_is_written_for_model(tmp_path, model):
    case = _write(tmp_path, {"turbulence_model": model})
    present = {p.name for p in (case / "0").iterdir() if p.name in ALL_TURB}
    assert present == EXPECTED_FIELDS[model]

    props = _text(case, "constant/turbulenceProperties")
    if model == "laminar":
        assert re.search(r"simulationType\s+laminar;", props)
        assert "RASModel" not in props
    else:
        assert re.search(r"simulationType\s+RAS;", props)
        assert re.search(rf"RASModel\s+{model};", props)

    schemes = _text(case, "system/fvSchemes")
    solution = _text(case, "system/fvSolution")
    for name in SOLVED[model]:
        assert re.search(rf"div\(phi,{name}\)\s+bounded Gauss upwind;", schemes), name
        assert re.search(rf"^\s+{name}\s+0\.7;", solution, re.M), f"relaxation for {name}"
    for name in {"k", "omega", "epsilon", "R"} - set(SOLVED[model]):
        assert f"div(phi,{name})" not in schemes, f"{model} must not ask for div(phi,{name})"
    if model in ("LRR", "SSG"):
        assert re.search(r"div\(R\)\s+Gauss linear;", schemes)
        assert "div((nu*dev2(T(grad(U))))) Gauss linear;" in schemes
        assert "volSymmTensorField" in _text(case, "0/R")
    solved = "|".join(("U", *SOLVED[model]))
    solver_key = f'"({solved})"' if SOLVED[model] else "U"
    assert re.search(rf"^\s+{re.escape(solver_key)}\s*$", solution, re.M), solver_key

    if model != "laminar":
        k_wall = re.search(r"walls\s*\{[^}]*\}", _text(case, "0/nut"))
        assert k_wall and "nutkWallFunction" in k_wall.group(0)
    sidecar = json.loads(_text(case, "w27-case.json"))
    assert sidecar["turbulence"]["model"] == model


@pytest.mark.parametrize("model", TURBULENCE_MODELS)
def test_transient_case_is_written_for_model(tmp_path, model):
    case = _write(
        tmp_path,
        {"turbulence_model": model, "time_dependency": "Transient"},
        transient={"end_time": 0.002, "delta_t": 0.001, "time_step_mode": "fixed", "write_count": 1},
    )
    schemes = _text(case, "system/fvSchemes")
    solution = _text(case, "system/fvSolution")
    for name in SOLVED[model]:
        assert re.search(rf"div\(phi,{name}\)\s+Gauss limitedLinear 1;", schemes), name
    solved = "|".join(("U", *SOLVED[model]))
    final = f'"({solved})Final"' if SOLVED[model] else "UFinal"
    assert final in solution
    present = {p.name for p in (case / "0").iterdir() if p.name in ALL_TURB}
    assert present == EXPECTED_FIELDS[model]


def test_panel_numbers_reach_fv_solution(tmp_path):
    case = _write(
        tmp_path,
        {"turbulence_model": "kEpsilon", "residual_u": 2e-5, "residual_p": 3e-4, "relax_u": 0.5, "relax_p": 0.2, "n_non_orthogonal": 1},
    )
    solution = _text(case, "system/fvSolution")
    assert "residualControl { p 3e-4; U 2e-5; \"(k|epsilon)\" 2e-5; }" in solution
    assert re.search(r"nNonOrthogonalCorrectors 1;", solution)
    assert re.search(r"^\s+p\s+0\.2;", solution, re.M)
    for name in ("U", "k", "epsilon"):
        assert re.search(rf"^\s+{name}\s+0\.5;", solution, re.M), name


def test_switching_model_removes_the_old_fields(tmp_path):
    root = _project(tmp_path, {"turbulence_model": "kOmegaSST"})
    case = tmp_path / "case"
    spec = load_run_spec(root, run_id="run-t", require_mesh=False)
    write_run_case(spec, case)
    assert (case / "0" / "omega").is_file()
    (root / "simulations.json").write_text(
        json.dumps({"active_id": "sim_1", "simulations": [{"id": "sim_1", "turbulence_model": "laminar"}]}),
        encoding="utf-8",
    )
    spec = load_run_spec(root, run_id="run-t", require_mesh=False, simulation_id="sim_1")
    write_run_case(spec, case)
    assert not any((case / "0" / name).exists() for name in ALL_TURB)


# --------------------------------------------------------------------------- WSL

BLOCK_MESH = """FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }
convertToMeters 1;
vertices ( (0 0 0) (1 0 0) (1 0.1 0) (0 0.1 0) (0 0 0.1) (1 0 0.1) (1 0.1 0.1) (0 0.1 0.1) );
blocks ( hex (0 1 2 3 4 5 6 7) (20 4 4) simpleGrading (1 1 1) );
edges ();
boundary
(
    velocity_inlet_1 { type patch; faces ( (0 4 7 3) ); }
    pressure_1 { type patch; faces ( (1 2 6 5) ); }
    walls { type wall; faces ( (0 1 5 4) (3 7 6 2) (0 3 2 1) (4 5 6 7) ); }
);
"""

CONTROL_STUB = """FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }
application blockMesh; startFrom startTime; startTime 0; stopAt endTime; endTime 1; deltaT 1;
writeControl timeStep; writeInterval 1;
"""


@pytest.fixture(scope="module")
def channel_mesh(tmp_path_factory):
    from cfddesk.wsl.mesh_run import windows_to_wsl_path
    from cfddesk.wsl.openfoam import OPENFOAM_WRAPPER, run_wsl_bash

    mesh = tmp_path_factory.mktemp("channel")
    (mesh / "system").mkdir()
    (mesh / "constant").mkdir()
    (mesh / "system" / "blockMeshDict").write_text(BLOCK_MESH, encoding="ascii")
    (mesh / "system" / "controlDict").write_text(CONTROL_STUB, encoding="ascii")
    result = run_wsl_bash(
        f"cd '{windows_to_wsl_path(mesh)}' && {OPENFOAM_WRAPPER} bash -c 'blockMesh > log.blockMesh 2>&1'",
        timeout=180,
    )
    log = (mesh / "log.blockMesh").read_text(encoding="utf-8", errors="replace") if (mesh / "log.blockMesh").is_file() else ""
    assert result.returncode == 0, result.stderr + log
    assert (mesh / "constant" / "polyMesh" / "owner").is_file(), log
    return mesh


def _solve(case: Path, app: str) -> str:
    from cfddesk.wsl.mesh_run import windows_to_wsl_path
    from cfddesk.wsl.openfoam import OPENFOAM_WRAPPER, run_wsl_bash

    result = run_wsl_bash(
        f"cd '{windows_to_wsl_path(case)}' && {OPENFOAM_WRAPPER} bash -c '{app} > log.{app} 2>&1'",
        timeout=300,
    )
    log = (case / f"log.{app}").read_text(encoding="utf-8", errors="replace")
    assert result.returncode == 0, f"{app} exit {result.returncode}\n{log[-3000:]}"
    assert "FOAM FATAL" not in log, log[-3000:]
    assert not re.search(r"keyword \S+ is undefined", log), log[-3000:]
    assert "End" in log.splitlines()[-3:] or re.search(r"^End\s*$", log, re.M), log[-3000:]
    return log


@pytest.mark.wsl
@pytest.mark.parametrize("model", TURBULENCE_MODELS)
def test_simplefoam_runs_two_iterations(tmp_path, channel_mesh, model):
    root = _project(tmp_path, {"turbulence_model": model})
    spec = load_run_spec(root, run_id="run-wsl", require_mesh=False, n_procs=1)
    spec.mesh_case_dir = channel_mesh
    spec.end_time = 2
    spec.write_interval = 2
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    log = _solve(case, "simpleFoam")
    assert re.search(r"^Time = 2\s*$", log, re.M), log[-2000:]
    for name in SOLVED[model]:
        assert re.search(rf"Solving for {name}\w*,", log), f"{model}: no {name} equation in log"
    assert (case / "2" / "U").is_file()


@pytest.mark.wsl
@pytest.mark.parametrize("model", TURBULENCE_MODELS)
def test_pimplefoam_runs_two_steps(tmp_path, channel_mesh, model):
    root = _project(tmp_path, {"turbulence_model": model, "time_dependency": "Transient"})
    spec = load_run_spec(
        root,
        run_id="run-wsl-t",
        require_mesh=False,
        n_procs=1,
        transient_override={"end_time": 0.0002, "delta_t": 0.0001, "time_step_mode": "fixed", "write_count": 1},
    )
    spec.mesh_case_dir = channel_mesh
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    log = _solve(case, "pimpleFoam")
    for name in SOLVED[model]:
        assert re.search(rf"Solving for {name}\w*,", log), f"{model}: no {name} equation in log"


@pytest.mark.parametrize(
    ("line", "field", "value"),
    [
        ("smoothSolver:  Solving for epsilon, Initial residual = 0.2299, Final residual = 0.0017, No Iterations 1", "epsilon", 0.2299),
        ("smoothSolver:  Solving for Rxy, Initial residual = 0.3046, Final residual = 0.0072, No Iterations 1", "Rxy", 0.3046),
        ("[3] smoothSolver:  Solving for omega, Initial residual = 1e-3, Final residual = 1e-5, No Iterations 1", "omega", 1e-3),
    ],
)
def test_residual_parser_reads_every_models_equations(line, field, value):
    from cfddesk.wsl.solve_run import parse_residual_line

    parsed = parse_residual_line(line)
    assert parsed is not None and parsed["field"] == field
    assert parsed["initial"] == pytest.approx(value)
