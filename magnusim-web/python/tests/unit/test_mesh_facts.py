"""Mesh facts, the Courant-rate table and the run estimate (run health RH2, part 1).

Fixtures (``tests/fixtures/mesh-facts``, see its README.md): real OpenFOAM v2606 output from
small cases made in WSL on one core: checkMesh reports (two good meshes, a skewed one, one
with a cell turned inside out, one of very thin cells), snappyHexMesh's log with its layer
report, two meshes (a graded 2D contraction, ascii and binary, and a snappy mesh around a
sphere with two layers) and the Courant numbers pimpleFoam logged on them at a fixed time
step.
"""

from __future__ import annotations

import gzip
import json
import math
import os
import shutil
from pathlib import Path

import pytest
from magnusim_sdk import courant_rates, mesh_facts, run_estimate
from magnusim_sdk.courant_rates import rate_along, rate_table
from magnusim_sdk.mesh_facts import (
    build_mesh_facts,
    checkmesh_bbox,
    first_layer_m,
    load_mesh_facts,
    mesher_of,
    parse_checkmesh,
    parse_snappy_layers,
    read_mesh_facts,
    record_quality,
    snappy_layer_expansions,
    write_mesh_facts,
)
from magnusim_sdk.run_estimate import (
    DEFAULT_S_PER_CELL_STEP,
    courant_at,
    estimate_run,
    pc_solve_rate,
    solve_rate_sample,
)

from tests.conftest import FIXTURES

FIX = FIXTURES / "mesh-facts"
CHECKMESH = FIX / "checkmesh"
LOGGED = json.loads((FIX / "courant-logged.json").read_text(encoding="utf-8"))


def _log(name: str) -> str:
    return (CHECKMESH / name).read_text(encoding="utf-8")


def _case(tmp_path: Path, mesh: str, name: str = "case") -> Path:
    """A case folder holding one of the fixture meshes (gunzipped, as the meshers write them)."""
    case = tmp_path / name
    poly = case / "constant" / "polyMesh"
    poly.mkdir(parents=True)
    for gz in (FIX / mesh / "constant" / "polyMesh").glob("*.gz"):
        (poly / gz.stem).write_bytes(gzip.decompress(gz.read_bytes()))
    return case


# ---------------------------------------------------------------------------
# checkMesh
# ---------------------------------------------------------------------------


def test_checkmesh_ok_reports():
    q = parse_checkmesh(_log("ok-hex-2d.log"))
    assert q["known"] is True and q["ok"] is True and q["n_failed"] == 0 and q["failed"] == []
    assert q["n_cells"] == 960
    assert q["max_non_orthogonality"] == 0.0
    assert q["max_aspect_ratio"] == pytest.approx(2.801584594)
    assert q["min_volume_m3"] == pytest.approx(8.594009138e-05)
    assert q["total_volume_m3"] == pytest.approx(0.24)
    s = parse_checkmesh(_log("ok-snappy-layers.log"))
    assert (s["ok"], s["n_cells"], s["max_non_orthogonality"], s["max_skewness"]) == (True, 3468, pytest.approx(31.64049603), pytest.approx(0.5783786725))
    assert s["avg_non_orthogonality"] == pytest.approx(12.35260668)


def test_checkmesh_skewed_is_a_failed_check_the_meshers_accept():
    q = parse_checkmesh(_log("skewed.log"))
    assert (q["ok"], q["n_failed"]) == (False, 1)
    assert q["failed"] == [{"check": "skewness", "count": 22, "unit": "faces", "accepted": True}]
    assert q["max_skewness"] == pytest.approx(8.000000342)
    assert q["skewed_faces"] == 22
    # A warning (one star), not a failure: the faces over 70 degrees.
    assert q["severe_non_orthogonal_faces"] == 750
    assert q["max_non_orthogonality"] == pytest.approx(72.64597596)


