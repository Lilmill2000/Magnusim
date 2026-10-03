"""A study whose fluid is Water solves with Water's numbers everywhere the case
uses the fluid: viscosity, the sidecar's density, kinematic pressure and the
mass-flow inlet's density."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.analysis import write_run_case
from cfddesk.registry.discovery import get_hub
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec
from magnusim_sdk.fluids import by_key

NU_WATER = 1.004e-6
RHO_WATER = 998.2


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _water_case(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    shutil.copytree(JS_PROJECT, root)
    water = {
        "name": "Water",
        "library": "WATER",
        "kinematic_viscosity": NU_WATER,
        "density": RHO_WATER,
        "assigned_volumes": ["Body1"],
        "simulation_id": "sim_1",
    }
    (root / "materials.json").write_text(json.dumps({"materials": [water]}), encoding="utf-8")
    bcs = {
        "defaults": {"wall_type": "No-slip"},
        "boundary_conditions": [
            {
                "name": "inlet",
                "bc_type": "Velocity Inlet",
                "velocity_type": "Flow rate",
                "flow_rate_type": "Mass flow",
                "value": 2,
                "unit": "kg/s",
                "faces": ["face 1@Body1"],
                "simulation_id": "sim_1",
            },
            {
                "name": "outlet",
                "bc_type": "Pressure Outlet",
                "value": 1000,
                "unit": "Pa",
                "faces": ["face 2@Body1"],
                "simulation_id": "sim_1",
            },
        ],
    }
    (root / "boundary_conditions.json").write_text(json.dumps(bcs), encoding="utf-8")
    spec = load_run_spec(root, run_id="run-water", require_mesh=False, n_procs=1)
    assert spec.ok, spec.error
    assert (spec.nu, spec.rho) == (NU_WATER, RHO_WATER)
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    return case


def _patch(text: str, patch: str) -> str:
    m = re.search(rf"\b{patch}\s*\{{([^}}]*)\}}", text)
    assert m, patch
    return m.group(1)


def test_water_reaches_every_place_the_case_uses_the_fluid(tmp_path: Path):
    case = _water_case(tmp_path)
    transport = (case / "constant" / "transportProperties").read_text(encoding="utf-8")
    nu = re.search(r"^nu\s+\[0 2 -1 0 0 0 0\]\s+([^;]+);", transport, re.M)
    assert nu and float(nu.group(1)) == NU_WATER

    sidecar = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert sidecar["rho"] == RHO_WATER
    assert sidecar["nu"] == NU_WATER

    # p is kinematic: 1000 Pa over Water's density.
    outlet_p = _patch((case / "0" / "p").read_text(encoding="utf-8"), "outlet")
    assert "fixedValue" in outlet_p
    value = re.search(r"value\s+uniform\s+([^;]+);", outlet_p)
    assert value and float(value.group(1)) == pytest.approx(1000 / RHO_WATER, rel=1e-7)

    # The mass-flow inlet turns kg/s into a velocity with Water's density.
    inlet_u = _patch((case / "0" / "U").read_text(encoding="utf-8"), "inlet")
    assert "flowRateInletVelocity" in inlet_u
    rho_inlet = re.search(r"rhoInlet\s+([^;]+);", inlet_u)
    assert rho_inlet and float(rho_inlet.group(1)) == RHO_WATER
    mass = re.search(r"massFlowRate\s+constant\s+([^;]+);", inlet_u)
    assert mass and float(mass.group(1)) == pytest.approx(2.0)


def test_the_water_preset_is_the_sdk_water():
    rows = {row["key"]: row for row in get_hub().registry("material").describe()}
    library = {p["key"]: p for p in rows["newtonian_incompressible"]["library"]}
    sdk = by_key("water")
    assert library["water"]["name"] == sdk.name == "Water"
    assert library["water"]["values"] == {"nu": sdk.nu, "rho": sdk.rho} == {"nu": NU_WATER, "rho": RHO_WATER}
