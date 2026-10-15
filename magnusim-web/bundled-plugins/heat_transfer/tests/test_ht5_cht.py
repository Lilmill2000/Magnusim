"""Conjugate heat transfer (HT5), without WSL: the mesh reader, the regions a study's
mesh and materials make, the case a CHT run writes (goldens and each rule), what blocks
a CHT run (in the user's words), the solver the launch picks, the log parser and the
monitors and energy balance read back from a finished case.

``CFDDESK_UPDATE_GOLDEN=1`` rewrites the goldens.
"""

from __future__ import annotations

import dataclasses
import json
import re
import shutil
from pathlib import Path
from typing import Any

import pytest
from ht_inputs import AIR, ALUMINIUM, GOLDEN, make_inputs

from heat_transfer import cht, polymesh
from heat_transfer.contract import validate_ready
from heat_transfer.runspec import load_spec
from heat_transfer.writer import write_case

TESTS = Path(__file__).resolve().parent
WEB = TESTS.parents[2]
TWO_ZONES = WEB / "python" / "tests" / "fixtures" / "cht-case" / "constant" / "polyMesh"  # ascii: air | aluminium_6061
THIN = TESTS / "fixtures" / "thin-plate" / "constant" / "polyMesh"  # binary: plate (1 cell thick) under air
FINISHED = TESTS.parent / "e2e" / "fixtures" / "cht-case"
ROWS = [
    {"name": "air", "role": "fluid", "bodies": ["Body1"], "cells": 32},
    {"name": "aluminium_6061", "role": "solid", "bodies": ["Body2"], "cells": 32},
]
WALLS_FIXED = [{"id": "bc-w", "name": "walls", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 1@Body1"],
                "thermal_condition": "temperature", "wall_temperature": 300.0}]


def _mesh(tmp: Path, src: Path = TWO_ZONES) -> Path:
    mesh = tmp / "mesh"
    shutil.copytree(src, mesh / "constant" / "polyMesh")
    return mesh


def _inputs(tmp: Path, *, rows=ROWS, src: Path = TWO_ZONES, materials=None, **kw: Any):
    mesh = _mesh(tmp, src)
    inp = make_inputs(tmp, materials=materials if materials is not None else [AIR, ALUMINIUM], mesh_dir=mesh, **kw)
    patches = [p.name for p in polymesh.read_polymesh(mesh / "constant" / "polyMesh").patches]
    return dataclasses.replace(inp, mesh={**inp.mesh, "patches": patches, **({"regions": rows} if rows else {})})


# ---------------------------------------------------------------------------
# The mesh reader
# ---------------------------------------------------------------------------


def test_the_reader_reads_an_ascii_mesh_with_zones():
    m = polymesh.read_polymesh(TWO_ZONES)
    assert (m.n_cells, m.n_faces, m.n_internal, m.zone_names) == (64, 248, 136, ["air", "aluminium_6061"])
    assert polymesh.patch_zones(m) == {"walls": {"air": 56, "aluminium_6061": 56}}
    assert polymesh.zone_interfaces(m) == {("air", "aluminium_6061"): 8}
    vols = polymesh.zone_volumes(m)
    assert vols["air"] == pytest.approx(1e-6) and vols["aluminium_6061"] == pytest.approx(1e-6)
    assert polymesh.thin_cells(m, "air") == (0, 32)
    assert polymesh.locate(m, [[0.005, 0.005, 0.005], [0.015, 0.005, 0.005], [0.5, 0, 0]]) == ["air", "aluminium_6061", None]


def test_the_reader_reads_a_binary_mesh_and_finds_a_solid_one_cell_thick():
    m = polymesh.read_polymesh(THIN)
    assert m.zone_names == ["plate", "air"] and m.n_cells == 75
    assert polymesh.thin_cells(m, "plate") == (25, 25)
    assert polymesh.thin_cells(m, "air") == (0, 50)
    assert polymesh.zone_volumes(m)["plate"] == pytest.approx(1e-7)
    assert polymesh.locate(m, [[0.005, 0.005, 0.0005], [0.005, 0.005, 0.002]]) == ["plate", "air"]


