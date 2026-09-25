"""Unit tests for host-side snappy hex-dominant prep (Step 6)."""
from __future__ import annotations

import struct
from pathlib import Path

import pytest

from cfddesk.mesh.snappy_hexdominant import (
    block_from_fineness,
    fineness_params,
    read_feature_marks,
    read_polymesh_counts,
    scale_body1_stl,
    write_hexdominant_dicts,
)
from cfddesk.mesh.snappy_policy import SNAPPY_GEOMETRY_REV

# Two triangles in mm spanning x 0..10, y -5..20, z 3..40.
_TRIS_MM = [
    ((0.0, 0.0, 1.0), [(0.0, -5.0, 3.0), (10.0, 0.0, 3.0), (0.0, 20.0, 3.0)]),
    ((1.0, 0.0, 0.0), [(10.0, 0.0, 3.0), (10.0, 20.0, 40.0), (10.0, -5.0, 40.0)]),
]
_BOUNDS_M = {
    "xmin": 0.0,
    "xmax": 0.010,
    "ymin": -0.005,
    "ymax": 0.020,
    "zmin": 0.003,
    "zmax": 0.040,
}


def _write_binary_stl(path: Path) -> None:
    buf = bytearray(b"binary test".ljust(80, b"\0"))
    buf += struct.pack("<I", len(_TRIS_MM))
    for normal, verts in _TRIS_MM:
        buf += struct.pack("<12fH", *normal, *(c for v in verts for c in v), 0)
    path.write_bytes(bytes(buf))


def _write_ascii_stl(path: Path) -> None:
    lines = ["solid Body1"]
    for normal, verts in _TRIS_MM:
        lines.append("facet normal {} {} {}".format(*normal))
        lines.append(" outer loop")
        lines += ["  vertex {} {} {}".format(*v) for v in verts]
        lines += [" endloop", "endfacet"]
    lines.append("endsolid Body1")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def _bounds_of(points) -> dict[str, float]:
    xs, ys, zs = zip(*points, strict=True)
    return {
        "xmin": min(xs),
        "xmax": max(xs),
        "ymin": min(ys),
        "ymax": max(ys),
        "zmin": min(zs),
        "zmax": max(zs),
    }


def _assert_bounds(bounds: dict) -> None:
    for key, expected in _BOUNDS_M.items():
        assert bounds[key] == pytest.approx(expected, abs=1e-9), key


def test_scale_body1_stl_binary(tmp_path: Path):
    src = tmp_path / "in.stl"
    _write_binary_stl(src)
    dst = tmp_path / "tri" / "Body1.stl"
    res = scale_body1_stl(src, dst)

    raw = dst.read_bytes()
    assert len(raw) == 84 + 50 * len(_TRIS_MM) == res["body1_bytes"]
    assert not raw[:5].lower().startswith(b"solid")  # still reads as binary
    assert struct.unpack_from("<I", raw, 80)[0] == len(_TRIS_MM)
    assert res["bounds_m"]["ntri"] == len(_TRIS_MM)
    _assert_bounds(res["bounds_m"])
    points = []
    for i in range(len(_TRIS_MM)):
        vals = struct.unpack_from("<12fH", raw, 84 + 50 * i)
        points += [vals[3:6], vals[6:9], vals[9:12]]
    _assert_bounds(_bounds_of(points))


def test_scale_body1_stl_ascii(tmp_path: Path):
    src = tmp_path / "in.stl"
    _write_ascii_stl(src)
    dst = tmp_path / "tri" / "Body1.stl"
    res = scale_body1_stl(src, dst)

    text = dst.read_text(encoding="ascii")
    assert "\\n" not in text
    assert text.endswith("\n")
    lines = text.splitlines()
    assert lines[0] == "solid Body1_W23"
    assert lines[-1] == "endsolid Body1_W23"
    assert sum(ln.startswith("facet normal") for ln in lines) == len(_TRIS_MM)
    assert sum(ln == "endfacet" for ln in lines) == len(_TRIS_MM)
    points = [tuple(map(float, ln.split()[1:])) for ln in lines if ln.lstrip().startswith("vertex")]
    assert len(points) == 3 * len(_TRIS_MM)
    _assert_bounds(_bounds_of(points))
    _assert_bounds(res["bounds_m"])


