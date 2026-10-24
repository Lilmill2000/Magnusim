"""The CHT mesh reader on meshes of every format and at size (no WSL).

- the same box mesh written ascii, binary, with 64-bit labels and 32-bit scalars gives the
  same summary (a header's ``arch "LSB;label=64;scalar=32"`` read as such);
- a thick base with fins one cell thick is refused as thin (the share is among the cells
  at the solid's surface), a solid two cells across is not;
- an ascii polyhedral mesh (faceList) at size: the first check reads it within 5 s and
  1 GB per 2 M cells, a second check of the same mesh files reads nothing, and a new
  process reads the summary kept beside the mesh. ``HT_BENCH_CELLS`` sets the size
  (default 125 000; ``HT_BENCH_CELLS=2000000`` is the review's target); the numbers are
  printed (``-s``).
"""

from __future__ import annotations

import json
import os
import time
import tracemalloc
from pathlib import Path

import pytest
from ht_mesh_gen import box_mesh

from heat_transfer import cht, polymesh


def _fresh() -> None:
    polymesh._LAST.clear()
    polymesh._MEMO.clear()


@pytest.mark.parametrize(
    ("binary", "label", "scalar"),
    [(False, 32, 64), (True, 32, 64), (True, 64, 64), (True, 64, 32), (True, 32, 32)],
)
def test_every_format_gives_the_same_summary(tmp_path: Path, binary: bool, label: int, scalar: int):
    _fresh()
    poly = tmp_path / "constant" / "polyMesh"
    box_mesh(poly, 6, 5, 4, size=(0.06, 0.05, 0.04), zones={"solid": lambda i, j, k: k < 2, "air": lambda i, j, k: k >= 2},
             binary=binary, label=label, scalar=scalar)
    raw = (poly / "owner").read_bytes()
    head, _pos = polymesh._header(raw)
    assert polymesh._sizes(head) == (binary, 8 if label == 64 else 4, 4 if scalar == 32 else 8)
    doc = polymesh.mesh_summary(poly, thin_zones=["solid", "air"], volumes=True,
                                points=[[0.031, 0.021, 0.011], [0.031, 0.021, 0.031], [1.0, 0.0, 0.0]])
    assert doc["zone_names"] == ["solid", "air"]
    assert doc["patch_zones"]["zmin"] == {"solid": 30}
    assert doc["patch_zones"]["xmin"] == {"solid": 10, "air": 10}
    assert doc["interfaces"] == [["solid", "air", 30]]
    assert doc["thin"] == {"solid": [0, 60], "air": [0, 60]}
    assert doc["volumes"]["solid"] == pytest.approx(0.06 * 0.05 * 0.02, rel=1e-5)
    assert doc["volumes"]["air"] == pytest.approx(0.06 * 0.05 * 0.02, rel=1e-5)
    assert list(doc["located"].values()) == ["solid", "air", None]


def test_a_header_value_with_semicolons_in_quotes_is_read_whole():
    head, _pos = polymesh._header(b'FoamFile\n{\n format binary;\n arch "LSB;label=64;scalar=32";\n class labelList;\n}\n')
    assert head["arch"] == "LSB;label=64;scalar=32" and head["class"] == "labelList"
    assert polymesh._sizes(head) == (True, 8, 4)


def _sink(fin_cells: int):
    """Zones of a heat sink in HT0's proportions: a base 7 cells high (10 mm on 1.5 mm cells),
    seven fins ``fin_cells`` thick every 4 cells, 16 cells tall; air around."""
    def solid(i, j, k):
        return (k < 7) | (((i % 4) < fin_cells) & (i > 1) & (k < 23))
    return {"sink": solid, "air": lambda i, j, k: ~solid(i, j, k)}


def _sink_layout(tmp: Path, fin_cells: int) -> cht.Layout:
    poly = tmp / "constant" / "polyMesh"
    box_mesh(poly, 30, 12, 25, size=(0.045, 0.018, 0.0375), zones=_sink(fin_cells))
    rows = [{"name": "sink", "role": "solid", "bodies": ["Body2"], "cells": 0},
            {"name": "air", "role": "fluid", "bodies": ["Body1"], "cells": 0}]
    records = [
        {"id": "m-s", "name": "Sink", "material_model": "thermo_solid", "assigned_volumes": ["Body2"]},
        {"id": "m-a", "name": "Air", "material_model": "thermo_fluid", "assigned_volumes": ["Body1"]},
    ]
    _fresh()
    return cht.layout(rows, records, poly, thin=True)


def test_fins_one_cell_thick_on_a_thick_base_are_thin(tmp_path: Path):
    # Fins one cell thick on a base 7 cells high: a third of the sink's cells are thin (the
    # old share, over every cell, passed it); among the cells near its surface over half.
    lay = _sink_layout(tmp_path / "one", 1)
    n_thin, near = lay.thin["sink"]
    assert n_thin == 7 * 12 * 16 and n_thin / near >= cht.THIN_LIMIT
    assert cht.thin_problem(lay) == (
        "Body2 (Sink) is about one cell thick: "
        f"{int(100 * n_thin / near)} % of its cells at its surface touch it on every side. Refine the mesh there so the "
        "solid is at least 2 cells across (thinner solids make the solve diverge), or make the part thicker."
    )
    # The same fins two cells thick: none thin.
    lay = _sink_layout(tmp_path / "two", 2)
    assert lay.thin["sink"][0] == 0 and cht.thin_problem(lay) is None


def _bench_size() -> int:
    return int(os.environ.get("HT_BENCH_CELLS") or 125_000)


