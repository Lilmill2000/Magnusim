"""One cell across (2D), Hex-dominant's setting (validation gap G5): when a part can be
meshed so and why not (cfddesk.mesh.two_d.plan_two_d), the dictionaries that make the 2D
mesh, and what generate_snappy.py writes or refuses with. The WSL meshing is tested by
bundled-plugins/incompressible_flow/e2e/one-cell-across.spec.js.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from cfddesk.cad.step import load_step
from cfddesk.mesh import two_d
from cfddesk.mesh.snappy_hexdominant import base_cell_size, write_hexdominant_dicts

pytestmark = pytest.mark.occt

PY = Path(__file__).resolve().parents[2]
WEB = PY.parent


def _write_step(shape, path: Path) -> Path:
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    w = STEPControl_Writer()
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    w.Transfer(shape, STEPControl_AsIs)
    assert int(w.Write(str(path))) == 1
    return path


def _box(x, y, z, dx, dy, dz):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape()


def _cylinder(p, d, r, h):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(*p), gp_Dir(*d)), r, h).Shape()


def _cut(a, b):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut

    return BRepAlgoAPI_Cut(a, b).Shape()


@pytest.fixture(scope="module")
def slab(tmp_path_factory) -> Path:
    """A channel 100 x 50 mm, 10 mm deep along z, with a 10 mm hole through it: a slab."""
    path = tmp_path_factory.mktemp("slab") / "slab.step"
    return _write_step(_cut(_box(0, 0, 0, 100, 50, 10), _cylinder((30, 25, -1), (0, 0, 1), 5, 12)), path)


@pytest.fixture(scope="module")
def blind(tmp_path_factory) -> Path:
    """The same channel with a hole only halfway through: not the same at every depth."""
    path = tmp_path_factory.mktemp("blind") / "blind.step"
    return _write_step(_cut(_box(0, 0, 0, 100, 50, 10), _cylinder((30, 25, -1), (0, 0, 1), 5, 6)), path)


@pytest.fixture(scope="module")
def rod(tmp_path_factory) -> Path:
    """A round bar along y: its one side face is curved, its two ends flat."""
    path = tmp_path_factory.mktemp("rod") / "rod.step"
    return _write_step(_cylinder((0, 0, 0), (0, 1, 0), 10, 30), path)


def _faces(solid) -> dict[str, list[int]]:
    """The slab's faces by where they are: front (z = 0), back (z = 10), in (x = 0), out (x = 100), rest."""
    out: dict[str, list[int]] = {"front": [], "back": [], "in": [], "out": [], "rest": []}
    for r in solid.faces:
        x, _y, z = r.centroid
        key = "front" if abs(z) < 1e-6 else "back" if abs(z - 10) < 1e-6 else "in" if abs(x) < 1e-6 else "out" if abs(x - 100) < 1e-6 else "rest"
        out[key].append(int(r.face_id))
    return out


def _patches(faces: dict[str, list[int]], names: dict[str, str]) -> dict[int, str]:
    return {f: names.get(k, "walls") for k, ids in faces.items() for f in ids}


def _bcs(faces, **kinds: tuple[str, bool]) -> list[two_d.BcFaces]:
    """BCs by face group: ``front=("Sides", True)`` is a Symmetry named Sides on the front."""
    by_name: dict[tuple[str, bool], list[int]] = {}
    for key, (name, sym) in kinds.items():
        by_name.setdefault((name, sym), []).extend(faces[key])
    return [two_d.BcFaces(n, s, tuple(ids)) for (n, s), ids in by_name.items()]


# ---------------------------------------------------------------- the rule


