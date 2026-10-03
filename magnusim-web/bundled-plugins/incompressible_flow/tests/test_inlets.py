"""What each inlet, outlet and wall record writes into 0/U, 0/p and the turbulence
fields (writer._build_field_patches)."""

from __future__ import annotations

from pathlib import Path

import pytest

from incompressible_flow.runspec import RunSpec
from incompressible_flow.writer import _build_field_patches

TURB = {"k": "0.5", "omega": "20", "epsilon": "0.9", "R": "(0.3 0 0 0.3 0 0.3)"}
TWO_FACES = ["face 1@Body1", "face 2@Body1"]
CFM_M3S = 0.00047194745


def _spec(*mapped: tuple[str, dict], rho: float = 1.204, wall_default: str = "No-slip") -> RunSpec:
    return RunSpec(
        project_dir=Path("."),
        run_id="r1",
        mesh_case_dir=Path("."),
        n_procs=1,
        solver_app="simpleFoam",
        end_time=200,
        write_interval=50,
        transient=None,
        nu=1.516e-5,
        rho=rho,
        wall_default=wall_default,
        bcs=[],
        monitor_patches=[],
        face_props={},
        mapped=[{"bc": bc, "patch": patch} for patch, bc in mapped],
    )


def _patches(spec: RunSpec, *names: str):
    return _build_field_patches(spec, list(names), turb_values=TURB)


def _inlet(**fields) -> dict:
    return {"name": "Inlet", "bc_type": "Velocity inlet", "faces": TWO_FACES, **fields}


def _number(entry: str) -> float:
    """The number of 'constant 0.02' or 'uniform -5'."""
    return float(entry.split()[1])


def _vector(entry: str) -> list[float]:
    """The components of 'uniform (1 2 2)'."""
    return [float(x) for x in entry.split("(", 1)[1].rstrip(")").split()]


def test_volumetric_inlet_writes_its_rate_once_per_face():
    rec = _inlet(velocity_type="Flow rate", flow_rate_type="Volumetric flow", value=0.01, unit="m3/s")
    u, p, _turb = _patches(_spec(("inlet", rec)), "inlet", "walls")
    assert u["inlet"]["type"] == "flowRateInletVelocity"
    assert _number(u["inlet"]["volumetricFlowRate"]) == pytest.approx(0.02)
    assert "massFlowRate" not in u["inlet"]
    assert p["inlet"] == {"type": "zeroGradient"}


def test_mass_flow_inlet_writes_its_rate_per_face_and_the_fluid_density():
    rec = _inlet(velocity_type="Flow rate", flow_rate_type="Mass flow", value=0.5, unit="kg/s")
    u, _p, _turb = _patches(_spec(("inlet", rec), rho=1.204), "inlet", "walls")
    assert u["inlet"]["type"] == "flowRateInletVelocity"
    assert _number(u["inlet"]["massFlowRate"]) == pytest.approx(1.0)
    assert float(u["inlet"]["rhoInlet"]) == 1.204
    assert "volumetricFlowRate" not in u["inlet"]


@pytest.mark.parametrize("unit", ["ft3/min", "ft\N{SUPERSCRIPT THREE}/min"])
def test_imperial_flow_rate_is_converted_then_written_per_face(unit):
    rec = _inlet(velocity_type="Flow rate", flow_rate_type="Volumetric flow", value=100, unit=unit)
    u, _p, _turb = _patches(_spec(("inlet", rec)), "inlet", "walls")
    assert _number(u["inlet"]["volumetricFlowRate"]) == pytest.approx(2 * 100 * CFM_M3S)


@pytest.mark.parametrize(
    "rec",
    [
        _inlet(velocity_type="Flow rate", flow_rate_type="Volumetric flow", value=0.01, unit="m3/s"),
        _inlet(velocity_type="Flow rate", flow_rate_type="Mass flow", value=0.5, unit="kg/s"),
        _inlet(velocity_type="Fixed", value=5, unit="m/s", direction="Normal to face"),
    ],
    ids=["volumetric", "mass", "fixed"],
)
def test_apply_per_face_flag_changes_nothing(rec):
    # Older projects' records have no apply_per_face; the rate is per face either way.
    without = _patches(_spec(("inlet", rec)), "inlet", "walls")
    flagged = _patches(_spec(("inlet", {**rec, "apply_per_face": True})), "inlet", "walls")
    assert flagged == without


def test_vector_inlet_writes_speed_times_the_unit_vector():
    rec = _inlet(velocity_type="Fixed", value=3, unit="m/s", direction="Vector", vector=[1, 2, 2])
    u, _p, _turb = _patches(_spec(("inlet", rec)), "inlet", "walls")
    assert u["inlet"]["type"] == "fixedValue"
    assert _vector(u["inlet"]["value"]) == pytest.approx([1.0, 2.0, 2.0])


def test_normal_inlet_writes_surface_normal_minus_speed():
    rec = _inlet(velocity_type="Fixed", value=10, unit="ft/s", direction="Normal to face")
    u, _p, _turb = _patches(_spec(("inlet", rec)), "inlet", "walls")
    assert u["inlet"]["type"] == "surfaceNormalFixedValue"
    assert _number(u["inlet"]["refValue"]) == pytest.approx(-3.048)
    assert u["inlet"]["value"] == "uniform (0 0 0)"


def test_inlet_turbulence_is_fixed():
    rec = _inlet(velocity_type="Fixed", value=5, unit="m/s")
    _u, _p, turb = _patches(_spec(("inlet", rec)), "inlet", "walls")
    assert turb["k"]["inlet"] == {"type": "fixedValue", "value": "uniform 0.5"}
    assert turb["omega"]["inlet"] == {"type": "fixedValue", "value": "uniform 20"}
    assert turb["nut"]["inlet"] == {"type": "calculated", "value": "uniform 0"}


def test_an_explicit_slip_wall_under_a_no_slip_default_is_slip_on_its_patch_only():
    inlet = _inlet(velocity_type="Fixed", value=5, unit="m/s")
    slip = {"name": "Wall 57", "bc_type": "Wall", "wall_type": "Slip", "faces": ["face 57@Body1"]}
    u, p, turb = _patches(_spec(("inlet", inlet), ("wall_57", slip)), "inlet", "wall_57", "walls")
    assert u["wall_57"] == {"type": "slip"}
    assert p["wall_57"] == {"type": "zeroGradient"}
    assert turb["k"]["wall_57"] == {"type": "zeroGradient"}
    assert turb["omega"]["wall_57"] == {"type": "zeroGradient"}
    assert turb["nut"]["wall_57"] == {"type": "calculated", "value": "uniform 0"}
    # Every other wall keeps the No-slip default and its wall functions.
    assert u["walls"] == {"type": "noSlip"}
    assert turb["k"]["walls"] == {"type": "kqRWallFunction", "value": "uniform 0.5"}
    assert turb["omega"]["walls"] == {"type": "omegaWallFunction", "value": "uniform 20"}
    assert turb["nut"]["walls"] == {"type": "nutkWallFunction", "value": "uniform 0"}