def test_a_large_ascii_polyhedral_mesh_is_checked_fast_and_kept(tmp_path: Path, monkeypatch, capsys):
    cells = _bench_size()
    n = max(4, round(cells ** (1.0 / 3.0)))
    nz = max(4, cells // (n * n))
    case = tmp_path / "mesh"
    poly = case / "constant" / "polyMesh"
    t0 = time.perf_counter()
    info = box_mesh(poly, n, n, nz, size=(0.1, 0.1, 0.1 * nz / n), zones={"solid": lambda i, j, k: k < nz // 4,
                                                                             "air": lambda i, j, k: k >= nz // 4})
    t_gen = time.perf_counter() - t0
    size_mb = sum(p.stat().st_size for p in poly.iterdir()) / 2**20

    # First check (Start's): read the mesh, patches, interfaces, how thin the solid is.
    _fresh()
    t0 = time.perf_counter()
    doc = polymesh.mesh_summary(poly, thin_zones=["solid"], keep=True)
    t_first = time.perf_counter() - t0
    assert doc["interfaces"] == [["solid", "air", n * n]]
    assert doc["patch_zones"]["zmin"] == {"solid": n * n}
    assert (case / polymesh.SUMMARY_FILE).is_file()

    # A second check of the same files reads no mesh file (in memory, then from beside the mesh).
    def boom(*_a, **_k):
        raise AssertionError("the mesh was read again")

    monkeypatch.setattr(polymesh, "read_polymesh", boom)
    t0 = time.perf_counter()
    again = polymesh.mesh_summary(poly, thin_zones=["solid"], keep=True)
    t_again = time.perf_counter() - t0
    assert again["thin"] == doc["thin"]
    polymesh._MEMO.clear()
    t0 = time.perf_counter()
    from_disk = polymesh.mesh_summary(poly, thin_zones=["solid"], keep=True)
    t_disk = time.perf_counter() - t0
    assert from_disk["interfaces"] == doc["interfaces"]
    monkeypatch.undo()

    # The same first check's peak memory (numpy's arrays are traced).
    _fresh()
    (case / polymesh.SUMMARY_FILE).unlink()
    tracemalloc.start()
    polymesh.mesh_summary(poly, thin_zones=["solid"])
    _cur, peak_first = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    # The writer's extra asks: a W/m3 source's volume, a thermocouple's region.
    polymesh._MEMO.clear()
    t0 = time.perf_counter()
    tracemalloc.start()
    vols = polymesh.mesh_summary(poly, thin_zones=["solid"], volumes=True)["volumes"]
    _cur, peak_vol = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    t_vol = time.perf_counter() - t0
    assert vols["solid"] == pytest.approx(0.1 * 0.1 * 0.1 * (nz // 4) / n, rel=1e-6)
    polymesh._MEMO.clear()
    t0 = time.perf_counter()
    tracemalloc.start()
    where = polymesh.mesh_summary(poly, points=[[0.05, 0.05, 0.001], [0.05, 0.05, 0.1 * nz / n - 0.001]])["located"]
    _cur, peak_loc = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    t_loc = time.perf_counter() - t0
    assert list(where.values()) == ["solid", "air"]

    row = {
        "cells": info["n_cells"], "faces": info["n_faces"], "files_MB": round(size_mb, 1), "generate_s": round(t_gen, 2),
        "first_check_s": round(t_first, 3), "first_check_peak_MB": round(peak_first / 2**20, 1),
        "same_mesh_again_s": round(t_again, 4), "new_process_s": round(t_disk, 4),
        "volumes_s": round(t_vol, 3), "volumes_peak_MB": round(peak_vol / 2**20, 1),
        "locate_s": round(t_loc, 3), "locate_peak_MB": round(peak_loc / 2**20, 1),
    }
    with capsys.disabled():
        print("\nHT5 mesh bench", json.dumps(row))
    # The review's targets on 2 M cells: < 5 s and < 1 GB (the parse works in pieces, a few
    # at once, so a small mesh's peak is mostly that fixed part: 96 MB is allowed for it).
    budget = 2**30 * info["n_cells"] / 2_000_000 + 96 * 2**20
    assert t_first < 5.0
    assert peak_first < budget and peak_vol < budget and peak_loc < budget
    assert t_again < 0.05 and t_disk < 0.5


def test_a_piece_of_an_ascii_face_list_is_parsed_in_little_memory():
    """A piece's parse holds about 8 times its size. It held 16 times (an array per byte to
    find the character after each number), and up to 4 pieces are parsed at once: on Linux,
    where more of them overlapped, the bench's peak went over its budget (170-174 MB of 160)."""
    piece = b"".join(b"4(%d %d %d %d)\n" % (i, i + 1, i + 2, i + 3) for i in range(100_000, 134_000))
    polymesh._face_piece(b"3(0 1 2)\n", 4)  # numpy's first-call allocations are not the piece's
    tracemalloc.start()
    sizes, labels = polymesh._face_piece(piece, 4)
    _cur, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert sizes.size == 34_000 and labels[-1] == 134_002
    assert peak < 12 * len(piece)


def test_an_ascii_face_of_many_points_written_over_several_lines_reads():
    """OpenFOAM writes a face of more than 10 points as a list over several lines."""
    piece = b"4(0 1 2 3)\n12\n(\n0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n)\n3(5 6 7)\n"
    sizes, labels = polymesh._face_piece(piece, 4)
    assert sizes.tolist() == [4, 12, 3]
    assert labels.tolist() == [0, 1, 2, 3, *range(12), 5, 6, 7]
