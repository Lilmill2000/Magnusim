"""gate:l4-equal (LINK proposal revision 7, section 9 L4; the meshing session's conditions).

L4 makes the preview and the mesh input faster without changing what they say:

- the binary BREP sidecar a STEP preview now writes (speed plan step 2) gives the
  same face ids, face table, mesher face records, bodies and display mesh as the STEP;
- numpy gives exactly what the per-node loops gave (``l4_loops``): the display
  triangles (step 5) and ``convert_step_to_stl``'s collect and write (step 4), byte
  for byte;
- the face table split over 4 processes equals the serial one, in order (step 6);
- the display budget applies only from BUDGET_MIN_FACES face visits; below it a plain
  import's preview is byte-identical to before; with it, the exact box from the
  triangles is within the deflection of AddOptimal's (steps 3 and 4).
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

from tests.conftest import FIXTURES
from tests.unit import l4_loops

pytestmark = pytest.mark.occt

PY = Path(__file__).resolve().parents[2]
TOOLS = PY / "tools"
ELBOW = FIXTURES / "elbow.step"
SHARED = FIXTURES / "geometry" / "two-boxes-shared-face.brep"
CONTRACT = FIXTURES / "link-contract"


def _read(path: Path):
    from OCP.BinTools import BinTools
    from OCP.TopoDS import TopoDS_Shape

    from cfddesk.cad import io

    if path.suffix == ".bbrep":
        shape = TopoDS_Shape()
        BinTools.Read_s(shape, str(path))
        return shape
    if path.suffix == ".brep":
        return io._load_brep(path)
    return io._load_step(path)


def _located():
    """The elbow three times: as is, moved (a translation) and turned (a rotation)."""
    from OCP.BRep import BRep_Builder
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS_Compound

    base = _read(ELBOW)
    move = gp_Trsf()
    move.SetTranslation(gp_Vec(250.0, -40.0, 12.5))
    turn = gp_Trsf()
    turn.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0.3, 0.4, 0.866)), 0.7)
    b = BRep_Builder()
    comp = TopoDS_Compound()
    b.MakeCompound(comp)
    b.Add(comp, base)
    b.Add(comp, base.Moved(TopLoc_Location(move)))
    b.Add(comp, base.Moved(TopLoc_Location(turn)))
    return comp


SHAPES = {
    "elbow": lambda: _read(ELBOW),
    "two-boxes-shared-face": lambda: _read(SHARED),
    "contract-a-shared": lambda: _read(CONTRACT / "a-shared" / "shape.bbrep"),
    "contract-b-internal": lambda: _read(CONTRACT / "b-internal" / "shape.bbrep"),
    "contract-c-apart": lambda: _read(CONTRACT / "c-apart" / "shape.bbrep"),
    "located-compound": _located,
}


def _meshed(name: str):
    from cfddesk.cad import preview

    shape = SHAPES[name]()
    _bounds, box = preview.shape_bounds(shape)
    preview.mesh_for_display(shape, box)
    return shape


@pytest.mark.parametrize("name", sorted(SHAPES))
def test_display_triangles_numpy_equal_the_loop(name: str, tmp_path: Path):
    from cfddesk.cad import preview

    fast = preview.extract_display_faces(_meshed(name))
    loop = l4_loops.extract_display_faces(_meshed(name))
    assert len(loop[2]) > 0
    np.testing.assert_array_equal(fast[0], np.asarray(loop[0], dtype=np.float64))
    np.testing.assert_array_equal(fast[1], np.asarray(loop[1], dtype=np.float64))
    np.testing.assert_array_equal(fast[2], np.asarray(loop[2], dtype=np.int64))
    np.testing.assert_array_equal(fast[3], np.asarray(loop[3]))
    np.testing.assert_array_equal(fast[4], np.asarray(loop[4]))
    # And the faces VTP the viewport reads, byte for byte.
    preview.save_faces_vtp(tmp_path / "fast.vtp", *fast)
    preview.save_faces_vtp(tmp_path / "loop.vtp", *loop)
    assert (tmp_path / "fast.vtp").read_bytes() == (tmp_path / "loop.vtp").read_bytes()


@pytest.mark.parametrize("name", sorted(SHAPES))
def test_stl_collect_and_write_numpy_equal_the_loop(name: str, tmp_path: Path):
    sys.path.insert(0, str(TOOLS))
    import convert_step_to_stl as conv

    fast_v, fast_t = conv.collect_mesh(_meshed(name))
    loop_v, loop_t = l4_loops.collect_mesh(_meshed(name))
    np.testing.assert_array_equal(fast_v, np.asarray(loop_v, dtype=np.float64))
    np.testing.assert_array_equal(fast_t, np.asarray(loop_t, dtype=np.int64))
    conv.write_binary_stl(tmp_path / "fast.stl", fast_v, fast_t, header=b"h")
    l4_loops.write_binary_stl(tmp_path / "loop.stl", loop_v, loop_t, header=b"h")
    assert (tmp_path / "fast.stl").read_bytes() == (tmp_path / "loop.stl").read_bytes()


# Facet normals (nx, ny, 0) whose float32 value differs between len = sq ** 0.5 (C pow,
# what the loop took) and sqrt: found by search (a float32 midpoint as ny / len).
POW_NOT_SQRT = [(1.0094919893127718, 1.9687460796523673), (0.7034545086786352, 0.27004236474164295), (1.7711078430651654, 0.9581863211272411)]


def test_stl_writer_takes_the_loops_length_not_sqrt(tmp_path: Path):
    """A facet whose length ``** 0.5`` and ``sqrt`` round apart, so that its float32 normal
    differs: the numpy writer still writes the loop's bytes."""
    sys.path.insert(0, str(TOOLS))
    import convert_step_to_stl as conv

    verts: list[tuple[float, float, float]] = []
    tris = []
    for nx, ny in POW_NOT_SQRT:
        # u = (0, 0, 1), v = (ny, -nx, 0): u x v = (nx, ny, 0) exactly.
        base = len(verts)
        verts += [(0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (ny, -nx, 0.0)]
        tris.append((base, base + 1, base + 2))
        sq = nx * nx + ny * ny + 0.0 * 0.0
        assert np.float32(ny / sq**0.5) != np.float32(ny / float(np.sqrt(sq))) or np.float32(nx / sq**0.5) != np.float32(nx / float(np.sqrt(sq)))
    conv.write_binary_stl(tmp_path / "fast.stl", np.asarray(verts), np.asarray(tris), header=b"x")
    l4_loops.write_binary_stl(tmp_path / "loop.stl", verts, tris, header=b"x")
    assert (tmp_path / "fast.stl").read_bytes() == (tmp_path / "loop.stl").read_bytes()


def test_convert_cli_cad_quality_bytes_on_elbow(tmp_path: Path):
    """``convert_step_to_stl.py --cad-quality`` (what the Hex-dominant goldens run) on
    elbow.step writes the bytes the loop pipeline wrote."""
    sys.path.insert(0, str(TOOLS))
    import convert_step_to_stl as conv

    step = tmp_path / "source.step"
    shutil.copy(ELBOW, step)
    out = tmp_path / "Body1.stl"
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(PY), str(PY / "sdk")])}
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step), "--out", str(out), "--cad-quality"],
        cwd=str(PY), env=env, capture_output=True, text=True, timeout=300,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    shape = conv.load_step(step)
    conv.tessellate_cad_quality(shape)
    verts, tris = l4_loops.collect_mesh(shape)
    l4_loops.write_binary_stl(tmp_path / "loop.stl", verts, tris, header=b"W16 Body1 from source.step via OCP")
    assert out.read_bytes() == (tmp_path / "loop.stl").read_bytes()
    meta = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
    assert meta["bounds"]["ntri"] == len(tris) and meta["cad_quality"] is True


