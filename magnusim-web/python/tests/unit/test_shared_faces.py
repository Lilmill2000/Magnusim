"""A face two bodies share is inside the part: no patch, meshed through, no BC.

``geometry/two-boxes-shared-face.brep``: box 1 is x 0..10 mm, box 2 x 10..30 mm,
sharing the x = 10 face (face 2@Body1 and face 7@Body2, ``test_face_visits``).
Before, every mesher got it wrong: Standard meshed the boxes as two regions with
a wall between them (gmsh's healing gave each box its own copy of the face),
cfMesh's cartesianMesh aborted on the doubled face, and Hex-dominant kept only
the box ``locationInMesh`` was in, without its outlet. ``e2e/shared-face-inside.spec.js``
meshes it for real with each of them.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from cfddesk.cad import preview, shared_faces
from cfddesk.cad.io import load_cad, read_step_shape, write_geometry
from cfddesk.cad.step import load_step
from tests.unit.test_face_visits import PY, SHARED, WEB, _patch_x

pytestmark = pytest.mark.occt

INTERFACE_X_M = 0.01


def _boxes(*corners_and_sizes, fuse: bool):
    """Boxes ``((x, y, z), (dx, dy, dz))``, General-Fused (shared faces) or just put in a compound."""
    from OCP.BRep import BRep_Builder
    from OCP.BRepAlgoAPI import BRepAlgoAPI_BuilderAlgo
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from OCP.TopoDS import TopoDS_Compound
    from OCP.TopTools import TopTools_ListOfShape

    boxes = [BRepPrimAPI_MakeBox(gp_Pnt(*p), *d).Shape() for p, d in corners_and_sizes]
    if fuse:
        args = TopTools_ListOfShape()
        for b in boxes:
            args.Append(b)
        algo = BRepAlgoAPI_BuilderAlgo()
        algo.SetArguments(args)
        algo.Build()
        assert algo.IsDone()
        return algo.Shape()
    comp = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(comp)
    for b in boxes:
        builder.Add(comp, b)
    return comp


def _shared_in_table(shape) -> dict[int, int]:
    return {f["id"]: f["shared_with"] for f in preview.face_properties(shape) if "shared_with" in f}


@pytest.fixture
def imported(tmp_path: Path) -> Path:
    step = tmp_path / "geom" / "source.step"
    write_geometry(load_cad(SHARED), step)
    return step


# ---------------------------------------------------------------- which faces


def test_face_table_marks_both_visits_of_the_shared_face(imported: Path):
    table = preview.face_properties(read_step_shape(imported))
    assert {f["id"]: f.get("shared_with") for f in table if f.get("shared_with")} == {2: 7, 7: 2}
    assert (table[1]["body"], table[6]["body"]) == (1, 2)


def test_mesher_and_face_table_agree(imported: Path):
    solid = load_step(imported)
    assert shared_faces.shared_face_ids(solid) == {1: 6, 6: 1}
    assert shared_faces.face_bodies(solid)[6] == 2


def test_step_copy_without_the_sidecar_finds_the_same_face(imported: Path):
    """The STEP copy gives each box its own copy of the face (12 distinct faces):
    it is found as two coincident faces with opposite normals."""
    imported.with_suffix(".bbrep").unlink()
    assert _shared_in_table(read_step_shape(imported)) == {2: 7, 7: 2}
    assert shared_faces.shared_face_ids(load_step(imported)) == {1: 6, 6: 1}


def test_touching_boxes_not_fused_count_as_sharing():
    """A multi-body STEP from most CAD systems: two solids touching over a whole
    face, each with its own copy of it."""
    shape = _boxes(((0, 0, 0), (10, 10, 10)), ((10, 0, 0), (20, 10, 10)), fuse=False)
    assert _shared_in_table(shape) == {2: 7, 7: 2}


@pytest.mark.parametrize(
    "boxes",
    [
        [((0, 0, 0), (10, 10, 10)), ((10.5, 0, 0), (20, 10, 10))],
        [((0, 0, 0), (10, 10, 10)), ((10, 0, 0), (20, 20, 10))],
        [((10, 0, 0), (20, 10, 10))],
    ],
    ids=["gap-between", "box-2-face-larger", "one-body"],
)
def test_no_shared_face(boxes):
    assert _shared_in_table(_boxes(*boxes, fuse=False)) == {}


def test_three_bodies_in_a_row():
    shape = _boxes(((0, 0, 0), (10, 10, 10)), ((10, 0, 0), (10, 10, 10)), ((20, 0, 0), (10, 10, 10)), fuse=True)
    shared = _shared_in_table(shape)
    assert len(shared) == 4
    table = preview.face_properties(shape)
    for a, b in shared.items():
        fa, fb = table[a - 1], table[b - 1]
        assert fa["body"] != fb["body"] and np.allclose(fa["centroid"], fb["centroid"])
        assert round(fa["centroid"][0], 6) in (10.0, 20.0)


def test_refusal_names_the_face_and_both_bodies():
    bodies = {1: 1, 6: 2}
    shared = {1: 6, 6: 1}
    msg = shared_faces.bc_refusal([("Outlet", [0]), ("velocity_inlet_1", [7, 6])], shared, bodies)
    assert msg == (
        "Face 7@Body2 is inside the part (Body1 and Body2 share it), so it can't take a "
        'boundary condition. Remove it from "velocity_inlet_1".'
    )
    # The mesh panel shows the first 160 characters of a failed mesh's error.
    assert len(msg) <= 160
    assert shared_faces.bc_refusal([("Outlet", [0])], shared, bodies) is None


def test_refinements_on_the_shared_face_are_dropped():
    from cfddesk.mesh.web_refinements import InflateRef, drop_inside_faces

    def inflate(fids):
        return InflateRef(
            name="Inflate", face_ids=list(fids), faces=[], n_layers=3, expansion=1.2, thickness_m=1e-4,
            first_layer_m=None, min_thickness_m=0.0, relative_thickness=None, gradation="normal",
        )

    sizes, mins = {1: 1e-4, 2: 2e-4}, {1: 1e-5}
    notes = [{"name": "A", "face_ids": [1]}, {"name": "B", "face_ids": [1, 2]}]
    only_inside, mixed = inflate([6]), inflate([6, 7])
    drop_inside_faces({1: 6, 6: 1}, sizes, mins, notes, [only_inside, mixed])
    assert sizes == {2: 2e-4} and mins == {}
    assert notes == [{"name": "B", "face_ids": [2]}]
    assert only_inside.face_ids == [] and "inside the part" in only_inside.skipped
    assert mixed.face_ids == [7] and mixed.skipped is None


# ---------------------------------------------------------------- the meshers


def _project(tmp: Path, inlet: str, outlet: str = "face 1@Body1") -> Path:
    """The mesh golden tests' project holding the fixture, inlet and outlet on these labels."""
    from cfddesk.project.paths import (
        create_geometry_folder,
        create_mesh_folder,
        create_study_folder,
    )

    proj = tmp / "proj"
    proj.mkdir(parents=True)
    for f in (WEB / "e2e" / "fixtures" / "sample-project-steady-state").glob("*.json"):
        shutil.copy(f, proj / f.name)
    doc = json.loads((proj / "boundary_conditions.json").read_text(encoding="utf-8"))
    doc["boundary_conditions"][0]["faces"] = [inlet]
    doc["boundary_conditions"][1]["faces"] = [outlet]
    (proj / "boundary_conditions.json").write_text(json.dumps(doc), encoding="utf-8")
    geom = create_geometry_folder(proj, {"id": "geom-e2e", "name": "two", "original_filename": SHARED.name})
    write_geometry(load_cad(SHARED), Path(geom["dir"]) / "source.step")
    create_study_folder(proj, "geom-e2e", {"id": "sim_1", "name": "Incompressible Steady-state"})
    create_mesh_folder(proj, "sim_1", {"id": "mesh_1", "name": "Mesh 1"})
    return proj


