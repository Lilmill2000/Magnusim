"""A boundary's "Varies with time" table: what the record holds, what readiness
refuses, and what the case writer puts in 0/U and 0/p (transient runs only)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from cfddesk.project.paths import assemble_study_bcs, assemble_study_materials
from cfddesk.registry.contract import ReadyContext

from incompressible_flow import contract
from incompressible_flow import time_table as tt
from incompressible_flow.runspec import RunSpec
from incompressible_flow.writer import (
    _build_field_patches,
    patch_turbulence,
    resolve_speed_and_dhyd,
)

TURB = {"k": "0.5", "omega": "20", "epsilon": "0.9", "R": "(0.3 0 0 0.3 0 0.3)"}
TWO_FACES = ["face 1@Body1", "face 2@Body1"]
RAMP = [[0, 1], [0.2, 3]]


def _spec(*mapped: tuple[str, dict], transient: bool = True, rho: float = 1.2) -> RunSpec:
    return RunSpec(
        project_dir=Path("."),
        run_id="r1",
        mesh_case_dir=Path("."),
        n_procs=1,
        solver_app="pimpleFoam" if transient else "simpleFoam",
        end_time=1,
        write_interval=0.1,
        transient=None,
        nu=1.5e-5,
        rho=rho,
        wall_default="No-slip",
        bcs=[],
        monitor_patches=[],
        face_props={},
        mapped=[{"bc": bc, "patch": patch} for patch, bc in mapped],
        time_dependency="transient" if transient else "steady",
    )


def _patches(spec: RunSpec, *names: str):
    return _build_field_patches(spec, list(names), turb_values=TURB)


def _inlet(**fields) -> dict:
    base = {"name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 1@Body1"], "value": 5, "unit": "m/s"}
    return {**base, "time_varying": True, "time_table": RAMP, **fields}


def _pressure(**fields) -> dict:
    base = {"name": "Pressure", "bc_type": "Pressure", "faces": ["face 3@Body1"], "value": 0, "unit": "Pa"}
    return {**base, "time_varying": True, "time_table": [[0, 12], [1, 24]], **fields}


def _rows(entry: str) -> list[tuple[str, str]]:
    """The (time, value) rows of a written table Function1."""
    body = entry.split("values", 1)[1].split(");", 1)[0]
    out = []
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("(") and line.endswith(")") and line != "(":
            t, v = line[1:-1].split(" ", 1)
            out.append((t, v))
    return out


def _opt(entry: str, key: str) -> str:
    for line in entry.splitlines():
        parts = line.strip().rstrip(";").split()
        if parts and parts[0] == key:
            return parts[1]
    raise AssertionError(f"{key} not in {entry!r}")


# -- the record -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "on"),
    [(True, True), ("true", True), (False, False), (None, False), ("no", False), (1, False)],
)
def test_varies_with_time_reads_a_saved_flag(raw, on):
    assert tt.varies_with_time({"time_varying": raw}) is on


def test_after_the_last_point_holds_unless_repeat():
    assert tt.after_last({}) == "Hold"
    assert tt.after_last({"time_after_last": "repeat"}) == "Repeat"
    assert tt.after_last({"time_after_last": "Loop"}) == "Hold"


@pytest.mark.parametrize(
    ("rows", "problem"),
    [
        ([], "the table needs at least 2 rows (time, value)"),
        ([[0, 1]], "the table needs at least 2 rows (time, value)"),
        ([[0, 1], [None, 2]], "row 2 has no time"),
        ([[0, 1], [1, ""]], "row 2 has no value"),
        ([[0, 1], [1, "abc"]], "row 2 has no value"),
        ([[0, 1], [0, 2]], "the times must increase from row to row (row 2 is at 0 s, not after 0 s)"),
        ([[0, 1], [2, 2], [1.5, 3]], "the times must increase from row to row (row 3 is at 1.5 s, not after 2 s)"),
        ([[0, 1], [1, 2]], None),
        ([["0", "1"], ["0.5", "2"]], None),
    ],
)
def test_table_problem_in_the_users_words(rows, problem):
    assert tt.table_problem({"time_table": rows, "unit": "m/s"}, "velocity") == problem


def test_values_are_converted_from_the_unit_they_were_typed_in():
    rec = {"time_table": [[0, 10], [1, 20]], "unit": "ft/s"}
    assert tt.si_rows(rec, "velocity") == pytest.approx([(0, 3.048), (1, 6.096)])
    # The table's own unit wins over the BC's (the panel stores it with the rows).
    rec = {"time_table": [[0, 1], [1, 2]], "unit": "ft/s", "time_table_unit": "m/s"}
    assert tt.si_rows(rec, "velocity") == pytest.approx([(0, 1), (1, 2)])
    assert tt.si_rows({"time_table": [[0, 100], [1, 200]], "unit": "ft3/min"}, "volumetric_flow") == pytest.approx(
        [(0, 0.047194745), (1, 0.09438949)]
    )
    assert tt.si_rows({"time_table": [[0, 1], [1, 2]], "unit": "psi"}, "pressure") == pytest.approx(
        [(0, 6894.757293168), (1, 13789.514586336)]
    )


def test_a_table_typed_for_another_quantity_is_refused_not_misread():
    # Typed in m/s on a velocity inlet, then the BC became a pressure.
    rec = {"time_table": [[0, 1], [1, 2]], "unit": "Pa", "time_table_unit": "m/s"}
    assert tt.table_problem(rec, "pressure") == "its values are in m/s, which is not a unit of pressure: type them again"
    assert tt.si_rows(rec, "pressure") is None


def test_peak_and_span():
    rec = {"time_table": [[0, -4], [1, 2], [2, 3]], "unit": "m/s"}
    assert tt.peak_si(rec, "velocity") == 4
    assert tt.span_si(rec, "velocity") == (-4, 3)
    assert tt.peak_si({"time_table": [[0, 1]]}, "velocity") is None


# -- the case: velocity inlets --------------------------------------------------------


def test_normal_speed_table_is_uniform_normal_fixed_value_pointing_in():
    u, p, turb = _patches(_spec(("inlet", _inlet())), "inlet", "walls")
    e = u["inlet"]
    assert e["type"] == "uniformNormalFixedValue"
    # Positive along the outward normal in OpenFOAM: an inflow is negative.
    assert _rows(e["uniformValue"]) == [("0", "-1"), ("0.2", "-3")]
    assert _opt(e["uniformValue"], "type") == "table"
    assert _opt(e["uniformValue"], "outOfBounds") == "clamp"
    assert _opt(e["uniformValue"], "interpolationScheme") == "linear"
    assert e["value"] == "uniform (0 0 0)"
    assert p["inlet"] == {"type": "zeroGradient"}
    # Turbulence at the inlet stays fixed.
    assert turb["k"]["inlet"] == {"type": "fixedValue", "value": "uniform 0.5"}


def test_repeat_writes_out_of_bounds_repeat():
    u, _p, _t = _patches(_spec(("inlet", _inlet(time_after_last="Repeat"))), "inlet", "walls")
    assert _opt(u["inlet"]["uniformValue"], "outOfBounds") == "repeat"


def test_vector_table_is_uniform_fixed_value_along_the_unit_vector():
    rec = _inlet(direction="Vector", vector=[3, 4, 0], time_table=[[0, 5], [1, 10]])
    u, _p, _t = _patches(_spec(("inlet", rec)), "inlet", "walls")
    e = u["inlet"]
    assert e["type"] == "uniformFixedValue"
    assert _rows(e["uniformValue"]) == [("0", "(3 4 0)"), ("1", "(6 8 0)")]
    assert e["value"] == "uniform (3 4 0)"


def test_volumetric_flow_table_is_per_face():
    rec = _inlet(velocity_type="Flow rate", flow_rate_type="Volumetric flow", unit="m³/s", faces=TWO_FACES, time_table=[[0, 0.01], [2, 0.03]])
    u, _p, _t = _patches(_spec(("inlet", rec)), "inlet", "walls")
    e = u["inlet"]
    assert e["type"] == "flowRateInletVelocity"
    assert _rows(e["volumetricFlowRate"]) == [("0", "0.02"), ("2", "0.06")]
    assert "massFlowRate" not in e
    assert e["extrapolateProfile"] == "false"


def test_mass_flow_table_carries_the_fluid_density():
    rec = _inlet(velocity_type="Flow rate", flow_rate_type="Mass flow", unit="lb/s", time_table=[[0, 1], [1, 2]])
    u, _p, _t = _patches(_spec(("inlet", rec), rho=998.2), "inlet", "walls")
    e = u["inlet"]
    assert e["type"] == "flowRateInletVelocity"
    assert _rows(e["massFlowRate"]) == [("0", "0.45359237"), ("1", "0.90718474")]
    assert e["rhoInlet"] == "998.2"


# -- the case: pressures ----------------------------------------------------------------


def test_pressure_table_is_uniform_fixed_value_kinematic():
    _u, p, _t = _patches(_spec(("pressure", _pressure()), rho=1.2), "pressure", "walls")
    e = p["pressure"]
    assert e["type"] == "uniformFixedValue"
    assert _rows(e["uniformValue"]) == [("0", "10"), ("1", "20")]
    assert e["value"] == "uniform 10"


def test_total_pressure_table_is_uniform_total_pressure():
    rec = _pressure(bc_type="Total pressure inlet", unit="kPa", time_table=[[0, 1.2], [0.5, 2.4]], time_after_last="Repeat")
    u, p, _t = _patches(_spec(("intake", rec), rho=1.2), "intake", "walls")
    e = p["intake"]
    assert e["type"] == "uniformTotalPressure"
    assert _rows(e["p0"]) == [("0", "1000"), ("0.5", "2000")]
    assert _opt(e["p0"], "outOfBounds") == "repeat"
    assert u["intake"]["type"] == "pressureInletOutletVelocity"


# -- steady studies, tables that are off or wrong -------------------------------------------


@pytest.mark.parametrize(
    ("patch", "rec"),
    [("inlet", _inlet()), ("pressure", _pressure()), ("intake", _pressure(bc_type="Total pressure inlet"))],
    ids=["inlet", "pressure", "total pressure"],
)
def test_a_steady_study_writes_the_fixed_value(patch, rec):
    steady = _patches(_spec((patch, rec), transient=False), patch, "walls")
    off = _patches(_spec((patch, {**rec, "time_varying": False})), patch, "walls")
    assert steady == off
    u, p, _t = steady
    assert u[patch]["type"] in ("surfaceNormalFixedValue", "pressureInletOutletVelocity")
    assert p[patch]["type"] in ("zeroGradient", "fixedValue", "totalPressure")


def test_a_run_with_its_transient_control_resolved_is_transient():
    spec = _spec(("inlet", _inlet()), transient=False)
    spec.transient = object()  # type: ignore[assignment]
    u, _p, _t = _patches(spec, "inlet", "walls")
    assert u["inlet"]["type"] == "uniformNormalFixedValue"


def test_a_table_readiness_refuses_is_never_written():
    u, _p, _t = _patches(_spec(("inlet", _inlet(time_table=[[0, 1]]))), "inlet", "walls")
    assert u["inlet"]["type"] == "surfaceNormalFixedValue"


def test_the_written_field_reads_as_one_dictionary(tmp_path: Path):
    from magnusim_sdk.foam import write_vol_field

    u, _p, _t = _patches(_spec(("inlet", _inlet())), "inlet", "walls")
    write_vol_field(tmp_path / "U", object_name="U", cls="volVectorField", dims="[0 1 -1 0 0 0 0]", internal="uniform (0 0 0)", patches=u)
    text = (tmp_path / "U").read_text(encoding="utf-8")
    block = text.split("    inlet\n", 1)[1].split("\n    }\n", 1)[0]
    assert "type          uniformNormalFixedValue;" in block
    assert "uniformValue          \n        {\n            type            table;" in block
    # The table's braces close inside the patch (whose own closing brace the split dropped).
    assert block.count("{") == block.count("}") + 1
    assert "        };\n        value          uniform (0 0 0);" in block


# -- reference speed (turbulence at the inlet, velocity cap, time step) -------------------


def test_the_reference_speed_is_the_tables_largest():
    rec = _inlet(value=1, time_table=[[0, 0], [1, 30], [2, 10]])
    assert resolve_speed_and_dhyd(_spec(("inlet", rec)))[0] == pytest.approx(30)
    assert resolve_speed_and_dhyd(_spec(("inlet", rec), transient=False))[0] == pytest.approx(1)


def test_inlet_turbulence_uses_the_tables_largest_speed():
    rec = _inlet(value=1, time_table=[[0, 0], [1, 20]], turbulence_spec="Intensity and length scale", turbulence_intensity=5, turbulence_length_scale=0.01)
    own = patch_turbulence(_spec(("inlet", rec)), speed_ref=1.0)
    assert own["inlet"]["k"] == pytest.approx(1.5 * (0.05 * 20) ** 2)


def test_pressure_tables_set_the_pressure_driven_speed():
    a = _pressure(name="A", time_table=[[0, 0], [1, 600]])
    b = {"name": "B", "bc_type": "Pressure", "faces": ["face 4@Body1"], "value": 0, "unit": "Pa"}
    speed, _d = resolve_speed_and_dhyd(_spec(("a", a), ("b", b), rho=1.2))
    assert speed == pytest.approx((2 * 600 / 1.2) ** 0.5)


# -- readiness ---------------------------------------------------------------------------


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def _ready(tmp_path: Path, bcs: list[dict], *, td: str = "Transient", patches: tuple[str, ...] = ("inlet", "pressure", "walls")) -> list[dict]:
    root = tmp_path / "p"
    geom = root / "geometries" / "Geometry_g"
    _write(geom / "id.json", {"id": "g", "kind": "geometry"})
    study = geom / "simulations" / "Study"
    _write(study / "id.json", {"id": "s1", "kind": "simulation", "time_dependency": td})
    _write(study / "materials" / "Air" / "material.json", {"id": "m1", "name": "Air", "simulation_id": "s1", "assigned_volumes": ["v1"]})
    for i, bc in enumerate(bcs):
        _write(study / "boundary_conditions" / f"BC_{i}" / "bc.json", {"id": f"b{i}", "simulation_id": "s1", **bc})
    ctx = ReadyContext(
        project_dir=root,
        simulation_id="s1",
        run_id="r1",
        mesh_id="m",
        mesh_case_dir=None,
        patches=patches,
        study={"id": "s1", "time_dependency": td},
        read_study=lambda _n: None,
        mesh={"mesh_id": "m", "mesh_name": "Mesh 1"},
        materials=tuple(assemble_study_materials(root, "s1")),
        bcs=tuple(assemble_study_bcs(root, "s1")),
    )
    return contract.validate_ready(ctx)


OUTLET = {"name": "Pressure", "bc_type": "Pressure", "faces": ["face 2@B"], "value": 0, "unit": "Pa"}


@pytest.mark.parametrize(
    ("rows", "problem"),
    [
        ([[0, 1]], "the table needs at least 2 rows (time, value)"),
        ([[0, 1], [0, 2]], "the times must increase from row to row (row 2 is at 0 s, not after 0 s)"),
        ([[0, 1], [1, None]], "row 2 has no value"),
    ],
)
def test_ready_refuses_a_table_that_cannot_be_solved(tmp_path: Path, rows, problem):
    issues = _ready(tmp_path, [_inlet(time_table=rows), OUTLET])
    assert issues == [{"message": f'"Varies with time" on "Inlet": {problem}.', "fix": {"go": "bc", "id": "b0", "name": "Inlet"}}]


def test_ready_refuses_a_pressure_table_typed_in_a_speed_unit(tmp_path: Path):
    issues = _ready(tmp_path, [_inlet(time_varying=False), _pressure(time_table_unit="m/s")])
    assert issues[0]["message"] == '"Varies with time" on "Pressure": its values are in m/s, which is not a unit of pressure: type them again.'


def test_a_steady_study_ignores_the_table(tmp_path: Path):
    assert _ready(tmp_path, [_inlet(time_table=[[0, 1]]), OUTLET], td="Steady-state") == []


def test_ready_with_good_tables(tmp_path: Path):
    assert _ready(tmp_path, [_inlet(), OUTLET]) == []


def test_two_pressures_with_the_same_value_are_driven_by_a_table(tmp_path: Path):
    a = _pressure(name="A", faces=["face 1@B"], time_table=[[0, 0], [1, 50]])
    b = {**OUTLET, "name": "B"}
    assert _ready(tmp_path, [a, b], patches=("a", "b")) == []
    issues = _ready(tmp_path, [a, b], td="Steady-state", patches=("a", "b"))
    assert issues[0]["message"].startswith("Both pressure boundaries have the same value")
