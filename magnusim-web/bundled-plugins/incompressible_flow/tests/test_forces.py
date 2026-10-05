"""Forces monitors: the monitor type, the forces / forceCoeffs function objects the
writer emits for a run's Forces monitors, and the rows read back from what
OpenFOAM v2606 wrote (fixtures/pitzdaily-monitors: a real simpleFoam run of the
case this writer wrote over the pitzDaily mesh, 8 iterations)."""

from __future__ import annotations

import dataclasses
import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry
from conftest import FIXTURES, JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.force_objects import (
    force_coeffs_block,
    forces_block,
    forces_functions_text,
    plan_forces_monitors,
)
from incompressible_flow.forces_results import parse_dat, read_dat
from incompressible_flow.monitors import (
    DEFAULT_WALLS,
    FORCE_QUANTITY_KEYS,
    MONITOR_QUANTITIES,
    forces_monitor_records,
)
from incompressible_flow.reference import resolve_reference
from incompressible_flow.results import run_monitors
from incompressible_flow.writer import write_solve_case

CASE = FIXTURES / "pitzdaily-monitors"


@pytest.fixture
def registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _ref(**raw):
    return resolve_reference(SimpleNamespace(reference=raw, mapped=[], face_props={}, rho=1.2, speed_for_k=1.0))


def _mapped(*names):
    return [{"bc": {"id": f"bc-{n.lower()}", "name": n, "bc_type": "Wall", "faces": [f"f {n}"]}, "patch": n.lower()} for n in names]


def test_forces_block_is_v2606_forces_in_newtons():
    text = forces_block("forces_drag", ["wing", "walls"], rho=998.2, cofr=(0.25, 0, 0), write_control_text="writeControl    timeStep;")
    assert "type            forces;" in text and "libs            (forces);" in text
    assert "patches         (wing walls);" in text
    # The case stores p / rho: rhoInf scales it back to pascals, so forces are in N.
    assert "rho             rhoInf;" in text and "rhoInf          998.2;" in text
    assert "CofR            (0.25 0 0);" in text


def test_force_coeffs_block_has_the_reference_values():
    text = force_coeffs_block(
        "coeffs_drag", ["wing"], rho=1.2, cofr=(0, 0, 0), lift=(0, 0, 1), drag=(1, 0, 0),
        speed=12.5, length=0.3, area=0.75, write_control_text="writeControl    timeStep;",
    )
    for line in ("type            forceCoeffs;", "liftDir         (0 0 1);", "dragDir         (1 0 0);",
                 "magUInf         12.5;", "lRef            0.3;", "Aref            0.75;"):
        assert line in text, line
    # v2606 takes the pitch axis as lift x drag itself.
    assert "pitchAxis" not in text


def test_plan_takes_each_boundary_patch_and_names_the_ones_the_mesh_lacks():
    spec = SimpleNamespace(
        mapped=_mapped("Wing", "Flap"),
        forces_monitors=[{"id": "rc1", "name": "Drag", "boundaries": ["bc-wing", DEFAULT_WALLS, "bc-flap", "bc-gone"]}],
    )
    (plan,) = plan_forces_monitors(spec, {"wing", "walls", "inlet"}, _ref(ref_area=2.0))
    assert plan["key"] == "forces_drag" and plan["coeffs_key"] == "coeffs_drag"
    assert plan["patches"] == ["wing", "walls"]
    assert plan["boundaries"] == ["Wing", "Walls with no boundary condition"]
    assert plan["missing"] == ["Flap"]
    assert any("Re-mesh to give 'Flap' its own boundary" in n for n in plan["notes"])
    assert any("no faces or was deleted" in n for n in plan["notes"])
    assert plan["moment_coefficient"] is False  # no reference length


def test_plan_without_area_writes_no_coefficients_and_without_patches_nothing():
    spec = SimpleNamespace(
        mapped=_mapped("Wing"),
        forces_monitors=[
            {"id": "a", "name": "Body", "boundaries": ["Wing"]},  # a BC saved without an id: its name
            {"id": "b", "name": "Body", "boundaries": ["bc-wing"]},
            {"id": "c", "name": "Empty", "boundaries": []},
        ],
    )
    plans = plan_forces_monitors(spec, None, _ref())
    assert [p["key"] for p in plans] == ["forces_body", "forces_body_2", None]
    assert [p["coeffs_key"] for p in plans] == [None, None, None]
    assert "No walls are picked" in plans[2]["notes"][0]
    text = forces_functions_text(plans, _ref())
    assert text.count("type            forces;") == 2 and "forceCoeffs" not in text