def test_a_slab_with_symmetry_on_both_ends_is_meshed_one_cell_across(slab: Path):
    solid = load_step(slab)
    f = _faces(solid)
    plan = two_d.plan_two_d(
        solid,
        0.001,
        _bcs(f, front=("Sides", True), back=("Sides", True), **{"in": ("Inlet", False), "out": ("Outlet", False)}),
        _patches(f, {"front": "sides", "back": "sides", "in": "inlet", "out": "outlet"}),
    )
    assert isinstance(plan, two_d.TwoDPlan), plan
    assert (plan.axis, plan.lo_m, plan.hi_m) == (2, 0.0, pytest.approx(0.01))
    assert plan.front_faces == tuple(f["front"]) and plan.back_faces == tuple(f["back"])
    s = plan.summary()
    assert s["axis"] == "z" and s["depth_m"] == pytest.approx(0.01) and s["cells_across"] == 1
    assert s["front"] == {"faces": [f"Face {f['front'][0] + 1}@Body1"], "bc": "Sides", "patch": "sides"}
    assert s["back"]["bc"] == "Sides"


def test_no_symmetry_says_so(slab: Path):
    solid = load_step(slab)
    f = _faces(solid)
    reason = two_d.plan_two_d(solid, 0.001, _bcs(f, front=("Walls", False)), _patches(f, {}))
    assert reason == "No boundary condition is a Symmetry. Put one Symmetry on the two parallel flat faces at the part's ends (its front and back)."


def test_one_end_without_a_bc_names_that_face(slab: Path):
    solid = load_step(slab)
    f = _faces(solid)
    reason = two_d.plan_two_d(solid, 0.001, _bcs(f, front=("Sides", True)), _patches(f, {"front": "sides"}))
    assert reason == f"Face {f['back'][0] + 1}@Body1, at the part's end along z, has no boundary condition: both end faces need a Symmetry."


def test_one_end_with_another_bc_names_it(slab: Path):
    solid = load_step(slab)
    f = _faces(solid)
    reason = two_d.plan_two_d(solid, 0.001, _bcs(f, front=("Sides", True), back=("Outlet", False)), _patches(f, {"front": "sides", "back": "outlet"}))
    assert reason == f'Face {f["back"][0] + 1}@Body1, at the part\'s end along z, has "Outlet", not a Symmetry: both end faces need a Symmetry.'


def test_a_part_that_changes_with_depth_is_refused(blind: Path):
    """The hole's floor is flat across z inside the part: not a straight extrusion."""
    solid = load_step(blind)
    floor = next(
        r.face_id
        for r in solid.faces
        if r.surface_type == "Plane" and np.allclose(r.centroid, (30, 25, 5), atol=1e-6)
    )
    ends = {"front": [], "back": []}
    for r in solid.faces:
        if abs(r.centroid[2] - 10) < 1e-6:
            ends["back"].append(r.face_id)
        elif abs(r.centroid[2]) < 1e-6:
            ends["front"].append(r.face_id)
    bcs = [two_d.BcFaces("Sides", True, tuple(ends["front"] + ends["back"]))]
    reason = two_d.plan_two_d(solid, 0.001, bcs, {f: "sides" for f in ends["front"] + ends["back"]})
    assert reason == f"The part is not a straight extrusion between its two end faces along z: Face {floor + 1}@Body1 is neither on an end nor parallel to z."


def test_a_curved_side_parallel_to_the_axis_is_a_slab(rod: Path):
    solid = load_step(rod)
    discs = [r.face_id for r in solid.faces if r.surface_type == "Plane"]
    plan = two_d.plan_two_d(solid, 0.001, [two_d.BcFaces("Ends", True, tuple(discs))], {f: "ends" for f in discs})
    assert isinstance(plan, two_d.TwoDPlan), plan
    assert plan.axis == 1 and plan.depth_m == pytest.approx(0.03)


def test_two_symmetry_bcs_one_per_end_keep_their_patches(slab: Path):
    solid = load_step(slab)
    f = _faces(solid)
    plan = two_d.plan_two_d(solid, 0.001, _bcs(f, front=("Front", True), back=("Back", True)), _patches(f, {"front": "front", "back": "back"}))
    assert isinstance(plan, two_d.TwoDPlan), plan
    assert (plan.front_patch, plan.back_patch, plan.front_bc, plan.back_bc) == ("front", "back", "Front", "Back")


