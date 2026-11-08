"""A long part's flat end faces on Hex-dominant (2026-11-08): the block's ends along an axis whose
cells are long against their side across.

F2 keeps a long part's background cells within 3 times as long as their side across, and that
left case 2's 30 D pipe at fineness 6 (80 cells along, 9.98 mm, against 3.33 mm across y) with
its inlet and outlet 9.6 % bigger than the part's discs: 344.33 mm² for 314.16. snappyHexMesh's
own steps did it (watched in a debug run, snappyHexMesh v2606):

1. Castellation: where a level's cells cross the part's plane, the cell that holds the plane is
   kept when its centre is in the part, so the castellated face lands up to half a cell inside
   the part or outside. Case 2's inlet landed 0.750 mm inside at the walls' level (2) and
   0.497 mm outside at the feature level (3), round the rim.
2. The snap's patch smoothing (snapControls nSmoothPatch 5) pulls a flat face into the part by
   1 - 0.955**5 = 0.2056 of its cell along the axis: the centre went to 1.263 mm inside.
3. A point is snapped only from within the snap tolerance (1.0) times its longest edge on the
   face, the short side across (0.831 mm at level 2): the centre stayed 1.263 mm inside, and the
   slanted ring between it and the rim (snapped from outside) added 30.6 mm² to each end.

Now along an axis the cap lengthened, the block keeps its counts, but its two ends move (and its
cells shrink by under one cell over the part) so that each of the part's two planes there sits
0.46 of the finest cell that can reach it inside a background cell: the face lands that little
outside the part at every level, and the pull leaves it within reach. These tests write the
dictionaries the generator writes (``generate_snappy.py --render-only``) and check those three
steps on them; ``tests/wsl/test_mesh_wsl.py`` W6 and W8 mesh the pipes and check their shape.

The cap is not needed for it. A pipe the cap leaves alone has cells up to 3 times as long as
their side across too: a 20 x 500 mm pipe at fineness 6 with physics-based meshing off (67 8 12,
the walls' level 1) kept its inlet's centre 1.87 mm inside and its ends 331.7 mm² (+5.6 %), and a
20 x 300 mm pipe at fineness 4 (42 8 12) points up to 0.63 mm inside (W9, 2026-11-08). So every
axis whose cells are long against the longer side across is aligned (``end_plane_axes``), not
only the one the cap lengthened. A block whose cells are about as long as wide keeps its corners,
byte for byte.

Fails on ce6aa3eb (F2's block, its corners the part's box times 1.33): case 2's inlet lands
0.750 mm inside the part at level 2, and ``aligned_span`` / ``lengthened_axes`` do not exist. Fails
on 6c515bc6 (only the cap's axis aligned): the 25 D pipe with physics-based meshing off lands
1.866 mm inside at level 1, case 1's pipe at fineness 4 0.375 mm inside at level 2, and the
50 D pipe at fineness 10 0.272 mm inside at level 3; ``end_plane_axes`` does not exist.
"""

from __future__ import annotations

import math
import re
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.mesh.snappy_hexdominant import (
    _PAD,
    ALIGN_GAP,
    MAX_BACKGROUND_ASPECT,
    _padded_box,
    aligned_span,
    background_of,
    block_from_fineness,
    lengthened_axes,
)
from tests.unit.test_mesh_goldens import PY, TOOLS, _env, _project, _run

# ---------------------------------------------------------------- the dictionaries written