def test_forces_monitor_records_are_the_forces_result_controls():
    rcs = [
        {"id": "a", "monitor_type": "area_average", "faces": ["f"]},
        {"id": "b", "monitor_type": "forces", "name": "Drag", "boundaries": ["bc-1", "", DEFAULT_WALLS]},
        {"id": "c", "monitor_type": "forces"},
    ]
    assert forces_monitor_records(rcs) == [
        {"id": "b", "name": "Drag", "boundaries": ["bc-1", DEFAULT_WALLS]},
        {"id": "c", "name": "Forces", "boundaries": []},
    ]


def test_the_writer_emits_forces_after_the_monitors_and_records_them(tmp_path: Path):
    spec = load_run_spec(JS_PROJECT, run_id="run-forces", require_mesh=False, n_procs=1)
    spec = dataclasses.replace(
        spec,
        reference={"ref_area": 0.5, "ref_length": 0.1, "ref_cofr": [0.01, 0, 0]},
        forces_monitors=[{"id": "rc-f", "name": "Forces 1", "boundaries": [DEFAULT_WALLS, "pressure_1"]}],
    )
    write_solve_case(spec, tmp_path / "case")
    control = (tmp_path / "case" / "system" / "controlDict").read_text(encoding="utf-8")
    assert control.index("mon_velocity_inlet_1") < control.index("forces_forces_1") < control.index("coeffs_forces_1")
    assert "patches         (walls pressure_1);" in control
    assert "magUInf         50;" in control  # blank speed: the inlet's 50 m/s
    side = json.loads((tmp_path / "case" / "w27-case.json").read_text(encoding="utf-8"))
    assert side["forces_monitors"][0]["coeffs_key"] == "coeffs_forces_1"
    assert side["reference"]["speed_m_s"] == 50.0 and side["reference"]["speed_auto"] is True
    assert side["reference"]["cofr_m"] == [0.01, 0.0, 0.0]


def test_parse_dat_reads_columns_by_header():
    text = "# Force\n# CofR : (0 0 0)\n#\n# Time\ttotal_x total_y total_z\n1 1 2 3\n2 (4 5 6)\nbad row\n"
    cols, rows = parse_dat(text)
    assert cols == ["Time", "total_x", "total_y", "total_z"]
    assert rows == [[1.0, 1.0, 2.0, 3.0], [2.0, 4.0, 5.0, 6.0]]


def test_a_restart_folder_supersedes_the_rows_from_its_first_time(tmp_path: Path):
    for t, rows in (("0", ["1 1 0 0", "2 2 0 0", "3 3 0 0"]), ("2", ["2 20 0 0", "3 30 0 0"])):
        d = tmp_path / "postProcessing" / "forces_x" / t
        d.mkdir(parents=True)
        (d / "force.dat").write_text("# Time total_x total_y total_z\n" + "\n".join(rows) + "\n", encoding="utf-8")
    assert [(r["Time"], r["total_x"]) for r in read_dat(tmp_path, "forces_x", "force.dat")] == [
        (1.0, 1.0), (2.0, 20.0), (3.0, 30.0)
    ]


