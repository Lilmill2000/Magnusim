"""Incompressible Flow's RunSpec: what it reads from the core's run inputs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.runspec import RunSpec, air_from_materials

FIX = JS_PROJECT


def test_assemble_study_bc_defaults_reads_slip_when_folder_bcs_exist(tmp_path: Path):
    from cfddesk.project.paths import (
        assemble_study_bc_defaults,
        create_geometry_folder,
        create_study_folder,
        find_study,
        persist_child_item,
    )

    create_geometry_folder(tmp_path, {"id": "g1", "name": "part.step", "original_filename": "part.step"})
    create_study_folder(tmp_path, "g1", {"id": "sim-a", "name": "Study A"})
    study = find_study(tmp_path, "sim-a")
    assert study is not None
    persist_child_item(
        Path(study["dir"]) / "boundary_conditions",
        "bc",
        {
            "id": "bc-1",
            "name": "Pressure 1",
            "bc_type": "Pressure",
            "faces": ["face 10@Body1"],
            "simulation_id": "sim-a",
        },
    )
    (Path(study["dir"]) / "boundary_conditions" / "defaults.json").write_text(
        json.dumps(
            {
                "defaults": {"wall_type": "Slip"},
                "defaults_by_simulation": {
                    "sim-other": {"wall_type": "No-slip"},
                    "sim-a": {"wall_type": "Slip"},
                },
                "simulation_id": "sim-a",
            }
        ),
        encoding="utf-8",
    )
    assert assemble_study_bc_defaults(tmp_path, "sim-a") == {"wall_type": "Slip"}
    spec = load_run_spec(tmp_path, run_id="r1", simulation_id="sim-a", require_mesh=False)
    assert spec.wall_default == "Slip"


def test_build_field_patches_slip_default_writes_slip_walls():
    from incompressible_flow.writer import _build_field_patches

    spec = RunSpec(
        project_dir=Path("."),
        run_id="r1",
        mesh_case_dir=Path("."),
        n_procs=1,
        solver_app="simpleFoam",
        end_time=200,
        write_interval=50,
        transient=None,
        nu=1.529e-5,
        rho=1.196,
        wall_default="Slip",
        bcs=[],
        monitor_patches=[],
        face_props={},
    )
    u_field, _p, _turb = _build_field_patches(
        spec, ["walls"], turb_values={"k": "1", "omega": "1", "epsilon": "1", "R": "(1 0 0 1 0 1)"}
    )
    assert u_field["walls"]["type"] == "slip"


def test_air_from_materials():
    mats = {
        "materials": [
            {
                "name": "Air",
                "kinematic_viscosity": 1.5e-5,
                "density": 1.2,
                "assigned_volumes": ["solid_1"],
                "simulation_id": "sim_1",
            }
        ]
    }
    air = air_from_materials(mats, "sim_1")
    assert air is not None
    assert air["nu"] == 1.5e-5
    assert air["rho"] == 1.2
    assert air["assigned"] is True


def test_load_run_spec_steady_fixture():
    if not (FIX / "boundary_conditions.json").is_file():
        pytest.skip("js-project fixture missing")
    spec = load_run_spec(FIX, run_id="run-land1", require_mesh=False)
    assert spec.ok
    assert spec.solver_app == "simpleFoam"
    assert spec.transient is None
    assert spec.nu > 0 and spec.rho > 0
    assert "velocity_inlet_1" in spec.monitor_patches or any(
        "inlet" in p for p in spec.monitor_patches
    )
    assert len(spec.bcs) >= 2


def test_load_run_spec_transient_fixture():
    if not (FIX / "boundary_conditions.json").is_file():
        pytest.skip("js-project fixture missing")
    # Force transient via override + control file already has transient block
    spec = load_run_spec(
        FIX,
        run_id="run-land1-t",
        require_mesh=False,
        transient_override={"end_time": 5, "write_count": 50},
    )
    assert spec.ok
    assert spec.solver_app == "pimpleFoam"
    assert spec.transient is not None
    assert abs(spec.transient.write_interval - 0.1) < 1e-12


def test_web_adapter_solver_app_name_no_collision():
    """land3-fix2: the run spec's Literal is SolverAppName; registry class stays SolverApp."""
    from cfddesk.registry.solver import SolverApp as RegSolverApp

    import incompressible_flow.runspec as wa

    assert hasattr(wa, "SolverAppName")
    assert not hasattr(wa, "SolverApp")
    assert wa.SolverAppName.__args__ == ("simpleFoam", "pimpleFoam")
    assert isinstance(RegSolverApp, type)