def _part_step(tmp: Path, shape: str, dims_mm: tuple[float, float, float]) -> tuple[Path, tuple[int, int], dict[str, float]]:
    """A pipe (diameter, length) or a box (x, y, z) along +x from x = 0, its inlet the face at
    x = 0 and its outlet the face at the far end (1-based labels), and its box in metres."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step

    tmp.mkdir(parents=True, exist_ok=True)
    step = tmp / f"{shape}.step"
    if shape == "pipe":
        d_mm, l_mm, _ = dims_mm
        solid = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), d_mm / 2.0, l_mm).Shape()
        r = d_mm / 2000.0
        bounds = {"xmin": 0.0, "xmax": l_mm / 1000.0, "ymin": -r, "ymax": r, "zmin": -r, "zmax": r}
    else:
        l_mm, y_mm, z_mm = dims_mm
        solid = BRepPrimAPI_MakeBox(l_mm, y_mm, z_mm).Shape()
        bounds = {"xmin": 0.0, "xmax": l_mm / 1000.0, "ymin": 0.0, "ymax": y_mm / 1000.0, "zmin": 0.0, "zmax": z_mm / 1000.0}
    write_step(solid, step)
    faces = load_step(step).faces
    inlet = [f.face_id for f in faces if abs(f.centroid[0]) < 1e-6]
    outlet = [f.face_id for f in faces if abs(f.centroid[0] - bounds["xmax"] * 1000.0) < 1e-6]
    assert len(inlet) == 1 and len(outlet) == 1
    return step, (inlet[0] + 1, outlet[0] + 1), bounds


def _render(tmp: Path, shape: str, dims_mm: tuple[float, float, float], fineness: int, *, physics: bool = True) -> tuple[Path, dict[str, float]]:
    """The case folder ``generate_snappy.py --render-only`` writes for the part, and its box."""
    step, faces, bounds = _part_step(tmp / "step", shape, dims_mm)
    proj, mesh = _project(tmp, step=step, faces=faces)
    src = next(proj.rglob("source.step"))
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(src), "--out", str(src.with_name("Body1.stl")), "--cad-quality"],
        cwd=str(PY), env=_env(), capture_output=True, text=True, timeout=600,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    case = mesh / "case"
    _run(
        [
            str(TOOLS / "generate_snappy.py"),
            "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", "cfddesk-golden-snappy",
            "--generate-id", "golden", "--fineness", str(fineness), "--add-layers", "0", "--physics-based", "1" if physics else "0",
            "--mesh-id", "mesh_1", "--simulation-id", "sim_1", "--render-only",
        ]
    )
    return case, bounds


_VERTEX = re.compile(r"^\s*\(([-+0-9.eE]+) ([-+0-9.eE]+) ([-+0-9.eE]+)\)\s*$", re.M)


def _block(case: Path) -> tuple[list[tuple[float, float]], list[int]]:
    """The block's span (metres) and cell count along x, y and z, as blockMeshDict has them."""
    text = (case / "system" / "blockMeshDict").read_text(encoding="utf-8")
    verts = [tuple(float(v) for v in m.groups()) for m in _VERTEX.finditer(text)]
    assert len(verts) == 8, text
    counts = [int(v) for v in re.search(r"hex \([^)]*\) \((\d+) (\d+) (\d+)\)", text).groups()]  # type: ignore[union-attr]
    return [(min(v[k] for v in verts), max(v[k] for v in verts)) for k in range(3)], counts