def test_real_v2606_output_reads_as_a_forces_row():
    answer = run_monitors(CASE)
    (row,) = [r for r in answer["custom"] if r["type"] == "forces"]
    assert (row["id"], row["key"], row["type"], row["default_quantity"]) == ("rc-f1", "forces_forces_1", "forces", "Fd")
    assert len(row["series"]) == 8 and [p["t"] for p in row["series"]] == [float(i) for i in range(1, 9)]
    last = row["last"]
    # The last line of force.dat, moment.dat and coefficient.dat.
    assert last["F_N"] == pytest.approx([-0.0144669208, 0.00339752689, 1.33044899e-19])
    assert last["M_Nm"][2] == pytest.approx(-0.000199904465)
    assert last["Cd"] == pytest.approx(-0.241115347) and last["CmPitch"] == pytest.approx(0.131170909)
    # Drag along +X, lift along +Y, side = lift x drag (-Z), as forceCoeffs.
    assert (last["Fd_N"], last["Fl_N"]) == pytest.approx((-0.0144669208, 0.00339752689))
    for p in row["series"]:
        assert p["F_N"] == pytest.approx([a + b for a, b in zip(p["Fp_N"], p["Fv_N"], strict=True)], rel=1e-6, abs=1e-9)
        assert p["Fdp_N"] + p["Fdv_N"] == pytest.approx(p["Fd_N"], rel=1e-6, abs=1e-9)
        # Our projection over q A is OpenFOAM's coefficient: U 10 m/s, A 0.001 m², rho 1.2.
        q_a = 0.5 * 1.2 * 10.0**2 * 0.001
        assert p["Fd_N"] / q_a == pytest.approx(p["Cd"], rel=1e-6)
        assert p["Fl_N"] / q_a == pytest.approx(p["Cl"], rel=1e-6)
    assert row["quantities"] == list(FORCE_QUANTITY_KEYS) + ["Cd", "Cl", "Cs", "Cm"]
    assert row["details"][0] == ["Walls", "lowerWall, upperWall"]
    assert "Re-mesh to give 'Wing' its own boundary" in row["note"]


def test_no_area_no_coefficient_quantities(tmp_path: Path):
    case = tmp_path / "case"
    shutil.copytree(CASE, case)
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    side["forces_monitors"][0].update(coeffs_key=None, notes=[], moment_coefficient=False)
    (case / "w27-case.json").write_text(json.dumps(side), encoding="utf-8")
    (row,) = [r for r in run_monitors(case)["custom"] if r["type"] == "forces"]
    assert row["quantities"] == list(FORCE_QUANTITY_KEYS)
    assert row["last"]["Cd"] is None
    assert "Set a reference area" in row["note"]


def test_a_forces_monitor_that_wrote_nothing_has_no_row(tmp_path: Path):
    case = tmp_path / "case"
    case.mkdir()
    plan = {"id": "x", "name": "F", "key": "forces_f", "coeffs_key": None, "patches": ["w"], "notes": []}
    (case / "w27-case.json").write_text(json.dumps({"rho": 1.2, "forces_monitors": [plan]}), encoding="utf-8")
    assert run_monitors(case)["custom"] == []


def test_contract_answer_and_monitor_type(registry):
    spec = get_registry("analysis").get("incompressible_steady")
    answer = contract.run_monitors(spec, CASE)
    keys = [q["key"] for q in answer["quantities"]]
    assert set(answer["custom"][0]["quantities"]) <= set(keys)
    assert {q.key for q in MONITOR_QUANTITIES} == set(keys)
    row = {r["key"]: r for r in get_registry("monitor").describe()}["forces"]
    assert (row["label"], row["target"], row["user_creatable"]) == ("Forces", "boundary", True)
    assert row["boundary_kinds"] == ["wall"]
    assert "reference values" in row["study_note"]
    assert "forces" in spec.monitors
    by_key = {q.key: q for q in MONITOR_QUANTITIES}
    assert (by_key["Fd"].unit, by_key["Mx"].unit, by_key["Cd"].unit) == ("N", "N·m", "")
    assert [k for k, q in by_key.items() if q.headline and k in row["quantities"]] == ["Fd", "Fl", "Cd", "Cl"]


def test_load_run_spec_reads_the_runs_forces_monitors_and_the_studys_reference():
    from cfddesk.project.run_inputs import gather_run_inputs

    from incompressible_flow.runspec import load_run_spec

    inputs = gather_run_inputs(JS_PROJECT, run_id="r", require_mesh=False, n_procs=1)
    assert load_run_spec(inputs).forces_monitors == [] and load_run_spec(inputs).reference == {}
    rcs = [{"id": "rc-f", "name": "Drag", "monitor_type": "forces", "category": "Boundary data", "boundaries": ["@walls"]}]
    inputs = dataclasses.replace(
        inputs,
        run={**inputs.run, "result_controls": rcs},
        study={**inputs.study, "ref_area": 1.5, "ref_speed": None, "turbulence_model": "kEpsilon"},
    )
    spec = load_run_spec(inputs)
    assert spec.forces_monitors == [{"id": "rc-f", "name": "Drag", "boundaries": ["@walls"]}]
    assert spec.reference == {"ref_area": 1.5}
    # It is not an area-average monitor too.
    assert spec.custom_monitors == []
