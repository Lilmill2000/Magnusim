"""Unit tests for host-side snappy hex-dominant prep (Step 6)."""
from __future__ import annotations

from pathlib import Path

from cfddesk.mesh.snappy_hexdominant import (
    block_from_fineness,
    fineness_params,
    read_polymesh_counts,
    scale_body1_stl,
    write_hexdominant_dicts,
)
from cfddesk.mesh.snappy_policy import SNAPPY_GEOMETRY_REV


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
    bounds = {"xmin": 0.0, "xmax": 0.05, "ymin": 0.0, "ymax": 0.04, "zmin": 0.0, "zmax": 0.03}
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