def test_a_box_picks_the_axis_whose_ends_are_symmetry(tmp_path: Path):
    """A box is a straight extrusion along x, y and z: the Symmetry ends choose; with every face
    a Symmetry the thinnest depth is the slab's."""
    solid = load_step(_write_step(_box(0, 0, 0, 40, 30, 20), tmp_path / "box.step"))
    ys = [r.face_id for r in solid.faces if r.surface_type == "Plane" and (abs(r.centroid[1]) < 1e-6 or abs(r.centroid[1] - 30) < 1e-6)]
    plan = two_d.plan_two_d(solid, 0.001, [two_d.BcFaces("Sym", True, tuple(ys))], {f: "sym" for f in ys})
    assert isinstance(plan, two_d.TwoDPlan) and plan.axis == 1
    every = [r.face_id for r in solid.faces]
    plan = two_d.plan_two_d(solid, 0.001, [two_d.BcFaces("Sym", True, tuple(every))], {f: "sym" for f in every})
    assert isinstance(plan, two_d.TwoDPlan) and plan.axis == 2 and plan.depth_m == pytest.approx(0.02)


def test_a_part_of_two_bodies_is_refused(tmp_path: Path):
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    comp = TopoDS_Compound()
    b = BRep_Builder()
    b.MakeCompound(comp)
    b.Add(comp, _box(0, 0, 0, 10, 10, 10))
    b.Add(comp, _box(20, 0, 0, 10, 10, 10))
    solid = load_step(_write_step(comp, tmp_path / "two.step"))
    reason = two_d.plan_two_d(solid, 0.001, [two_d.BcFaces("Sym", True, (0,))], {})
    assert reason == "The part has 2 bodies: one cell across meshes a part of one body."


def test_refusal_words():
    assert two_d.refusal_words("No boundary condition is a Symmetry.") == (
        "One cell across (2D) can't mesh this part: No boundary condition is a Symmetry. Or turn One cell across off."
    )


# ---------------------------------------------------------------- the dictionaries


BOUNDS = {"xmin": 0.0, "xmax": 0.1, "ymin": 0.0, "ymax": 0.05, "zmin": 0.0, "zmax": 0.01}


@pytest.mark.parametrize(
    ("axis", "front", "back"),
    [(0, "(0 4 7 3)", "(2 6 5 1)"), (1, "(1 5 4 0)", "(3 7 6 2)"), (2, "(0 3 2 1)", "(4 5 6 7)")],
)
def test_the_background_is_one_cell_of_the_depth_with_its_ends_as_patches(axis, front, back):
    """The part: 100 mm across in the section, 50 mm deep along ``axis``."""
    bounds = {f"{c}{e}": (0.0 if e == "min" else 0.05 if k == axis else 0.1) for k, c in enumerate("xyz") for e in ("min", "max")}
    base = 0.1 * math.sqrt(2) / 50
    verts, got, boundary = two_d.background(bounds, base, axis, 0.0, 0.05, 1.33)
    assert [int(x) for x in got.strip("()").split()] == [1 if k == axis else round(0.1 * 1.33 / base) for k in range(3)]
    lo = [v[axis] for v in verts]
    assert sorted(set(lo)) == [0.0, 0.05]
    assert f"{two_d.FRONT}\n    {{\n        type patch;\n        faces ({front});" in boundary
    assert f"{two_d.BACK}\n    {{\n        type patch;\n        faces ({back});" in boundary
    # The named ends are the block's faces at the low and the high end.
    idx_lo = [int(i) for i in front.strip("()").split()]
    idx_hi = [int(i) for i in back.strip("()").split()]
    assert {verts[i][axis] for i in idx_lo} == {0.0} and {verts[i][axis] for i in idx_hi} == {0.05}


def test_the_section_sets_the_background_cell():
    """The depth is left out of the diagonal: a deep slab meshes its section as a thin one does."""
    deep = {**BOUNDS, "zmax": 1.0}
    assert base_cell_size(5, BOUNDS, two_d_axis=2) == pytest.approx(base_cell_size(5, deep, two_d_axis=2))
    assert base_cell_size(5, BOUNDS, two_d_axis=2) == pytest.approx(math.hypot(0.1, 0.05) / (16 * 2 ** (4 / 3)))
    assert base_cell_size(5, deep) > base_cell_size(5, deep, two_d_axis=2)