def test_checkmesh_negative_volume_fails_four_checks_none_accepted():
    q = parse_checkmesh(_log("negative-volume.log"))
    assert (q["ok"], q["n_failed"]) == (False, 4)
    assert [(f["check"], f["count"], f["unit"], f["accepted"]) for f in q["failed"]] == [
        ("non_aligned_edges", 1, "edges", False),
        ("negative_volume", 1, "cells", False),
        ("non_orthogonality", 3, "faces", False),
        ("face_pyramids", 4, "faces", False),
    ]
    assert q["max_non_orthogonality"] == pytest.approx(107.448358)
    assert q["min_volume_m3"] == pytest.approx(-6.768447007e-05)
    assert q["total_volume_m3"] is None


def test_checkmesh_high_aspect_ratio_over_eight_cells_is_not_accepted():
    q = parse_checkmesh(_log("high-aspect-ratio.log"))
    assert q["failed"] == [{"check": "aspect_ratio", "count": 36, "unit": "cells", "accepted": False}]
    assert q["max_aspect_ratio"] == pytest.approx(8333.33)
    few = _log("high-aspect-ratio.log").replace("number of cells 36", "number of cells 5")
    assert parse_checkmesh(few)["failed"][0]["accepted"] is True


def test_checkmesh_without_a_verdict_is_not_known():
    assert parse_checkmesh("") == {"known": False}
    assert parse_checkmesh(None) == {"known": False}
    cut = _log("ok-hex-2d.log").split("Checking geometry")[0]
    assert parse_checkmesh(cut) == {"known": False}
    other = _log("ok-hex-2d.log").replace("Mesh OK.", " ***Some new check failed: 3 things\n\nFailed 1 mesh checks.")
    q = parse_checkmesh(other)
    assert q["failed"] == [{"check": "other", "count": None, "unit": None, "accepted": False, "text": "Some new check failed: 3 things"}]


def test_checkmesh_box_and_the_record_quality():
    assert checkmesh_bbox(_log("ok-hex-2d.log")) == {"min": [0.0, 0.0, 0.0], "max": [3.0, 1.0, 0.1], "size": [3.0, 1.0, 0.1]}
    assert checkmesh_bbox("nothing") is None
    rec = record_quality(parse_checkmesh(_log("negative-volume.log")))
    assert set(rec) == {
        "known", "ok", "n_failed", "failed", "max_non_orthogonality", "avg_non_orthogonality",
        "severe_non_orthogonal_faces", "max_skewness", "skewed_faces", "max_aspect_ratio", "min_volume_m3",
    }
    assert record_quality({"known": False, "max_skewness": 3}) == {"known": False}
    assert record_quality(None) == {"known": False}
    many = {"known": True, "failed": [{"check": "other", "text": str(i)} for i in range(20)]}
    assert len(record_quality(many)["failed"]) == mesh_facts.RECORD_FAILED_MAX


# ---------------------------------------------------------------------------
# Boundary layers
# ---------------------------------------------------------------------------

_STANDARD_LAYERS = """
Layer mesh : cells:1200  faces:4000  points:1500

patch faces        layers        overall thickness
              target   mesh     [m]       [%]
----- -----    -----    ----     ---       ---
wall 300      3        2.9      0.0019    95
wall_bl2 100  3        3        0.00095   100
inlet_wall 50 3        0        0         0

Layer mesh : cells:1200  faces:4000  points:1500
"""


def test_snappy_layer_report():
    rows = parse_snappy_layers((FIX / "sphere" / "log.snappyHexMesh").read_text(encoding="utf-8"))
    assert rows == [{"patch": "ball", "faces": 416, "layers_asked": 2.0, "layers": 2.0, "total_m": 0.0367}]
    old = "patch faces layers overall thickness\n                   [m]       [%]\n----- ----- ------ ---       ---\nwall  10    1.5    0.002     80\n"
    assert parse_snappy_layers(old) == [{"patch": "wall", "faces": 10, "layers_asked": None, "layers": 1.5, "total_m": 0.002}]
    assert parse_snappy_layers("no report") is None
    assert len(parse_snappy_layers(_STANDARD_LAYERS)) == 3