def _snap(case: Path) -> dict[str, float]:
    """The levels and snap controls snappyHexMeshDict has: the walls' level (each surface's),
    the finest level written (features and refinement regions too), nSmoothPatch, tolerance."""
    text = (case / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
    surfaces = [int(a) for a, b in re.findall(r"level \((\d+) (\d+)\);", text) if a == b]
    singles = [int(v) for v in re.findall(r"^\s*level (\d+);", text, re.M)]
    regions = [int(v) for v in re.findall(r"levels \(\([-+0-9.eE]+ (\d+)\)\);", text)]
    return {
        "walls": min(surfaces),
        "finest": max(surfaces + singles + regions),
        "n_smooth_patch": int(re.search(r"nSmoothPatch (\d+);", text).group(1)),  # type: ignore[union-attr]
        "tolerance": float(re.search(r"tolerance ([0-9.eE+-]+);", text).group(1)),  # type: ignore[union-attr]
    }


def _landings(case: Path, bounds: dict[str, float]) -> list[dict[str, float]]:
    """At each level that can reach the part's two planes along x (walls' level to the finest):
    where the castellated face lands (mm, + inside the part), where the patch smoothing leaves it
    (+ its pull, 1 - 0.955**nSmoothPatch of the cell along x) and how far the snap reaches there
    (the tolerance times the longer cell side across)."""
    spans, counts = _block(case)
    snap = _snap(case)
    pull = 1.0 - 0.955 ** snap["n_smooth_patch"]
    out = []
    for plane, inward in ((bounds["xmin"], 1.0), (bounds["xmax"], -1.0)):
        for level in range(int(snap["walls"]), int(snap["finest"]) + 1):
            h = (spans[0][1] - spans[0][0]) / counts[0] / 2**level
            across = max((spans[k][1] - spans[k][0]) / counts[k] for k in (1, 2)) / 2**level
            k = math.floor((plane - spans[0][0]) / h)
            lo, hi = spans[0][0] + k * h, spans[0][0] + (k + 1) * h
            centre_in_part = (0.5 * (lo + hi) - plane) * inward > 0
            # The kept cell's outer face, or the removed cell's inner one.
            face = (lo if centre_in_part else hi) if inward > 0 else (hi if centre_in_part else lo)
            landed = (face - plane) * inward
            out.append({
                "plane_mm": plane * 1e3, "level": level, "landed_mm": landed * 1e3,
                "smoothed_mm": (landed + pull * h) * 1e3, "reach_mm": snap["tolerance"] * across * 1e3,
            })
    return out


# The cap lengthened these: case 2's pipe (30 D at fineness 6: 67 cells along before the cap, 80
# with it), W6's 55 D pipe, a 26 D pipe, a 40 D pipe a fineness up (walls level 3), and a 1 m
# square duct. With physics-based meshing off the walls' level is 1 and the features' 3: the
# finest is two levels up. The cap leaves the last four alone, their cells still long against
# their side across: W9's two pipes (the 25 D pipe with physics-based meshing off, case 1's pipe
# at fineness 4), case 1's pipe at its fineness 6 (its inlet landed outside the part before, by
# its block's luck) and a 50 D pipe at fineness 10.
ALIGNED = [
    ("case 2's 30 D pipe", "pipe", (20.0, 600.0, 0.0), 6, True, "(80 8 12)"),
    ("30 D, physics-based off", "pipe", (20.0, 600.0, 0.0), 6, False, "(80 8 12)"),
    ("26 D", "pipe", (20.0, 520.0, 0.0), 6, True, "(70 8 12)"),
    ("40 D at fineness 7", "pipe", (20.0, 800.0, 0.0), 7, True, "(107 8 12)"),
    ("55 D (W6)", "pipe", (20.0, 1100.0, 0.0), 6, True, "(147 8 12)"),
    ("duct 1000 x 20 x 20", "box", (1000.0, 20.0, 20.0), 6, True, "(134 8 12)"),
    ("25 D, physics-based off (W9)", "pipe", (20.0, 500.0, 0.0), 6, False, "(67 8 12)"),
    ("case 1's 15 D pipe at fineness 4 (W9)", "pipe", (20.0, 300.0, 0.0), 4, True, "(42 8 12)"),
    ("case 1's 15 D pipe", "pipe", (20.0, 300.0, 0.0), 6, True, "(67 8 12)"),
    ("50 D at fineness 10", "pipe", (20.0, 1000.0, 0.0), 10, True, "(170 8 12)"),
]


@pytest.mark.occt
@pytest.mark.parametrize(("name", "shape", "dims", "fineness", "physics", "block"), ALIGNED, ids=[c[0] for c in ALIGNED])
def test_an_axis_of_long_cells_lands_its_end_faces_just_outside_the_part(
    tmp_path: Path, name: str, shape: str, dims: tuple[float, float, float], fineness: int, physics: bool, block: str
):
    case, bounds = _render(tmp_path, shape, dims, fineness, physics=physics)
    spans, counts = _block(case)
    # The block's counts, as before.
    assert f"({counts[0]} {counts[1]} {counts[2]})" == block == block_from_fineness(fineness, bounds), name
    # Its cells along x no longer than the padded span's were: still within 3 to 1 of y's.
    along = (spans[0][1] - spans[0][0]) / counts[0]
    assert along <= (bounds["xmax"] - bounds["xmin"]) * _PAD / counts[0] * (1 + 1e-9)
    assert along <= MAX_BACKGROUND_ASPECT * (spans[1][1] - spans[1][0]) / counts[1] * (1 + 1e-9)
    # The block holds the part with at least a cell to spare at each end.
    assert spans[0][0] <= bounds["xmin"] - along and spans[0][1] >= bounds["xmax"] + along
    rows = _landings(case, bounds)
    for row in rows:
        # The castellated face lands outside the part (the cell that holds the plane is kept),
        # and the smoothing's pull leaves it within the snap's reach.
        assert row["landed_mm"] < 0.0, (name, row)
        assert abs(row["smoothed_mm"]) <= row["reach_mm"], (name, row)


@pytest.mark.occt
@pytest.mark.parametrize(
    ("name", "shape", "dims", "fineness"),
    [
        # Cells about as long as wide: (65 13 13), and (52 9 12) at 1.04 times the side across.
        ("5 D pipe", "pipe", (20.0, 100.0, 0.0), 6),
        ("6 D pipe", "pipe", (20.0, 120.0, 0.0), 5),
        ("plate 100 x 100 x 2", "box", (100.0, 100.0, 2.0), 4),
    ],
)
def test_a_block_of_cells_about_as_long_as_wide_keeps_its_corners(tmp_path: Path, name: str, shape: str, dims: tuple[float, float, float], fineness: int):
    """Byte for byte the corners the block had (the part's box times 1.33 about its centre)."""
    from cfddesk.mesh.snappy_hexdominant import end_plane_axes

    case, bounds = _render(tmp_path, shape, dims, fineness)
    assert end_plane_axes(fineness, bounds) == []
    text = (case / "system" / "blockMeshDict").read_text(encoding="utf-8")
    verts, _loc = _padded_box(bounds)
    assert "vertices\n(\n" + "\n".join(f"    ({v[0]:.8f} {v[1]:.8f} {v[2]:.8f})" for v in verts) + "\n);" in text, name
    assert f"hex (0 1 2 3 4 5 6 7) {block_from_fineness(fineness, bounds)} simpleGrading (1 1 1)" in text


# ---------------------------------------------------------------- the rule itself


def _pipe(d_mm: float, l_mm: float) -> dict[str, float]:
    r = d_mm / 2000.0
    return {"xmin": 0.0, "xmax": l_mm / 1000.0, "ymin": -r, "ymax": r, "zmin": -r, "zmax": r}


def test_the_cap_lengthens_a_needles_long_axis_only():
    assert lengthened_axes(6, _pipe(20.0, 600.0)) == [0]  # 67 -> 80 cells along
    assert lengthened_axes(6, _pipe(20.0, 1100.0)) == [0]  # 68 -> 147
    # Within 3 to 1 already: case 1's pipe, the 10 D pipe, the elbow, a plate, a needle along z.
    assert lengthened_axes(6, _pipe(20.0, 300.0)) == []
    assert lengthened_axes(5, _pipe(20.0, 200.0)) == []
    elbow = {"xmin": -0.1524, "xmax": 0.1524, "ymin": -0.1524, "ymax": 0.1524, "zmin": -0.508, "zmax": 0.3048}
    assert lengthened_axes(5, elbow) == []
    assert lengthened_axes(4, {"xmin": 0.0, "xmax": 0.1, "ymin": 0.0, "ymax": 0.1, "zmin": 0.0, "zmax": 0.002}) == []
    assert lengthened_axes(6, {"xmin": 0.0, "xmax": 0.02, "ymin": 0.0, "ymax": 0.02, "zmin": 0.0, "zmax": 0.6}) == [2]
    assert lengthened_axes(6, None) == []


def _along(axis: int, d_mm: float, l_mm: float) -> dict[str, float]:
    """A pipe's box: ``l_mm`` along ``axis`` from 0, ``d_mm`` across."""
    r = d_mm / 2000.0
    out: dict[str, float] = {}
    for k, c in enumerate("xyz"):
        out[f"{c}min"], out[f"{c}max"] = (0.0, l_mm / 1000.0) if k == axis else (-r, r)
    return out


def test_end_plane_axes_are_the_axes_of_long_cells():
    from cfddesk.mesh.snappy_hexdominant import end_plane_axes

    # The cap's axis: case 2's pipe, the 55 D pipe, a needle along z.
    assert end_plane_axes(6, _pipe(20.0, 600.0)) == [0]
    assert end_plane_axes(6, _pipe(20.0, 1100.0)) == [0]
    assert end_plane_axes(6, _along(2, 20.0, 600.0)) == [2]
    # Long cells the cap leaves alone: case 1's pipe at fineness 6 (5.96 mm along, 1.79 times the
    # 3.33 mm across y) and 4 (9.5 mm, 2.86 times), the 25 D pipe, a 10 D pipe at fineness 5 (1.51
    # times), case 1's pipe along y and z.
    assert end_plane_axes(6, _pipe(20.0, 300.0)) == [0]
    assert end_plane_axes(4, _pipe(20.0, 300.0)) == [0]
    assert end_plane_axes(6, _pipe(20.0, 500.0)) == [0]
    assert end_plane_axes(5, _pipe(20.0, 200.0)) == [0]
    assert end_plane_axes(6, _along(1, 20.0, 300.0)) == [1]
    assert end_plane_axes(4, _along(2, 20.0, 300.0)) == [2]
    # Cells about as long as wide: short pipes, the elbow (1.02 times along z), a plate, a box
    # round a body (case 6's), and none at all without bounds.
    assert end_plane_axes(6, _pipe(20.0, 100.0)) == []
    assert end_plane_axes(5, _pipe(20.0, 120.0)) == []
    assert end_plane_axes(6, _pipe(20.0, 160.0)) == []
    elbow = {"xmin": -0.1524, "xmax": 0.1524, "ymin": -0.1524, "ymax": 0.1524, "zmin": -0.508, "zmax": 0.3048}
    assert end_plane_axes(5, elbow) == []
    assert end_plane_axes(4, {"xmin": 0.0, "xmax": 0.1, "ymin": 0.0, "ymax": 0.1, "zmin": 0.0, "zmax": 0.002}) == []
    assert end_plane_axes(4, {"xmin": -0.08, "xmax": 0.15, "ymin": -0.15, "ymax": 0.15, "zmin": -0.15, "zmax": 0.15}) == []
    assert end_plane_axes(6, None) == []
    # At fineness 1 to 3 the snap reaches further (tolerance 1.5) and pulls less (nSmoothPatch 3):
    # cells over 1.79 times the side across, not 1.06.
    assert end_plane_axes(2, _pipe(20.0, 60.0)) == []


def _model_landings(bounds: dict[str, float], axis: int, fineness: int, physics: bool) -> list[tuple[float, float, bool]]:
    """``_landings``' three steps on the block the generator writes for a part (its counts, and
    ``aligned_span`` along ``end_plane_axes`` by the finest of the walls' and the features'
    levels), at both of the part's planes on ``axis``: each level's (smoothed mm, reach mm,
    whether that axis is aligned)."""
    from cfddesk.mesh.snappy_hexdominant import end_plane_axes, walls_level_for_settings
    from cfddesk.mesh.snappy_policy import feature_refinement_level, snap_controls_for_fineness

    walls = walls_level_for_settings(fineness, physics_based=physics)
    finest = max(walls, feature_refinement_level(walls, fineness=fineness))
    counts = background_of(fineness, bounds) or [1, 1, 1]
    aligned = end_plane_axes(fineness, bounds)
    spans = []
    for k, c in enumerate("xyz"):
        lo, hi = bounds[f"{c}min"], bounds[f"{c}max"]
        if k in aligned:
            a, b, _gap = aligned_span(lo, hi, counts[k], finest)
        else:
            a, b = 0.5 * (lo + hi) - 0.5 * (hi - lo) * _PAD, 0.5 * (lo + hi) + 0.5 * (hi - lo) * _PAD
        spans.append((a, b))
    snap = snap_controls_for_fineness(fineness, has_features=True)
    pull = 1.0 - 0.955**snap.n_smooth_patch
    c = "xyz"[axis]
    out = []
    for plane, inward in ((bounds[f"{c}min"], 1.0), (bounds[f"{c}max"], -1.0)):
        for level in range(walls, finest + 1):
            h = (spans[axis][1] - spans[axis][0]) / counts[axis] / 2**level
            across = max((spans[k][1] - spans[k][0]) / counts[k] for k in range(3) if k != axis) / 2**level
            i = math.floor((plane - spans[axis][0]) / h + 1e-12)
            lo, hi = spans[axis][0] + i * h, spans[axis][0] + (i + 1) * h
            kept = (0.5 * (lo + hi) - plane) * inward > 0
            face = (lo if kept else hi) if inward > 0 else (hi if kept else lo)
            out.append((((face - plane) * inward + pull * h) * 1e3, snap.tolerance * across * 1e3, axis in aligned))
    return out


@pytest.mark.parametrize("physics", [True, False], ids=["physics-based", "physics-based off"])
def test_no_pipes_end_face_is_left_past_the_snaps_reach(physics: bool):
    """20 mm pipes 3 to 300 D long along x, y and z at every fineness: by ``_landings``' three
    steps, each end face on the block the generator writes ends within the snap's reach at every
    level, and on a block left as it was within ``ALIGN_REACH_SHARE`` of it, however it lands."""
    from cfddesk.mesh.snappy_hexdominant import ALIGN_REACH_SHARE, cell_limit_refusal

    past, checked = [], 0
    for fineness in range(1, 11):
        for axis in range(3):
            for half_d in range(6, 601):
                bounds = _along(axis, 20.0, 10.0 * half_d)
                if cell_limit_refusal(fineness, bounds):
                    continue
                checked += 1
                for smoothed, reach, aligned in _model_landings(bounds, axis, fineness, physics):
                    if abs(smoothed) > reach or (not aligned and abs(smoothed) > ALIGN_REACH_SHARE * reach):
                        past.append(("xyz"[axis], fineness, half_d / 2.0, round(smoothed, 3), round(reach, 3), aligned))
    assert checked > 17_000
    assert past == [], past[:20]


@pytest.mark.parametrize(("l_mm", "fineness", "finest"), [(600.0, 6, 3), (600.0, 6, 5), (1100.0, 6, 3), (800.0, 7, 4), (520.0, 6, 3)])
def test_aligned_span_puts_both_planes_its_gap_inside_a_background_cell(l_mm: float, fineness: int, finest: int):
    bounds = _pipe(20.0, l_mm)
    n = (background_of(fineness, bounds) or [0])[0]
    lo, hi = bounds["xmin"], bounds["xmax"]
    a, b, gap = aligned_span(lo, hi, n, finest)
    h = (b - a) / n
    fine = h / 2**finest
    # The gap: ALIGN_GAP of the finest cell, under half of it (the cell that holds the plane keeps
    # its centre in the part at every level).
    assert gap == pytest.approx(ALIGN_GAP * fine, rel=1e-12) and 0.0 < gap < 0.5 * fine
    # Each plane is the gap inside a background cell: a background face sits the gap outside it.
    for plane, outward in ((lo, -1.0), (hi, 1.0)):
        face = plane + outward * gap
        k = (face - a) / h
        assert abs(k - round(k)) < 1e-9, (plane, k)
    # The same count, cells no longer than the padded span's and within a cell of them over the part.
    padded = (hi - lo) * _PAD / n
    assert h <= padded * (1 + 1e-12)
    inner = round((hi - lo + 2 * gap) / h)
    gaps = 2 * ALIGN_GAP / 2**finest
    assert (hi - lo) / (inner - 1 - gaps) > padded
    # At least a cell beyond each end, split as evenly as the count allows.
    below, above = round((lo - gap - a) / h), round((b - hi - gap) / h)
    assert below >= 1 and above >= 1 and above - below in (0, 1)
    assert below + inner + above == n
