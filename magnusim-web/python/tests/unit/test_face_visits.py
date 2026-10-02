"""One face numbering for the viewport, the face table, the mesher and the bodies.

Two boxes that share a face (a conformal two-body part, as a General Fuse makes it)
visit that face twice: once in each solid. The face table and the mesher always
numbered every visit, but the viewport's faceId used a de-duplicated map, so after
the shared face every viewport id named the next face along. A BC picked on the
far end of box 2 (viewport "face 7") landed on the face the two boxes share (face
7 in the mesh). ``preview.face_visits`` is now the one rule all of them use.

Fixture ``geometry/two-boxes-shared-face.brep``: box 1 is x 0..10, box 2 is x
10..30 (both 10 x 10 in y and z), sharing the x = 10 face. Face 2 is that face in
box 1 and face 7 in box 2; face 8 is box 2's far end (x = 30). Rebuild it with
``CFDDESK_UPDATE_GOLDEN=1 pytest tests/unit/test_face_visits.py``.
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

from cfddesk.cad import preview
from cfddesk.cad.io import load_cad, read_step_shape, write_geometry
from cfddesk.cad.step import load_step, volumes_from_shape
from tests.conftest import FIXTURES

pytestmark = pytest.mark.occt

PY = Path(__file__).resolve().parents[2]
WEB = PY.parent
SHARED = FIXTURES / "geometry" / "two-boxes-shared-face.brep"
# Made from SHARED by the code before the fix (preview version 7); e2e/shared-face-ids.spec.js
# puts it in a project to check that the app replaces it.
OLD_PREVIEW = WEB / "e2e" / "fixtures" / "shared-face-preview-v7"
UPDATE = os.environ.get("CFDDESK_UPDATE_GOLDEN", "").strip() in ("1", "true", "yes")


def two_boxes():
    from OCP.BRepAlgoAPI import BRepAlgoAPI_BuilderAlgo
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from OCP.TopTools import TopTools_ListOfShape

    args = TopTools_ListOfShape()
    args.Append(BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 10, 10, 10).Shape())
    args.Append(BRepPrimAPI_MakeBox(gp_Pnt(10, 0, 0), 20, 10, 10).Shape())
    fuse = BRepAlgoAPI_BuilderAlgo()
    fuse.SetArguments(args)
    fuse.Build()
    assert fuse.IsDone()
    return fuse.Shape()


def explorer_faces(shape):
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def unique_faces(shape) -> int:
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedMapOfShape

    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_FACE, m)
    return m.Extent()


@pytest.fixture
def imported(tmp_path: Path) -> Path:
    """The fixture imported the way the app stores it: source.step plus its binary sidecar."""
    step = tmp_path / "geom" / "source.step"
    write_geometry(load_cad(SHARED), step)
    return step


def test_fixture_is_two_boxes_sharing_a_face(tmp_path: Path):
    if UPDATE:
        from OCP.BRepTools import BRepTools

        out = tmp_path / "two.brep"
        assert BRepTools.Write_s(two_boxes(), str(out))
        SHARED.write_bytes(out.read_bytes().replace(b"\r\n", b"\n"))
    shape = load_cad(SHARED).shape
    assert len(explorer_faces(shape)) == 12
    assert unique_faces(shape) == 11
    # The import keeps the sharing (the binary sidecar is what the app reads).
    step = tmp_path / "geom" / "source.step"
    write_geometry(load_cad(SHARED), step)
    assert unique_faces(read_step_shape(step)) == 11


def test_face_visits_counts_every_visit_with_its_body(imported: Path):
    shape = read_step_shape(imported)
    visits = preview.face_visits(shape)
    flat = explorer_faces(shape)
    assert [i for i, _b, _f in visits] == list(range(1, 13))
    # Same faces in the same order as the plain explorer walk the face table always used.
    assert all(f.IsEqual(g) for (_i, _b, f), g in zip(visits, flat, strict=True))
    assert [b for _i, b, _f in visits] == [1] * 6 + [2] * 6
    shared = visits[1][2]
    assert visits[6][2].IsSame(shared)
    assert [i for i, _b, f in visits if f.IsSame(shared)] == [2, 7]


def test_viewport_face_table_mesher_and_bodies_agree(imported: Path, tmp_path: Path):
    """Each viewport faceId/solidId is the face table entry and the mesher record of that number."""
    import pyvista as pv

    out = tmp_path / "preview"
    meta = preview.export_preview(
        imported, out / "cad_edges.vtp", out / "cad_faces.vtp", out / "cad_preview.json",
        shape=read_step_shape(imported),
    )
    assert meta["preview_version"] == preview.PREVIEW_VERSION == 8
    assert meta["n_faces"] == 12 and meta["n_solids"] == 2
    table = meta["faces"]
    assert [f["id"] for f in table] == list(range(1, 13))
    assert [f["body"] for f in table] == [1] * 6 + [2] * 6

    vtp = pv.read(out / "cad_faces.vtp")
    face_id = np.asarray(vtp.cell_data["faceId"])
    solid_id = np.asarray(vtp.cell_data["solidId"])
    centres = np.asarray(vtp.cell_centers().points)
    areas = np.asarray(vtp.compute_cell_sizes(length=False, volume=False).cell_data["Area"])
    solid = load_step(imported)
    assert len(solid.faces) == 12
    for f in table:
        cells = face_id == f["id"]
        assert cells.any(), f"face {f['id']} is not in the viewport"
        drawn = (centres[cells] * areas[cells, None]).sum(axis=0) / areas[cells].sum()
        assert np.allclose(drawn, f["centroid"], atol=1e-6), (f["id"], drawn, f["centroid"])
        assert set(solid_id[cells].tolist()) == {f["body"]}
        rec = solid.faces[f["id"] - 1]
        assert rec.face_id == f["id"] - 1
        assert np.allclose(rec.centroid, f["centroid"]) and rec.area == pytest.approx(f["area"])
    far_end = next(f for f in table if np.allclose(f["centroid"], [30, 5, 5]))
    assert (far_end["id"], far_end["body"]) == (8, 2)

    # Each body lists its own visit of the shared face (0-based face ids).
    assert [(v.volume_id, v.face_ids) for v in solid.volumes] == [
        ("solid-0", tuple(range(0, 6))),
        ("solid-1", tuple(range(6, 12))),
    ]
    assert solid.volume_for_face(6) == "solid-1"
    assert [v.face_ids for v in volumes_from_shape(two_boxes())] == [tuple(range(0, 6)), tuple(range(6, 12))]


def test_numbers_survive_the_step_copy(imported: Path):
    """The STEP copy does not share the face (12 distinct faces), the sidecar does (11).
    Counting every visit gives both the same numbers; a de-duplicated count would not."""
    sidecar = preview.face_properties(read_step_shape(imported))
    imported.with_suffix(".bbrep").unlink()
    step_only = read_step_shape(imported)
    assert unique_faces(step_only) == 12
    from_step = preview.face_properties(step_only)
    assert [(f["id"], f.get("body")) for f in from_step] == [(f["id"], f.get("body")) for f in sidecar]
    for a, b in zip(from_step, sidecar, strict=True):
        assert np.allclose(a["centroid"], b["centroid"], atol=1e-9)


def test_face_outside_every_solid_has_no_body():
    """A compound of box 1, a loose face, box 2: the loose face keeps its place in the
    numbering and gets no body; each box's faces get their own body."""
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
    from OCP.TopoDS import TopoDS_Compound

    builder = BRep_Builder()
    comp = TopoDS_Compound()
    builder.MakeCompound(comp)
    builder.Add(comp, BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 1, 1, 1).Shape())
    builder.Add(comp, BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0, 0, 5), gp_Dir(0, 0, 1)), 0, 1, 0, 1).Face())
    builder.Add(comp, BRepPrimAPI_MakeBox(gp_Pnt(3, 0, 0), 1, 1, 1).Shape())
    visits = preview.face_visits(comp)
    assert [b for _i, b, _f in visits] == [1] * 6 + [None] + [2] * 6
    assert all(f.IsEqual(g) for (_i, _b, f), g in zip(visits, explorer_faces(comp), strict=True))
    table = preview.face_properties(comp)
    assert "body" not in table[6] and table[7]["body"] == 2
    assert [v.face_ids for v in volumes_from_shape(comp)] == [tuple(range(0, 6)), tuple(range(7, 13))]