def test_the_sides_are_stretched_past_both_ends():
    pts = np.array([[1.0, 2.0, 0.0], [1.0, 2.0, 0.01], [3.0, 4.0, 0.005]])
    out = two_d.stretched(pts, 2, 0.0, 0.01)
    assert out[:, :2].tolist() == pts[:, :2].tolist()
    assert out[:, 2].tolist() == pytest.approx([-0.01, 0.02, 0.005])
    assert pts[0, 2] == 0.0  # the input is left as it was


def test_extrude_and_create_patch_dictionaries():
    ext = two_d.extrude_mesh_dict(0.01)
    for line in (
        "constructFrom   patch;",
        f'sourceCase      "$FOAM_CASE/{two_d.SLAB_CASE}";',
        f"sourcePatches   ({two_d.FRONT});",
        f"exposedPatchName {two_d.BACK};",
        "flipNormals     true;",
        "extrudeModel    plane;",
        "nLayers         1;",
        "linearNormalCoeffs { thickness 0.01; }",
        "mergeFaces      false;",
    ):
        assert line in ext
    one = two_d.create_patch_dict("sides", "sides")
    assert "pointSync false;" in one and one.count("constructFrom patches;") == 1
    assert f"name sides;\n        patchInfo {{ type patch; }}\n        constructFrom patches;\n        patches ({two_d.FRONT} {two_d.BACK});" in one
    two = two_d.create_patch_dict("front", "back")
    assert two.count("constructFrom patches;") == 2
    assert "name front;" in two and f"patches ({two_d.FRONT});" in two and "name back;" in two and f"patches ({two_d.BACK});" in two