def test_layer_expansions_and_first_layer():
    glob, per = snappy_layer_expansions((FIX / "sphere" / "system" / "snappyHexMeshDict").read_text(encoding="utf-8"))
    assert (glob, per) == (1.2, {})
    d = "addLayersControls\n{\n  layers\n  {\n    wall { nSurfaceLayers 3; expansionRatio 1.5; }\n    \"inlet.*\" { nSurfaceLayers 2; }\n  }\n  expansionRatio 1.1; // global\n}\n"
    assert snappy_layer_expansions(d) == (1.1, {"wall": 1.5})
    assert snappy_layer_expansions("") == (None, {})
    # The sphere's two layers grow by 1.2 to 36.7 mm: a 16.7 mm first layer.
    assert first_layer_m(0.0367, 2.0, 1.2) == pytest.approx(0.0367 * 0.2 / 0.44)
    assert first_layer_m(0.003, 3.0, 1.0) == pytest.approx(0.001)
    assert first_layer_m(0.003, 0.2, 1.2) is None
    assert first_layer_m(0.0, 2, 1.2) is None


# ---------------------------------------------------------------------------
# The three meshers' records, normalised
# ---------------------------------------------------------------------------


def _write(path: Path, doc: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc) if not isinstance(doc, str) else doc, encoding="utf-8")


def test_standard_facts(tmp_path: Path):
    case = _case(tmp_path, "contraction")
    shutil.copy(CHECKMESH / "ok-hex-2d.log", case / "log.checkMesh")
    _write(case / "log.snappyHexMesh", _STANDARD_LAYERS)
    # As generate_standard.py writes it (a trimmed copy).
    _write(case / "standard-meta.json", {
        "path_kind": "standard",
        "add_layers": True,
        "layers_applied": True,
        "sizing": {"bbox_m": [3.0, 1.0, 0.1], "surface_size_m": 0.004, "core_size_m": 0.004,
                   "layers": {"n": 3, "total_thickness_m": 0.0016, "expansion": 1.5, "relative_thickness": 0.4}},
        "inflate_boundary_layer": [{"patch": "inlet_wall", "n_layers": 3, "expansion": 1.3, "skipped": False}],
    })
    f = build_mesh_facts(case)
    assert f["mesher"] == "standard"
    assert (f["n_cells"], f["surface_cell_m"], f["part_size_m"]) == (960, 0.004, [3.0, 1.0, 0.1])
    assert f["bbox_m"]["size"] == [3.0, 1.0, 0.1]
    lay = f["layers"]
    assert (lay["asked"], lay["applied"]) == (True, True)
    walls = {w["patch"]: w for w in lay["walls"]}
    # The size band joins its patch: 400 faces, layers face-weighted, the thinner band's first layer kept.
    assert walls["wall"]["faces"] == 400
    assert walls["wall"]["layers"] == pytest.approx((300 * 2.9 + 100 * 3) / 400, abs=1e-3)
    first_wall = first_layer_m(0.0019, 2.9, 1.5)
    first_band = first_layer_m(0.00095, 3, 1.5)
    assert walls["wall"]["first_min_m"] == pytest.approx(first_band, rel=1e-3)
    assert walls["wall"]["first_m"] == pytest.approx((300 * first_wall + 100 * first_band) / 400, rel=1e-3)
    # The Inflate patch's own growth (1.3) is used; it got no layers.
    assert walls["inlet_wall"]["layers"] == 0 and walls["inlet_wall"]["first_m"] is None
    assert lay["first_m"] == pytest.approx(walls["wall"]["first_m"], rel=1e-3)


def test_standard_layers_dropped(tmp_path: Path):
    case = _case(tmp_path, "contraction")
    _write(case / "standard-meta.json", {"add_layers": True, "layers_applied": False, "sizing": {"surface_size_m": 0.01}})
    _write(case / "log.snappyHexMesh", "layers off (no snappyHexMeshDict)\n")
    f = build_mesh_facts(case)
    assert f["quality"] == {"known": False}
    assert f["layers"] == {"asked": True, "applied": False, "first_m": None, "walls": []}


