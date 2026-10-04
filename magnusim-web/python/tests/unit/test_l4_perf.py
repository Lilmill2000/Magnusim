"""gate:l4-perf (LINK proposal revision 7, section 9 L4): a regression guard on speed.

Two checks, both run only when ``-m`` names ``slow`` (a time limit is no default-suite
check: other work on the PC moves it).

1. **Against the baseline.** A generated part of 10,000 faces (a tube cut into
   cylindrical patches and planar end sectors, one solid, ``make_part``) goes through
   link-demo's input path with no CAD: the link job's preview process
   (``python -m cfddesk.cad.link_preview``, a binary BREP and its face-name sidecar), then
   the follow-ups (the centre of mass and the thumbnail), then the Hex-dominant mesh input
   (``prepare_input``'s ``build_mesh_input``). Each stage's seconds (the rows of section 7)
   are printed beside ``tests/fixtures/l4-perf/baseline.json`` (this PC). The stages L4
   changed (``CHANGED``) fail when they take more than 1.5 times their baseline plus half a
   second, times the PC's load: a fixed workload (``calibrate``) is timed before and after
   the part, and the limits grow by its slow-down against the baseline's own. The total and
   the follow-ups (code L4 did not change) are printed, not checked: load alone moved them
   past their limits. So is the wait for the split face table (its processes' start is
   what a loaded PC slows most); check 2 holds it against the serial table.
2. **Against the code L4 replaced, in the same process and under the same load** (speed
   plan steps 3-5, which the tube cannot show: its 10,000 small faces give 60,000 display
   triangles, and AddOptimal costs nothing on them). On ``make_fine_part`` (36 B-spline
   tori: few faces, fine triangles, a costly AddOptimal) the preview's ``triangles`` stage
   against the per-node loop (``l4_loops``), the budget's ``bbox_plain`` + ``bbox_exact``
   against AddOptimal, the budget's triangle count, and ``build_mesh_input``'s collect and
   write against the loops; and on the tube the preview's wait for the split face table
   against the table computed in its own process (step 6). Each is the best of two runs,
   interleaved.

It cannot show the time of Daniel's 113 MB part; the L4 handoff records that by hand.
A failure of check 1 on a busy PC means little: run it again on a quiet PC before acting
on it. ``pytest -m slow tests/unit/test_l4_perf.py -s``; ``CFDDESK_UPDATE_GOLDEN=1``
records a new baseline (on a quiet PC).
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import FIXTURES

pytestmark = [pytest.mark.occt, pytest.mark.slow]

PY = Path(__file__).resolve().parents[2]
TOOLS = PY / "tools"
BASELINE = FIXTURES / "l4-perf" / "baseline.json"
UPDATE = os.environ.get("CFDDESK_UPDATE_GOLDEN", "").strip() in ("1", "true", "yes")
RATIO = 1.5
SLACK_S = 0.5
# The stages L4 changed (section 7 steps 3-5 and 5.9), checked against the baseline. The
# wait for the split face table (step 6) is checked against the table computed in the
# preview's own process instead (check 2): it is the face-table processes' start, which a
# loaded PC slows far more than the calibration.
CHANGED = (
    "preview.bbox_plain",
    "preview.display_mesh",
    "preview.triangles",
    "preview.bbox_exact",
    "preview.faces_vtp",
    "prepare_input",
)


def make_part(path: Path) -> int:
    """A tube (outer radius 100 mm, inner 60 mm, 200 mm long) whose walls are cut into
    100 x 49 cylindrical patches each and whose ends into 100 planar sectors each: one
    solid of 10,000 faces, sewn (about 2 s). Returns its number of faces."""
    from OCP.BinTools import BinTools, BinTools_FormatVersion
    from OCP.BRepBuilderAPI import (
        BRepBuilderAPI_MakeEdge,
        BRepBuilderAPI_MakeFace,
        BRepBuilderAPI_MakeSolid,
        BRepBuilderAPI_MakeWire,
        BRepBuilderAPI_Sewing,
    )
    from OCP.BRepLib import BRepLib
    from OCP.GC import GC_MakeArcOfCircle
    from OCP.Geom import Geom_CylindricalSurface
    from OCP.gp import gp_Ax3, gp_Dir, gp_Pnt
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    nu, nv, r_out, r_in, h = 100, 49, 100.0, 60.0, 200.0
    sew = BRepBuilderAPI_Sewing(1e-6)
    axis = gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1))
    for r in (r_out, r_in):
        surf = Geom_CylindricalSurface(axis, r)
        for i in range(nu):
            for j in range(nv):
                u0, u1 = 2 * math.pi * i / nu, 2 * math.pi * (i + 1) / nu
                sew.Add(BRepBuilderAPI_MakeFace(surf, u0, u1, h * j / nv, h * (j + 1) / nv, 1e-7).Face())

    def at(r: float, a: float, z: float) -> gp_Pnt:
        return gp_Pnt(r * math.cos(a), r * math.sin(a), z)

    for z in (0.0, h):
        for i in range(nu):
            a0, a1 = 2 * math.pi * i / nu, 2 * math.pi * (i + 1) / nu
            am = 0.5 * (a0 + a1)
            wire = BRepBuilderAPI_MakeWire()
            wire.Add(BRepBuilderAPI_MakeEdge(at(r_in, a0, z), at(r_out, a0, z)).Edge())
            wire.Add(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(at(r_out, a0, z), at(r_out, am, z), at(r_out, a1, z)).Value()).Edge())
            wire.Add(BRepBuilderAPI_MakeEdge(at(r_out, a1, z), at(r_in, a1, z)).Edge())
            wire.Add(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(at(r_in, a1, z), at(r_in, am, z), at(r_in, a0, z)).Value()).Edge())
            sew.Add(BRepBuilderAPI_MakeFace(wire.Wire()).Face())
    sew.Perform()
    shell = TopoDS.Shell_s(TopExp_Explorer(sew.SewedShape(), TopAbs_SHELL).Current())
    solid = BRepBuilderAPI_MakeSolid(shell).Solid()
    BRepLib.OrientClosedSolid_s(solid)
    BinTools.Write_s(solid, str(path), False, False, BinTools_FormatVersion.BinTools_FormatVersion_CURRENT)
    count, exp = 0, TopExp_Explorer(solid, TopAbs_FACE)
    while exp.More():
        count += 1
        exp.Next()
    return count


def make_fine_part(path: Path) -> int:
    """36 tori (major radius 30 mm, minor 10 mm, 90 mm apart), each converted to a B-spline
    face: few faces, about 576,000 display triangles below the budget, and an AddOptimal
    that takes a quarter of a second where a plain box takes a millisecond. Returns its
    number of faces."""
    from OCP.BinTools import BinTools, BinTools_FormatVersion
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeTorus
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.TopoDS import TopoDS_Compound

    b = BRep_Builder()
    comp = TopoDS_Compound()
    b.MakeCompound(comp)
    for i in range(6):
        for j in range(6):
            torus = BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(i * 90.0, j * 90.0, 0.0), gp_Dir(0, 0, 1)), 30.0, 10.0).Shape()
            b.Add(comp, BRepBuilderAPI_NurbsConvert(torus, True).Shape())
    BinTools.Write_s(comp, str(path), False, False, BinTools_FormatVersion.BinTools_FormatVersion_CURRENT)
    return 36


def calibrate(tube: Path, fine: Path) -> float:
    """Seconds of a fixed workload no L4 change touches: a Python process that imports
    OCP (what each face-table process and the preview start with), surface properties of
    the tube's first 2,000 faces (one core) and a coarse parallel mesh of the fine part
    (all cores)."""
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    from cfddesk.cad.preview import read_bbrep

    shape, part = read_bbrep(tube), read_bbrep(fine)
    t0 = time.perf_counter()
    subprocess.run([sys.executable, "-c", "import cfddesk.cad.preview"], cwd=str(PY), env=_env(), check=True, timeout=300)
    exp, n = TopExp_Explorer(shape, TopAbs_FACE), 0
    while exp.More() and n < 2000:
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(exp.Current(), props)
        n += 1
        exp.Next()
    BRepMesh_IncrementalMesh(part, 0.05, False, 0.3, True)
    return time.perf_counter() - t0


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    return env


def _run(argv: list[str], timeout: float = 900) -> tuple[subprocess.CompletedProcess, float]:
    t0 = time.perf_counter()
    r = subprocess.run([sys.executable, *argv], cwd=str(PY), env=_env(), capture_output=True, text=True, timeout=timeout)
    return r, time.perf_counter() - t0


def test_linked_part_of_10k_faces_stays_within_its_baseline(tmp_path: Path, request: pytest.FixtureRequest):
    if "slow" not in str(request.config.getoption("markexpr") or ""):
        pytest.skip("a timing guard: run it with pytest -m slow")
    from magnusim_sdk.link import face_visits, sha256_file, write_face_names

    from cfddesk.cad.preview import read_bbrep

    shape_file = tmp_path / "part.bbrep"
    n_faces = make_part(shape_file)
    assert 9_500 <= n_faces <= 10_500, n_faces
    fine = tmp_path / "fine.bbrep"
    make_fine_part(fine)
    calibrate(shape_file, fine)  # warm
    cal_before = calibrate(shape_file, fine)
    visits = face_visits(read_bbrep(shape_file))
    names = tmp_path / "part.names.json"
    write_face_names(
        names,
        [{"index": 1, "id": "b1", "name": "Part"}],
        [{"index": i, "body": b or 1, "name": f"F{i}"} for i, b, _f in visits],
        shape_sha256=sha256_file(shape_file),
    )
    out, report = tmp_path / "new", tmp_path / "preview.json"
    stages: dict[str, float] = {}

    ran, wall = _run(
        ["-m", "cfddesk.cad.link_preview", "--shape", str(shape_file), "--format", "brep", "--names", str(names),
         "--shape-sha256", sha256_file(shape_file), "--out", str(out), "--report", str(report)]
    )
    assert ran.returncode == 0, ran.stderr[-3000:]
    rep = json.loads(report.read_text(encoding="utf-8"))
    assert rep["ok"] is True and rep["display_budget"] is True, rep
    # The stage events printed as the preview went, and the same in the report.
    lines = [json.loads(x.split(" ", 1)[1]) for x in ran.stdout.splitlines() if x.startswith("LINK_STAGE ")]
    assert {d["stage"]: d["seconds"] for d in lines} == rep["timings"]
    stages.update({f"preview.{k}": v for k, v in rep["timings"].items()})
    stages["preview.process_start_and_rest"] = round(wall - sum(rep["timings"].values()), 3)
    stages["preview.total"] = round(wall, 3)

    ran, wall = _run(["-m", "cfddesk.cad.link_preview", "--com", str(out / "source.bbrep")])
    assert ran.returncode == 0 and "LINK_COM " in ran.stdout, ran.stderr[-2000:]
    stages["follow_up.center_of_mass"] = round(wall, 3)
    ran, wall = _run(
        [str(TOOLS / "render_geometry_thumb.py"), "--vtp", str(out / "cad_faces.vtp"), "--edges", str(out / "cad_edges.vtp"), "--out", str(tmp_path / "thumb.png")]
    )
    assert ran.returncode == 0 and (tmp_path / "thumb.png").is_file(), ran.stderr[-2000:]
    stages["follow_up.thumbnail"] = round(wall, 3)

    sys.path.insert(0, str(TOOLS))
    import convert_step_to_stl as conv

    t0 = time.perf_counter()
    meta = conv.build_mesh_input(
        out / "source.step", out / "Body1.stl", bounds=rep["bounds"], shape_sha256="perf", display_budget=True
    )
    stages["prepare_input"] = round(time.perf_counter() - t0, 3)
    assert meta["cad_quality"] is True and meta["bounds"]["ntri"] >= rep["n_display_tris"]
    calibration = round(0.5 * (cal_before + calibrate(shape_file, fine)), 3)

    (tmp_path / "l4-perf-stages.json").write_text(json.dumps(stages, indent=1), encoding="utf-8")
    if UPDATE or not BASELINE.is_file():
        print("\nL4 perf stages (s):\n" + "\n".join(f"  {k:36s} {v:8.3f}" for k, v in stages.items()))
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        doc = {"faces": n_faces, "calibration": calibration, "stages": stages}
        BASELINE.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
        if not UPDATE:
            pytest.skip(f"no baseline yet: recorded {BASELINE}")
        return
    doc = json.loads(BASELINE.read_text(encoding="utf-8"))
    base: dict[str, Any] = doc["stages"]
    load = max(1.0, calibration / float(doc["calibration"]))
    limits = {k: RATIO * float(base[k]) * load + SLACK_S for k in CHANGED}
    print(
        f"\nL4 perf stages (s), load {load:.2f} (calibration {calibration} s, baseline {doc['calibration']} s):\n"
        + "\n".join(
            f"  {k:36s} {v:8.3f}  baseline {float(base.get(k, float('nan'))):7.3f}"
            + (f"  limit {limits[k]:7.3f}" if k in limits else "  (not checked)")
            for k, v in stages.items()
        )
    )
    slow = {k: (stages[k], base[k]) for k in CHANGED if stages[k] > limits[k]}
    assert not slow, (
        f"stages over 1.5 x their baseline x the load {load:.2f} (run again on a quiet PC before acting): "
        + ", ".join(f"{k} {v} s (baseline {b})" for k, (v, b) in slow.items())
    )


def test_speed_steps_beat_the_code_they_replaced(tmp_path: Path, request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch):
    """Speed plan steps 3-6 against the code they replaced, in this process, so the load
    of the PC slows both sides alike (``make_fine_part``, ``make_part``; see the module's
    check 2)."""
    if "slow" not in str(request.config.getoption("markexpr") or ""):
        pytest.skip("a timing guard: run it with pytest -m slow")
    from cfddesk.cad import preview
    from tests.unit import l4_loops

    monkeypatch.syspath_prepend(str(TOOLS))
    import convert_step_to_stl as conv

    geom = tmp_path / "geom"
    geom.mkdir()
    bbrep = geom / "source.bbrep"
    make_fine_part(bbrep)
    seen: dict[str, Any] = {}
    exact_min_faces = preview.BUDGET_MIN_FACES

    def preview_of(budget: bool) -> dict[str, float]:
        # The fine part has 36 faces: the budget is forced here to time its boxes.
        monkeypatch.setattr(preview, "BUDGET_MIN_FACES", 1 if budget else exact_min_faces)
        timings: dict[str, float] = {}
        meta = preview.export_preview(
            geom / "source.step", tmp_path / "e.vtp", tmp_path / "f.vtp", tmp_path / "m.json",
            shape=preview.read_bbrep(bbrep), com=False, bbrep=bbrep, timings=timings,
        )
        seen["budget" if budget else "plain"] = meta
        return timings

    def loop_triangles() -> float:
        shape = preview.read_bbrep(bbrep)
        _bounds, box = preview.shape_bounds(shape)
        preview.mesh_for_display(shape, box)
        t0 = time.perf_counter()
        l4_loops.extract_display_faces(shape)
        return time.perf_counter() - t0

    def addoptimal() -> float:
        shape = preview.read_bbrep(bbrep)
        t0 = time.perf_counter()
        preview.shape_bounds(shape)
        return time.perf_counter() - t0

    def loop_stl() -> float:
        shape = preview.read_bbrep(bbrep)
        conv.tessellate_cad_quality(shape, seen["plain"]["bounds"])
        t0 = time.perf_counter()
        verts, tris = l4_loops.collect_mesh(shape)
        l4_loops.write_binary_stl(tmp_path / "loop.stl", verts, tris)
        return time.perf_counter() - t0

    def new_stl() -> float:
        meta = conv.build_mesh_input(geom / "source.step", geom / "Body1.stl", bounds=seen["plain"]["bounds"], shape_sha256="perf")
        return float(meta["timings"]["collect"]) + float(meta["timings"]["write_stl"])

    rows: dict[str, tuple[float, float]] = {}
    # Step 5: the display triangles, numpy against the per-node loop.
    new = old = float("inf")
    for _ in range(2):
        new = min(new, preview_of(False)["triangles"])
        old = min(old, loop_triangles())
    rows["triangles (step 5)"] = (new, old)
    # Steps 3 and 4: the budget's plain box and triangle box against AddOptimal.
    new = old = float("inf")
    for _ in range(2):
        t = preview_of(True)
        assert "bbox" not in t, "the budget took AddOptimal's box"
        new = min(new, t["bbox_plain"] + t["bbox_exact"])
        old = min(old, addoptimal())
    rows["box (step 3)"] = (new, old)
    # The mesh input's collect and write, numpy against the loops.
    new = old = float("inf")
    for _ in range(2):
        new = min(new, new_stl())
        old = min(old, loop_stl())
    rows["mesh input collect + write"] = (new, old)
    # Step 6: the wait for the split face table after the edges, against the table
    # computed in the preview's own process (no split), on the 10,000-face tube.
    from cfddesk.cad import face_table

    tube_dir = tmp_path / "tube"
    tube_dir.mkdir()
    tube = tube_dir / "source.bbrep"
    make_part(tube)
    real_start = face_table.start

    def face_table_wait(split: bool) -> float:
        monkeypatch.setattr(face_table, "start", real_start if split else (lambda *_a, **_k: None))
        timings: dict[str, float] = {}
        preview.export_preview(
            tube_dir / "source.step", tmp_path / "te.vtp", tmp_path / "tf.vtp", tmp_path / "tm.json",
            shape=preview.read_bbrep(tube), com=False, bbrep=tube, timings=timings,
        )
        return timings["face_table"]

    monkeypatch.setattr(preview, "BUDGET_MIN_FACES", exact_min_faces)
    new = old = float("inf")
    for _ in range(2):
        new = min(new, face_table_wait(True))
        old = min(old, face_table_wait(False))
    rows["face table wait (step 6)"] = (new, old)
    print("\nL4 speed steps, new vs the code L4 replaced (s, best of 2):\n" + "\n".join(
        f"  {k:28s} {n:7.3f}  {o:7.3f}  ({n / o:.2f})" for k, (n, o) in rows.items()
    ))
    plain, budget = seen["plain"], seen["budget"]
    assert plain["n_display_tris"] >= 300_000, "the fine part no longer tessellates finely: no proof"
    assert rows["box (step 3)"][1] >= 0.1, "AddOptimal costs nothing on the fine part: no proof"
    # Step 4: the budget's display mesh is a small fraction of the exact one.
    assert budget.get("display_budget") is True and budget["n_display_tris"] <= 0.2 * plain["n_display_tris"]
    # The split's gain needs idle cores: 0.13 of the serial table on a quiet PC, 0.52 with
    # every core busy; without the split, or started late, it is 1 or more.
    limits = {"triangles (step 5)": 0.4, "box (step 3)": 0.25, "mesh input collect + write": 0.4, "face table wait (step 6)": 0.75}
    slow = {k: v for k, v in rows.items() if v[0] > limits[k] * v[1]}
    assert not slow, "slower than the limit against the code L4 replaced: " + ", ".join(
        f"{k} {n:.3f} s vs {o:.3f} s (limit {limits[k]} x)" for k, (n, o) in slow.items()
    )