def test_write_dicts_one_cell_across(tmp_path: Path):
    patches = [{"name": "walls", "type": "wall", "file": "patch_walls.stl"}, {"name": "inlet", "type": "patch", "file": "patch_inlet.stl"}]
    base = base_cell_size(5, BOUNDS, two_d_axis=2)
    meta = write_hexdominant_dicts(
        tmp_path,
        block="(8 8 12)",
        feature_level=3,
        walls_level=2,
        add_layers=False,
        snap={},
        bounds_m=BOUNDS,
        patches=patches,
        location_m=(0.07, 0.025, 0.005),
        two_d={"axis": 2, "lo_m": 0.0, "hi_m": 0.01, "base_m": base, "front_patch": "sides", "back_patch": "sides"},
    )
    bm = (tmp_path / "system" / "blockMeshDict").read_text(encoding="utf-8")
    assert "hex (0 1 2 3 4 5 6 7) (48 24 1) simpleGrading (1 1 1)" in bm
    assert f"    {two_d.FRONT}\n    {{\n        type patch;\n        faces ((0 3 2 1));" in bm
    snap = (tmp_path / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
    assert "    handleSnapProblems false;" in snap
    # The feature edges reach past the block's ends: refined by distance (two feature-level cells).
    assert f"            levels (({2 * base / 8:.6g} 3));" in snap and "            level 3;" not in snap
    assert "locationInMesh (0.07000000 0.02500000 0.00371900);" in snap
    # The ends are the block's own patches, not surfaces.
    assert two_d.FRONT not in snap and two_d.BACK not in snap
    assert (tmp_path / "system" / "extrudeMeshDict").read_text(encoding="utf-8") == two_d.extrude_mesh_dict(0.01)
    assert (tmp_path / "system" / "createPatchDict").read_text(encoding="utf-8") == two_d.create_patch_dict("sides", "sides")
    assert meta["block"] == "(48 24 1)"
    assert meta["two_d"]["front_patch"] == "sides" and meta["two_d"]["base_m"] == pytest.approx(base)


def test_write_dicts_without_it_are_as_before(tmp_path: Path):
    write_hexdominant_dicts(tmp_path, block="(8 8 12)", feature_level=3, walls_level=2, add_layers=False, snap={}, bounds_m=BOUNDS)
    snap = (tmp_path / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
    assert "handleSnapProblems" not in snap
    assert "            level 3;" in snap and "levels ((" not in snap
    assert "boundary\n(\n);" in (tmp_path / "system" / "blockMeshDict").read_text(encoding="utf-8")
    assert not (tmp_path / "system" / "extrudeMeshDict").exists()


def test_the_script_makes_the_2d_mesh_only_when_asked():
    sh = (PY / "cfddesk" / "wsl" / "templates" / "snappy_hexdominant.sh").read_bytes()
    assert b"\r\n" not in sh
    text = sh.decode("utf-8")
    assert 'if [ "${EC:-1}" -eq 0 ] && [ -f system/extrudeMeshDict ]; then' in text
    i = text.index("openfoam2606 extrudeMesh")
    assert text.index("mv constant/polyMesh mgf3d/constant/") < i < text.index("openfoam2606 checkMesh > log.checkMesh") < text.index("openfoam2606 createPatch -overwrite")
    assert "log.extrudeMesh log.createPatch log.checkMesh" in text


# ---------------------------------------------------------------- the generator


def _project(tmp: Path, step: Path, bcs: list[dict]) -> Path:
    from cfddesk.cad.io import load_cad, write_geometry
    from cfddesk.cad.step import tessellate_faces
    from cfddesk.mesh.snappy_hexdominant import write_binary_stl
    from cfddesk.project.paths import (
        create_geometry_folder,
        create_mesh_folder,
        create_study_folder,
    )

    proj = tmp / "proj"
    proj.mkdir(parents=True)
    for f in (WEB / "e2e" / "fixtures" / "sample-project-steady-state").glob("*.json"):
        shutil.copy(f, proj / f.name)
    (proj / "boundary_conditions.json").write_text(
        json.dumps({"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{**b, "simulation_id": "sim_1"} for b in bcs]}), encoding="utf-8"
    )
    geom = create_geometry_folder(proj, {"id": "geom-2d", "name": "slab", "original_filename": step.name})
    write_geometry(load_cad(step), Path(geom["dir"]) / "source.step")
    pts, tris, _fids = tessellate_faces(load_step(Path(geom["dir"]) / "source.step"))
    write_binary_stl(Path(geom["dir"]) / "Body1.stl", pts, tris, "test")
    create_study_folder(proj, "geom-2d", {"id": "sim_1", "name": "Incompressible Steady-state"})
    create_mesh_folder(proj, "sim_1", {"id": "mesh_1", "name": "Mesh 1"})
    return proj


def _labels(step: Path) -> dict[str, list[str]]:
    return {k: [f"face {f + 1}@Body1" for f in ids] for k, ids in _faces(load_step(step)).items()}


def _generate(proj: Path, case: Path, *extra: str) -> tuple[int, dict, str]:
    env = dict(os.environ)
    env["MAGNUSIM_WSL_CASE_ROOT"] = "/home/golden/cases"
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    argv = [
        sys.executable, "tools/generate_snappy.py", "--project-dir", str(proj), "--case-dir", str(case),
        "--wsl-case", "cfddesk-twod-test", "--generate-id", "twod", "--fineness", "3", "--add-layers", "0",
        "--mesh-id", "mesh_1", "--simulation-id", "sim_1", "--render-only", *extra,
    ]
    r = subprocess.run(argv, cwd=str(PY), env=env, capture_output=True, text=True, timeout=600)
    result: dict = {}
    for line in r.stdout.splitlines():
        if line.startswith("MAGNUSIM_EVENT ") and '"event":"result"' in line:
            result = json.loads(line.split(" ", 1)[1])
    return r.returncode, result, r.stdout + r.stderr


def _slab_bcs(lab: dict[str, list[str]], back: dict | None = None) -> list[dict]:
    return [
        {"name": "Sides", "bc_type": "Symmetry", "faces": lab["front"] + ([] if back else lab["back"])},
        *([back] if back else []),
        {"name": "Inlet", "bc_type": "Velocity Inlet", "velocity_type": "Fixed", "value": 1.0, "unit": "m/s", "direction": "normal", "faces": lab["in"]},
        {"name": "Outlet", "bc_type": "Pressure Outlet", "value": 0, "unit": "Pa", "faces": lab["out"]},
    ]


def test_generate_writes_the_2d_case(slab: Path, tmp_path: Path):
    lab = _labels(slab)
    proj = _project(tmp_path, slab, _slab_bcs(lab))
    case = tmp_path / "case"
    rc, result, out = _generate(proj, case, "--one-cell-across", "1")
    assert rc == 0 and result.get("ok") is True, out[-3000:]
    assert result["block"].endswith(" 1)")
    meta = json.loads((case / "w23-geometry-meta.json").read_text(encoding="utf-8"))
    assert meta["two_d"]["front"] == {"faces": [lab["front"][0].replace("face", "Face")], "bc": "Sides", "patch": "sides"}
    assert meta["two_d"]["depth_m"] == pytest.approx(0.01)
    assert (case / "system" / "extrudeMeshDict").is_file()
    assert "patches (magnusim_2d_front magnusim_2d_back);" in (case / "system" / "createPatchDict").read_text(encoding="utf-8")
    tri = case / "constant" / "triSurface"
    # The side faces only, stretched past both ends; the ends are the block's patches.
    names = sorted(p.name for p in tri.glob("patch_*.stl"))
    assert names == ["patch_inlet.stl", "patch_outlet.stl", "patch_walls.stl"]
    from tests.unit.test_shared_faces import _binary_stl_triangles

    z = np.concatenate([_binary_stl_triangles(tri / n)[:, :, 2].ravel() for n in names])
    assert z.min() == pytest.approx(-0.01, abs=1e-7) and z.max() == pytest.approx(0.02, abs=1e-7)
    body = _binary_stl_triangles(tri / "Body1.stl")
    assert not np.all(np.isclose(body[:, :, 2], 0.0), axis=1).any()  # no end-face triangle


def test_generate_without_it_meshes_the_ends_as_before(slab: Path, tmp_path: Path):
    lab = _labels(slab)
    proj = _project(tmp_path, slab, _slab_bcs(lab))
    case = tmp_path / "case"
    rc, result, out = _generate(proj, case)
    assert rc == 0 and result.get("ok") is True, out[-3000:]
    assert "two_d" not in json.loads((case / "w23-geometry-meta.json").read_text(encoding="utf-8"))
    assert (case / "constant" / "triSurface" / "patch_sides.stl").is_file()
    assert not (case / "system" / "extrudeMeshDict").exists()


def test_generate_refuses_a_part_it_cant_mesh_so(slab: Path, tmp_path: Path):
    lab = _labels(slab)
    outlet = {"name": "Back", "bc_type": "Pressure Outlet", "value": 0, "unit": "Pa", "faces": lab["back"]}
    proj = _project(tmp_path, slab, _slab_bcs(lab, back=outlet))
    rc, result, out = _generate(proj, tmp_path / "case", "--one-cell-across", "1")
    assert rc != 0 and result.get("ok") is False, out[-3000:]
    face = lab["back"][0].replace("face", "Face")
    assert result["error"] == (
        f'One cell across (2D) can\'t mesh this part: {face}, at the part\'s end along z, has "Back", not a Symmetry: '
        "both end faces need a Symmetry. Or turn One cell across off."
    )


def test_the_check_tool_answers_as_generate_plans(slab: Path, tmp_path: Path):
    lab = _labels(slab)
    proj = _project(tmp_path, slab, _slab_bcs(lab))
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    r = subprocess.run(
        [sys.executable, "tools/mesh_two_d.py", "--project-dir", str(proj), "--simulation-id", "sim_1"],
        cwd=str(PY), env=env, capture_output=True, text=True, timeout=300,
    )
    answer = json.loads(r.stdout.strip().splitlines()[-1])
    assert answer["ok"] is True and answer["available"] is True, r.stdout + r.stderr
    assert answer["two_d"]["axis"] == "z" and answer["two_d"]["cells_across"] == 1
    assert answer["two_d"]["back"]["bc"] == "Sides"
    # No Symmetry: the reason.
    (proj / "boundary_conditions.json").write_text(
        json.dumps({"boundary_conditions": [{"name": "Inlet", "bc_type": "Velocity Inlet", "value": 1.0, "faces": lab["in"], "simulation_id": "sim_1"}]}),
        encoding="utf-8",
    )
    r = subprocess.run(
        [sys.executable, "tools/mesh_two_d.py", "--project-dir", str(proj), "--simulation-id", "sim_1"],
        cwd=str(PY), env=env, capture_output=True, text=True, timeout=300,
    )
    answer = json.loads(r.stdout.strip().splitlines()[-1])
    assert answer == {
        "ok": True,
        "available": False,
        "reason": "No boundary condition is a Symmetry. Put one Symmetry on the two parallel flat faces at the part's ends (its front and back).",
    }


# ---------------------------------------------------------------- the mesh's facts


def test_the_facts_say_the_mesh_is_2d(tmp_path: Path):
    """The facts of a 2D Hex-dominant mesh: one cell across, its axis, depth and ends; the
    quality is checkMesh's on the 2D mesh (a real v2606 report of the slab with layers), and
    the surface cell is the section's background cell over 2^level."""
    from magnusim_sdk.mesh_facts import build_mesh_facts

    case = tmp_path
    (case / "log.checkMesh").write_bytes((PY / "tests" / "fixtures" / "mesh-facts" / "checkmesh" / "one-cell-across-2d.log").read_bytes())
    base = base_cell_size(5, BOUNDS, two_d_axis=2)
    front = {"faces": ["Face 5@Body1"], "bc": "Sides", "patch": "sides"}
    meta = {"walls_level": 2, "bounds_m": BOUNDS, "two_d": {"axis": 2, "depth_m": 0.01, "base_m": base, "front": front, "back": {**front, "faces": ["Face 3@Body1"]}}}
    (case / "w23-geometry-meta.json").write_text(json.dumps(meta), encoding="utf-8")
    facts = build_mesh_facts(case)
    assert facts["mesher"] == "hexdominant"
    assert facts["two_d"] == {"axis": "z", "depth_m": 0.01, "cells_across": 1, "front": front, "back": {**front, "faces": ["Face 3@Body1"]}}
    assert facts["surface_cell_m"] == pytest.approx(base / 4, rel=1e-3)
    q = facts["quality"]
    assert q["ok"] is True and q["n_failed"] == 0 and q["max_aspect_ratio"] == pytest.approx(3.91752)
    assert facts["n_cells"] == 2732
    assert facts["bbox_m"]["size"] == [0.1, 0.05, 0.01]


def test_a_3d_mesh_has_no_2d_facts(tmp_path: Path):
    from magnusim_sdk.mesh_facts import build_mesh_facts

    (tmp_path / "w23-geometry-meta.json").write_text(json.dumps({"walls_level": 2, "bounds_m": BOUNDS}), encoding="utf-8")
    assert "two_d" not in build_mesh_facts(tmp_path)


def test_feature_marks_by_distance_count_only_when_asked(tmp_path: Path):
    """A 2D mesh's features refine by distance (its edges' end points lie outside the block)."""
    from cfddesk.mesh.snappy_hexdominant import read_feature_marks

    log = tmp_path / "log.snappyHexMesh"
    log.write_text(
        "Marked for refinement due to explicit features             : 0 cells.\n"
        "Marked for refinement due to distance to explicit features : 48 cells.\n",
        encoding="utf-8",
    )
    assert read_feature_marks(log) == {"marks": [0], "total": 0}
    assert read_feature_marks(log, distance=True) == {"marks": [0, 48], "total": 48}
