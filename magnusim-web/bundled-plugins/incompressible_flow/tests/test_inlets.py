"""What each inlet, outlet and wall record writes into 0/U, 0/p and the turbulence
fields (writer._build_field_patches)."""

from __future__ import annotations

import math
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


# -- velocity outlets: the outflow the panel asks for ---------------------------


def _outlet(**fields) -> dict:
    return {"name": "Vent", "bc_type": "Velocity outlet", "faces": TWO_FACES, **fields}


def test_normal_velocity_outlet_writes_its_speed_outward():
    rec = _outlet(velocity_type="Fixed", value=10, unit="ft/s", direction="Normal to face")
    u, p, turb = _patches(_spec(("vent", rec)), "vent", "walls")
    # surfaceNormalFixedValue is positive out of the domain.
    assert u["vent"] == {"type": "surfaceNormalFixedValue", "refValue": "uniform 3.048", "value": "uniform (0 0 0)"}
    assert p["vent"] == {"type": "zeroGradient"}
    assert turb["k"]["vent"] == {"type": "inletOutlet", "inletValue": "uniform 0.5", "value": "uniform 0.5"}


def test_a_negative_outlet_speed_still_leaves():
    rec = _outlet(velocity_type="Fixed", value=-4, unit="m/s", direction="Normal to face")
    u, _p, _turb = _patches(_spec(("vent", rec)), "vent", "walls")
    assert _number(u["vent"]["refValue"]) == 4


def test_vector_velocity_outlet_writes_speed_along_the_vector():
    rec = _outlet(velocity_type="Fixed", value=3, unit="m/s", direction="Vector", vector=[0, 0, 2])
    u, _p, _turb = _patches(_spec(("vent", rec)), "vent", "walls")
    assert u["vent"]["type"] == "fixedValue"
    assert _vector(u["vent"]["value"]) == pytest.approx([0.0, 0.0, 3.0])


def test_volumetric_velocity_outlet_writes_its_rate_once_per_face():
    rec = _outlet(velocity_type="Flow rate", flow_rate_type="Volumetric flow", value=100, unit="ft3/min")
    u, _p, _turb = _patches(_spec(("vent", rec)), "vent", "walls")
    assert u["vent"]["type"] == "flowRateOutletVelocity"
    assert _number(u["vent"]["volumetricFlowRate"]) == pytest.approx(2 * 100 * CFM_M3S)
    assert "massFlowRate" not in u["vent"]


def test_mass_flow_velocity_outlet_writes_its_rate_and_the_fluid_density():
    rec = _outlet(velocity_type="Flow rate", flow_rate_type="Mass flow", value=0.25, unit="kg/s")
    u, _p, _turb = _patches(_spec(("vent", rec), rho=998.2), "vent", "walls")
    assert u["vent"]["type"] == "flowRateOutletVelocity"
    assert _number(u["vent"]["massFlowRate"]) == pytest.approx(0.5)
    assert u["vent"]["rhoOutlet"] == "998.2"


def test_a_velocity_outlet_without_a_value_keeps_the_free_outflow():
    rec = _outlet(velocity_type="Fixed", unit="m/s")
    u, p, _turb = _patches(_spec(("vent", rec)), "vent", "walls")
    assert u["vent"] == {"type": "inletOutlet", "inletValue": "uniform (0 0 0)", "value": "uniform (0 0 0)"}
    assert p["vent"] == {"type": "zeroGradient"}


# -- symmetry -------------------------------------------------------------------


def test_symmetry_mirrors_every_field():
    inlet = _inlet(velocity_type="Fixed", value=5, unit="m/s")
    sym = {"name": "Mid plane", "bc_type": "Symmetry", "faces": ["face 9@Body1"]}
    u, p, turb = _patches(_spec(("inlet", inlet), ("mid_plane", sym)), "inlet", "mid_plane", "walls")
    assert u["mid_plane"] == p["mid_plane"] == {"type": "symmetry"}
    assert {name: turb[name]["mid_plane"] for name in turb} == {name: {"type": "symmetry"} for name in ("k", "omega", "nut")}


BOUNDARY = """FoamFile
{
    version     2.0;
    format      ascii;
    class       polyBoundaryMesh;
    location    "constant/polyMesh";
    object      boundary;
}

4
(
    inlet
    {
        type            patch;
        nFaces          1;
        startFace       0;
    }
    mid_plane
    {
        type            wall;
        inGroups        1(wall);
        nFaces          1;
        startFace       1;
    }
    old_sym
    {
        type            symmetry;
        inGroups        1(symmetry);
        nFaces          1;
        startFace       2;
    }
    walls
    {
        type            wall;
        inGroups        1(wall);
        nFaces          1;
        startFace       3;
    }
)
"""


