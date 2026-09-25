"""Every geometry format the Add geometry picker lists loads; mesh imports stay fast.

Fixtures: tests/fixtures/geometry/elbow.* (python/tools/gen_geometry_fixtures.py writes
them from tests/fixtures/elbow.step), the same part in every format.
"""
from __future__ import annotations

import os
import struct
import time
from pathlib import Path

import pytest
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

from cfddesk.cad import io

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "geometry"
FORMATS = ("step", "stp", "iges", "igs", "brep", "brp", "stl", "obj", "ply")
SIZE_MM = (304.8, 304.8, 812.8)


def _volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def _centroids(shape) -> list[tuple[float, float, float]]:
    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(TopoDS.Face_s(exp.Current()), props)
        c = props.CentreOfMass()
        out.append((c.X(), c.Y(), c.Z()))
        exp.Next()
    return out


def test_picker_formats_match_the_loader():
    shell = (Path(__file__).resolve().parents[3] / "src" / "app" / "shell.html").read_text(encoding="utf-8")
    accept = shell.split('id="geometry-file-input" accept="', 1)[1].split('"', 1)[0]
    listed = sorted(a.strip()[1:] for a in accept.split(",") if a.strip().startswith("."))
    assert listed == sorted(FORMATS)
    assert {f".{e}" for e in FORMATS} == io.BREP_EXTS | io.MESH_EXTS


@pytest.mark.parametrize("ext", FORMATS)
def test_every_listed_format_loads_as_one_watertight_solid(ext):
    loaded = io.load_cad(FIX / f"elbow.{ext}")
    assert loaded.n_solids == 1
    assert loaded.watertight
    assert loaded.n_faces > 0
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.Add_s(loaded.shape, box)
    x0, y0, z0, x1, y1, z1 = box.Get()
    for got, want in zip((x1 - x0, y1 - y0, z1 - z0), SIZE_MM, strict=True):
        assert got == pytest.approx(want, abs=1.0)
    assert _volume(loaded.shape) == pytest.approx(_volume(io.load_cad(FIX / "elbow.step").shape), rel=0.02)


def test_closed_stl_becomes_a_solid_without_sewing():
    solid = io._closed_solid_from_stl(FIX / "elbow.stl")
    assert solid is not None
    assert io.count_sub(solid, io.TopAbs_SOLID) == 1
    assert _volume(solid) > 0


def _write_open_stl(path: Path) -> None:
    """Binary STL of a unit cube with its top two triangles missing (not watertight)."""
    v = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    tris = [(0, 2, 1), (0, 3, 2), (0, 1, 5), (0, 5, 4), (2, 3, 7), (2, 7, 6), (1, 2, 6), (1, 6, 5), (0, 4, 7), (0, 7, 3)]
    with path.open("wb") as fh:
        fh.write(b"\0" * 80 + struct.pack("<I", len(tris)))
        for t in tris:
            fh.write(struct.pack("<3f", 0, 0, 0))
            for i in t:
                fh.write(struct.pack("<3f", *v[i]))
            fh.write(b"\0\0")


def test_open_stl_falls_back_to_sewing_and_is_reported_not_watertight(tmp_path):
    stl = tmp_path / "open.stl"
    _write_open_stl(stl)
    assert io._closed_solid_from_stl(stl) is None
    loaded = io.load_cad(stl)
    assert loaded.n_faces > 0
    assert not loaded.watertight


def test_step_sidecar_keeps_face_order_and_is_ignored_when_stale(tmp_path):
    shape = io.load_cad(FIX / "elbow.stl").shape
    step = tmp_path / "source.step"
    io.write_step(shape, step)
    side = io.step_sidecar_path(step)
    assert side.is_file()
    fast = io.read_step_shape(step)
    slow = io._load_step(step)
    a, b = _centroids(fast), _centroids(slow)
    assert len(a) == len(b)
    assert max(max(abs(p - q) for p, q in zip(x, y, strict=True)) for x, y in zip(a, b, strict=True)) < 1e-6

    # Something rewrites the STEP later (different part): the old sidecar must not be used.
    other = io.load_cad(FIX / "elbow.step").shape
    time.sleep(0.01)
    io.write_step(other, tmp_path / "other.step")
    os.replace(tmp_path / "other.step", step)
    os.utime(step, None)
    assert io.count_sub(io.read_step_shape(step), TopAbs_FACE) == 17


def test_deferred_step_is_readable_before_and_after_the_background_write(tmp_path):
    shape = io.load_cad(FIX / "elbow.stl").shape
    step = tmp_path / "source.step"
    io.write_step(shape, step, defer=True)
    assert not step.exists()
    assert io.step_sidecar_path(step).is_file()
    assert io.geometry_file_exists(step)
    faces = io.count_sub(io.read_step_shape(step), TopAbs_FACE)
    assert faces == io.count_sub(shape, TopAbs_FACE)

    io.write_deferred_step(step)
    assert step.is_file()
    # The STEP carries the sidecar's time, so the fast sidecar stays the one read.
    assert step.stat().st_mtime_ns == io.step_sidecar_path(step).stat().st_mtime_ns
    assert io.count_sub(io._load_step(step), TopAbs_FACE) == faces
    assert not list(tmp_path.glob("*.tmp.step"))


def test_mesh_imports_defer_the_step_and_cad_imports_do_not(tmp_path):
    import json
    import subprocess
    import sys

    tool = Path(__file__).resolve().parents[2] / "tools" / "normalize_cad_import.py"
    for name, deferred in (("elbow.stl", True), ("elbow.iges", False)):
        out = tmp_path / name / "source.step"
        out.parent.mkdir()
        proc = subprocess.run(
            [sys.executable, str(tool), "--in", str(FIX / name), "--out", str(out)],
            capture_output=True, text=True, check=False,
        )
        line = next(ln for ln in proc.stdout.splitlines() if ln.startswith("CAD_NORMALIZE_OK"))
        payload = json.loads(line.split(" ", 1)[1])
        assert payload["step_deferred"] is deferred
        assert out.exists() is (not deferred)
        assert io.geometry_file_exists(out)