def _bbrep_of(shape, path: Path) -> Path:
    from OCP.BinTools import BinTools, BinTools_FormatVersion

    BinTools.Write_s(shape, str(path), False, False, BinTools_FormatVersion.BinTools_FormatVersion_CURRENT)
    return path


@pytest.mark.parametrize("name", ["elbow", "two-boxes-shared-face", "contract-a-shared", "contract-b-internal", "located-compound"])
def test_split_face_table_equals_serial_in_order(name: str, tmp_path: Path):
    from cfddesk.cad import face_table, preview

    # The processes read the BREP's bytes; the serial table is taken on the same bytes
    # (export_preview reads them too before it splits, see shape_is_bbrep).
    bbrep = _bbrep_of(SHAPES[name](), tmp_path / "shape.bbrep")
    shape = preview.read_bbrep(bbrep)
    serial = preview.face_properties(shape)
    split = face_table.start(bbrep, len(serial), processes=4)
    assert split is not None and len(split.parts) >= 2
    rows = split.rows()
    assert rows is not None, "a face-table process failed"
    assert [r["id"] for r in rows] == [r["id"] for r in serial]
    table = preview.face_properties(shape, split=face_table.start(bbrep, len(serial), processes=4))
    assert json.dumps(table) == json.dumps(serial)


