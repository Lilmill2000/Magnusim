"""incompressible_flow.flow_bcs: the exported flow BCs are exactly what the writer writes.

Every BC kind, both time dependencies, every turbulence model family and every
starting flow: the case Incompressible Flow's own ``write_solve_case`` writes for a
study and the ``0/U`` and turbulence fields a caller writes from ``flow_patches`` for
the same run are byte-identical. The js-project golden case too. Then the module's
public surface: fixed wall tokens, fixed scale keys, Incompressible Flow's own Start
sentences and its reading of the turbulence model.
"""

from __future__ import annotations

import dataclasses
import re
from pathlib import Path

import pytest
from cfddesk.project.run_inputs import RunInputs, gather_run_inputs
from conftest import JS_PROJECT
from magnusim_sdk.foam import write_vol_field

from incompressible_flow import flow_bcs
from incompressible_flow.runspec import load_run_spec
from incompressible_flow.writer import _uniform_vector, write_solve_case

PLUGIN_DIR = Path(__file__).resolve().parents[1]

# One record of every kind Incompressible Flow offers.
RECORDS = [
    {"id": "in1", "name": "inlet_speed", "bc_type": "Velocity inlet", "value": 2.0, "unit": "m/s", "faces": ["f1"],
     "turbulence_spec": "Intensity and length scale", "turbulence_intensity": 3, "turbulence_length_scale": 0.02},
    {"id": "in2", "name": "inlet_mass", "bc_type": "Velocity inlet", "velocity_type": "Flow rate",
     "flow_rate_type": "Mass", "value": 0.01, "unit": "kg/s", "faces": ["f2"]},
    {"id": "in3", "name": "inlet_vector", "bc_type": "Velocity inlet", "value": 1.5, "unit": "m/s",
     "direction": "Vector", "vector": [1, 1, 0], "faces": ["f3"],
     "turbulence_spec": "Intensity and viscosity ratio", "turbulence_intensity": 4, "turbulence_viscosity_ratio": 20},
    {"id": "in4", "name": "inlet_table", "bc_type": "Velocity inlet", "value": 1.0, "unit": "m/s", "faces": ["f4"],
     "time_varying": True, "time_table": [[0, 0.5], [1, 2.0]]},
    {"id": "out1", "name": "outlet_p", "bc_type": "Pressure", "value": 10, "unit": "Pa", "faces": ["f5"]},
    {"id": "out2", "name": "outlet_u", "bc_type": "Velocity outlet", "value": 0.5, "unit": "m/s", "faces": ["f6"]},
    {"id": "w1", "name": "wall_move", "bc_type": "Wall", "wall_type": "Moving", "wall_velocity": [0.2, 0, 0], "faces": ["f7"]},
    {"id": "w2", "name": "wall_spin", "bc_type": "Wall", "wall_type": "Rotating", "rotation_axis": [0, 0, 1],
     "rotation_speed": 60, "faces": ["f8"]},
    {"id": "w3", "name": "wall_slip", "bc_type": "Wall", "wall_type": "Slip", "faces": ["f9"]},
    {"id": "s1", "name": "sym", "bc_type": "Symmetry", "faces": ["f10"]},
    {"id": "fs1", "name": "far", "bc_type": "Freestream", "value": 3.0, "unit": "m/s", "vector": [0, 1, 0],
     "freestream_pressure": 5, "faces": ["f11"]},
    {"id": "tp1", "name": "total", "bc_type": "Total pressure inlet", "value": 20, "unit": "Pa", "faces": ["f12"]},
]

PATCHES = ["walls", *(r["name"] for r in RECORDS)]
MODELS = ["laminar", "kOmegaSST", "kEpsilon", "SpalartAllmaras", "LRR"]
STARTS = [("still", (0.0, 0.0, 0.0)), ("inlet", (0.0, 0.0, 0.0)), ("custom", (0.3, -0.1, 0.05))]
DIMS = {
    "k": ("volScalarField", "[0 2 -2 0 0 0 0]"),
    "omega": ("volScalarField", "[0 0 -1 0 0 0 0]"),
    "epsilon": ("volScalarField", "[0 2 -3 0 0 0 0]"),
    "R": ("volSymmTensorField", "[0 2 -2 0 0 0 0]"),
    "nut": ("volScalarField", "[0 2 -1 0 0 0 0]"),
    "nuTilda": ("volScalarField", "[0 2 -1 0 0 0 0]"),
}


