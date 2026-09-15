"""Unit tests for web JSON → RunSpec adapter."""
from __future__ import annotations

from pathlib import Path

import pytest

from cfddesk.project.web_adapter import (
    air_from_materials,
    load_run_spec,
    sanitize_patch_name,
    web_bc_to_registry,
)

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"


def test_sanitize_patch_name():
    assert sanitize_patch_name("Velocity Inlet 1") == "velocity_inlet_1"
    assert sanitize_patch_name("pressure_1") == "pressure_1"


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


def test_web_bc_to_registry_velocity_and_pressure():
    key, settings = web_bc_to_registry(
        {
            "bc_type": "Velocity Inlet",
            "velocity_type": "Fixed",
            "value": 2.0,
            "unit": "m/s",
            "direction": "normal",
        }
    )
    assert key == "velocity_inlet_fixed"
    assert settings.get("speed") == 2.0

    key2, settings2 = web_bc_to_registry(
        {"bc_type": "Pressure Outlet", "value": 0, "unit": "Pa"}
    )
    assert key2.startswith("pressure_")
    assert settings2.get("gauge_pressure") == 0.0


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


def test_parse_boundary_patches_indented(tmp_path: Path):
    from cfddesk.project.web_adapter import _parse_boundary_patches

    boundary = tmp_path / "boundary"
    boundary.write_text(
        "FoamFile\n{\n    format ascii;\n}\n\n3\n(\n    walls\n    {\n        type            wall;\n    }\n"
        "    velocity_inlet_1\n    {\n        type            patch;\n    }\n"
        "    pressure_1\n    {\n        type            patch;\n    }\n)\n",
        encoding="utf-8",
    )
    assert _parse_boundary_patches(boundary) == ["walls", "velocity_inlet_1", "pressure_1"]