def test_an_empty_zone_written_as_its_count_alone_reads(tmp_path):
    """splitMeshRegions writes the other regions' zones in a region's mesh as ``List<label> 0;``."""
    poly = tmp_path / "polyMesh"
    shutil.copytree(TWO_ZONES, poly)
    text = (poly / "cellZones").read_text(encoding="utf-8")
    second = text.index("aluminium_6061\n{")
    text = text[:second] + "aluminium_6061\n{\n    type            cellZone;\n    cellLabels      List<label> 0;\n}\n)\n"
    (poly / "cellZones").write_text(text, encoding="utf-8")
    m = polymesh.read_polymesh(poly)
    assert m.zone_names == ["air", "aluminium_6061"] and int((m.cell_zone == 1).sum()) == 0


def test_one_region_names_keep_clear_of_the_case_files():
    from cfddesk.wsl.region_rule import RESERVED, region_name_ok

    assert cht.RESERVED == RESERVED
    for name in ("Aluminium 6061", "g", "T", "fvSchemes", "Processor 1", "6061", ""):
        assert region_name_ok(cht.region_word(name)), name
    assert cht.region_word("Aluminium 6061") == "aluminium_6061"


# ---------------------------------------------------------------------------
# Regions and layout
# ---------------------------------------------------------------------------


def _records(*mats):
    return [{**m, "simulation_id": "sim_1"} for m in mats]


def test_the_layout_of_a_two_region_mesh():
    lay = cht.layout(ROWS, _records(AIR, ALUMINIUM), TWO_ZONES, volumes=True, thin=True)
    assert [(r.name, r.role, r.bodies, r.zone) for r in lay.regions] == [
        ("air", "fluid", ("Body1",), "air"),
        ("aluminium_6061", "solid", ("Body2",), "aluminium_6061"),
    ]
    assert lay.split and lay.touching == [("air", "aluminium_6061")]
    assert lay.interfaces("air") == ["air_to_aluminium_6061"] and lay.interfaces("aluminium_6061") == ["aluminium_6061_to_air"]
    assert lay.patches == {"air": ["walls"], "aluminium_6061": ["walls"]}
    assert lay.thin == {"aluminium_6061": (0, 32)} and cht.thin_problem(lay) is None
    assert lay.regions[1].label == "Body2 (Aluminium 6061)"


def test_a_mesh_made_for_other_materials_is_refused():
    with pytest.raises(cht.ChtError, match="was made before the materials changed"):
        cht.layout(ROWS, _records(AIR, {**ALUMINIUM, "assigned_volumes": ["Body3"]}), TWO_ZONES)
    with pytest.raises(cht.ChtError, match="was made before the materials changed"):
        cht.layout([], _records(AIR, ALUMINIUM), TWO_ZONES)
    # A study of one solid on every body: one region, the mesh as it is (no split).
    one = cht.layout([], _records({**ALUMINIUM, "assigned_volumes": ["Body1", "Body2"]}), TWO_ZONES)
    assert [r.name for r in one.regions] == ["aluminium_6061"] and not one.split and one.touching == []


def test_a_solid_about_one_cell_thick_is_found():
    rows = [{"name": "plate", "role": "solid", "bodies": ["Body1"]}, {"name": "air", "role": "fluid", "bodies": ["Body2"]}]
    plate = {**ALUMINIUM, "name": "Plate", "assigned_volumes": ["Body1"]}
    lay = cht.layout(rows, _records(plate, {**AIR, "assigned_volumes": ["Body2"]}), THIN, thin=True)
    assert cht.thin_problem(lay) == (
        "Body1 (Plate) is about one cell thick: 100 % of its cells at its surface touch it on every side. Refine the mesh "
        "there so the solid is at least 2 cells across (thinner solids make the solve diverge), or make the part thicker."
    )


# ---------------------------------------------------------------------------
# The case
# ---------------------------------------------------------------------------