def _inputs(tmp_path: Path, *, transient: bool, model: str = "kOmegaSST", start: str = "still",
            u0: tuple[float, float, float] = (0.0, 0.0, 0.0)) -> RunInputs:
    return RunInputs(
        project_dir=tmp_path,
        run_id="r1",
        simulation_id="s1",
        mesh_id=None,
        n_procs=1,
        require_mesh=False,
        time_dependency="transient" if transient else "steady",
        analysis_key="other_analysis",
        solver_key="otherFoam",
        materials={"materials": []},
        bcs_doc={"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{**r, "simulation_id": "s1"} for r in RECORDS]},
        mesh={"ok": True, "patches": PATCHES, "case_dir": str(tmp_path)},
        face_props={f"f{i}": {"area_m2": 0.01 * i, "normal": [1, 0, 0]} for i in range(1, 13)},
        study={"turbulence_model": model, "initial_flow": start,
               "initial_ux": u0[0], "initial_uy": u0[1], "initial_uz": u0[2]},
        transient_override={"end_time": 2, "write_count": 4} if transient else None,
    )


def _caller_writes(got: flow_bcs.FlowPatches, out: Path) -> None:
    """What another plugin writes from flow_patches: 0/U and each turbulence field."""
    write_vol_field(out / "U", object_name="U", cls="volVectorField", dims="[0 1 -1 0 0 0 0]",
                    internal=_uniform_vector(got.initial_velocity), patches=got.U)
    for name, patches in got.turbulence.items():
        cls, dims = DIMS[name]
        write_vol_field(out / name, object_name=name, cls=cls, dims=dims, internal=got.turbulence_internal[name], patches=patches)


@pytest.mark.parametrize("transient", [False, True])
@pytest.mark.parametrize("model", MODELS)
@pytest.mark.parametrize(("start", "u0"), STARTS)
def test_every_kind_is_byte_identical_to_what_incompressible_flow_writes(tmp_path, transient, model, start, u0):
    """write_solve_case on the study's own inputs against the fields built from flow_patches:
    every BC kind, each model's own fields (nuTilda for Spalart-Allmaras, R and epsilon for
    LRR), every starting flow."""
    inputs = _inputs(tmp_path, transient=transient, model=model, start=start, u0=u0)
    spec = load_run_spec(inputs)
    case = tmp_path / "case"
    assert write_solve_case(spec, case)["ok"]
    got = flow_bcs.flow_patches(inputs, nu=spec.nu, rho=spec.rho, turbulence_model=model, initial_flow=start, initial_u=u0)
    mine = tmp_path / "mine"
    _caller_writes(got, mine)
    assert (mine / "U").read_bytes() == (case / "0" / "U").read_bytes()
    written = sorted(p.name for p in (case / "0").iterdir() if p.name in DIMS)
    assert sorted(got.turbulence) == written
    expected = {"laminar": [], "kOmegaSST": ["k", "nut", "omega"], "kEpsilon": ["epsilon", "k", "nut"],
                "SpalartAllmaras": ["nuTilda", "nut"], "LRR": ["R", "epsilon", "k", "nut"]}[model]
    assert written == expected
    for name in written:
        assert (mine / name).read_bytes() == (case / "0" / name).read_bytes(), name


def test_kinds_and_wall_motions_are_fixed_tokens(tmp_path):
    got = flow_bcs.flow_patches(_inputs(tmp_path, transient=False), nu=1.5e-5, rho=1.18, turbulence_model="kOmegaSST")
    assert got.kinds == {
        "walls": "wall",
        "inlet_speed": "inlet",
        "inlet_mass": "inlet",
        "inlet_vector": "inlet",
        "inlet_table": "inlet",
        "outlet_p": "pressure",
        "outlet_u": "velocity_outlet",
        "wall_move": "wall",
        "wall_spin": "wall",
        "wall_slip": "wall",
        "sym": "symmetry",
        "far": "freestream",
        "total": "total_pressure",
    }
    assert got.wall_motion == {"walls": "no_slip", "wall_move": "moving", "wall_spin": "rotating", "wall_slip": "slip"}
    assert set(got.wall_motion.values()) <= set(flow_bcs.WALL_MOTIONS)
    by = {r["name"]: r for r in RECORDS}
    assert [flow_bcs.wall_motion(by[n]) for n in ("wall_move", "wall_spin", "wall_slip")] == ["moving", "rotating", "slip"]
    assert flow_bcs.wall_motion({"bc_type": "Wall"}) == "no_slip"
    assert flow_bcs.wall_motion(by["sym"]) is None


@pytest.mark.parametrize("model", ["kOmegaSST", "SpalartAllmaras"])
def test_scales_have_fixed_keys_and_units(tmp_path, model):
    """scales and each patch_scales entry: k, omega, epsilon, intensity (a fraction), length_scale_m,
    nu_tilda (Spalart-Allmaras only); a viscosity-ratio boundary gets the length its k and omega imply."""
    got = flow_bcs.flow_patches(_inputs(tmp_path, transient=False, model=model), nu=1.5e-5, rho=1.18, turbulence_model=model)
    assert tuple(got.scales) == flow_bcs.SCALE_KEYS
    # A freestream on Auto has scales of its own except under Spalart-Allmaras (its case-wide rule holds there).
    own = {"inlet_speed", "inlet_vector"} | ({"far"} if model != "SpalartAllmaras" else set())
    assert set(got.patch_scales) == own
    for name, sc in got.patch_scales.items():
        assert tuple(sc) == flow_bcs.SCALE_KEYS, name
        assert sc["epsilon"] == pytest.approx(0.09 * sc["k"] * sc["omega"])
        assert (sc["nu_tilda"] is not None) == (model == "SpalartAllmaras")
    speed = got.patch_scales["inlet_speed"]
    assert speed["intensity"] == pytest.approx(0.03) and speed["length_scale_m"] == pytest.approx(0.02)
    ratio = got.patch_scales["inlet_vector"]
    assert ratio["intensity"] == pytest.approx(0.04)
    assert ratio["length_scale_m"] == pytest.approx(ratio["k"] ** 0.5 / (0.09**0.25 * ratio["omega"]))
    assert got.scales["intensity"] == pytest.approx(0.05)
    assert (got.scales["nu_tilda"] is not None) == (model == "SpalartAllmaras")
    if model == "kOmegaSST":
        assert got.turbulence["k"]["inlet_speed"] != got.turbulence["k"]["inlet_mass"]


def test_a_table_is_in_effect_only_in_a_transient_run(tmp_path):
    steady = flow_bcs.flow_patches(_inputs(tmp_path, transient=False), nu=1.5e-5, rho=1.2, turbulence_model="laminar")
    moving = flow_bcs.flow_patches(_inputs(tmp_path, transient=True), nu=1.5e-5, rho=1.2, turbulence_model="laminar")
    assert steady.U["inlet_table"]["type"] == "surfaceNormalFixedValue"
    assert moving.U["inlet_table"] != steady.U["inlet_table"]
    rec = next(r for r in RECORDS if r["name"] == "inlet_table")
    assert flow_bcs.varies_with_time(rec, transient=True) is True
    assert flow_bcs.varies_with_time(rec, transient=False) is False


def test_compressible_mass_flow_reads_the_density_field(tmp_path):
    got = flow_bcs.flow_patches(_inputs(tmp_path, transient=False), nu=1.5e-5, rho=1.18, turbulence_model="laminar", compressible=True)
    entry = got.U["inlet_mass"]
    assert entry["type"] == "flowRateInletVelocity"
    assert entry["rho"] == "rho"
    assert entry["rhoInlet"] == "1.18"
    plain = flow_bcs.flow_patches(_inputs(tmp_path, transient=False), nu=1.5e-5, rho=1.18, turbulence_model="laminar")
    assert "rho" not in plain.U["inlet_mass"]


def test_pressures_in_pascals_are_the_fixed_value():
    by = {r["name"]: r for r in RECORDS}
    assert flow_bcs.boundary_pressure_pa(by["outlet_p"]) == 10
    assert flow_bcs.boundary_pressure_pa({**by["outlet_p"], "value": 1, "unit": "kPa"}) == 1000
    assert flow_bcs.boundary_pressure_pa(by["total"]) == 20
    assert flow_bcs.boundary_pressure_pa(by["far"]) == 5
    assert flow_bcs.boundary_pressure_pa(by["sym"]) == 0
    # A "Varies with time" table is not read: the fixed value.
    table = {**by["outlet_p"], "time_varying": True, "time_table": [[0, 0], [1, 500]]}
    assert flow_bcs.boundary_pressure_pa(table) == 10


def test_boundary_problems_are_incompressible_flows_own_sentences():
    by = {r["name"]: r for r in RECORDS}
    assert flow_bcs.boundary_problem(by["inlet_speed"], turbulence_model="kOmegaSST", transient=False) is None
    bad = {**by["inlet_speed"], "turbulence_intensity": 0}
    problem = flow_bcs.boundary_problem(bad, turbulence_model="kOmegaSST", transient=False)
    assert problem is not None and problem.kind == "turbulence"
    assert problem.message == f'Turbulence at the inlet of "inlet_speed": {problem.detail}.'
    assert "turbulence intensity" in problem.detail
    assert flow_bcs.boundary_problem(bad, turbulence_model="laminar", transient=False) is None
    axis = {**by["wall_spin"], "rotation_axis": [0, 0, 0]}
    spin = flow_bcs.boundary_problem(axis, turbulence_model="laminar", transient=False)
    assert spin is not None and spin.kind == "wall_motion"
    assert spin.message == 'Wall "wall_spin": its rotation axis has no direction (all three components are 0).'
    table = {**by["inlet_table"], "time_table": [[0, 1]]}
    timed = flow_bcs.boundary_problem(table, turbulence_model="laminar", transient=True)
    assert timed is not None and timed.kind == "time_table"
    assert timed.message == f'"Varies with time" on "inlet_table": {timed.detail}.'
    assert flow_bcs.boundary_problem(table, turbulence_model="laminar", transient=False) is None
    assert flow_bcs.boundary_kind({"bc_type": "Something else"}) is None


def test_a_boundary_without_faces_is_not_checked():
    """As Incompressible Flow's Start: a BC with no assigned face is not part of the run."""
    bad = {**RECORDS[0], "turbulence_intensity": 0, "faces": []}
    assert flow_bcs.boundary_problem(bad, turbulence_model="kOmegaSST", transient=False) is None


def test_the_turbulence_model_is_read_as_incompressible_flow_reads_it():
    """Display names and loose spellings normalise ("spalart-allmaras" keeps the Spalart-Allmaras
    rules: a viscosity-ratio inlet is fine there); an unknown model raises."""
    assert flow_bcs.turbulence_model_name("spalart-allmaras") == "SpalartAllmaras"
    assert flow_bcs.turbulence_model_name("k-omega SST") == "kOmegaSST"
    assert flow_bcs.turbulence_model_name("laminar") == "laminar"
    ratio = {**RECORDS[2], "turbulence_viscosity_ratio": 20}
    assert flow_bcs.boundary_problem(ratio, turbulence_model="spalart-allmaras", transient=False) is None
    with pytest.raises(ValueError, match="unknown turbulence model 'kOmegaSSTT'"):
        flow_bcs.boundary_problem(RECORDS[0], turbulence_model="kOmegaSSTT", transient=False)
    with pytest.raises(ValueError, match="unknown turbulence model"):
        flow_bcs.flow_patches(object(), nu=1e-5, rho=1.0, turbulence_model="")


@pytest.mark.parametrize("mode", ["steady", "transient"])
def test_the_golden_case_fields_come_out_of_the_module(tmp_path, mode):
    """js-project (the js_steady / js_transient golden): 0/U and the turbulence fields a
    caller writes from flow_patches are byte-identical to the case Incompressible Flow writes."""
    override = {"end_time": 5, "write_count": 50, "delta_t": 0.001} if mode == "transient" else None
    inputs = gather_run_inputs(JS_PROJECT, run_id=f"r-{mode}", require_mesh=False, transient_override=override)
    spec = load_run_spec(inputs)
    case = tmp_path / "case"
    assert write_solve_case(spec, case)["ok"]
    got = flow_bcs.flow_patches(
        inputs,
        nu=spec.nu,
        rho=spec.rho,
        turbulence_model=spec.physics.turbulence_model,
        initial_flow=spec.physics.initial_flow,
        initial_u=spec.physics.initial_u,
    )
    mine = tmp_path / "mine"
    _caller_writes(got, mine)
    assert (mine / "U").read_bytes() == (case / "0" / "U").read_bytes()
    assert set(got.turbulence) == {"k", "omega", "nut"}
    for name in got.turbulence:
        assert (mine / name).read_bytes() == (case / "0" / name).read_bytes(), name


def _version(text: str) -> tuple[int, ...]:
    m = re.search(r'^version = "(\d+)\.(\d+)\.(\d+)', text, re.M)
    assert m, "the manifest has no version"
    return tuple(int(x) for x in m.groups())


def test_the_manifest_exports_the_module():
    text = (PLUGIN_DIR / "manifest.toml").read_text(encoding="utf-8")
    assert re.search(r'^exports = \["incompressible_flow\.flow_bcs"\]$', text, re.M)
    # flow_bcs is part of Incompressible Flow 1.1 and later 1.x.
    assert (1, 1, 0) <= _version(text) < (2, 0, 0)
    assert (PLUGIN_DIR / "incompressible_flow" / "flow_bcs.py").is_file()


def test_the_first_problem_follows_starts_order_across_the_records():
    """IF's Start checks every record's turbulence, then every table, then every wall: a
    turbulence problem on a later record is reported before a wall problem on an earlier one."""
    by = {r["name"]: r for r in RECORDS}
    wall = {**by["wall_spin"], "rotation_axis": [0, 0, 0]}
    inlet = {**by["inlet_speed"], "turbulence_intensity": 0}
    first = flow_bcs.first_boundary_problem([wall, inlet], turbulence_model="kOmegaSST", transient=False)
    assert first is not None and first.kind == "turbulence"
    assert first.message.startswith('Turbulence at the inlet of "inlet_speed":')
    # Record by record, the wall's own problem is what boundary_problem says of it.
    assert flow_bcs.boundary_problem(wall, turbulence_model="kOmegaSST", transient=False).kind == "wall_motion"
    # Laminar: no turbulence check, so the wall's problem is the first.
    assert flow_bcs.first_boundary_problem([wall, inlet], turbulence_model="laminar", transient=False).kind == "wall_motion"
    table = {**by["inlet_table"], "time_table": [[0, 1]]}
    assert flow_bcs.first_boundary_problem([wall, table], turbulence_model="laminar", transient=True).kind == "time_table"
    assert flow_bcs.first_boundary_problem(RECORDS, turbulence_model="kOmegaSST", transient=True) is None


@pytest.mark.parametrize(
    ("saved", "token"),
    # The study's default wall is slip or no-slip (a default cannot move: the writer reads
    # anything else as no-slip, and so does flow_patches).
    [("slip", "slip"), ("Slip", "slip"), ("No-slip", "no_slip"), ("no slip", "no_slip"), ("Moving", "no_slip"),
     ("rotating", "no_slip"), ("", "no_slip"), (None, "no_slip"), ("sticky", "no_slip")],
)
def test_the_default_wall_is_read_as_the_writer_reads_it(tmp_path, saved, token):
    """Walls no BC claims take the study's default wall, whatever spelling it was saved with:
    the token matches the 0/U entry the writer writes for them."""
    inputs = _inputs(tmp_path, transient=False, model="laminar")
    inputs = dataclasses.replace(inputs, bcs_doc={**inputs.bcs_doc, "defaults": {"wall_type": saved}})
    got = flow_bcs.flow_patches(inputs, nu=1.5e-5, rho=1.2, turbulence_model="laminar")
    assert got.wall_motion["walls"] == token
    assert got.U["walls"]["type"] == {"slip": "slip", "no_slip": "noSlip"}[token]
    case = tmp_path / "case"
    assert write_solve_case(load_run_spec(inputs), case)["ok"]
    written = re.search(r"\n    walls\n    \{\n\s*type\s+(\w+);", (case / "0" / "U").read_text(encoding="utf-8"))
    assert written and written.group(1) == got.U["walls"]["type"]


def test_every_wall_kind_has_a_token():
    from incompressible_flow import bc_kinds

    assert set(flow_bcs._WALL_TOKENS) == set(bc_kinds.WALL_KINDS)
    assert set(flow_bcs._WALL_TOKENS.values()) == set(flow_bcs.WALL_MOTIONS)