def _generate(tool: str, proj: Path, case: Path, *extra: str) -> tuple[int, dict, str]:
    env = dict(os.environ)
    env["MAGNUSIM_WSL_CASE_ROOT"] = "/home/golden/cases"
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    argv = [
        sys.executable, f"tools/{tool}", "--project-dir", str(proj), "--case-dir", str(case),
        "--wsl-case", "cfddesk-sharedface-test", "--generate-id", "sharedface", "--fineness", "1",
        "--mesh-id", "mesh_1", "--simulation-id", "sim_1", *extra,
    ]
    r = subprocess.run(argv, cwd=str(PY), env=env, capture_output=True, text=True, timeout=600)
    result = {}
    for line in r.stdout.splitlines():
        if line.startswith("MAGNUSIM_EVENT ") and '"event":"result"' in line:
            result = json.loads(line.split(" ", 1)[1])
    return r.returncode, result, r.stdout + r.stderr


def _cells_meet_across_the_interface(msh: Path) -> bool:
    """Some node on x = 10 mm belongs to cells on both sides (two walled-off regions share none)."""
    lines = msh.read_text(encoding="ascii").splitlines()
    nodes: dict[int, float] = {}
    left: set[int] = set()
    right: set[int] = set()
    i = 0
    while i < len(lines):
        tag = lines[i].strip()
        if tag == "$Nodes":
            for row in lines[i + 2 : i + 2 + int(lines[i + 1])]:
                nid, x, _y, _z = row.split()
                nodes[int(nid)] = float(x)
        elif tag == "$Elements":
            for row in lines[i + 2 : i + 2 + int(lines[i + 1])]:
                v = [int(t) for t in row.split()]
                if v[1] == 2:  # boundary triangle
                    continue
                conn = v[3 + v[2] :]
                cx = sum(nodes[n] for n in conn) / len(conn)
                on = {n for n in conn if abs(nodes[n] - INTERFACE_X_M) < 1e-9}
                (left if cx < INTERFACE_X_M else right).update(on)
        i += 1
    return len(left & right) > 0.5 * max(len(left), len(right), 1)