def test_cfmesh_facts(tmp_path: Path):
    case = _case(tmp_path, "contraction")
    shutil.copy(CHECKMESH / "skewed.log", case / "log.checkMesh")
    # As generate_cfmesh_standard.py writes it (trimmed).
    _write(case / "w28-cfmesh-meta.json", {
        "path_kind": "cartesianMesh", "backend": "cfmesh", "add_layers": True, "layers_applied": True,
        "first_layer_m": 0.0004, "wall_boundary_layers": 3, "base_cell_m": 0.01,
        "prep": {"max_cell_m": 0.01, "boundary_cell_m": 0.004, "skin_cell_m": 0.002},
        "inflate_boundary_layer": [],
    })
    f = build_mesh_facts(case)
    assert f["mesher"] == "cfmesh"
    assert f["surface_cell_m"] == 0.002
    assert f["layers"] == {"asked": True, "applied": True, "first_m": 0.0004, "walls": []}
    assert f["quality"]["failed"][0]["check"] == "skewness"
    _write(case / "w28-cfmesh-meta.json", {"add_layers": True, "layers_applied": False, "first_layer_m": 0.0004, "prep": {"boundary_cell_m": 0.004}})
    f = build_mesh_facts(case)
    assert (f["surface_cell_m"], f["layers"]["applied"], f["layers"]["first_m"]) == (0.004, False, None)


def test_hexdominant_facts(tmp_path: Path):
    case = _case(tmp_path, "sphere")
    shutil.copy(CHECKMESH / "ok-snappy-layers.log", case / "log.checkMesh")
    shutil.copy(FIX / "sphere" / "log.snappyHexMesh", case / "log.snappyHexMesh")
    (case / "system").mkdir()
    shutil.copy(FIX / "sphere" / "system" / "snappyHexMeshDict", case / "system" / "snappyHexMeshDict")
    _write(case / "system" / "blockMeshDict", (
        "FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }\n"
        "convertToMeters 1;\nvertices\n(\n    (-1 -0.6 -0.6) (1.6 -0.6 -0.6) (1.6 0.6 -0.6) (-1 0.6 -0.6)\n"
        "    (-1 -0.6 0.6) (1.6 -0.6 0.6) (1.6 0.6 0.6) (-1 0.6 0.6)\n);\n"
        "blocks\n(\n    hex (0 1 2 3 4 5 6 7) (13 6 6) simpleGrading (1 1 1)\n);\n"
    ))
    # As generate_snappy.py writes it (trimmed): the sphere's case had level 2 on the walls.
    _write(case / "w23-geometry-meta.json", {
        "add_layers": True, "walls_level": 2, "layers": [{"patch": "ball", "n_layers": 2}],
        "bounds_m": {"xmin": -0.3, "xmax": 0.3, "ymin": -0.3, "ymax": 0.3, "zmin": -0.3, "zmax": 0.3},
    })
    f = build_mesh_facts(case)
    assert f["mesher"] == "hexdominant"
    assert f["part_size_m"] == [0.6, 0.6, 0.6]
    # Background cells of 0.2 m, two levels down at the walls.
    assert f["surface_cell_m"] == pytest.approx(0.05)
    assert f["layers"]["asked"] is True and f["layers"]["applied"] is True
    [ball] = f["layers"]["walls"]
    assert (ball["patch"], ball["faces"], ball["layers"], ball["total_m"]) == ("ball", 416, 2.0, 0.0367)
    assert ball["first_m"] == pytest.approx(0.01668, rel=1e-3)
    assert f["layers"]["first_m"] == pytest.approx(0.01668, rel=1e-3)
    # Layers asked but none made: dropped.
    _write(case / "log.snappyHexMesh", (FIX / "sphere" / "log.snappyHexMesh").read_text(encoding="utf-8").replace(
        "ball 416      2        2        0.0367    100", "ball 416      2        0        0         0"))
    assert build_mesh_facts(case)["layers"]["applied"] is False
    # Asked, and no report at all (snappy never reached layers): not known.
    (case / "log.snappyHexMesh").unlink()
    assert build_mesh_facts(case)["layers"]["applied"] is None


def test_newest_mesher_record_wins_and_a_plugin_mesh_has_quality_only(tmp_path: Path):
    case = _case(tmp_path, "contraction")
    assert mesher_of(case) is None
    shutil.copy(CHECKMESH / "ok-hex-2d.log", case / "log.checkMesh")
    f = build_mesh_facts(case)
    assert (f["mesher"], f["quality"]["ok"], f["surface_cell_m"]) == (None, True, None)
    _write(case / "w23-geometry-meta.json", {"walls_level": 1})
    _write(case / "standard-meta.json", {"sizing": {}})
    later = case / "standard-meta.json"
    os.utime(later, ns=(later.stat().st_atime_ns, (case / "w23-geometry-meta.json").stat().st_mtime_ns + 10**9))
    assert mesher_of(case) == "standard"
    assert build_mesh_facts(case, mesher="hexdominant")["mesher"] == "hexdominant"


