"""Incompressible Flow's pre-run check (run health, RH2; contract API 1.9 RunModel.check):
the worker's analysis.run_check on a project, the inputs it reads of the run (its reference
speed and inlet, the velocity limit it is written with, its physics), the ranks it would get
and this PC's rate, and the same rows in its plan at Start (prepare_run.checks)."""

from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.precheck import check_inputs

PISO_100 = {"end_time": 10, "write_count": 60, "max_co": 100, "n_outer_correctors": 1, "n_correctors": 2}


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The JS fixture project; it has no generated mesh, so its runs solve on its folder (as
    prepare_run --no-require-mesh does)."""
    from cfddesk.project import run_inputs

    root = tmp_path / "js"
    shutil.copytree(JS_PROJECT, root)
    real = run_inputs.gather_run_inputs

    def _without_mesh(*args, **kwargs):
        kwargs["require_mesh"] = False
        return real(*args, **kwargs)

    monkeypatch.setattr(run_inputs, "gather_run_inputs", _without_mesh)
    return root


def test_the_run_model_has_the_check_hook():
    for key in ("incompressible_transient", "incompressible_steady"):
        model = contract.run_model(get_registry("analysis").get(key))
        assert model is not None and model.check is not None


def test_check_inputs_read_the_run_as_its_case_is_written(project: Path):
    spec = load_run_spec(project, run_id="run-x", require_mesh=False, time_dependency="Transient", transient_override=PISO_100)
    inputs = check_inputs(spec, PISO_100, {"ranks": 8, "kept": ["still_start"]}, transient=True)
    assert inputs["time_dependency"] == "transient"
    assert inputs["settings"]["max_co"] == 100 and inputs["settings"]["n_outer_correctors"] == 1
    # The velocity limit the case is written with: 10x the reference speed, at least 50 m/s.
    assert inputs["velocity_cap"] == pytest.approx(max(50.0, 10.0 * inputs["speed"]))
    assert inputs["inlet"] and inputs["inlet_driven"] is True
    # The model in the plugin's own words (the core names none).
    words = inputs["turbulence"]
    assert words["label"] and words["laminar"] is (spec.physics.turbulence_model == "laminar")
    assert words["any_yplus"] == {"label": "k-omega SST", "key": "turbulence_model", "value": "kOmegaSST"}
    assert inputs["kept"] == ["still_start"] and inputs["ranks"] == 8
    assert inputs["steady_copy"] is True
    # A steady run: its study's relaxation, no velocity limit.
    steady = check_inputs(spec, {"end_time": 200}, {}, transient=False)
    assert steady["velocity_cap"] is None
    assert set(steady["numerics"]) == {"relax_p", "relax_u", "simplec", "n_non_orthogonal", "numerics_preset"}


def test_the_rpc_merges_ranks_and_rate_and_checks_proposed_settings(project: Path):
    from cfddesk.worker import methods

    out = methods.analysis_run_check(
        project_dir=str(project),
        run_id="run-x",
        time_dependency="Transient",
        settings=PISO_100,
        cores=4,
        rank_cap=8,
        s_per_cell_step=2e-5,
        rate_source="measured",
    )
    assert out["ok"] is True and out["checked"] is True
    assert out["analysis_key"] == "incompressible_transient"
    assert out["ranks"] == 4
    rows = {r["code"]: r for r in out["checks"]}
    assert rows["piso_high_co"]["level"] == "warn"
    assert rows["piso_high_co"]["fix"]["values"] == [{"key": "transient.n_outer_correctors", "value": 3}, {"key": "transient.max_co", "value": 5}]
    assert all(r["level"] in ("error", "warn", "info") for r in out["checks"])
    # The what-if clears the Courant rows; the estimate line is always there.
    what_if = methods.analysis_run_check(project_dir=str(project), run_id="run-x", time_dependency="Transient", settings={**PISO_100, "n_outer_correctors": 3, "max_co": 5}, rank_cap=8)
    assert not {"piso_high_co", "pimple_co_vs_outer"} & {r["code"] for r in what_if["checks"]}
    assert isinstance(what_if["estimate"]["line"], str) and what_if["estimate"]["line"]


def test_the_plan_at_start_reports_the_same_rows(project: Path):
    from cfddesk.registry import run_case

    planned = run_case.plan_run(project, "run-x", time_dependency="Transient", transient=PISO_100, require_mesh=False, check={"rank_cap": 8, "s_per_cell_step": 2e-5, "rate_source": "measured"})
    assert planned["ok"] is True, planned
    codes = [c["code"] for c in planned["plan"]["checks"]]
    assert "piso_high_co" in codes
    # A plan without the check context (the case writer, a Continue) reports none.
    plain = run_case.plan_run(project, "run-x", time_dependency="Transient", transient=PISO_100, require_mesh=False)
    assert "checks" not in plain["plan"]


def test_before_a_mesh_only_the_settings_are_checked_and_the_line_says_why():
    """No generated mesh: the spec cannot be read, so the inlets, mesh and physics are not
    checked. The line says the estimate waits for the mesh (not that no inlet sets a speed),
    and the answer says it is not complete, so nothing claims the mesh and physics were checked."""
    from incompressible_flow.precheck import NO_MESH_ESTIMATE, run_check

    for spec in (None, SimpleNamespace(ok=False, error="mesh.json missing — generate a mesh first")):
        inputs = check_inputs(spec, PISO_100, {"mesh_ready": False}, transient=True)
        assert inputs["inputs_complete"] is False
        assert inputs["no_estimate"] == NO_MESH_ESTIMATE == "No time-step estimate until the mesh is generated"
        out = run_check(transient=True, spec=spec or SimpleNamespace(ok=False), settings=PISO_100, context={"mesh_ready": False})
        assert out["estimate"]["complete"] is False
        assert out["estimate"]["unchecked"] == "its mesh and physics are checked once the mesh is generated"
        assert out["estimate"]["line"] == NO_MESH_ESTIMATE
        assert [r["code"] for r in out["checks"]] == ["piso_high_co"]
    # A steady run without a mesh: settings only, no time-step words.
    steady = check_inputs(None, {"end_time": 200}, {}, transient=False)
    assert steady["inputs_complete"] is False and "no_estimate" not in steady


def test_a_2d_mesh_whose_ends_lost_their_symmetry_is_named():
    """The mesh facts' two_d ends, read against the study's BCs on their patches: a Symmetry is
    fine; anything else is listed once per BC with both ends' faces."""
    from incompressible_flow.precheck import two_d_unmirrored

    facts = {"two_d": {"front": {"faces": ["Face 5@Body1"], "bc": "Sides", "patch": "sides"}, "back": {"faces": ["Face 3@Body1"], "bc": "Sides", "patch": "sides"}}}
    mirror = SimpleNamespace(mapped=[{"patch": "sides", "bc": {"name": "Sides", "bc_type": "Symmetry"}}, {"patch": "inlet", "bc": {"name": "Inlet", "bc_type": "Velocity inlet"}}])
    assert two_d_unmirrored(mirror, facts) == []
    walls = SimpleNamespace(mapped=[{"patch": "sides", "bc": {"name": "Sides", "bc_type": "Wall", "wall_type": "No-slip"}}])
    assert two_d_unmirrored(walls, facts) == [{"faces": ["Face 5@Body1", "Face 3@Body1"], "bc": "Sides"}]
    # A 3D mesh: nothing here.
    assert two_d_unmirrored(walls, {"quality": {}}) == []
    # The Symmetry deleted (no BC holds the ends' patch any more): the writer solves them as the
    # walls with no BC are, so they are listed with that wall; a Slip default mirrors the flow.
    gone = [{"faces": ["Face 5@Body1", "Face 3@Body1"], "bc": None, "default_wall": "No-slip"}]
    assert two_d_unmirrored(SimpleNamespace(mapped=[]), facts) == gone
    assert two_d_unmirrored(SimpleNamespace(mapped=[{"patch": "sides"}], wall_default="No-slip"), facts) == gone
    assert two_d_unmirrored(SimpleNamespace(mapped=[], wall_default="Slip"), facts) == []
    # Facts that name no patch for an end can't be read against the BCs: nothing.
    assert two_d_unmirrored(SimpleNamespace(mapped=[]), {"two_d": {"front": {"faces": ["Face 5@Body1"]}}}) == []