@pytest.mark.parametrize("hex_core", ["0", "1"])
def test_standard_meshes_through_the_shared_face(tmp_path: Path, hex_core: str):
    proj = _project(tmp_path, "face 8@Body2")
    case = tmp_path / "case"
    rc, result, out = _generate(
        "generate_standard.py", proj, case, "--hex-core", hex_core, "--add-layers", "0", "--threads", "1",
        "--prepare-only",
    )
    assert rc == 0 and result.get("ok"), out[-3000:]
    msh = case / "constant" / "triSurface" / "geometry.msh"
    patches = _patch_x(msh)
    assert set(patches) == {"velocity_inlet_1", "pressure_1", "walls"}
    assert patches["velocity_inlet_1"] == pytest.approx((0.03, 0.03))
    assert patches["pressure_1"] == pytest.approx((0.0, 0.0))
    # No boundary triangle lies on the shared face: every walls triangle is on an outer face.
    walls_on_interface = 0
    lines = msh.read_text(encoding="ascii").splitlines()
    i = lines.index("$Nodes")
    xs = {int(r.split()[0]): float(r.split()[1]) for r in lines[i + 2 : i + 2 + int(lines[i + 1])]}
    i = lines.index("$Elements")
    for row in lines[i + 2 : i + 2 + int(lines[i + 1])]:
        v = [int(t) for t in row.split()]
        if v[1] == 2 and all(abs(xs[n] - INTERFACE_X_M) < 1e-9 for n in v[3 + v[2] :]):
            walls_on_interface += 1
    assert walls_on_interface == 0
    assert _cells_meet_across_the_interface(msh)
    log = (case / "log.gmsh_host.txt").read_text(encoding="utf-8")
    assert "2 bodies fused into 1 fluid volume(s)" in log
    assert result["hex_core_applied"] is (hex_core == "1")


@pytest.mark.parametrize("tool", ["generate_standard.py", "generate_cfmesh_standard.py", "generate_snappy.py"])
def test_every_mesher_refuses_a_bc_on_the_shared_face(tmp_path: Path, tool: str):
    """Refused before anything goes to WSL, with the face, both bodies and the BC named."""
    proj = _project(tmp_path, "face 7@Body2")
    geom = next((proj / "geometries").iterdir())
    if tool == "generate_snappy.py":
        # Hex-dominant needs the part's Body1.stl (the app writes it); any surface of the part does.
        from cfddesk.cad.step import tessellate_faces
        from cfddesk.mesh.snappy_hexdominant import write_binary_stl

        pts, tris, _fids = tessellate_faces(load_step(geom / "source.step"))
        write_binary_stl(geom / "Body1.stl", pts, tris, "test")
    extra = ["--add-layers", "0"] + (["--prepare-only", "--threads", "1"] if tool == "generate_standard.py" else [])
    rc, result, out = _generate(tool, proj, tmp_path / "case", *extra)
    assert rc != 0 and result.get("ok") is False, out[-3000:]
    assert result["error"] == (
        "Face 7@Body2 is inside the part (Body1 and Body2 share it), so it can't take a "
        'boundary condition. Remove it from "velocity_inlet_1".'
    )


