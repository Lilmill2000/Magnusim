"""HT2 (host API 1.8): a study whose materials make several regions is meshed with one
cellZone per region, the faces between regions meshed through (conformal), never a patch.

The two-box part (``geometry/two-boxes-shared-face.brep``): box 1 is x 0..10 mm, box 2
x 10..30 mm, the x = 10 face shared. Body1 gets a fluid (Air), Body2 a solid
(Aluminium 6061) through the heat example test plugin (``fixtures/heat-plugins``).
A study with one material is meshed exactly as before (its goldens say so).
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from cfddesk.project import web_writes as ww
from cfddesk.project.paths import find_study
from cfddesk.project.regions import mesh_regions, regions_signature
from cfddesk.registry import reset_for_tests
from tests.unit.test_shared_faces import (
    INTERFACE_X_M,
    _cells_meet_across_the_interface,
    _generate,
    _project,
)

HEAT = Path(__file__).resolve().parents[1] / "fixtures" / "heat-plugins"


@pytest.fixture(autouse=True)
def _heat_plugins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(HEAT))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _mat(mid: str, name: str, model: str, bodies: list[str]) -> dict:
    return {"id": mid, "name": name, "material_model": model, "assigned_volumes": bodies, "simulation_id": "sim_1"}


def _heat_project(tmp: Path, materials: list[dict]) -> Path:
    proj = _project(tmp, "face 8@Body2")
    ident = Path(find_study(proj, "sim_1")["dir"]) / "id.json"  # type: ignore[index]
    doc = json.loads(ident.read_text(encoding="utf-8"))
    ident.write_text(json.dumps({**doc, "analysis_type": "example_heat_steady"}) + "\n", encoding="utf-8")
    ww.set_materials(
        proj,
        {"simulation_id": "sim_1", "materials": materials, "only_ids": [m["id"] for m in materials]},
        sim_id="sim_1",
    )
    return proj


TWO = [
    _mat("m-air", "Air", "example_heat_fluid", ["Body1"]),
    _mat("m-al", "Aluminium 6061", "example_heat_solid", ["Body2"]),
]


def _msh(path: Path) -> tuple[dict[int, tuple[int, str]], dict[int, float], list[list[int]]]:
    """(physical names by tag, node x by id, element rows) of an MSH 2.2 file."""
    lines = path.read_text(encoding="ascii").splitlines()
    i = lines.index("$PhysicalNames")
    names = {}
    for row in lines[i + 2 : i + 2 + int(lines[i + 1])]:
        dim, tag, name = row.split(" ", 2)
        names[int(tag)] = (int(dim), name.strip('"'))
    i = lines.index("$Nodes")
    xs = {int(r.split()[0]): float(r.split()[1]) for r in lines[i + 2 : i + 2 + int(lines[i + 1])]}
    i = lines.index("$Elements")
    rows = [[int(t) for t in r.split()] for r in lines[i + 2 : i + 2 + int(lines[i + 1])]]
    return names, xs, rows


@pytest.mark.parametrize("hex_core", ["0", "1"])
def test_two_materials_mesh_as_two_cell_zones_meeting_at_the_interface(tmp_path: Path, hex_core: str) -> None:
    proj = _heat_project(tmp_path, TWO)
    case = tmp_path / "case"
    rc, result, out = _generate(
        "generate_standard.py", proj, case, "--hex-core", hex_core, "--add-layers", "1", "--threads", "1",
        "--prepare-only",
    )
    assert rc == 0 and result.get("ok"), out[-3000:]
    msh = case / "constant" / "triSurface" / "geometry.msh"
    names, xs, rows = _msh(msh)
    volumes = {tag: name for tag, (dim, name) in names.items() if dim == 3}
    assert sorted(volumes.values()) == ["air", "aluminium_6061"]
    patches = {name for dim, name in names.values() if dim == 2}
    # The solid's leftover faces have their own walls; the inlet sits on the solid here.
    assert {"walls", "aluminium_6061_walls", "pressure_1", "velocity_inlet_1"} <= patches
    # Every cell is tagged with its own body's region: x < 10 mm air, x > 10 mm aluminium.
    by_tag = {name: tag for tag, name in volumes.items()}
    wrong = 0
    for v in rows:
        if v[1] in (4, 5, 6, 7):  # tet, hex, prism, pyramid
            conn = v[3 + v[2] :]
            cx = sum(xs[n] for n in conn) / len(conn)
            want = by_tag["air"] if cx < INTERFACE_X_M else by_tag["aluminium_6061"]
            wrong += int(v[3] != want)
    assert wrong == 0
    # No boundary triangle on the interface; the cells on both sides share its nodes.
    on_interface = [
        v for v in rows if v[1] == 2 and all(abs(xs[n] - INTERFACE_X_M) < 1e-9 for n in v[3 + v[2] :])
    ]
    assert on_interface == []
    assert _cells_meet_across_the_interface(msh)
    log = (case / "log.gmsh_host.txt").read_text(encoding="utf-8")
    assert "2 bodies fragmented into 2 volume(s) in 2 regions: air, aluminium_6061" in log
    assert "fused" not in log
    # The hex core needs one volume: never with two regions.
    assert result["hex_core_applied"] is False
    # Boundary layers grow on fluid walls only (the solid's walls take none).
    smd = (case / "system" / "snappyHexMeshDict").read_text(encoding="utf-8") if (case / "system" / "snappyHexMeshDict").is_file() else ""
    assert "aluminium_6061_walls" not in smd
    assert "velocity_inlet_1" not in smd


def test_the_mesh_records_its_regions(tmp_path: Path) -> None:
    proj = _heat_project(tmp_path, TWO)
    case = tmp_path / "case"
    rc, result, out = _generate(
        "generate_standard.py", proj, case, "--hex-core", "0", "--add-layers", "0", "--threads", "1", "--prepare-only",
    )
    assert rc == 0 and result.get("ok"), out[-3000:]
    log = (case / "log.gmsh_host.txt").read_text(encoding="utf-8")
    assert "regions: air " in log and " cells, aluminium_6061 " in log


def test_one_material_on_both_bodies_meshes_as_before(tmp_path: Path) -> None:
    proj = _heat_project(tmp_path, [_mat("m-air", "Air", "example_heat_fluid", ["Body1", "Body2"])])
    case = tmp_path / "case"
    rc, result, out = _generate(
        "generate_standard.py", proj, case, "--hex-core", "0", "--add-layers", "0", "--threads", "1", "--prepare-only",
    )
    assert rc == 0 and result.get("ok"), out[-3000:]
    names, _xs, _rows = _msh(case / "constant" / "triSurface" / "geometry.msh")
    assert {n for d, n in names.values() if d == 3} == {"fluid"}
    assert "2 bodies fused into 1 fluid volume(s)" in (case / "log.gmsh_host.txt").read_text(encoding="utf-8")


def test_a_body_with_no_material_is_refused_with_the_fix(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    proj = _heat_project(tmp_path, TWO)
    three = SimpleNamespace(volumes=[object(), object(), object()], mesh_triangles=None, faces=[])
    why = mesh_regions(proj, "sim_1", three)
    assert why == "Body3 has no material. In this simulation every body is meshed with its material: give it one in Materials."


def test_region_signatures_ignore_order_and_see_a_body_move() -> None:
    a = [{"name": "air", "role": "fluid", "bodies": ["Body1"]}, {"name": "al", "role": "solid", "bodies": ["Body2"]}]
    b = list(reversed(a))
    assert regions_signature(a) == regions_signature(b)
    moved = [{"name": "air", "role": "fluid", "bodies": ["Body1", "Body2"]}]
    assert regions_signature(a) != regions_signature(moved)


def test_hex_dominant_writes_a_surface_between_the_regions_and_a_point_in_each(tmp_path: Path) -> None:
    import sys

    import numpy as np

    from tests.unit.test_shared_faces import PY, _binary_stl_triangles

    sys.path.insert(0, str(PY / "tools"))
    from generate_snappy import boundary_patches

    from cfddesk.mesh.snappy_hexdominant import write_hexdominant_dicts

    proj = _heat_project(tmp_path, TWO)
    step = next((proj / "geometries").iterdir()) / "source.step"
    tri_dir = tmp_path / "tri"
    prep = boundary_patches(proj, step, tri_dir, "sim_1", mesh_id="mesh_1", add_layers=True)
    assert sorted(p["name"] for p in prep["patches"]) == ["aluminium_6061_walls", "pressure_1", "velocity_inlet_1", "walls"]
    assert [i["name"] for i in prep["interfaces"]] == ["interface_air_aluminium_6061"]
    itf = _binary_stl_triangles(tri_dir / "interface_air_aluminium_6061.stl")
    assert len(itf) and np.allclose(itf[:, :, 0], INTERFACE_X_M)
    # The patches and the interface close each region: every edge is used twice, but the
    # interface's rim, where it meets both boxes' outer faces, three times.
    tris = np.concatenate([_binary_stl_triangles(tri_dir / p["file"]) for p in prep["patches"]] + [itf])
    keys = np.round(tris.reshape(-1, 3), 9)
    _, ids = np.unique(keys, axis=0, return_inverse=True)
    ids = ids.reshape(-1, 3)
    edges = np.sort(np.concatenate([ids[:, [0, 1]], ids[:, [1, 2]], ids[:, [2, 0]]]), axis=1)
    uniq, counts = np.unique(edges, axis=0, return_counts=True)
    assert set(counts.tolist()) == {2, 3}
    pts = np.zeros((ids.max() + 1, 3))
    pts[ids.ravel()] = tris.reshape(-1, 3)
    assert np.allclose(pts[uniq[counts == 3]][:, :, 0], INTERFACE_X_M)
    # Each region's point is inside its own body.
    (air_p, air), (al_p, al) = prep["locations"]
    assert (air, al) == ("air", "aluminium_6061")
    assert air_p[0] < INTERFACE_X_M < al_p[0]
    # Boundary layers on the fluid walls only.
    assert [s.name for s in prep["layer_specs"]] == ["pressure_1", "walls"] or "aluminium_6061_walls" not in [
        s.name for s in prep["layer_specs"]
    ]
    case = tmp_path / "case"
    meta = write_hexdominant_dicts(
        case, block="(10 10 10)", feature_level=1, walls_level=1, add_layers=True, snap={},
        bounds_m={"xmin": 0, "xmax": 0.03, "ymin": 0, "ymax": 0.01, "zmin": 0, "zmax": 0.01},
        patches=prep["patches"], layer_specs=prep["layer_specs"], refine_regions=[],
        locations=prep["locations"], interfaces=prep["interfaces"],
    )
    dic = (case / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
    assert "locationsInMesh" in dic and "locationInMesh (" not in dic
    assert ") air)" in dic and ") aluminium_6061)" in dic
    assert "allowFreeStandingZoneFaces false;" in dic
    block = dic.split("interface_air_aluminium_6061\n        {", 1)[1].split("}", 1)[0]
    assert "patchInfo" not in block
    assert [r["region"] for r in meta["locationsInMesh"]] == ["air", "aluminium_6061"]


def test_a_mesh_goes_out_of_date_when_the_materials_bodies_change(tmp_path: Path) -> None:
    from cfddesk.project.scope import build_project_tree

    proj = _heat_project(tmp_path, TWO)
    mesh_dir = next((Path(find_study(proj, "sim_1")["dir"]) / "meshes").iterdir())  # type: ignore[index]
    made = [
        {"name": "air", "role": "fluid", "bodies": ["Body1"], "cells": 10},
        {"name": "aluminium_6061", "role": "solid", "bodies": ["Body2"], "cells": 5},
    ]
    (mesh_dir / "mesh.json").write_text(
        json.dumps({"live_mesh_result": {"status": "done", "n_cells": 15, "regions": made}}), encoding="utf-8"
    )

    def mesh_row() -> dict:
        return build_project_tree(proj, "proj")["geometries"][0]["studies"][0]["meshes"][0]

    assert not mesh_row().get("out_of_date")
    # Both bodies now Air: one region, not the two the mesh has.
    ww.set_materials(
        proj,
        {"simulation_id": "sim_1", "materials": [_mat("m-air", "Air", "example_heat_fluid", ["Body1", "Body2"]),
                                                  _mat("m-al", "Aluminium 6061", "example_heat_solid", [])],
         "only_ids": ["m-air", "m-al"]},
        sim_id="sim_1",
    )
    row = mesh_row()
    assert row["out_of_date"] is True and row["out_of_date_materials"] is True