def test_a_moving_wall_through_its_own_faces_in_a_closed_box_is_named():
    """A Moving wall is a fixed velocity on its faces: a part across a face pushes fluid through
    it, which a closed box can't take (the solver's adjustPhi stops it). Flat faces are checked
    whole, curved ones at their middle only (listed as unchecked when along there); a Rotating
    wall is never listed (the solver keeps it along its faces)."""
    from incompressible_flow.precheck import holds_pressure, walls_across
    from incompressible_flow.runspec import FaceProps

    top = FaceProps(area_m2=0.01, normal=(0.0, 1.0, 0.0), centroid=(0.05, 0.1, 0.05), planar=True)
    drum = FaceProps(area_m2=0.01, normal=(0.0, 0.0, 1.0), centroid=(0.05, 0.1, 0.05), planar=False)

    def spec(velocity, props, kind="Moving", **extra):
        lid = {"name": "Lid", "bc_type": "Wall", "wall_type": kind, "wall_velocity": velocity, "faces": ["face 3@Body1"], **extra}
        return SimpleNamespace(mapped=[{"patch": "lid", "bc": lid}], face_props={"face 3@Body1": props})

    # Along the lid: nothing. Straight up through it, or the field default (1, 0, 0) on a lid
    # whose normal is x: listed, with its faces as the panels name them.
    assert walls_across(spec([1.0, 0.0, 0.0], top)) == ([], [])
    assert walls_across(spec([0.0, 2.0, 0.0], top)) == ([{"name": "Lid", "faces": ["Face 3@Body1"], "velocity": [0.0, 2.0, 0.0]}], [])
    side = FaceProps(area_m2=0.01, normal=(1.0, 0.0, 0.0), planar=True)
    assert walls_across(spec(None, side))[0] == [{"name": "Lid", "faces": ["Face 3@Body1"], "velocity": [1.0, 0.0, 0.0]}]
    # A tilt under a millionth of the speed counts as along.
    assert walls_across(spec([1.0, 1e-8, 0.0], top)) == ([], [])
    # Curved: along it at its middle, the rest unchecked; across it at its middle, through.
    assert walls_across(spec([1.0, 0.0, 0.0], drum)) == ([], [{"name": "Lid", "faces": ["Face 3@Body1"]}])
    assert walls_across(spec([0.0, 0.0, 1.0], drum))[0][0]["faces"] == ["Face 3@Body1"]
    # A face the table has no normal for, a Rotating wall, a still one: nothing.
    assert walls_across(spec([0.0, 2.0, 0.0], FaceProps())) == ([], [])
    rot = spec(None, top, kind="Rotating", rotation_axis=[0, 1, 0], rotation_speed=100)
    assert walls_across(rot) == ([], [])
    assert walls_across(spec([0.0, 0.0, 0.0], top)) == ([], [])
    # A boundary that holds the pressure (a pressure BC, a total-pressure inlet, a freestream).
    assert holds_pressure(spec([0.0, 2.0, 0.0], top)) is False
    opening = SimpleNamespace(mapped=[{"patch": "out", "bc": {"name": "Out", "bc_type": "Pressure", "faces": ["face 1@Body1"]}}])
    assert holds_pressure(opening) is True