def test_facts_are_kept_beside_the_mesh_and_go_stale_with_it(tmp_path: Path):
    case = _case(tmp_path, "contraction")
    shutil.copy(CHECKMESH / "ok-hex-2d.log", case / "log.checkMesh")
    assert read_mesh_facts(case) is None
    assert load_mesh_facts(case) is None
    # A mesh made before the facts existed: built on request, then kept.
    built = load_mesh_facts(case, build=True)
    assert built is not None and (case / mesh_facts.FACTS_FILE).is_file() and (case / courant_rates.RATES_FILE).is_file()
    assert built["courant_rates"]["n_cells"] == 960
    assert "top" not in built["courant_rates"]
    assert read_mesh_facts(case) == json.loads((case / mesh_facts.FACTS_FILE).read_text(encoding="utf-8"))
    assert courant_rates.read_rates(case)["top"][0][0] >= 0
    # The mesh is generated again: the old facts and rates are not read.
    pts = case / "constant" / "polyMesh" / "points"
    pts.write_text(pts.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert read_mesh_facts(case) is None
    assert courant_rates.read_rates(case) is None
    assert load_mesh_facts(None) is None
    assert load_mesh_facts(tmp_path / "nothing", build=True) is None


def test_write_mesh_facts_never_fails_on_an_unreadable_mesh(tmp_path: Path):
    case = tmp_path / "case"
    (case / "constant" / "polyMesh").mkdir(parents=True)
    (case / "constant" / "polyMesh" / "owner").write_text("not a mesh", encoding="utf-8")
    f = write_mesh_facts(case)
    assert f["courant_rates"]["skipped"].startswith("the mesh could not be read")
    assert f["quality"] == {"known": False}
    assert not (case / courant_rates.RATES_FILE).exists()


def test_rates_skipped_above_the_cell_cap(tmp_path: Path):
    case = _case(tmp_path, "contraction")
    assert courant_rates.write_rates(case, max_cells=100) == {"skipped": "over 100 cells"}
    assert courant_rates.read_rates(case) is None


# ---------------------------------------------------------------------------
# The Courant-rate table
# ---------------------------------------------------------------------------


def _cube(case: Path, side: float, kind: str) -> None:
    """One hex cell of the given side; its six faces in one patch of type ``kind``."""
    poly = case / "constant" / "polyMesh"
    poly.mkdir(parents=True)
    head = 'FoamFile\n{{\n    version 2.0;\n    format ascii;\n    class {c};\n    {n}object {o};\n}}\n'
    pts = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (0, 4, 7, 3), (1, 2, 6, 5)]
    note = 'note "nPoints:8  nCells:1  nFaces:6  nInternalFaces:0";\n    '
    (poly / "points").write_text(head.format(c="vectorField", n="", o="points") + "8\n(\n" + "".join(f"({x * side} {y * side} {z * side})\n" for x, y, z in pts) + ")\n")
    (poly / "faces").write_text(head.format(c="faceList", n="", o="faces") + "6\n(\n" + "".join(f"4({a} {b} {c} {d})\n" for a, b, c, d in faces) + ")\n")
    (poly / "owner").write_text(head.format(c="labelList", n=note, o="owner") + "6\n(\n0\n0\n0\n0\n0\n0\n)\n")
    (poly / "neighbour").write_text(head.format(c="labelList", n=note, o="neighbour") + "0\n(\n)\n")
    (poly / "boundary").write_text(head.format(c="polyBoundaryMesh", n="", o="boundary") + f"1\n(\n    all\n    {{\n        type {kind};\n        nFaces 6;\n        startFace 0;\n    }}\n)\n")


