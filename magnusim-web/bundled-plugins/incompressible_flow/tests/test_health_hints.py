"""The run's health hints (RH1): what the case writer tells the health checks of a run."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

from incompressible_flow.runspec import RunSpec
from incompressible_flow.transient import TransientControl
from incompressible_flow.writer import fixed_inflow, write_solve_case

TWO_FACES = ["face 1@Body1", "face 2@Body1"]
BOUNDARY = """FoamFile
{
    version     2.0;
    format      ascii;
    class       polyBoundaryMesh;
    object      boundary;
}
3
(
    inlet
    {
        type            patch;
        nFaces          1;
        startFace       0;
    }
    outlet
    {
        type            patch;
        nFaces          1;
        startFace       1;
    }
    walls
    {
        type            wall;
        nFaces          1;
        startFace       2;
    }
)
"""
INLET = {"name": "Inlet", "bc_type": "Velocity inlet", "faces": TWO_FACES, "velocity_type": "Fixed", "value": 5, "unit": "m/s"}
OUTLET = {"name": "Outlet", "bc_type": "Pressure outlet", "faces": ["face 3@Body1"], "value": 0, "unit": "Pa"}
TOTAL = {"name": "Inlet", "bc_type": "Total pressure inlet", "faces": TWO_FACES, "value": 100, "unit": "Pa"}


def _spec(*mapped: tuple[str, dict], transient: TransientControl | None = None) -> RunSpec:
    return RunSpec(
        project_dir=Path("."),
        run_id="r1",
        mesh_case_dir=Path("."),
        n_procs=1,
        solver_app="pimpleFoam" if transient else "simpleFoam",
        end_time=transient.end_time if transient else 200,
        write_interval=50,
        transient=transient,
        nu=1.516e-5,
        rho=1.204,
        wall_default="No-slip",
        bcs=[],
        monitor_patches=["inlet", "outlet"],
        face_props={},
        mapped=[{"bc": bc, "patch": patch} for patch, bc in mapped],
    )


PISO = TransientControl(
    end_time=10.0,
    delta_t=1e-4,
    write_interval=0.5,
    adjust_time_step=True,
    max_co=100.0,
    max_delta_t=0.5,
    time_scheme="Euler",
    n_outer_correctors=1,
    n_correctors=2,
    n_non_orthogonal_correctors=0,
)


def _written(tmp_path: Path, spec: RunSpec) -> tuple[dict, dict]:
    mesh = tmp_path / "mesh" / "constant" / "polyMesh"
    mesh.mkdir(parents=True)
    (mesh / "owner").write_text("", encoding="utf-8")
    (mesh / "boundary").write_text(BOUNDARY, encoding="utf-8")
    spec.mesh_case_dir = tmp_path / "mesh"
    out = tmp_path / "case"
    report = write_solve_case(spec, out)
    side = json.loads((out / "w27-case.json").read_text(encoding="utf-8"))
    return side, report


def test_a_piso_run_carries_its_mode_courant_limit_and_monitors(tmp_path: Path):
    side, report = _written(tmp_path, _spec(("inlet", INLET), ("outlet", OUTLET), transient=PISO))
    h = side["health_hints"]
    assert report["health_hints"] == h
    assert h["app"] == "pimpleFoam" and h["mode"] == "PISO"
    assert h["n_outer"] == 1 and h["n_correctors"] == 2 and h["max_co"] == 100.0
    assert h["end_time"] == 10.0 and h["average_from"] == 0.0
    assert h["uref"] == 5.0 and h["fixed_inflow"] is True
    assert h["limiter"] == {"name": "limitU", "cap": 50.0, "factor": 10, "floor": 50}
    assert h["linsolve"]["p"] == {"max_iter": 200, "tol": 1e-7, "rel_tol": 0.01, "final_rel_tol": 0.0}
    assert h["linsolve"]["U"]["max_iter"] == 50
    assert h["monitors"] == {"inlet": "mon_inlet", "outlet": "mon_outlet"}


def test_a_table_inlet_and_a_pressure_driven_case_have_no_fixed_inflow(tmp_path: Path):
    table = {**INLET, "time_varying": True, "time_table": [[0, 0], [1, 5]]}
    assert fixed_inflow(_spec(("inlet", table), ("outlet", OUTLET), transient=PISO)) is False
    # A table only counts in a transient study.
    assert fixed_inflow(_spec(("inlet", table), ("outlet", OUTLET))) is True
    assert fixed_inflow(_spec(("inlet", TOTAL), ("outlet", OUTLET), transient=PISO)) is False
    assert fixed_inflow(_spec(("outlet", OUTLET), transient=PISO)) is False


def test_a_steady_run_is_simple_with_no_courant(tmp_path: Path):
    side, _ = _written(tmp_path, _spec(("inlet", INLET), ("outlet", OUTLET)))
    h = side["health_hints"]
    assert h["mode"] == "SIMPLE" and h["n_outer"] is None and h["max_co"] is None
    assert h["linsolve"]["p"]["final_rel_tol"] == 0.01


def test_pimple_mode(tmp_path: Path):
    side, _ = _written(tmp_path, _spec(("inlet", INLET), ("outlet", OUTLET), transient=dataclasses.replace(PISO, n_outer_correctors=3, max_co=5.0)))
    assert side["health_hints"]["mode"] == "PIMPLE" and side["health_hints"]["n_outer"] == 3