def _run_spec(*mapped: dict, nu: float = 1e-4, reference: dict | None = None, face_props: dict | None = None):
    from incompressible_flow.runspec import RunSpec

    return RunSpec(
        project_dir=Path("."), run_id="r1", mesh_case_dir=Path("."), n_procs=1, solver_app="simpleFoam",
        end_time=2000, write_interval=100, transient=None, nu=nu, rho=1.0, wall_default="No-slip", bcs=[],
        monitor_patches=[], face_props=face_props or {}, n_cells=1000,
        mapped=[{"bc": bc, "patch": str(bc["name"]).lower()} for bc in mapped], reference=reference or {},
    )


FAR = {"name": "Far", "bc_type": "Freestream", "faces": ["face 1@Body1"], "unit": "m/s", "vector": [1, 0, 0]}
SPHERE = {"name": "Sphere", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 2@Body1"]}


@pytest.mark.parametrize("speed", [1.0, 0.5, 30.0])
def test_a_freestream_sets_the_speed_and_re_on_the_bodys_reference_length(speed: float):
    """A body in one Freestream: the stream's own speed is the case's, also at 1 m/s and below (a
    1 m/s stream read as none: "No time-step estimate: no inlet speed or pressure difference sets
    a flow speed", no Re), and Re is on the study's reference length (the sphere's D)."""
    from magnusim_sdk.runcheck import check

    from incompressible_flow.reference import resolve_reference
    from incompressible_flow.writer import reference_speed

    spec = _run_spec({**FAR, "value": speed}, SPHERE, reference={"ref_length": 0.01})
    assert reference_speed(spec)[0::2] == (speed, "freestream")
    # The force coefficients' blank reference speed is the stream's too (it was 1 m/s below it).
    assert resolve_reference(spec).speed == speed
    inputs = check_inputs(spec, {"end_time": 2000}, {}, transient=False)
    assert inputs["speed"] == speed and inputs["d_hyd"] is None and inputs["ref_length"] == 0.01
    est = check(inputs)["estimate"]
    assert est["re"] == pytest.approx(speed * 0.01 / 1e-4)
    assert f"Re ≈ {speed * 100:,.0f}" in est["line"]
    # Without a reference length: Re on the domain's length along the flow, as before.
    bare = check_inputs(_run_spec({**FAR, "value": speed}, SPHERE), {"end_time": 2000}, {}, transient=False)
    assert bare["speed"] == speed and bare["ref_length"] is None


def test_a_still_freestream_or_a_faster_pressure_drive_keep_the_speed_as_before():
    from incompressible_flow.writer import reference_speed

    # A freestream with no speed (an opening to still air) sets none: 1 m/s, as before.
    assert reference_speed(_run_spec({**FAR, "value": 0}, SPHERE))[0::2] == (1.0, "pressure")
    assert check_inputs(_run_spec({**FAR, "value": 0}, SPHERE), {"end_time": 10}, {}, transient=False)["speed"] is None
    # A velocity outlet's faster outflow still wins over a slower stream.
    out = {"name": "Out", "bc_type": "Velocity outlet", "faces": ["face 3@Body1"], "value": 4, "unit": "m/s"}
    assert reference_speed(_run_spec({**FAR, "value": 0.5}, out))[0::2] == (4.0, "pressure")


def test_on_a_mesh_one_cell_across_re_is_a_2d_channels():
    """A 2D slice's inlet is h high and as deep as the slice: its hydraulic diameter is a 2D
    channel's, 2h (Re_D = U 2h / nu), not the circle of its area (the 2D step read "Re ≈ 55" at
    Re_D 100, and a deeper slice more)."""
    from magnusim_sdk.runcheck import check

    from incompressible_flow.runspec import FaceProps

    h, depth, nu = 0.0052, 0.005, 1.04e-4
    inlet = {"name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 1@Body1"], "value": 1, "unit": "m/s"}
    props = {"face 1@Body1": FaceProps(area_m2=h * depth, normal=(-1.0, 0.0, 0.0), planar=True)}
    spec = _run_spec(inlet, nu=nu, face_props=props)
    facts = {"two_d": {"axis": "z", "depth_m": depth, "cells_across": 1}}
    inputs = check_inputs(spec, {"end_time": 4000}, {"mesh": facts}, transient=False)
    assert inputs["d_hyd"] == pytest.approx(2 * h)
    assert check(inputs)["estimate"]["re"] == pytest.approx(100.0)
    # A 3D mesh of the same part: the inlet's hydraulic diameter as before.
    import math

    flat = check_inputs(spec, {"end_time": 4000}, {"mesh": {"quality": {}}}, transient=False)
    assert flat["d_hyd"] == pytest.approx(2 * math.sqrt(h * depth / math.pi))