def test_a_cube_of_side_h_has_rate_one_over_h(tmp_path: Path):
    _cube(tmp_path / "a", 1.0, "patch")
    assert rate_table(tmp_path / "a" / "constant" / "polyMesh")["max"] == [1.0, 1.0, 1.0]
    _cube(tmp_path / "b", 0.002, "patch")
    t = rate_table(tmp_path / "b" / "constant" / "polyMesh")
    assert t["p99_9"] == [pytest.approx(500.0)] * 3
    assert t["bbox_m"]["size"] == [0.002, 0.002, 0.002]
    # Wall faces carry no flux.
    _cube(tmp_path / "c", 1.0, "wall")
    assert rate_table(tmp_path / "c" / "constant" / "polyMesh")["max"] == [0.0, 0.0, 0.0]


def test_ascii_and_binary_meshes_give_one_table(tmp_path: Path):
    a = rate_table(_case(tmp_path, "contraction", "a") / "constant" / "polyMesh")
    b = rate_table(_case(tmp_path, "contraction-binary", "b") / "constant" / "polyMesh")
    assert a == b
    assert (a["n_cells"], a["bad_cells"], len(a["top"])) == (960, 0, 960)
    # A 2D mesh: no rate across its empty faces.
    assert a["max"][2] == 0.0


@pytest.mark.parametrize("mesh", ["contraction", "sphere"])
def test_the_table_against_the_courant_numbers_a_real_solve_logged(tmp_path: Path, mesh: str):
    """pimpleFoam (v2606, fixed time step, flow started uniform at the inflow speed) on the
    fixture mesh. Its first step's largest Courant number is the inflow speed x the time step x
    the largest rate along the flow: the table is exact there. Over the run the flow speeds up
    past the inflow speed (the contraction's step corner, the sphere's sides); the estimate's
    1.5 x the 99.9th percentile is within 0.5-2x of the largest Courant number logged."""
    run = LOGGED[mesh]
    table = rate_table(_case(tmp_path, mesh) / "constant" / "polyMesh")
    u, dt, d = run["inflow_speed"], run["delta_t"], run["direction"]
    first = run["courant_max"][0]
    assert u * dt * max(r[1] for r in table["top"]) == pytest.approx(first, rel=0.02)
    est = courant_at(table, speed=u, direction=d, delta_t=dt)
    assert est is not None
    assert 0.5 <= max(run["courant_max"]) / est <= 2.0


def test_rate_along_a_direction(tmp_path: Path):
    t = rate_table(_case(tmp_path, "sphere") / "constant" / "polyMesh")
    assert rate_along(t, (1, 0, 0)) == t["p99_9"][0]
    assert rate_along(t, (0, -5, 0)) == t["p99_9"][1]
    assert rate_along(t, (0.9999, 0.0001, 0)) == t["p99_9"][0]
    diag = rate_along(t, (1, 1, 0))
    # Never below the rate along either axis it leans on, never above the sum of the axes'.
    assert min(t["p99_9"][:2]) * math.sqrt(0.5) <= diag <= math.sqrt(0.5) * (t["max"][0] + t["max"][1]) + 1e-9
    assert rate_along(t, (0, 0, 0)) is None
    assert rate_along(None, (1, 0, 0)) is None
    assert rate_along(t, "x") is None
    # Past the kept cells (a mesh of more than 2 million cells): the axes' percentiles, combined.
    big = {**t, "n_rated": 10_000_000, "top": t["top"][:10]}
    assert rate_along(big, (1, 1, 0)) == pytest.approx(math.sqrt(0.5) * (t["p99_9"][0] + t["p99_9"][1]))


# ---------------------------------------------------------------------------
# The estimate and this PC's rate
# ---------------------------------------------------------------------------

# A table with Run_2's convective rate: about 9.0e4 1/s at 22.6 m/s and 1.5x (spec 1).
_RUN2_RATE = 9.0e4 / (22.6 * 1.5)
_RUN2 = {"v": 1, "n_cells": 625000, "n_rated": 625000, "p99_9": [_RUN2_RATE, 1.0, 1.0], "max": [_RUN2_RATE * 1.2, 1.0, 1.0], "top": []}