def test_cfmesh_surface_leaves_the_shared_face_out_and_is_closed(imported: Path, tmp_path: Path):
    sys.path.insert(0, str(PY / "tools"))
    from generate_cfmesh_standard import _add_default_walls, _apply_web_bcs

    from cfddesk.mesh.cfmesh_standard import export_multisolid_stl_ascii
    from cfddesk.mesh.web_refinements import leftover_faces
    from cfddesk.project.model import Project

    solid = load_step(imported)
    inside = shared_faces.shared_face_ids(solid)
    project = Project.from_solid(solid, scale_to_metres=0.001, units_confirmed=True)
    bcs = [
        {"name": "inlet", "bc_type": "Velocity Inlet", "value": 1, "faces": ["face 8@Body2"]},
        {"name": "outlet", "bc_type": "Pressure Outlet", "value": 0, "faces": ["face 1@Body1"]},
    ]
    project = _apply_web_bcs(project, bcs, len(solid.faces))
    project = _add_default_walls(project, leftover_faces(project, len(solid.faces), inside))
    out = tmp_path / "geometry.stl"
    counts, _merge = export_multisolid_stl_ascii(solid, project, out, max_edge_m=0.001, split_wall_faces=False)
    assert set(counts) == {"inlet", "outlet", "walls"}
    tris = _ascii_stl_triangles(out)
    assert not np.all(np.isclose(tris[:, :, 0], INTERFACE_X_M), axis=1).any()
    _assert_closed(tris)


def test_hex_dominant_patches_leave_the_shared_face_out_and_are_closed(tmp_path: Path):
    sys.path.insert(0, str(PY / "tools"))
    from generate_snappy import boundary_patches

    proj = _project(tmp_path, "face 8@Body2")
    step = next((proj / "geometries").iterdir()) / "source.step"
    tri_dir = tmp_path / "tri"
    prep = boundary_patches(proj, step, tri_dir, "sim_1", mesh_id="mesh_1")
    assert sorted(p["name"] for p in prep["patches"]) == ["pressure_1", "velocity_inlet_1", "walls"]
    tris = np.concatenate([_binary_stl_triangles(tri_dir / p["file"]) for p in prep["patches"]])
    assert not np.all(np.isclose(tris[:, :, 0], INTERFACE_X_M), axis=1).any()
    _assert_closed(tris)


def test_hex_dominant_gets_the_parts_surface_for_a_boxy_part(imported: Path, tmp_path: Path):
    """Hex-dominant's Body1.stl comes from the viewport's faces: 24 triangles for two
    boxes. It was refused under 100 triangles, so a boxy part could not be meshed."""
    out = tmp_path / "preview"
    preview.export_preview(imported, out / "cad_edges.vtp", out / "cad_faces.vtp", out / "cad_preview.json")
    stl = tmp_path / "Body1.stl"
    r = subprocess.run(
        [sys.executable, "tools/convert_step_to_stl.py", "--from-vtp", str(out / "cad_faces.vtp"), "--out", str(stl)],
        cwd=str(PY), capture_output=True, text=True, timeout=300,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    tris = _binary_stl_triangles(stl)
    assert len(tris) == 24
    assert tris[:, :, 0].min() == pytest.approx(0.0) and tris[:, :, 0].max() == pytest.approx(30.0)


def _ascii_stl_triangles(path: Path) -> np.ndarray:
    v = [[float(t) for t in ln.split()[1:4]] for ln in path.read_text(encoding="ascii").splitlines() if ln.strip().startswith("vertex")]
    return np.asarray(v, dtype=np.float64).reshape(-1, 3, 3)


def _binary_stl_triangles(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    n = int.from_bytes(raw[80:84], "little")
    rec = np.frombuffer(raw[84 : 84 + 50 * n], dtype=np.dtype([("n", "<3f4"), ("v", "<9f4"), ("a", "<u2")]))
    return rec["v"].astype(np.float64).reshape(-1, 3, 3)


def _assert_closed(tris: np.ndarray) -> None:
    """Every edge of the surface is used by exactly two triangles (no hole, no inner wall)."""
    keys = np.round(tris / 1e-9).astype(np.int64)
    edges: dict[tuple, int] = {}
    for t in keys:
        for a, b in ((0, 1), (1, 2), (2, 0)):
            e = tuple(sorted((tuple(t[a]), tuple(t[b]))))
            edges[e] = edges.get(e, 0) + 1
    counts = np.array(list(edges.values()))
    assert (counts == 2).all(), f"{(counts != 2).sum()} of {len(counts)} edges not used twice"