def _prepare_standard(tmp: Path, step_src: Path, inlet: str, outlet: str) -> Path:
    """``generate_standard.py --prepare-only`` on a project holding ``step_src`` (the
    mesh golden tests' project), with the inlet and outlet BCs on these face labels.
    Returns the gmsh mesh the mesher wrote."""
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
    geom = create_geometry_folder(proj, {"id": "geom-e2e", "name": "two", "original_filename": step_src.name})
    write_geometry(load_cad(step_src), Path(geom["dir"]) / "source.step")
    create_study_folder(proj, "geom-e2e", {"id": "sim_1", "name": "Incompressible Steady-state"})
    create_mesh_folder(proj, "sim_1", {"id": "mesh_1", "name": "Mesh 1"})
    case = tmp / "case"
    env = dict(os.environ)
    env["MAGNUSIM_WSL_CASE_ROOT"] = "/home/golden/cases"
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    argv = [
        sys.executable, "tools/generate_standard.py", "--project-dir", str(proj), "--case-dir", str(case),
        "--wsl-case", "cfddesk-faceids-test", "--generate-id", "faceids", "--fineness", "1",
        "--hex-core", "0", "--add-layers", "0", "--threads", "1",
        "--mesh-id", "mesh_1", "--simulation-id", "sim_1", "--prepare-only",
    ]
    r = subprocess.run(argv, cwd=str(PY), env=env, capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    return case / "constant" / "triSurface" / "geometry.msh"


def _patch_x(msh: Path) -> dict[str, tuple[float, float]]:
    """x range of each named surface patch in an ASCII MSH 2.2 file."""
    lines = msh.read_text(encoding="ascii").splitlines()
    names: dict[int, str] = {}
    nodes: dict[int, float] = {}
    out: dict[str, list[float]] = {}
    i = 0
    while i < len(lines):
        tag = lines[i].strip()
        if tag == "$PhysicalNames":
            for row in lines[i + 2 : i + 2 + int(lines[i + 1])]:
                dim, num, name = row.split(maxsplit=2)
                if dim == "2":
                    names[int(num)] = name.strip('"')
        elif tag == "$Nodes":
            for row in lines[i + 2 : i + 2 + int(lines[i + 1])]:
                nid, x, _y, _z = row.split()
                nodes[int(nid)] = float(x)
        elif tag == "$Elements":
            for row in lines[i + 2 : i + 2 + int(lines[i + 1])]:
                v = [int(t) for t in row.split()]
                if v[1] in (2, 3) and v[3] in names:
                    out.setdefault(names[v[3]], []).extend(nodes[n] for n in v[3 + v[2] :])
        i += 1
    return {k: (min(v), max(v)) for k, v in out.items()}


def test_the_mesher_puts_a_bc_on_the_face_the_viewport_names(tmp_path: Path):
    """The inlet goes on the label the viewport gives box 2's far end; the mesh puts it at x = 30 mm."""
    import pyvista as pv

    out = tmp_path / "preview"
    step = tmp_path / "geom" / "source.step"
    write_geometry(load_cad(SHARED), step)
    preview.export_preview(step, out / "cad_edges.vtp", out / "cad_faces.vtp", out / "cad_preview.json")
    vtp = pv.read(out / "cad_faces.vtp")
    at_far_end = np.isclose(np.asarray(vtp.cell_centers().points)[:, 0], 30.0)
    (fid,) = set(np.asarray(vtp.cell_data["faceId"])[at_far_end].tolist())
    (sid,) = set(np.asarray(vtp.cell_data["solidId"])[at_far_end].tolist())
    picked = f"face {fid}@Body{sid}"
    assert picked == "face 8@Body2"

    patches = _patch_x(_prepare_standard(tmp_path / "mesh", SHARED, picked, "face 1@Body1"))
    assert patches["velocity_inlet_1"] == pytest.approx((0.03, 0.03))
    assert patches["pressure_1"] == pytest.approx((0.0, 0.0))


def test_old_preview_fixture_has_the_old_viewport_ids():
    """The version 7 preview the e2e upgrades really has the bug: box 2's far end is
    viewport face 7, and the face table's face 7 is the shared face at x = 10."""
    import pyvista as pv

    meta = json.loads((OLD_PREVIEW / "cad_preview.json").read_text(encoding="utf-8"))
    assert meta["preview_version"] == 7
    vtp = pv.read(OLD_PREVIEW / "cad_faces.vtp")
    at_far_end = np.isclose(np.asarray(vtp.cell_centers().points)[:, 0], 30.0)
    assert set(np.asarray(vtp.cell_data["faceId"])[at_far_end].tolist()) == {7}
    assert meta["faces"][6]["centroid"] == pytest.approx([10, 5, 5])
    assert max(np.asarray(vtp.cell_data["faceId"]).tolist()) == 11