FILES = (
    "0/air/U",
    "0/air/T",
    "0/air/p",
    "0/air/p_rgh",
    "0/air/alphat",
    "0/air/k",
    "0/air/omega",
    "0/air/nut",
    "0/aluminium_6061/T",
    "0/aluminium_6061/p",
    "constant/regionProperties",
    "constant/g",
    "constant/air/thermophysicalProperties",
    "constant/air/turbulenceProperties",
    "constant/aluminium_6061/thermophysicalProperties",
    "constant/polyMesh/boundary",
    "system/controlDict",
    "system/fvSchemes",
    "system/fvSolution",
    "system/air/fvSchemes",
    "system/air/fvSolution",
    "system/aluminium_6061/fvSchemes",
    "system/aluminium_6061/fvSolution",
    "system/aluminium_6061/fvOptions",
)
MONITORS = [
    {"id": "mon-tc", "name": "TC", "monitor_type": "ht_thermocouple", "points": [[0.005, 0.005, 0.005], [0.015, 0.005, 0.005]]},
    {"id": "mon-q", "name": "Walls", "monitor_type": "ht_wall_heat_flux", "boundaries": ["bc-w"]},
    {"id": "mon-t", "name": "Wall T", "monitor_type": "ht_surface_temperature", "boundaries": ["bc-w"]},
]


def _compare(case: Path, name: str, files: tuple[str, ...], update: bool) -> None:
    gold = GOLDEN / name
    for rel in files:
        got, want = case / rel, gold / rel
        if not got.is_file():
            assert not want.is_file(), f"{rel} was not written"
            continue
        text = got.read_text(encoding="utf-8")
        if update:
            want.parent.mkdir(parents=True, exist_ok=True)
            want.write_bytes(text.encode("utf-8"))
            continue
        assert want.is_file(), f"missing golden {name}/{rel}"
        assert text == want.read_text(encoding="utf-8"), f"{name}/{rel} differs from its golden"


def _write(tmp: Path, **kw: Any) -> tuple[Path, dict[str, Any]]:
    spec = load_spec(_inputs(tmp, **kw))
    assert spec.ok and spec.cht, spec.error
    case = tmp / "case"
    report = write_case(spec, case)
    assert report["ok"], report
    return case, report


def test_golden_steady_cht_two_regions(tmp_path, update_golden):
    case, report = _write(
        tmp_path,
        bcs=WALLS_FIXED,
        materials=[AIR, {**ALUMINIUM, "heat_source_W": 2, "heat_source_W_m3": 0}],
        study={"gravity": "-y", "turbulence_model": "kOmegaSST"},
        run={"result_controls": MONITORS, "settle": {"id": "mon-tc", "quantity": "T_pt", "tolerance": 0.01, "window": 50}},
    )
    assert report["solver"] == "chtMultiRegionSimpleFoam" and report["regions"] == ["air", "aluminium_6061"]
    _compare(case, "cht_steady_two_regions", FILES, update_golden)
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["regions"] == [{"name": "air", "role": "fluid"}, {"name": "aluminium_6061", "role": "solid"}]
    assert side["pre_steps"] == [{"tool": "splitMeshRegions", "args": ["-cellZonesOnly", "-overwrite"]}]
    assert side["sources_W"] == 2 and side["cht"] is True
    # The thermocouple's points in the region each one is in: one probes object per region.
    tc = next(p for p in side["ht_monitors"] if p["type"] == "ht_thermocouple")
    assert [(p["region"], p["index"]) for p in tc["probes"]] == [("air", [0]), ("aluminium_6061", [1])]
    # A stop on a thermocouple with points in two bodies is not written (and says why).
    assert "settle" not in side or "error" in side.get("settle", {})
    # No field in 0/ itself: splitMeshRegions would copy it into every region.
    assert not [p for p in (case / "0").iterdir() if p.is_file()]