@pytest.mark.parametrize("name", sorted(SHAPES))
def test_face_table_before_and_after_l4_is_the_same_so_no_version_bump(name: str, tmp_path: Path):
    """The meshing session's condition 4 (CAD_PREVIEW_VERSION stays 8): the face table L4
    writes, serial and split over 4 processes, is the one the code before L4 wrote
    (``l4_loops.face_properties``, 91ecc84), byte for byte as JSON: the same face ids in
    the same order, the same bodies and ``shared_with``, the same fingerprints. And it
    numbers the faces as the mesher does (``cad.step``: face_id = id - 1, face_bodies,
    shared_face_ids) on the elbow and the multi-body fixtures."""
    from cfddesk.cad import face_table, preview
    from cfddesk.cad import step as cad_step
    from cfddesk.cad.shared_faces import face_bodies, shared_face_ids

    assert preview.PREVIEW_VERSION == 8
    shape = SHAPES[name]()
    before = json.dumps(l4_loops.face_properties(shape))
    assert json.dumps(preview.face_properties(shape)) == before
    # Split, on the BREP's bytes (what the processes read), against the old code on them.
    (tmp_path / "geom").mkdir()
    bbrep = _bbrep_of(shape, tmp_path / "geom" / "source.bbrep")
    again = preview.read_bbrep(bbrep)
    old_rows = l4_loops.face_properties(again)
    split = face_table.start(bbrep, len(old_rows), processes=4)
    assert split is not None and len(split.parts) >= 2
    rows = split.rows()
    assert rows is not None, "a face-table process failed"
    # The processes' own rows (no serial fallback), then shared_with as face_properties adds it.
    assert json.dumps(face_table.with_shared(rows, preview.face_visits(again))) == json.dumps(old_rows)
    # The mesher's numbering of the same file (a sidecar-only geometry, as a mesh import).
    solid = cad_step.load_step(tmp_path / "geom" / "source.step")
    assert [f.face_id + 1 for f in solid.faces] == [r["id"] for r in old_rows]
    bodies = face_bodies(solid)
    if len(solid.volumes) >= 2:
        assert {r["id"] - 1: r["body"] for r in old_rows} == bodies
    shared = shared_face_ids(solid)
    assert {r["id"] - 1: r["shared_with"] - 1 for r in old_rows if "shared_with" in r} == shared
    if name in ("two-boxes-shared-face", "contract-a-shared"):
        assert shared, "a shared face: no proof of shared_with"


def test_face_table_splits_only_large_parts():
    from cfddesk.cad import face_table

    assert face_table.processes_for(17) == 1
    assert face_table.processes_for(1999) == 1
    assert face_table.processes_for(2000) == 2
    assert face_table.processes_for(11_776) == 4


