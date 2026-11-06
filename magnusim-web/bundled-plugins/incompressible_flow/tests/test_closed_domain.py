"""A closed domain driven by a moving or rotating wall (validation set gap G1): a lid-driven
cavity, a stirred tank. Nothing flows in or out, so

- the readiness check counts a moving wall as what drives the flow and asks for no pressure
  boundary when nothing flows in or out (a wall "moving" at 0 is refused, and says so);
- the case's reference speed (the time step, the velocity limit, the pre-run check) is the
  wall's: a moving wall's velocity, a rotating wall's speed at its faces' rim;
- the SIMPLE and PIMPLE dictionaries carry ``pRefCell 0; pRefValue 0;``, which OpenFOAM reads
  only when no boundary fixes the pressure (``setRefCell``: ``p.needReference()``), so a case
  with a pressure boundary is solved exactly as before;
- the transient preview and the pre-run check have their numbers and say nothing of a
  flow-through.

The ``wsl`` tests solve a closed cavity on a blockMesh cube, and a channel with and without
the reference entries (``pytest -m wsl -k closed``).
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

import pytest
from cfddesk.project.paths import assemble_study_bcs, assemble_study_materials
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.contract import ReadyContext
from cfddesk.registry.discovery import get_registry
from test_turbulence_models import (
    CONTROL_STUB,
    channel_mesh,  # noqa: F401  (fixture)
)

from incompressible_flow.runspec import FaceProps, RunSpec

LID = {"name": "Lid", "bc_type": "Wall", "wall_type": "Moving", "wall_velocity": [2, 0, 0], "faces": ["face 4@B"]}
WALLS = {"name": "Walls", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 1@B", "face 2@B", "face 3@B"]}
DISC = {
    "name": "Disc",
    "bc_type": "Wall",
    "wall_type": "Rotating",
    "rotation_axis": [0, 0, 1],
    "rotation_origin": [0, 0, 0],
    "rotation_speed": 60,
    "faces": ["face 5@B"],
}
OUTLET = {"name": "Outlet", "bc_type": "Pressure outlet", "faces": ["face 6@B"], "value": 0}
VENT = {"name": "Vent", "bc_type": "Velocity outlet", "faces": ["face 6@B"], "value": 1, "unit": "m/s"}
INLET = {"name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 6@B"], "value": 3}


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


# -- readiness ------------------------------------------------------------------


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def _ready(tmp_path: Path, bcs: list[dict], *, transient: bool = False) -> list[dict]:
    root = tmp_path / "p"
    geom = root / "geometries" / "Geometry_g"
    _write(geom / "id.json", {"id": "g", "kind": "geometry"})
    study = geom / "simulations" / "Study"
    td = "Transient" if transient else "Steady-state"
    _write(study / "id.json", {"id": "s1", "kind": "simulation", "time_dependency": td})
    _write(study / "materials" / "Fluid" / "material.json", {"id": "m1", "name": "Fluid", "simulation_id": "s1", "assigned_volumes": ["v1"]})
    for i, bc in enumerate(bcs):
        _write(study / "boundary_conditions" / f"BC_{i}" / "bc.json", {"id": f"b{i}", "simulation_id": "s1", **bc})
    patches = tuple(str(b["name"]).lower() for b in bcs) + ("walls",)
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
    key = "incompressible_transient" if transient else "incompressible_steady"
    return contract.validate_ready(get_registry("analysis").get(key), ctx)


@pytest.mark.parametrize("transient", [False, True], ids=["steady", "transient"])
def test_a_closed_box_with_a_moving_lid_is_ready(tmp_path: Path, transient: bool):
    assert _ready(tmp_path, [LID, WALLS], transient=transient) == []


def test_a_closed_box_with_a_rotating_wall_is_ready(tmp_path: Path):
    assert _ready(tmp_path, [DISC, WALLS]) == []


def test_a_moving_lid_with_one_pressure_opening_is_ready(tmp_path: Path):
    # An open cavity: the lid drives it, the opening holds the pressure level.
    assert _ready(tmp_path, [LID, WALLS, OUTLET]) == []


def test_a_moving_wall_does_not_hold_the_pressure_for_a_velocity_outlet(tmp_path: Path):
    # Something flows out: the inflow needs a pressure boundary to come through.
    assert _ready(tmp_path, [LID, VENT]) == [{"message": "Add a pressure boundary with an assigned face", "fix": {"go": "bc-picker"}}]


def test_a_moving_wall_beside_an_inlet_still_needs_a_pressure_boundary(tmp_path: Path):
    assert _ready(tmp_path, [LID, INLET]) == [{"message": "Add a pressure boundary with an assigned face", "fix": {"go": "bc-picker"}}]


@pytest.mark.parametrize(
    ("wall", "why"),
    [
        ({**LID, "wall_velocity": [0, 0, 0]}, "its velocity is 0"),
        ({**DISC, "rotation_speed": 0}, "its rotation speed is 0"),
    ],
    ids=["moving at 0", "rotating at 0"],
)
def test_a_closed_box_whose_wall_stands_still_says_why(tmp_path: Path, wall: dict, why: str):
    issues = _ready(tmp_path, [wall, WALLS])
    name = wall["name"]
    assert issues == [
        {
            "message": f'Wall "{name}" does not move ({why}), so nothing drives the flow. Give it a velocity, or add an inlet and an outlet.'
            if wall["wall_type"] == "Moving"
            else f'Wall "{name}" does not move ({why}), so nothing drives the flow. Give it a rotation speed, or add an inlet and an outlet.',
            "fix": {"go": "bc", "id": "b0", "name": name},
        }
    ]


def test_a_closed_box_with_still_walls_only_names_every_driver(tmp_path: Path):
    issues = _ready(tmp_path, [WALLS])
    assert issues == [
        {
            "message": (
                "Add a velocity inlet or outlet, a freestream, two pressure boundaries, or a moving or rotating wall, "
                "each with an assigned face"
            ),
            "fix": {"go": "bc-picker"},
        }
    ]


def test_a_rotating_wall_with_no_axis_is_still_refused_for_its_axis(tmp_path: Path):
    disc = {**DISC, "rotation_axis": [0, 0, 0]}
    issues = _ready(tmp_path, [disc, WALLS])
    assert issues[0]["message"] == 'Wall "Disc": its rotation axis has no direction (all three components are 0).'


# -- the reference speed --------------------------------------------------------


def _spec(*bcs: dict, props: dict[str, FaceProps] | None = None) -> RunSpec:
    return RunSpec(
        project_dir=Path("."),
        run_id="r1",
        mesh_case_dir=Path("."),
        n_procs=1,
        solver_app="simpleFoam",
        end_time=200,
        write_interval=50,
        transient=None,
        nu=1e-3,
        rho=1.0,
        wall_default="No-slip",
        bcs=[],
        monitor_patches=[],
        face_props=props or {},
        mapped=[{"bc": bc, "patch": str(bc["name"]).lower()} for bc in bcs],
    )


def test_a_closed_box_takes_its_lids_speed():
    from incompressible_flow.writer import reference_speed, resolve_speed_and_dhyd

    spec = _spec(LID, WALLS)
    assert reference_speed(spec)[0] == 2.0 and reference_speed(spec)[2] == "wall"
    assert resolve_speed_and_dhyd(spec)[0] == 2.0
    # A slow lid is its own speed too, not the 1 m/s a case without a speed gets.
    slow = _spec({**LID, "wall_velocity": [0, 0.25, 0]}, WALLS)
    assert reference_speed(slow)[:3:2] == (0.25, "wall")


def test_a_rotating_walls_speed_is_at_its_faces_rim():
    from incompressible_flow.writer import reference_speed, wall_drive

    # A disc of radius 0.1 m centred on its axis: its rim turns at 60 rpm.
    props = {"face 5@B": FaceProps(area_m2=math.pi * 0.01, normal=(0, 0, 1), centroid=(0, 0, 0))}
    spec = _spec(DISC, WALLS, props=props)
    speed, _d, source = reference_speed(spec)
    assert speed == pytest.approx(2 * math.pi * 0.1) and source == "wall"
    assert wall_drive(spec) == [{"name": "Disc", "speed": pytest.approx(2 * math.pi * 0.1), "direction": None}]
    # Without the face table its rim is not known: no speed from it.
    assert reference_speed(_spec(DISC, WALLS))[2] == "none"


def test_a_faster_wall_sets_the_speed_of_a_pressure_driven_case_but_not_of_an_inlets():
    from incompressible_flow.writer import reference_speed

    p_in = {"name": "In", "bc_type": "Pressure outlet", "faces": ["f1"], "value": 2, "unit": "Pa"}
    p_out = {"name": "Out", "bc_type": "Pressure outlet", "faces": ["f2"], "value": 0, "unit": "Pa"}
    belt = {**LID, "wall_velocity": [5, 0, 0]}
    assert reference_speed(_spec(p_in, p_out))[0::2] == (2.0, "pressure")
    assert reference_speed(_spec(p_in, p_out, belt))[0::2] == (5.0, "wall")
    # An inlet's speed is the case's, as before (its turbulence and starting flow use it).
    assert reference_speed(_spec(INLET, OUTLET, belt))[0::2] == (3.0, "inlet")


def test_the_health_hints_say_the_speed_is_the_walls():
    from incompressible_flow.physics import StudyPhysics
    from incompressible_flow.writer import health_hints

    hints = health_hints(_spec(LID, WALLS), physics=StudyPhysics(), model="laminar", speed_ref=2.0, u_max=50.0, patch_names=["lid", "walls"])
    assert (hints["uref"], hints["uref_source"], hints["fixed_inflow"], hints["monitors"]) == (2.0, "wall", False, None)
    hints = health_hints(_spec(INLET, OUTLET), physics=StudyPhysics(), model="laminar", speed_ref=3.0, u_max=50.0, patch_names=["inlet", "outlet"])
    assert hints["uref_source"] == "inlet"


def test_the_transient_estimate_has_no_flow_through_in_a_closed_box():
    from incompressible_flow.runspec import transient_context
    from incompressible_flow.transient import resolve_transient_control

    ctx = transient_context(_spec(LID, WALLS))
    assert (ctx["speed_ref"], ctx["closed"]) == (2.0, True)
    meta = {"min_cell_volume_m3": 1e-6, "sizing": {"bbox_m": [0.1, 0.1, 0.1]}}
    closed = resolve_transient_control({"end_time": 1, "write_count": 10}, {**ctx, "mesh_meta": meta})
    assert closed.estimate["u_ref"] == 2.0 and closed.estimate["flow_through_s"] is None
    # Δt = 0.5 · Co · h / U: the lid's 2 m/s, cells of 0.01 m.
    assert closed.delta_t == pytest.approx(0.5 * 1.0 * 0.01 / 2.0)
    opened = resolve_transient_control({"end_time": 1, "write_count": 10}, {"speed_ref": 2.0, "mesh_meta": meta})
    assert opened.estimate["flow_through_s"] == pytest.approx(0.05)
    assert transient_context(_spec(INLET, OUTLET))["closed"] is False


# -- the pre-run check ----------------------------------------------------------


def test_the_pre_run_check_reads_the_lid():
    from magnusim_sdk.runcheck import check

    from incompressible_flow.precheck import check_inputs

    inputs = check_inputs(_spec(LID, WALLS), {"end_time": 400}, {"mesh": {"bbox_m": {"size": [0.1, 0.1, 0.1]}}}, transient=False)
    assert (inputs["speed"], inputs["direction"], inputs["inlet"], inputs["closed"], inputs["inlet_driven"]) == (2.0, [1.0, 0.0, 0.0], "", True, False)
    out = check(inputs)
    # Re on the box's length along the lid: 2 m/s × 0.1 m / 1e-3 m²/s.
    assert out["estimate"]["re"] == pytest.approx(200)
    assert "Re ≈ 200" in out["estimate"]["line"]
    # A lid moving along y: the length along y.
    tall = check_inputs(_spec({**LID, "wall_velocity": [0, -1, 0]}, WALLS), {"end_time": 400}, {"mesh": {"bbox_m": {"size": [0.1, 0.4, 0.1]}}}, transient=False)
    assert tall["direction"] == [0.0, -1.0, 0.0] and check(tall)["estimate"]["re"] == pytest.approx(400)
    opened = check_inputs(_spec(INLET, OUTLET), {"end_time": 400}, {}, transient=False)
    assert opened["closed"] is False


# -- the written case -----------------------------------------------------------


def _channel_project(tmp_path: Path, bcs: list[dict], record: dict) -> Path:
    from test_turbulence_models import _project

    root = _project(tmp_path, record)
    doc = {"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{"simulation_id": "sim_1", **b} for b in bcs]}
    (root / "boundary_conditions.json").write_text(json.dumps(doc), encoding="utf-8")
    return root


REF = re.compile(r"^    pRefCell\s+0;\n    pRefValue\s+0;$", re.M)


def _block(text: str, name: str) -> str:
    m = re.search(rf"^{name}\n\{{\n(.*?)^\}}", text, re.S | re.M)
    assert m, text
    return m.group(1)


@pytest.mark.parametrize("transient", [False, True], ids=["SIMPLE", "PIMPLE"])
def test_the_solution_dictionary_sets_the_pressure_reference(tmp_path: Path, transient: bool):
    from cfddesk.registry.analysis import write_run_case
    from conftest import run_spec as load_run_spec
    from test_turbulence_models import _project

    root = _project(tmp_path, {"turbulence_model": "laminar"})
    override = {"end_time": 0.0002, "delta_t": 0.0001, "time_step_mode": "fixed", "write_count": 1} if transient else None
    spec = load_run_spec(root, run_id="run-ref", require_mesh=False, n_procs=1, transient_override=override)
    assert spec.ok, spec.error
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    text = (case / "system" / "fvSolution").read_text(encoding="utf-8")
    block = _block(text, "PIMPLE" if transient else "SIMPLE")
    assert REF.search(block), block


# -- WSL: what OpenFOAM v2606 does with it ---------------------------------------

CUBE = """FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }
convertToMeters 0.1;
vertices ( (0 0 0) (1 0 0) (1 1 0) (0 1 0) (0 0 1) (1 0 1) (1 1 1) (0 1 1) );
blocks ( hex (0 1 2 3 4 5 6 7) (12 12 12) simpleGrading (1 1 1) );
boundary
(
    lid { type wall; faces ( (3 7 6 2) ); }
    walls { type wall; faces ( (0 4 7 3) (2 6 5 1) (1 5 4 0) (0 3 2 1) (4 5 6 7) ); }
);
"""


def _blockmesh(tmp_path: Path, block_mesh: str) -> Path:
    from cfddesk.wsl.mesh_run import windows_to_wsl_path
    from cfddesk.wsl.openfoam import OPENFOAM_WRAPPER, run_wsl_bash

    mesh = tmp_path / "mesh"
    (mesh / "system").mkdir(parents=True)
    (mesh / "constant").mkdir()
    (mesh / "system" / "blockMeshDict").write_text(block_mesh, encoding="ascii")
    (mesh / "system" / "controlDict").write_text(CONTROL_STUB, encoding="ascii")
    result = run_wsl_bash(f"cd '{windows_to_wsl_path(mesh)}' && {OPENFOAM_WRAPPER} bash -c 'blockMesh > log.blockMesh 2>&1'", timeout=180)
    assert result.returncode == 0, result.stderr
    return mesh


def _cavity_project(tmp_path: Path) -> Path:
    """The fixture project with a laminar study, a fluid of nu 1e-3 and the cube's walls: the
    lid moving at 1 m/s along x, the rest No-slip (Re 100 on 0.1 m)."""
    lid = {**LID, "wall_velocity": [1, 0, 0], "faces": ["face 1@Body1"]}
    walls = {**WALLS, "faces": ["face 2@Body1"]}
    root = _channel_project(tmp_path, [lid, walls], {"turbulence_model": "laminar"})
    mats = json.loads((root / "materials.json").read_text(encoding="utf-8")) if (root / "materials.json").is_file() else None
    if isinstance(mats, dict):
        for m in mats.get("materials") or []:
            m["kinematic_viscosity"] = 1e-3
            m["nu"] = 1e-3
            m["density"] = 1.0
        (root / "materials.json").write_text(json.dumps(mats), encoding="utf-8")
    return root


@pytest.mark.wsl
def test_closed_cavity_solves_on_simplefoam(tmp_path: Path):
    """A lid-driven cube (no inlet, no outlet, no pressure boundary) as the app writes it: the
    readiness has nothing against it, and simpleFoam solves it (it stopped with "Unable to set
    reference cell for field p" before pRefCell was written)."""
    from cfddesk.registry.analysis import write_run_case
    from conftest import run_spec as load_run_spec
    from wsl_tmp_case import log, run_steps

    mesh = _blockmesh(tmp_path, CUBE)
    root = _cavity_project(tmp_path)
    spec = load_run_spec(root, run_id="run-cavity", require_mesh=False, n_procs=1)
    assert spec.ok, spec.error
    spec.mesh_case_dir = mesh
    spec.end_time = 300
    spec.write_interval = 300
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    u_text = (case / "0" / "U").read_text(encoding="utf-8")
    lid = re.search(r"lid\s*\{\s*type\s+fixedValue;\s*value\s+uniform \(([^)]*)\);", u_text)
    assert lid and [float(c) for c in lid.group(1).split()] == [1.0, 0.0, 0.0], u_text
    code = run_steps(case, ["simpleFoam"], timeout=600)
    out = log(case, "simpleFoam")
    assert code == 0 and "FOAM FATAL" not in out, out[-3000:]
    assert "Unable to set reference cell" not in out
    # It solved: a saved time with a velocity field that moves.
    saved = sorted((p for p in case.iterdir() if p.is_dir() and re.fullmatch(r"\d+", p.name) and p.name != "0"), key=lambda p: int(p.name))
    assert saved, out[-2000:]
    assert re.search(r"^End\s*$", out, re.M), out[-2000:]


@pytest.mark.wsl
def test_the_pressure_reference_changes_nothing_where_a_boundary_holds_the_pressure(tmp_path: Path, channel_mesh):  # noqa: F811
    """The same channel case (velocity inlet, pressure outlet) solved with the reference
    entries and without them: every field it saves is byte for byte the same."""
    from cfddesk.registry.analysis import write_run_case
    from conftest import run_spec as load_run_spec
    from test_turbulence_models import _project
    from wsl_tmp_case import log, run_steps

    root = _project(tmp_path, {"turbulence_model": "laminar"})
    spec = load_run_spec(root, run_id="run-ref", require_mesh=False, n_procs=1)
    assert spec.ok, spec.error
    spec.mesh_case_dir = channel_mesh
    spec.end_time = 20
    spec.write_interval = 20
    cases = {}
    for name in ("with", "without"):
        case = tmp_path / name
        assert write_run_case(spec, case)["ok"]
        sol = case / "system" / "fvSolution"
        text = sol.read_text(encoding="utf-8")
        assert REF.search(text)
        if name == "without":
            sol.write_text(REF.sub("", text).replace("\n\n}", "\n}"), encoding="utf-8")
            assert "pRefCell" not in _block(sol.read_text(encoding="utf-8"), "SIMPLE")
        ctl = case / "system" / "controlDict"
        ctl.write_text(re.sub(r"writeFormat\s+\w+;", "writeFormat     ascii;", ctl.read_text(encoding="utf-8")), encoding="utf-8")
        assert run_steps(case, ["simpleFoam"], timeout=600) == 0, log(case, "simpleFoam")[-3000:]
        cases[name] = case
    a, b = cases["with"] / "20", cases["without"] / "20"
    assert a.is_dir() and b.is_dir()
    fields = sorted(p.name for p in a.iterdir() if p.is_file())
    assert "U" in fields and "p" in fields
    for f in fields:
        assert (a / f).read_bytes() == (b / f).read_bytes(), f