def test_write_dicts_use_real_newlines(tmp_path: Path):
    params = fineness_params(3, bounds_m=_BOUNDS_M)
    write_hexdominant_dicts(
        tmp_path,
        block=params["block"],
        feature_level=params["feature_level"],
        walls_level=params["walls_level"],
        add_layers=True,
        snap=params["snap"],
        bounds_m=_BOUNDS_M,
    )
    for name in (
        "blockMeshDict",
        "snappyHexMeshDict",
        "surfaceFeatureExtractDict",
        "controlDict",
        "fvSchemes",
        "fvSolution",
    ):
        text = (tmp_path / "system" / name).read_text(encoding="utf-8")
        assert "\\n" not in text, name
        lines = text.splitlines()
        assert lines[:2] == ["FoamFile", "{"], name
        assert f"    object      {name};" in lines, name
    snap_lines = (tmp_path / "system" / "snappyHexMeshDict").read_text(encoding="utf-8").splitlines()
    # The leading // comment must not swallow the dict body.
    assert "castellatedMesh true;" in snap_lines
    assert "            nSurfaceLayers 2;" in snap_lines


def test_read_feature_marks(tmp_path: Path):
    log = tmp_path / "log.snappyHexMesh"
    log.write_text(
        "Marked for refinement due to explicit features    : 120 cells.\n"
        "Marked for refinement due to explicit features : 7 cells.\n",
        encoding="utf-8",
    )
    assert read_feature_marks(log) == {"marks": [120, 7], "total": 127}


def test_fineness_params_uses_snappy_policy():
    p = fineness_params(5, physics_based=True)
    assert p["snappy_geometry_rev"] == SNAPPY_GEOMETRY_REV
    assert p["walls_level"] == 2
    assert p["feature_level"] >= p["walls_level"]
    assert "n_solve_iter" in p["snap"]
    assert p["snap"]["n_solve_iter"] >= 100  # policy, not old JS 30


def test_block_from_bounds():
    b = block_from_fineness(
        5,
        {"xmin": 0, "xmax": 0.1, "ymin": 0, "ymax": 0.1, "zmin": 0, "zmax": 0.2},
    )
    assert b.startswith("(") and b.endswith(")")


def test_write_dicts_and_counts(tmp_path: Path):
    # minimal ASCII STL
    stl = tmp_path / "Body1.stl"
    stl.write_text(
        "solid Body1\n"
        "facet normal 0 0 1\n outer loop\n"
        "  vertex 0 0 0\n  vertex 10 0 0\n  vertex 0 10 0\n"
        "endloop\nendfacet\nendsolid Body1\n",
        encoding="ascii",
    )
    case = tmp_path / "case"
    case.mkdir()
    tri = case / "constant" / "triSurface"
    scaled = scale_body1_stl(stl, tri / "Body1.stl")
    assert scaled["body1_bytes"] > 0
    assert scaled["bounds_m"]["xmax"] <= 0.02  # mm->m
    params = fineness_params(3, bounds_m=scaled["bounds_m"])
    meta = write_hexdominant_dicts(
        case,
        block=params["block"],
        feature_level=params["feature_level"],
        walls_level=params["walls_level"],
        add_layers=False,
        snap=params["snap"],
        bounds_m=scaled["bounds_m"],
    )
    assert (case / "system" / "snappyHexMeshDict").is_file()
    assert (case / "system" / "blockMeshDict").is_file()
    assert "locationInMesh" in meta
    # no polymesh yet
    counts = read_polymesh_counts(case)
    assert counts["n_cells"] is None


def test_snappy_template_exists():
    root = Path(__file__).resolve().parents[2]
    sh = root / "cfddesk" / "wsl" / "templates" / "snappy_hexdominant.sh"
    assert sh.is_file()
    text = sh.read_text(encoding="utf-8")
    assert "__DST__" in text and "MAGNUSIM_EVENT" in text
    assert "python3" not in text  # no embedded python heredocs