def test_the_case_makes_a_symmetry_bcs_patch_a_symmetry_patch_without_a_new_mesh(tmp_path: Path):
    from magnusim_sdk.foam import parse_boundary_patch_types

    from incompressible_flow.writer import write_solve_case

    mesh = tmp_path / "mesh" / "constant" / "polyMesh"
    mesh.mkdir(parents=True)
    (mesh / "owner").write_text("", encoding="utf-8")
    (mesh / "boundary").write_text(BOUNDARY, encoding="utf-8")
    inlet = _inlet(velocity_type="Fixed", value=5, unit="m/s")
    sym = {"name": "Mid plane", "bc_type": "Symmetry", "faces": ["face 9@Body1"]}
    # Meshed (or solved) as a symmetry plane before, a pressure boundary now.
    opened = {"name": "Old sym", "bc_type": "Pressure", "faces": ["face 8@Body1"], "value": 0, "unit": "Pa"}
    spec = _spec(("inlet", inlet), ("mid_plane", sym), ("old_sym", opened))
    spec.mesh_case_dir = tmp_path / "mesh"
    out = tmp_path / "case"
    write_solve_case(spec, out)
    types = parse_boundary_patch_types(out / "constant" / "polyMesh" / "boundary")
    assert types == {"inlet": "patch", "mid_plane": "symmetry", "old_sym": "patch", "walls": "wall"}
    u = " ".join((out / "0" / "U").read_text(encoding="utf-8").split())
    assert "mid_plane { type symmetry; }" in u


# -- freestream -----------------------------------------------------------------


def test_freestream_writes_the_far_field_conditions():
    far = {
        "name": "Far field",
        "bc_type": "Freestream",
        "faces": ["face 1@Body1"],
        "velocity_input": "Speed and direction",
        "value": 10,
        "unit": "ft/s",
        "vector": [0, 3, 4],
        "freestream_pressure": 120.4,
    }
    u, p, turb = _patches(_spec(("far_field", far), rho=1.204), "far_field", "walls")
    assert u["far_field"]["type"] == "freestreamVelocity"
    assert _vector(u["far_field"]["freestreamValue"]) == pytest.approx([0.0, 1.8288, 2.4384])
    assert p["far_field"] == {"type": "freestreamPressure", "freestreamValue": "uniform 100.00000"}
    assert turb["k"]["far_field"] == {"type": "freestream", "freestreamValue": "uniform 0.5"}
    assert turb["omega"]["far_field"] == {"type": "freestream", "freestreamValue": "uniform 20"}
    assert turb["nut"]["far_field"] == {"type": "calculated", "value": "uniform 0"}


def test_freestream_typed_as_a_velocity_vector_writes_that_vector():
    far = {"name": "Far", "bc_type": "Freestream", "faces": ["f"], "velocity_input": "Velocity vector", "value": 5, "unit": "m/s", "vector": [3, 0, -4]}
    u, _p, _turb = _patches(_spec(("far", far)), "far", "walls")
    assert _vector(u["far"]["freestreamValue"]) == pytest.approx([3.0, 0.0, -4.0])


def test_freestream_turbulence_on_auto_is_its_own_5_percent_and_viscosity_ratio_10():
    from incompressible_flow.writer import patch_turbulence

    far = {"name": "Far", "bc_type": "Freestream", "faces": ["f"], "value": 20, "unit": "m/s", "vector": [1, 0, 0]}
    spec = _spec(("far", far))
    own = patch_turbulence(spec, speed_ref=1.0)
    k = 1.5 * (0.05 * 20) ** 2
    assert own["far"]["k"] == pytest.approx(k)
    assert own["far"]["k"] / own["far"]["omega"] == pytest.approx(10 * spec.nu)
    # Its own setting wins over the Auto rule.
    far2 = {**far, "turbulence_spec": "Intensity and length scale", "turbulence_intensity": 1, "turbulence_length_scale": 0.1}
    own2 = patch_turbulence(_spec(("far", far2)), speed_ref=1.0)
    assert own2["far"]["length_scale_m"] == 0.1
    assert own2["far"]["k"] == pytest.approx(1.5 * (0.01 * 20) ** 2)


def test_a_freestream_only_case_takes_its_speed_as_the_reference():
    from incompressible_flow.writer import resolve_speed_and_dhyd

    far = {"name": "Far", "bc_type": "Freestream", "faces": ["f"], "value": 30, "unit": "m/s", "vector": [1, 0, 0]}
    speed, _d = resolve_speed_and_dhyd(_spec(("far", far)))
    assert speed == 30


# -- total-pressure inlet -------------------------------------------------------


def test_total_pressure_inlet_writes_p0_kinematic_and_lets_the_velocity_follow():
    intake = {"name": "Intake", "bc_type": "Total pressure inlet", "faces": ["f"], "value": 2, "unit": "kPa"}
    u, p, turb = _patches(_spec(("intake", intake), rho=1000.0), "intake", "walls")
    assert p["intake"] == {"type": "totalPressure", "p0": "uniform 2.0000000", "value": "uniform 2.0000000"}
    assert u["intake"] == {"type": "pressureInletOutletVelocity", "value": "uniform (0 0 0)"}
    assert turb["k"]["intake"] == {"type": "inletOutlet", "inletValue": "uniform 0.5", "value": "uniform 0.5"}