def test_run2_estimate():
    """Run_2 at Max Courant 1: about 1.1e-5 s, about 900,000 steps for 10 s, about 6 days on 15
    cores (spec 1); at Max Courant 5 with 3 outer loops, about 180,000 steps."""
    e = estimate_run(_RUN2, max_co=1, speed=22.6, direction=(1, 0, 0), end_time=10, cells=625000, ranks=15,
                     bbox_m={"size": [0.6, 0.3, 0.3]})
    assert e is not None
    assert e["delta_t_s"] == pytest.approx(1.11e-5, rel=0.01)
    assert e["steps"] == pytest.approx(900_000, rel=0.01)
    assert e["wall_s"] / 86400 == pytest.approx(6.1, rel=0.02)
    assert e["flow_through_s"] == pytest.approx(0.6 / 22.6)
    assert (e["co"], e["speed_factor"], e["rate_per_m"]) == (1.0, 1.5, _RUN2_RATE)
    e5 = estimate_run(_RUN2, max_co=5, speed=22.6, end_time=10, cells=625000, ranks=15, n_outer=3)
    assert e5["steps"] == pytest.approx(180_000, rel=0.01)
    assert e5["wall_s"] == pytest.approx(e["wall_s"] / 5 * 3, rel=0.001)
    # A measured rate on this PC replaces Run_2's.
    fast = estimate_run(_RUN2, max_co=1, speed=22.6, end_time=10, cells=625000, ranks=15, s_per_cell_step=7e-6)
    assert fast["wall_s"] == pytest.approx(e["wall_s"] / 2, rel=0.01)


def test_fixed_step_estimate_and_missing_inputs():
    e = estimate_run(_RUN2, max_co=1, speed=22.6, end_time=1, delta_t=1e-4)
    assert e["co"] == pytest.approx(9.0, rel=0.01)  # "a fixed step of 1e-4 s gives about 9"
    assert e["steps"] == 10000
    assert e["wall_s"] is None and e["flow_through_s"] is None
    assert courant_at(_RUN2, speed=22.6, direction=(1, 0, 0), delta_t=1e-4) == pytest.approx(9.0, rel=0.01)
    assert estimate_run(None, max_co=1, speed=22.6) is None
    assert estimate_run(_RUN2, max_co=1, speed=0) is None
    assert estimate_run(_RUN2, max_co=1, speed=22.6)["steps"] is None
    assert courant_at(_RUN2, speed=22.6, direction=(1, 0, 0), delta_t=0) is None


def test_pc_solve_rate():
    assert pc_solve_rate(None) == {"s_per_cell_step": DEFAULT_S_PER_CELL_STEP, "runs": 0, "source": "default"}
    assert pc_solve_rate({"solve_rate": {"samples": [{"s_per_cell_step": "x"}, None]}})["source"] == "default"
    three = {"solve_rate": {"samples": [{"s_per_cell_step": 3e-5}, {"s_per_cell_step": 1e-5}, {"s_per_cell_step": 2e-5}]}}
    assert pc_solve_rate(three) == {"s_per_cell_step": 2e-5, "runs": 3, "source": "measured"}
    many = {"solve_rate": {"samples": [{"s_per_cell_step": (i + 1) * 1e-6} for i in range(25)]}}
    r = pc_solve_rate(many)
    assert (r["runs"], r["s_per_cell_step"]) == (20, pytest.approx(15.5e-6))
    # Run_2: 0.6 s per step, 625,000 cells on 15 ranks, 1 outer loop.
    assert solve_rate_sample(solve_s=600, steps=1000, cells=625000, ranks=15) == pytest.approx(1.44e-5, rel=1e-3)
    assert solve_rate_sample(solve_s=600, steps=1000, cells=625000, ranks=15, n_outer=3) == pytest.approx(0.48e-5, rel=1e-3)
    assert solve_rate_sample(solve_s=None, steps=1, cells=1) is None
    assert solve_rate_sample(solve_s=1, steps=0, cells=1) is None


def test_the_estimate_is_kept_apart_from_the_written_time_step():
    """No case writer reads the rate table or the estimate (critique 12): the written auto
    time step keeps its own estimate (IF transient.estimate_delta_t, the goldens)."""
    web = Path(__file__).resolve().parents[3]
    for plugin in ("incompressible_flow", "heat_transfer"):
        for path in (web / "bundled-plugins" / plugin / plugin).rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            assert "courant_rates" not in text and "run_estimate" not in text, path
    assert run_estimate.SPEED_FACTOR == 1.5