def _face_table_procs(marker: str) -> list:
    """Live face-table processes whose command line names ``marker`` (a path of this test)."""
    import psutil

    found = []
    for proc in psutil.process_iter(["cmdline"]):
        try:
            cmd = " ".join(proc.info.get("cmdline") or [])
        except (psutil.Error, OSError):
            continue
        if "cfddesk.cad.face_table" in cmd and marker in cmd:
            found.append(proc)
    return found


def _py_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def test_a_face_table_process_exits_with_the_process_that_started_it(tmp_path: Path):
    """``--parent-pid``: a face-table process whose parent is gone exits at once (code 3)
    and writes no rows. A killed preview runs no clean-up, so its processes watch it."""
    bbrep = _bbrep_of(_read(ELBOW), tmp_path / "source.bbrep")
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        child = subprocess.Popen(
            [sys.executable, "-m", "cfddesk.cad.face_table", "--bbrep", str(bbrep), "--start", "0", "--stop", "17",
             "--out", str(tmp_path / "rows.json"), "--parent-pid", str(parent.pid)],
            cwd=str(PY), env=_py_env(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        parent.kill()
        parent.wait(timeout=30)
        _out, err = child.communicate(timeout=60)
    finally:
        parent.kill()
    assert child.returncode == 3, err.decode("utf-8", "replace")[-2000:]
    assert not (tmp_path / "rows.json").exists()
    # With its parent alive it computes the rows as before.
    alive = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        r = subprocess.run(
            [sys.executable, "-m", "cfddesk.cad.face_table", "--bbrep", str(bbrep), "--start", "0", "--stop", "17",
             "--out", str(tmp_path / "rows.json"), "--parent-pid", str(alive.pid)],
            cwd=str(PY), env=_py_env(), capture_output=True, timeout=120,
        )
    finally:
        alive.kill()
    assert r.returncode == 0, r.stderr[-2000:]
    assert len(json.loads((tmp_path / "rows.json").read_text(encoding="utf-8"))) == 17


def test_a_killed_link_preview_leaves_no_face_table_process_and_its_rows_folder_in_staging(tmp_path: Path):
    """The link job kills its preview on the 15-minute timeout and when the geometry is
    removed (``child.kill()``). Its face-table processes go with it, before they write a
    row, and their rows folder is in the job's own folder (``<staging>/new``), which the
    job removes, not in the system temp folder where nothing would."""
    import tempfile
    import time

    from tests.unit.test_l4_perf import make_part

    shape = tmp_path / "part.bbrep"
    assert make_part(shape) >= 2000
    out = tmp_path / "staging" / "new"
    temp_before = set(Path(tempfile.gettempdir()).glob("cfd-facetable-*"))
    proc = subprocess.Popen(
        [sys.executable, "-m", "cfddesk.cad.link_preview", "--shape", str(shape), "--format", "brep",
         "--out", str(out), "--report", str(tmp_path / "staging" / "preview.json")],
        cwd=str(PY), env={**_py_env(), "PYTHONUNBUFFERED": "1"}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    try:
        # The split starts before the display mesh, whose box is the stage before it.
        for line in proc.stdout:
            if line.startswith("LINK_STAGE ") and json.loads(line.split(" ", 1)[1])["stage"] == "bbox_plain":
                break
        else:
            pytest.fail("the preview ended before its display mesh")
        assert _face_table_procs(str(out)), "no face-table process was running: nothing to show"
        proc.kill()
        proc.wait(timeout=30)
        end = time.monotonic() + 20
        while _face_table_procs(str(out)) and time.monotonic() < end:
            time.sleep(0.2)
        assert not _face_table_procs(str(out)), "face-table processes outlived the killed preview"
    finally:
        proc.kill()
        for left in _face_table_procs(str(out)):
            left.kill()
    rows_dirs = list(out.glob(".face-table-*"))
    assert len(rows_dirs) == 1, rows_dirs
    assert not list(rows_dirs[0].glob("rows-*.json")), "the processes ran on and wrote their rows"
    assert set(Path(tempfile.gettempdir()).glob("cfd-facetable-*")) <= temp_before
    shutil.rmtree(tmp_path / "staging")  # what the job's rmQuiet(staging) does


def test_a_preview_that_fails_after_the_split_started_stops_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Any stage that raises once the split started (the shape hash, the centre of mass,
    the display mesh) stops its processes and removes their rows folder."""
    from cfddesk.cad import face_table, preview

    _split_small(monkeypatch)
    started = []
    real_start = face_table.start

    def spy(*a, **k):
        split = real_start(*a, **k)
        started.append(split)
        return split

    def broken_hash(_path: Path) -> str:
        raise RuntimeError("the hash failed")

    monkeypatch.setattr(face_table, "start", spy)
    monkeypatch.setattr(preview, "_sha256", broken_hash)
    geom = tmp_path / "geom"
    geom.mkdir()
    bbrep = _bbrep_of(_read(ELBOW), geom / "source.bbrep")
    with pytest.raises(RuntimeError, match="the hash failed"):
        preview.export_preview(
            geom / "source.step", tmp_path / "e.vtp", tmp_path / "f.vtp", tmp_path / "m.json",
            shape=preview.read_bbrep(bbrep), bbrep=bbrep, com=False,
        )
    split = started[0]
    assert split is not None and len(split.parts) >= 2
    assert all(p.poll() is not None for p, _o, _a, _b in split.parts), "a face-table process still runs"
    assert not split.dir.exists() and not list(geom.glob(".face-table-*"))


def test_a_rows_folder_a_killed_preview_left_is_removed_by_a_later_split(tmp_path: Path):
    from cfddesk.cad import face_table

    bbrep = _bbrep_of(_read(ELBOW), tmp_path / "source.bbrep")
    old, recent = tmp_path / ".face-table-old", tmp_path / ".face-table-recent"
    for d in (old, recent):
        d.mkdir()
        (d / "rows-0.json").write_text("[]", encoding="utf-8")
    stamp = os.stat(old).st_mtime - face_table.STALE_DIR_S - 60
    os.utime(old, (stamp, stamp))
    split = face_table.start(bbrep, 17, processes=2)
    assert split is not None and split.dir.parent == tmp_path and split.dir.name.startswith(".face-table-")
    assert split.rows() is not None
    assert not old.exists() and recent.exists() and not split.dir.exists()


def test_a_translation_needs_no_loop_and_a_rotation_does(monkeypatch: pytest.MonkeyPatch):
    """tri_arrays applies an identity or a translation with numpy and loops only over the
    nodes of a face with another location (the turned copy of the located compound)."""
    from cfddesk.cad import tri_arrays
    from cfddesk.cad.preview import face_visits

    looped: list[int] = []
    real = tri_arrays._loop_nodes
    monkeypatch.setattr(tri_arrays, "_loop_nodes", lambda tri, trsf: (looped.append(1), real(tri, trsf))[1])
    shape = _meshed("located-compound")
    faces = [f for _i, _b, f in face_visits(shape)]
    out = tri_arrays.face_triangulations(faces)
    assert len(faces) == 3 * 17 and all(ft is not None for ft in out)
    assert len(looped) == 17


def _geometry(tmp_path: Path, src: Path) -> Path:
    """A geometry folder holding a STEP only (a plain STEP import)."""
    from cfddesk.cad import io

    step = tmp_path / "geom" / "source.step"
    step.parent.mkdir(parents=True)
    if src.suffix == ".step":
        shutil.copy(src, step)
    else:
        io._write_step_file(io._load_brep(src), step)
    return step


def _close(a: dict, b: dict) -> bool:
    keys = ("id", "body", "surface_type", "shared_with")
    if any(a.get(k) != b.get(k) for k in keys):
        return False
    vals = [(a["area"], b["area"]), *zip(a["centroid"], b["centroid"], strict=True)]
    if a.get("normal") is not None or b.get("normal") is not None:
        vals += list(zip(a["normal"], b["normal"], strict=True))
    return all(abs(x - y) <= 1e-9 * max(1.0, abs(x), abs(y)) for x, y in vals)


@pytest.mark.parametrize("src", [ELBOW, SHARED], ids=["elbow", "two-boxes-shared-face"])
def test_sidecar_gives_the_steps_face_ids_bodies_and_fingerprints(src: Path, tmp_path: Path):
    """Speed plan step 2: the binary BREP (``source.bbrep``) gives the STEP's face ids, in
    the same order, the same bodies, and the same face fingerprints (area, centroid,
    normal) for the preview's face table and the mesher's records."""
    from cfddesk.cad import io, preview
    from cfddesk.cad import step as cad_step

    stepf = _geometry(tmp_path, src)
    from_step = io._load_step(stepf)
    side, written = preview.ensure_step_sidecar(stepf, from_step)
    assert written and side == io.step_sidecar_path(stepf) and side.is_file()
    from_side = io.read_step_shape(stepf)  # the sidecar: what the app reads from now on
    assert [(i, b) for i, b, _f in preview.face_visits(from_side)] == [(i, b) for i, b, _f in preview.face_visits(from_step)]
    t_side, t_step = preview.face_properties(from_side), preview.face_properties(from_step)
    assert len(t_side) == len(t_step) and all(_close(a, b) for a, b in zip(t_side, t_step, strict=True))
    moved = tmp_path / "step-only"
    moved.mkdir()
    shutil.copy(stepf, moved / "source.step")
    a, b = cad_step.load_step(stepf), cad_step.load_step(moved / "source.step")
    assert [(f.face_id, f.surface_type) for f in a.faces] == [(f.face_id, f.surface_type) for f in b.faces]
    assert all(abs(f.area - g.area) <= 1e-9 * g.area for f, g in zip(a.faces, b.faces, strict=True))
    assert [(v.volume_id, v.face_ids) for v in a.volumes] == [(v.volume_id, v.face_ids) for v in b.volumes]


def test_brep_round_trip_is_not_bit_exact_so_small_plain_imports_get_no_sidecar(tmp_path: Path):
    """Why the preview writes the sidecar only for a part with the display budget: a
    BinTools round trip renormalises a cylinder's axis (gp_Dir) in the last bit, so the
    Standard mesher's gmsh BREP of the elbow would change. Below the budget the STEP
    stays the only file, and the mesh is made from it exactly as before."""
    from cfddesk.cad import io, preview
    from cfddesk.mesh.gmsh_standard import write_gmsh_brep

    a = io._load_step(ELBOW)
    b = preview.read_bbrep(_bbrep_of(a, tmp_path / "s.bbrep"))
    write_gmsh_brep(a, tmp_path / "a.brep", scale_to_metres=0.001)
    write_gmsh_brep(b, tmp_path / "b.brep", scale_to_metres=0.001)
    assert (tmp_path / "a.brep").read_bytes() != (tmp_path / "b.brep").read_bytes()
    stepf = _geometry(tmp_path, ELBOW)
    out = tmp_path / "out"
    preview.export_preview(stepf, out / "cad_edges.vtp", out / "cad_faces.vtp", out / "cad_preview.json")
    assert not io.step_sidecar_path(stepf).exists()
    assert sorted(p.name for p in stepf.parent.iterdir()) == ["source.step"]


def test_budgeted_preview_writes_the_sidecar_once_with_the_steps_mtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.cad import io, preview

    monkeypatch.setattr(preview, "BUDGET_MIN_FACES", 17)
    stepf = _geometry(tmp_path, ELBOW)
    before = io.geometry_mtime_ns(stepf)
    out = tmp_path / "out"
    preview.export_preview(stepf, out / "cad_edges.vtp", out / "cad_faces.vtp", out / "cad_preview.json")
    side = io.step_sidecar_path(stepf)
    assert side.is_file()
    assert side.stat().st_mtime_ns == stepf.stat().st_mtime_ns
    # The geometry is no newer, so the preview just made stays fresh.
    assert io.geometry_mtime_ns(stepf) == before
    written = side.read_bytes()
    assert preview.ensure_step_sidecar(stepf, io._load_step(stepf)) == (side, False)
    assert side.read_bytes() == written
    # A STEP rewritten later (newer than its sidecar) gets a new one.
    os.utime(side, ns=(before - 10_000_000_000, before - 10_000_000_000))
    assert preview.ensure_step_sidecar(stepf, io._load_step(stepf)) == (side, True)
    assert side.stat().st_mtime_ns == stepf.stat().st_mtime_ns
    # write=False never writes one.
    side.unlink()
    assert preview.ensure_step_sidecar(stepf, io._load_step(stepf), write=False) == (None, False)
    assert not side.exists()
    assert not list(stepf.parent.glob("*.tmp.*"))


def _split_small(monkeypatch: pytest.MonkeyPatch) -> None:
    from cfddesk.cad import face_table, preview

    monkeypatch.setattr(preview, "BUDGET_MIN_FACES", 17)
    monkeypatch.setattr(face_table, "MIN_ROWS_PER_PROCESS", 4)


def _no_split(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every face-table process fails: the preview computes the rows itself."""
    from cfddesk.cad import face_table

    monkeypatch.setattr(face_table.Split, "rows", lambda self, timeout=900.0: (self.close(), None)[1])


def test_budgeted_preview_reads_the_sidecar_it_wrote_before_splitting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The face table's processes read source.bbrep, so the preview reads it too: the
    table is the same whether the processes worked or the preview computed it, and it
    is the table of the shape every later reader gets (io.read_step_shape). On the
    located compound the STEP and its BREP differ in the last bits, so this shows it."""
    from cfddesk.cad import io, preview

    _split_small(monkeypatch)
    tables = []
    for tag in ("split", "serial"):
        if tag == "serial":
            _no_split(monkeypatch)
        stepf = tmp_path / tag / "geom" / "source.step"
        stepf.parent.mkdir(parents=True)
        io._write_step_file(_located(), stepf)
        timings: dict = {}
        meta = preview.export_preview(stepf, tmp_path / tag / "e.vtp", tmp_path / tag / "f.vtp", tmp_path / tag / "m.json", timings=timings)
        assert "read_bbrep" in timings
        tables.append(json.dumps(meta["faces"]))
    assert tables[0] == tables[1]
    assert tables[0] == json.dumps(preview.face_properties(io.read_step_shape(stepf)))
    assert tables[0] != json.dumps(preview.face_properties(io._load_step(stepf))), "the STEP and its BREP agree: no proof"


def test_link_preview_of_a_text_brep_reads_its_binary_copy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A text BREP: the job stores it as source.bbrep (BinTools); the processes read that,
    and so does the preview, so the table does not depend on the processes working."""
    from OCP.BRepTools import BRepTools

    from cfddesk.cad import link_preview

    _split_small(monkeypatch)
    text = tmp_path / "shape.brep"
    BRepTools.Write_s(_located(), str(text))
    tables = []
    for tag in ("split", "serial"):
        if tag == "serial":
            _no_split(monkeypatch)
        report = link_preview.build(text, "brep", None, None, tmp_path / tag)
        assert report["encoding"] == "text" and "read_bbrep" in report["timings"]
        tables.append(json.loads((tmp_path / tag / "cad_preview.json").read_text(encoding="utf-8"))["faces"])
    assert tables[0] == tables[1]


def test_plain_import_preview_is_byte_identical_below_the_budget(tmp_path: Path):
    """No display budget below BUDGET_MIN_FACES: the faces VTP (Body1.stl's source for
    a plain import) is what the code before L4 wrote, and cad_preview.json has no new key."""
    from cfddesk.cad import preview

    stepf = _geometry(tmp_path, ELBOW)
    out = tmp_path / "out"
    meta = preview.export_preview(stepf, out / "cad_edges.vtp", out / "cad_faces.vtp", out / "cad_preview.json")
    assert meta["n_faces"] < preview.BUDGET_MIN_FACES
    assert "display_budget" not in meta and "shape_sha256" not in meta
    shape = preview.load_step(ELBOW)
    bounds, box = preview.shape_bounds(shape)
    info = preview.mesh_for_display(shape, box)
    preview.save_faces_vtp(tmp_path / "before.vtp", *l4_loops.extract_display_faces(shape))
    assert (out / "cad_faces.vtp").read_bytes() == (tmp_path / "before.vtp").read_bytes()
    assert meta["bounds"] == bounds and meta["linear_deflection"] == info["linear_deflection"]


def test_budget_applies_only_from_the_threshold(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.cad import io, preview

    assert preview.BUDGET_MIN_FACES == 5000 and preview.BUDGET_DEFLECTION == 0.001 and preview.BUDGET_ANGLE_DEG == 20.0
    assert not preview.budget_applies(4999) and preview.budget_applies(5000)
    stepf = _geometry(tmp_path, ELBOW)
    plain = preview.export_preview(stepf, tmp_path / "p" / "e.vtp", tmp_path / "p" / "f.vtp", tmp_path / "p" / "m.json")
    monkeypatch.setattr(preview, "BUDGET_MIN_FACES", 17)
    stepf = _geometry(tmp_path / "again", ELBOW)
    budget = preview.export_preview(stepf, tmp_path / "b" / "e.vtp", tmp_path / "b" / "f.vtp", tmp_path / "b" / "m.json")
    assert budget["display_budget"] is True
    import hashlib

    assert budget["shape_sha256"] == hashlib.sha256(io.step_sidecar_path(stepf).read_bytes()).hexdigest()
    assert budget["n_display_tris"] < plain["n_display_tris"]
    # Its deflection is 0.001 x the plain box's diagonal.
    box = preview.plain_box(preview.load_step(ELBOW))
    x0, y0, z0, x1, y1, z1 = box.Get()
    diag = ((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) ** 0.5
    assert budget["linear_deflection"] == pytest.approx(diag * 0.001, rel=1e-12)
    assert budget["angular_deflection"] == pytest.approx(math.radians(20.0), rel=1e-12)
    assert (budget["deviation_coefficient"], budget["deviation_angle_deg"]) == (0.001, 20.0)
    assert (plain["deviation_coefficient"], plain["deviation_angle_deg"]) == (0.0001, 5.0)
    # The exact box from the triangles: inside AddOptimal's, within the deflection.
    for k in ("xmin", "ymin", "zmin"):
        assert plain["bounds"][k] - 1e-9 <= budget["bounds"][k] <= plain["bounds"][k] + budget["linear_deflection"]
    for k in ("xmax", "ymax", "zmax"):
        assert plain["bounds"][k] - budget["linear_deflection"] <= budget["bounds"][k] <= plain["bounds"][k] + 1e-9
    # The plain box holds the exact one.
    for k, v in zip(("xmin", "ymin", "zmin", "xmax", "ymax", "zmax"), box.Get(), strict=True):
        assert (v <= plain["bounds"][k] + 1e-9) if k.endswith("min") else (v >= plain["bounds"][k] - 1e-9)
    # The same face ids and fingerprints either way.
    assert all(_close(a, b) for a, b in zip(budget["faces"], plain["faces"], strict=True))


def test_preview_records_its_stages(tmp_path: Path):
    from cfddesk.cad import preview

    stepf = _geometry(tmp_path, ELBOW)
    timings: dict = {}
    seen: list = []
    preview.export_preview(
        stepf, tmp_path / "o" / "e.vtp", tmp_path / "o" / "f.vtp", tmp_path / "o" / "m.json",
        timings=timings, on_stage=lambda name, s: seen.append(name),
    )
    for stage in ("read_shape", "write_bbrep", "bbox", "display_mesh", "triangles", "faces_vtp", "edges", "center_of_mass", "face_table"):
        assert stage in timings and timings[stage] >= 0
    assert seen == list(timings)