def test_total_pressure_inlet_takes_its_own_turbulence_at_the_case_speed():
    from incompressible_flow.writer import patch_turbulence

    intake = {
        "name": "Intake",
        "bc_type": "Total pressure inlet",
        "faces": ["f"],
        "value": 0,
        "turbulence_spec": "Intensity and viscosity ratio",
        "turbulence_intensity": 2,
        "turbulence_viscosity_ratio": 20,
    }
    own = patch_turbulence(_spec(("intake", intake)), speed_ref=4.0)
    assert own["intake"]["k"] == pytest.approx(1.5 * (0.02 * 4) ** 2)


def test_the_pressure_drop_from_a_total_pressure_inlet_sets_the_case_speed():
    from incompressible_flow.writer import resolve_speed_and_dhyd

    intake = {"name": "Intake", "bc_type": "Total pressure inlet", "faces": ["f1"], "value": 120.4, "unit": "Pa"}
    out = {"name": "Out", "bc_type": "Pressure", "faces": ["f2"], "value": 0, "unit": "Pa"}
    speed, _d = resolve_speed_and_dhyd(_spec(("intake", intake), ("out", out), rho=1.204))
    assert speed == pytest.approx(math.sqrt(2 * 120.4 / 1.204))


# -- moving and rotating walls --------------------------------------------------


def test_a_moving_wall_slides_at_its_velocity_with_wall_functions():
    belt = {"name": "Belt", "bc_type": "Wall", "wall_type": "Moving", "wall_velocity": [2, 0, 0], "faces": ["f"]}
    u, p, turb = _patches(_spec(("belt", belt)), "belt", "walls")
    assert u["belt"]["type"] == "fixedValue"
    assert _vector(u["belt"]["value"]) == pytest.approx([2.0, 0.0, 0.0])
    assert p["belt"] == {"type": "zeroGradient"}
    assert turb["k"]["belt"] == {"type": "kqRWallFunction", "value": "uniform 0.5"}
    assert turb["nut"]["belt"] == {"type": "nutkWallFunction", "value": "uniform 0"}


def test_a_rotating_wall_turns_about_its_axis_in_rad_per_s():
    disc = {
        "name": "Disc",
        "bc_type": "Wall",
        "wall_type": "Rotating",
        "rotation_axis": [0, 0, 2],
        "rotation_origin": [0.5, 0, 0],
        "rotation_speed": 600,
        "faces": ["f"],
    }
    u, p, turb = _patches(_spec(("disc", disc)), "disc", "walls")
    assert u["disc"]["type"] == "rotatingWallVelocity"
    assert (u["disc"]["origin"], u["disc"]["axis"]) == ("(0.5 0 0)", "(0 0 2)")
    assert float(u["disc"]["omega"]) == pytest.approx(600 * 2 * math.pi / 60)
    assert u["disc"]["value"] == "uniform (0 0 0)"
    assert p["disc"] == {"type": "zeroGradient"}
    assert turb["omega"]["disc"] == {"type": "omegaWallFunction", "value": "uniform 20"}


def test_moving_and_rotating_walls_are_wall_patches_in_a_laminar_case(tmp_path: Path):
    from magnusim_sdk.foam import parse_boundary_patch_types

    from incompressible_flow.physics import StudyPhysics
    from incompressible_flow.writer import write_solve_case

    mesh = tmp_path / "mesh" / "constant" / "polyMesh"
    mesh.mkdir(parents=True)
    (mesh / "owner").write_text("", encoding="utf-8")
    text = BOUNDARY.replace("mid_plane", "belt").replace("old_sym", "disc").replace("type            symmetry;", "type            patch;")
    (mesh / "boundary").write_text(text, encoding="utf-8")
    belt = {"name": "Belt", "bc_type": "Wall", "wall_type": "Moving", "wall_velocity": [1, 0, 0], "faces": ["f1"]}
    disc = {"name": "Disc", "bc_type": "Wall", "wall_type": "Rotating", "faces": ["f2"]}
    spec = _spec(("inlet", _inlet(velocity_type="Fixed", value=5, unit="m/s")), ("belt", belt), ("disc", disc))
    spec.mesh_case_dir = tmp_path / "mesh"
    spec.physics = StudyPhysics(turbulence_model="laminar")
    out = tmp_path / "case"
    write_solve_case(spec, out)
    types = parse_boundary_patch_types(out / "constant" / "polyMesh" / "boundary")
    assert types == {"inlet": "patch", "belt": "wall", "disc": "wall", "walls": "wall"}
    side = __import__("json").loads((out / "w27-case.json").read_text(encoding="utf-8"))
    assert {m["patch"]: m.get("wall_type") for m in side["mapped"]} == {"inlet": None, "belt": "Moving", "disc": "Rotating"}