def test_golden_transient_solids_only_one_region(tmp_path, update_golden):
    """One solid material on every body: no split, the mesh straight in its region's folder;
    a W/m³ source; chtMultiRegionFoam with the solids' diffusion number."""
    block = {**ALUMINIUM, "assigned_volumes": ["Body1", "Body2"], "heat_source_W": 0, "heat_source_W_m3": 1e6}
    bcs = [{"id": "bc-w", "name": "walls", "bc_type": "Solid wall", "faces": ["face 1@Body1"],
            "thermal_condition": "heat_transfer_coefficient", "wall_htc": 25, "ambient_temperature": 293.15}]
    case, report = _write(
        tmp_path, rows=[], materials=[block], bcs=bcs, transient={"end_time": 2, "write_count": 4},
        study={"gravity": "off"},
    )
    assert report["solver"] == "chtMultiRegionFoam" and report["regions"] == ["aluminium_6061"]
    files = (
        "0/aluminium_6061/T",
        "0/aluminium_6061/p",
        "constant/regionProperties",
        "constant/aluminium_6061/thermophysicalProperties",
        "constant/aluminium_6061/polyMesh/boundary",
        "system/controlDict",
        "system/fvSolution",
        "system/aluminium_6061/fvSchemes",
        "system/aluminium_6061/fvSolution",
        "system/aluminium_6061/fvOptions",
    )
    _compare(case, "cht_transient_one_solid", files, update_golden)
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert "pre_steps" not in side and side["regions"] == [{"name": "aluminium_6061", "role": "solid"}]
    assert side["sources_W"] == pytest.approx(2.0)  # 1e6 W/m³ over the 2 cm³ mesh
    assert (case / "constant" / "aluminium_6061" / "polyMesh" / "owner").is_file()
    assert re.search(r"maxDi\s+10;", (case / "system" / "controlDict").read_text(encoding="utf-8"))


def _fv(case: Path) -> str:
    path = case / "system" / "aluminium_6061" / "fvOptions"
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def test_the_heat_source_is_read_from_the_solid_record_else_an_older_study_row(tmp_path):
    """The source lives on the solid's material record (it copies and goes with it); a study
    saved before that keeps its heat_sources row (an object, or JSON text) for a record
    with neither key; a record's own keys win, 0 included."""
    on_record, _r = _write(tmp_path / "a", bcs=WALLS_FIXED, materials=[AIR, {**ALUMINIUM, "heat_source_W": 10}])
    assert "absolute" in _fv(on_record) and re.search(r"\(\s*10\s+0\s*\)", _fv(on_record))
    older = {"m-al": {"mode": "power", "power_W": 10, "power_density_W_m3": 0}}
    for study in ({"heat_sources": older}, {"heat_sources": json.dumps(older)}):
        case, _r = _write(tmp_path / f"b{len(str(study))}", bcs=WALLS_FIXED, study={"gravity": "-y", **study})
        assert _fv(case) == _fv(on_record)
    none_on_record, _r = _write(tmp_path / "c", bcs=WALLS_FIXED, materials=[AIR, {**ALUMINIUM, "heat_source_W": 0}],
                                study={"gravity": "-y", "heat_sources": older})
    assert _fv(none_on_record) == ""
    # A study copy gives the material a new id: the record's source goes with it.
    copied, _r = _write(tmp_path / "d", bcs=WALLS_FIXED, materials=[AIR, {**ALUMINIUM, "id": "m-copy", "heat_source_W": 10}],
                        study={"gravity": "-y", "heat_sources": json.dumps(older)})
    assert _fv(copied) == _fv(on_record)


def test_the_volumes_are_worked_out_only_for_a_source_per_volume(tmp_path):
    from heat_transfer.polymesh import SUMMARY_FILE

    case, report = _write(tmp_path / "a", bcs=WALLS_FIXED, materials=[AIR, {**ALUMINIUM, "heat_source_W": 3}])
    kept = json.loads((tmp_path / "a" / "mesh" / SUMMARY_FILE).read_text(encoding="utf-8"))
    assert "volumes" not in kept and report["ok"]
    _case, report = _write(tmp_path / "b", bcs=WALLS_FIXED, materials=[AIR, {**ALUMINIUM, "heat_source_W_m3": 1e6}])
    kept = json.loads((tmp_path / "b" / "mesh" / SUMMARY_FILE).read_text(encoding="utf-8"))
    assert kept["volumes"]["aluminium_6061"] == pytest.approx(1e-6, rel=1e-6)


def test_two_thermocouples_whose_names_would_make_the_same_object_get_their_own(tmp_path):
    from heat_transfer.functions import monitor_key

    taken: set[str] = set()
    assert monitor_key("TC air", taken) == "ht_probe_tc_air"
    monitors = [
        {"id": "m1", "name": "TC air", "monitor_type": "ht_thermocouple", "points": [[0.005, 0.005, 0.005]]},
        {"id": "m2", "name": "TC", "monitor_type": "ht_thermocouple", "points": [[0.005, 0.005, 0.005], [0.015, 0.005, 0.005]]},
    ]
    case, _r = _write(tmp_path, bcs=WALLS_FIXED, run={"result_controls": monitors})
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    keys = [p["key"] for m in side["ht_monitors"] if m["type"] == "ht_thermocouple" for p in m["probes"]]
    assert keys == ["ht_probe_tc_air", "ht_probe_tc_air_2", "ht_probe_tc_aluminium_6061"]
    assert len(set(keys)) == len(keys)


def test_switching_between_buoyant_and_cht_writes_each_case_clean(tmp_path):
    """The same run folder written as a CHT case, then (Body2 made fluid) as a buoyant one,
    then as CHT again: no file of the other kind is left (regionProperties would refuse the
    buoyant case; a top-level 0/ field would be split into every region)."""
    case = tmp_path / "case"
    spec = load_spec(_inputs(tmp_path, bcs=WALLS_FIXED))
    assert write_case(spec, case)["ok"]
    buoyant = load_spec(_inputs(tmp_path / "b", rows=[], materials=[{**AIR, "assigned_volumes": ["Body1", "Body2"]}], bcs=WALLS_FIXED))
    assert not buoyant.cht and write_case(buoyant, case)["ok"]
    assert not (case / "constant" / "regionProperties").exists()
    assert not [d for d in (case / "0").iterdir() if d.is_dir()]
    assert not [d for d in (case / "system").iterdir() if d.is_dir()]
    assert (case / "0" / "T").is_file() and "buoyantSimpleFoam" in (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert write_case(load_spec(_inputs(tmp_path / "c", bcs=WALLS_FIXED)), case)["ok"]
    assert not [p for p in (case / "0").iterdir() if p.is_file()]
    assert not (case / "constant" / "thermophysicalProperties").exists()
    assert (case / "constant" / "regionProperties").is_file()


def test_a_run_solved_before_the_materials_changed_does_not_continue(tmp_path):
    case = tmp_path / "case"
    assert write_case(load_spec(_inputs(tmp_path, bcs=WALLS_FIXED)), case)["ok"]
    (case / "20" / "air").mkdir(parents=True)
    (case / "20" / "aluminium_6061").mkdir(parents=True)
    for r in ("air", "aluminium_6061"):
        (case / "20" / r / "T").write_text("x", encoding="utf-8")
    again = load_spec(_inputs(tmp_path / "x", bcs=WALLS_FIXED, restart={"end_time": 40}))
    report = write_case(again, case)
    assert report["ok"] and report["restart"] == {"from_time": 20.0, "end_time": 40.0}
    assert (case / "20" / "air" / "T").is_file()
    buoyant = load_spec(_inputs(tmp_path / "y", rows=[], materials=[{**AIR, "assigned_volumes": ["Body1", "Body2"]}],
                                bcs=WALLS_FIXED, restart={"end_time": 60}))
    report = write_case(buoyant, case)
    assert report == {
        "ok": False,
        "error": "This run solved conjugate heat transfer, and the study's materials have changed since (the solver "
        "follows them): start a new run.",
    }


# ---------------------------------------------------------------------------
# What blocks a run
# ---------------------------------------------------------------------------


def _ctx(tmp: Path, *, materials, bcs, rows=ROWS, src: Path = TWO_ZONES, study=None, mesh_extra=None):
    from cfddesk.registry.contract import ReadyContext

    mesh = _mesh(tmp, src)
    names = [p.name for p in polymesh.read_polymesh(mesh / "constant" / "polyMesh").patches]
    return ReadyContext(
        project_dir=tmp,
        simulation_id="sim_1",
        run_id="run_1",
        mesh_id="mesh_1",
        mesh_case_dir=mesh,
        patches=tuple(names),
        study=dict(study or {"time_dependency": "Steady-state", "gravity": "-y"}),
        read_study=lambda _n: None,
        mesh={"mesh_id": "mesh_1", "mesh_name": "Mesh 1", "ok": True, **({"regions": rows} if rows else {}), **(mesh_extra or {})},
        materials=tuple({**m, "simulation_id": "sim_1"} for m in materials),
        bcs=tuple({**b, "simulation_id": "sim_1"} for b in bcs),
    )


def _first(ctx) -> str | None:
    issues = validate_ready(ctx)
    return issues[0]["message"] if issues else None


def test_a_ready_cht_study_has_no_issues(tmp_path):
    assert _first(_ctx(tmp_path, materials=[AIR, ALUMINIUM], bcs=WALLS_FIXED)) is None


def test_a_mesh_out_of_date_with_the_materials_is_refused(tmp_path):
    msg = _first(_ctx(tmp_path, materials=[AIR, ALUMINIUM], bcs=WALLS_FIXED, mesh_extra={"out_of_date_materials": True}))
    assert msg == (
        "Mesh 1 was made before the materials changed (each material's bodies are meshed as a region of their own): "
        "generate it again."
    )
    msg = _first(_ctx(tmp_path / "b", materials=[AIR, ALUMINIUM], bcs=WALLS_FIXED, rows=[],
                      mesh_extra={"out_of_date_materials": True, "engine": "cfmesh"}))
    assert msg.endswith("cfMesh can't mesh solid bodies separately: mesh with Standard or Hex-dominant.")
    # A one-region mesh another mesher made before a body became solid: no cfMesh hint.
    msg = _first(_ctx(tmp_path / "c", materials=[AIR, ALUMINIUM], bcs=WALLS_FIXED, rows=[],
                      mesh_extra={"out_of_date_materials": True, "engine": "standard"}))
    assert msg.endswith("generate it again.") and "cfMesh" not in msg


def test_an_inlet_on_a_solid_and_a_solid_wall_on_a_fluid_are_refused(tmp_path):
    inlet = [{"id": "bc-i", "name": "walls", "bc_type": "Velocity inlet", "value": 1, "unit": "m/s", "faces": ["face 9@Body2"]}]
    assert _first(_ctx(tmp_path, materials=[AIR, ALUMINIUM], bcs=inlet)) == (
        '"walls" is on Body2, which is solid (Aluminium 6061): fluid comes in or goes out only through a fluid '
        "body's faces. Move it to the fluid's faces, or give the solid's faces a Solid wall."
    )
    solid_wall = [{"id": "bc-s", "name": "walls", "bc_type": "Solid wall", "faces": ["face 1@Body1"],
                   "thermal_condition": "temperature", "wall_temperature": 300}]
    assert _first(_ctx(tmp_path / "b", materials=[AIR, ALUMINIUM], bcs=solid_wall)) == (
        'Solid wall "walls" is on Body1, which is fluid (Air). Give a fluid\'s faces a Wall.'
    )


def test_heat_paths(tmp_path):
    # A solid alone whose every face is adiabatic and that has no source.
    block = {**ALUMINIUM, "assigned_volumes": ["Body1", "Body2"]}
    assert _first(_ctx(tmp_path / "a", materials=[block], bcs=[], rows=[])) == (
        "Body1 and Body2 (Aluminium 6061) is solid, but every face of it is adiabatic and it has no heat source: "
        "nothing sets its temperature. Give a face a Solid wall with a temperature or a heat transfer coefficient, "
        "or a heat source, or let it touch the fluid."
    )
    # A source with nowhere for the heat to go: steady refused, transient runs.
    study = {"time_dependency": "Steady-state"}
    heated = {**block, "heat_source_W": 5}
    msg = _first(_ctx(tmp_path / "b", materials=[heated], bcs=[], rows=[], study=study))
    assert msg.startswith("A steady solve of Body1 and Body2 (Aluminium 6061) needs a way for heat to leave: here heat comes "
                          "in (the heat source in Body1 and Body2)")
    assert _first(_ctx(tmp_path / "c", materials=[heated], bcs=[], rows=[],
                       study={"time_dependency": "Transient"})) is None
    # The same from an older study's row.
    older = {"time_dependency": "Steady-state", "heat_sources": {"m-al": {"mode": "power", "power_W": 5}}}
    assert _first(_ctx(tmp_path / "b2", materials=[block], bcs=[], rows=[], study=older)) == msg
    # A source that takes heat out (below 0), or a heat flux out: heat only leaves.
    cooled = {**block, "heat_source_W": -5}
    msg = _first(_ctx(tmp_path / "e", materials=[cooled], bcs=[], rows=[], study=study))
    assert msg == (
        "A steady solve of Body1 and Body2 (Aluminium 6061) needs a face that sets a temperature: here heat only goes "
        "out (the heat source in Body1 and Body2) and nothing brings it in, so there is no steady temperature. Give a "
        "face a fixed temperature or a heat transfer coefficient, add an inlet and an outlet, or solve it as a "
        "transient study."
    )
    flux_out = [{"id": "bc-q", "name": "walls", "bc_type": "Solid wall", "faces": ["face 1@Body1"],
                 "thermal_condition": "heat_flux", "wall_heat_flux": -100}]
    msg = _first(_ctx(tmp_path / "f", materials=[block], bcs=flux_out, rows=[], study=study))
    assert msg.startswith("A steady solve of Body1 and Body2 (Aluminium 6061) needs a face that sets a temperature: here heat "
                          'only goes out (the heat flux on "walls")')
    # The fluid closed with gravity off and nothing moving: refused as in a buoyant study.
    msg = _first(_ctx(tmp_path / "d", materials=[AIR, ALUMINIUM], bcs=WALLS_FIXED, study={"gravity": "off"}))
    assert msg.startswith("Nothing moves the fluid in Body1 (Air): it has no inlet or outlet, gravity is off")


def test_a_thin_solid_is_refused_at_start(tmp_path):
    rows = [{"name": "plate", "role": "solid", "bodies": ["Body1"]}, {"name": "air", "role": "fluid", "bodies": ["Body2"]}]
    mats = [{**ALUMINIUM, "name": "Plate", "assigned_volumes": ["Body1"]}, {**AIR, "assigned_volumes": ["Body2"]}]
    msg = _first(_ctx(tmp_path, materials=mats, bcs=[], rows=rows, src=THIN))
    assert msg.startswith("Body1 (Plate) is about one cell thick: 100 % of its cells")


def test_a_solids_heat_source_the_solve_cannot_use_is_refused_with_its_material(tmp_path):
    from heat_transfer.contract import validate_ready

    both = {**ALUMINIUM, "heat_source_W": 3, "heat_source_W_m3": 100}
    issues = validate_ready(_ctx(tmp_path / "a", materials=[AIR, both], bcs=WALLS_FIXED))
    assert issues[0]["message"] == (
        "Aluminium 6061 has a heat source both in total and per volume: set one of them to 0."
    )
    assert issues[0]["fix"] == {"go": "material", "id": "m-al", "name": "Aluminium 6061"}
    word = {**ALUMINIUM, "heat_source_W": "lots"}
    assert _first(_ctx(tmp_path / "b", materials=[AIR, word], bcs=WALLS_FIXED)) == "Aluminium 6061's heat source is not a number."
    older = {"gravity": "-y", "heat_sources": "{not json"}
    assert _first(_ctx(tmp_path / "c", materials=[AIR, ALUMINIUM], bcs=WALLS_FIXED, study=older)) == (
        "Study settings: the heat sources were not saved as readable JSON."
    )


def test_boussinesq_on_a_gas_with_a_heat_source_is_refused(tmp_path):
    """HT0: air under Boussinesq round a 10 W heater ran to 600 K, where its density went to 0."""
    heater = {**ALUMINIUM, "heat_source_W": 10}
    msg = _first(_ctx(tmp_path, materials=[AIR, heater], bcs=WALLS_FIXED, study={"gravity": "-y", "density_model": "boussinesq"}))
    assert msg == (
        "Boussinesq holds for small temperature differences, and the heat source in Body2 can heat Air far past them "
        "(its density would go to 0). Use incompressible perfect gas."
    )
    # Perfect gas runs; a heat sink (below 0) is no such risk.
    assert _first(_ctx(tmp_path / "b", materials=[AIR, heater], bcs=WALLS_FIXED,
                       study={"gravity": "-y", "density_model": "perfect_gas"})) is None
    assert _first(_ctx(tmp_path / "c", materials=[AIR, {**heater, "heat_source_W": -10}], bcs=WALLS_FIXED,
                       study={"gravity": "-y", "density_model": "boussinesq"})) is None


def test_boussinesq_beta_dt_is_checked_in_a_cht_study_too(tmp_path):
    water = {**AIR, "name": "Water", "preset": "water", "density": 998.0, "thermal_expansion": 2.07e-4,
             "dynamic_viscosity": 1.0e-3, "specific_heat": 4182.0, "thermal_conductivity": 0.6}
    hot = [{**WALLS_FIXED[0], "wall_temperature": 1500.0}]
    msg = _first(_ctx(tmp_path, materials=[water, ALUMINIUM], bcs=hot, study={"gravity": "-y", "density_model": "boussinesq"}))
    assert msg.startswith("Boussinesq holds for small temperature differences: β·ΔT is 0.25")


# ---------------------------------------------------------------------------
# Launch, parser, results
# ---------------------------------------------------------------------------


def test_the_launch_follows_the_materials(tmp_path):
    from cfddesk.registry import contract as core
    from cfddesk.registry import get_registry, load_all, reset_for_tests

    reset_for_tests()
    load_all()
    steady = get_registry("analysis").get("heat_transfer_steady")
    transient = get_registry("analysis").get("heat_transfer_transient")
    solvers = get_registry("solver")
    assert core.launch_spec(steady, solvers).app == "buoyantSimpleFoam"
    cht_inputs = _inputs(tmp_path)
    assert core.launch_spec(steady, solvers, inputs=cht_inputs).app == "chtMultiRegionSimpleFoam"
    assert core.launch_spec(transient, solvers, inputs=cht_inputs).app == "chtMultiRegionFoam"
    one_fluid = _inputs(tmp_path / "b", rows=[], materials=[AIR])
    assert core.launch_spec(steady, solvers, inputs=one_fluid).app == "buoyantSimpleFoam"
    # Every launch names the one parser that reads both kinds of log.
    assert core.launch_spec(steady, solvers, inputs=cht_inputs).log_parser == core.launch_spec(steady, solvers).log_parser
    reset_for_tests()


def test_the_parser_reads_a_cht_log_by_region():
    from heat_transfer.parser import HeatParser

    parser = HeatParser()
    for line in (WEB / "python" / "tests" / "fixtures" / "cht-case" / "log.chtMultiRegionSimpleFoam").read_text(
        encoding="utf-8"
    ).splitlines():
        parser.feed(line)
    rows = parser.snapshot()["residuals"]
    assert len(rows) == 3
    assert set(rows[-1]) == {"t", "air:Ux", "air:Uy", "air:Uz", "air:h", "air:p_rgh", "aluminium_6061:h"}


def test_a_finished_cht_case_reads_its_monitors_and_balance():
    from heat_transfer.results import run_monitors

    answer = run_monitors(FINISHED)
    tcs = [r for r in answer["custom"] if r["name"].startswith("TC")]
    assert [r.get("region") for r in tcs] == ["air", "aluminium_6061"]
    assert 293.0 < tcs[0]["last"]["T_K"] < tcs[1]["last"]["T_K"]
    names = [r["name"] for r in answer["monitors"]]
    assert names == ["Energy balance", "Body2 (Aluminium 6061)"]
    labels = [s["label"] for s in answer["summary"]]
    assert labels == ["Heat in", "out", "imbalance"] and answer["summary"][2]["value"] < 1.0
    assert answer["summary_warn"] is False
    assert answer["interfaces"][0]["from_label"] == "Body1 (Air)" and answer["interfaces"][0]["W"] < 0
