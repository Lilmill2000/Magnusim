"""The C-mesh (airfoil.cmesh): Gmsh's blocks round a section, checked cell by cell.

Gmsh is in the plugin's environment and in the app's own Python; without it these
tests are skipped with that reason.
"""

from __future__ import annotations

import importlib.util
import math
from collections import Counter, defaultdict
from pathlib import Path

import pytest

from airfoil import cmesh, foamcase, naca

pytestmark = pytest.mark.skipif(importlib.util.find_spec("gmsh") is None, reason="Gmsh is not installed in this Python")


def _build(code: str = "2412", closed: bool = False, level: str = "medium", re: float = 1e6, **spec) -> dict:
    import gmsh
    from magnusim_sdk.gmsh_helpers import initialize_gmsh

    sec = naca.generate(code, 81, closed)
    initialize_gmsh(gmsh, readConfigFiles=False)
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        return cmesh.build(sec.x, sec.y, cmesh.MeshSpec(cmesh.LEVELS[level], re, **spec), gmsh)
    finally:
        gmsh.finalize()


@pytest.fixture(scope="module")
def blunt() -> dict:
    return _build()


@pytest.fixture(scope="module")
def sharp() -> dict:
    return _build(closed=True)


def _area(poly) -> float:
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % 4][1] - poly[(i + 1) % 4][0] * poly[i][1] for i in range(4))


def _centroid(poly) -> tuple[float, float]:
    a = cx = cy = 0.0
    for i in range(4):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % 4]
        cr = x0 * y1 - x1 * y0
        a += cr
        cx += (x0 + x1) * cr
        cy += (y0 + y1) * cr
    return cx / (3 * a), cy / (3 * a)


def _on_base(nodes, a: int, b: int) -> bool:
    """An edge of a blunt trailing edge's base: at the trailing edge, running across it."""
    (xa, ya), (xb, yb) = nodes[a], nodes[b]
    return min(xa, xb) > 0.9999 and abs(xa - xb) < abs(ya - yb)


def _edges(plane: dict) -> dict[tuple[int, int], list[int]]:
    out: dict[tuple[int, int], list[int]] = defaultdict(list)
    for ci, q in enumerate(plane["quads"]):
        for i in range(4):
            a, b = q[i], q[(i + 1) % 4]
            out[(min(a, b), max(a, b))].append(ci)
    return out


def test_first_cell_is_for_y_plus_one_and_the_ratios_add_up():
    # Cf = 0.026 / Re^(1/7) = 0.0036 at Re 1e6: y = 1 / (1e6 * sqrt(0.0018)).
    assert cmesh.first_cell_height(1e6) == pytest.approx(2.3529e-5, rel=1e-3)
    assert cmesh.first_cell_height(1e7) < cmesh.first_cell_height(1e6) / 8
    r = cmesh.geometric_ratio(20.0, 2.35e-5, 84)
    assert 2.35e-5 * (r**84 - 1) / (r - 1) == pytest.approx(20.0, rel=1e-9)
    assert cmesh.geometric_ratio(1.0, 0.1, 10) == 1.0
    assert cmesh.geometric_ratio(1.0, 0.2, 10) < 1.0
    assert cmesh.first_cell(1.0, cmesh.geometric_ratio(1.0, 0.01, 30), 30) == pytest.approx(0.01, rel=1e-9)
    n = cmesh.wall_cells(0.05, 2.35e-5, 1.15)
    assert 2.35e-5 * (1.15**n - 1) / 0.15 >= 0.05 > 2.35e-5 * (1.15 ** (n - 1) - 1) / 0.15


def test_every_cell_is_a_convex_counter_clockwise_quad_and_every_node_is_used_once(blunt):
    nodes, quads = blunt["nodes"], blunt["quads"]
    assert 27_000 < blunt["cells"] == len(quads) < 30_000
    assert len(set(nodes)) == len(nodes), "two nodes in one place"
    used = Counter(i for q in quads for i in q)
    assert set(used) == set(range(len(nodes)))
    for q in quads:
        poly = [nodes[i] for i in q]
        assert _area(poly) > 0
        for i in range(4):
            ax, ay = poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]
            bx, by = poly[(i + 1) % 4][0] - poly[i][0], poly[(i + 1) % 4][1] - poly[i][1]
            assert ax * by - ay * bx > 0, f"a corner bends the wrong way in {poly}"


def test_the_boundary_is_the_section_and_the_far_field_and_nothing_else(blunt, sharp):
    for plane in (blunt, sharp):
        edges = _edges(plane)
        outside = {e for e, cells in edges.items() if len(cells) == 1}
        assert all(len(cells) in (1, 2) for cells in edges.values())
        wing = {(min(a, b), max(a, b)) for a, b in plane["edges"]["wing"]}
        far = {(min(a, b), max(a, b)) for a, b in plane["edges"]["farfield"]}
        assert not wing & far
        assert outside == wing | far
        nodes = plane["nodes"]
        outlet = max(x for x, _y in nodes)
        assert outlet == pytest.approx(21.0, abs=1e-3)
        # The far field: the half circle of radius 20 round the trailing edge, top, bottom and outlet.
        for a, b in far:
            for i in (a, b):
                x, y = nodes[i]
                on_circle = abs(math.hypot(x - 1.0, y) - 20.0) < 0.05 and x <= 1.01
                assert on_circle or abs(abs(y) - 20.0) < 1e-6 or abs(x - outlet) < 1e-9, (x, y)
        # The section: every wing node lies on the section (within a hair of its points' outline).
        for a, b in wing:
            for i in (a, b):
                x, y = nodes[i]
                assert -1e-3 <= x <= 1.0001 and abs(y) < 0.1  # a cambered NACA nose reaches a hair below x = 0
    assert blunt["sharp"] is False and blunt["gap"] == pytest.approx(0.00252, abs=1e-5)
    assert sharp["sharp"] is True
    # The blunt trailing edge has its base on the wall: a vertical row of edges at its x.
    base = [e for e in blunt["edges"]["wing"] if _on_base(blunt["nodes"], *e)]
    assert len(base) >= 4
    assert sum(math.dist(blunt["nodes"][a], blunt["nodes"][b]) for a, b in base) == pytest.approx(blunt["gap"], rel=1e-6)


def test_lines_leave_the_wall_at_a_right_angle_and_the_first_cell_is_y_plus_one(blunt):
    nodes, quads = blunt["nodes"], blunt["quads"]
    wing = {(min(a, b), max(a, b)) for a, b in blunt["edges"]["wing"]}
    worst = 0.0
    heights = []
    for q in quads:
        for i in range(4):
            a, b = q[i], q[(i + 1) % 4]
            if (min(a, b), max(a, b)) not in wing:
                continue
            tx, ty = nodes[b][0] - nodes[a][0], nodes[b][1] - nodes[a][1]
            t = math.hypot(tx, ty)
            if _on_base(nodes, a, b):
                continue  # the base
            for w, o in ((a, q[(i + 3) % 4]), (b, q[(i + 2) % 4])):
                rx, ry = nodes[o][0] - nodes[w][0], nodes[o][1] - nodes[w][1]
                r = math.hypot(rx, ry)
                worst = max(worst, math.degrees(math.asin(min(1.0, abs(tx * rx + ty * ry) / (t * r)))))
                heights.append(r)
    # Transfinite interpolation alone leans them up to 50° near the leading edge.
    assert worst < 5.0, f"a line leaves the wall {worst:.1f}° off its normal"
    assert min(heights) == pytest.approx(blunt["h0"], rel=0.05)
    assert max(heights) == pytest.approx(blunt["h0"], rel=0.05)


def test_neighbouring_cells_differ_in_size_smoothly(blunt, sharp):
    """The far field once had cells 50 times the size of their neighbours where the
    leading-edge blocks met the rest; the case diverged in a few hundred iterations."""
    for plane in (blunt, sharp):
        nodes, quads = plane["nodes"], plane["quads"]
        areas = [_area([nodes[i] for i in q]) for q in quads]
        jump = max(max(areas[c[0]], areas[c[1]]) / min(areas[c[0]], areas[c[1]]) for c in _edges(plane).values() if len(c) == 2)
        assert jump < 3.0


def test_the_far_field_meets_the_section_fanned_out(blunt):
    """Cells on the half circle, top and bottom are no slivers: none is 50 times deeper than it is wide."""
    nodes = blunt["nodes"]
    far = {(min(a, b), max(a, b)) for a, b in blunt["edges"]["farfield"]}
    outlet = max(x for x, _y in nodes)
    worst = 0.0
    for q in blunt["quads"]:
        for i in range(4):
            a, b = q[i], q[(i + 1) % 4]
            if (min(a, b), max(a, b)) in far and abs(nodes[a][0] - outlet) > 1e-9:
                side = math.dist(nodes[a], nodes[b])
                depth = math.dist(nodes[a], nodes[q[(i + 3) % 4]])
                worst = max(worst, depth / side)
    assert worst < 50.0


def _non_orthogonality(plane: dict) -> tuple[float, int, tuple[float, float]]:
    """checkMesh's measure in the plane: the largest angle between an inner face's normal
    and the line between its two cells' centres (polygon centroids), the number of faces
    over 70°, and where the worst one is."""
    nodes, quads = plane["nodes"], plane["quads"]
    centres = [_centroid([nodes[i] for i in q]) for q in quads]
    worst, over, where = 0.0, 0, (0.0, 0.0)
    for (a, b), cells in _edges(plane).items():
        if len(cells) != 2:
            continue
        (xa, ya), (xb, yb) = nodes[a], nodes[b]
        nx, ny = yb - ya, xa - xb
        dx = centres[cells[1]][0] - centres[cells[0]][0]
        dy = centres[cells[1]][1] - centres[cells[0]][1]
        cos = abs(nx * dx + ny * dy) / (math.hypot(nx, ny) * math.hypot(dx, dy))
        angle = math.degrees(math.acos(min(1.0, cos)))
        over += angle > 70.0
        if angle > worst:
            worst, where = angle, (0.5 * (xa + xb), 0.5 * (ya + yb))
    return worst, over, where


@pytest.mark.parametrize("closed", [False, True], ids=["blunt", "sharp"])
@pytest.mark.parametrize("level", list(cmesh.LEVELS))
@pytest.mark.parametrize("re", [1e5, 1e6, foamcase.RE_RANGE[1]], ids=["re1e5", "re1e6", "re_top"])
def test_no_face_is_severely_non_orthogonal_at_any_level_or_reynolds_number(level, re, closed):
    """The wake cut's cells once reached 87° at Re 1e6 and 89.9° at 5e7 (checkMesh: 10 and
    82 faces over 70°): rows two chords long whose height changed along them by a
    different factor than the row across the cut, so their centres sat far apart along x."""
    worst, over, where = _non_orthogonality(_build(closed=closed, level=level, re=re))
    assert over == 0 and worst < 65.0, f"{over} faces over 70°, the worst {worst:.1f}° at {where}"


def test_the_wake_layer_keeps_its_height_to_the_outlet(blunt, sharp):
    """Every cell of the wake layer keeps its height along the wake, on both sides of the
    cut (the 87° faces were long rows whose heights changed along them by slightly
    different factors), and for a blunt trailing edge the base block's cells too."""
    for plane in (blunt, sharp):
        nodes = plane["nodes"]
        te_y = [y for x, y in nodes if abs(x - 1.0) < 1e-9]
        lo, hi = min(te_y) - 0.04, max(te_y) + 0.04  # well inside the 0.05-chord layer
        layer = [q for q in plane["quads"] if all(nodes[i][0] > 1.5 and lo < nodes[i][1] < hi for i in q)]
        assert len(layer) > 500
        for q in layer:
            # Its two sides across the wake (the two upstream nodes, the two downstream): the
            # same height to 1 part in 1e6, at the same place.
            pts = sorted((nodes[i] for i in q), key=lambda n: n[0])
            left, right = sorted(n[1] for n in pts[:2]), sorted(n[1] for n in pts[2:])
            assert pts[2][0] - pts[1][0] > 10 * (pts[1][0] - pts[0][0])
            assert right[1] - right[0] == pytest.approx(left[1] - left[0], rel=1e-6, abs=1e-12)
            assert right[0] == pytest.approx(left[0], abs=1e-9)


def test_levels_differ_and_the_reynolds_number_sets_the_first_cell():
    coarse = _build(level="coarse")
    fine = _build(level="fine")
    assert coarse["cells"] < 20_000 < 50_000 < fine["cells"]
    high = _build(level="coarse", re=1e7)
    assert high["h0"] == pytest.approx(cmesh.first_cell_height(1e7))
    assert high["wall_cells"] > coarse["wall_cells"]


def test_a_section_the_mesher_cannot_wrap_is_refused_with_its_reason():
    sec = naca.generate("2412", 81)
    with pytest.raises(cmesh.MeshError, match="Selig order"):
        cmesh.prepare(sec.x[::-1], sec.y[::-1])
    with pytest.raises(cmesh.MeshError, match="chord 1"):
        cmesh.prepare([2 * v for v in sec.x], [2 * v for v in sec.y])
    with pytest.raises(cmesh.MeshError, match="at least"):
        cmesh.prepare(sec.x[:5], sec.y[:5])
    # A wall layer that would fold over a concave dip.
    wall = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0]
    with pytest.raises(cmesh.MeshError, match="curves too tightly"):
        cmesh._check_layer(wall, [(0.0, 0.1), (2.0, 0.1), (1.0, 0.1)])


def test_the_msh_file_is_one_layer_of_hexahedra_with_its_four_boundary_groups(tmp_path: Path, sharp):
    out = tmp_path / "mesh.msh"
    info = cmesh.write_msh(out, sharp, 0.1)
    text = out.read_text(encoding="ascii")
    assert info == {"cells": sharp["cells"], "points": 2 * len(sharp["nodes"])}
    names = text.split("$PhysicalNames\n")[1].split("$EndPhysicalNames")[0].splitlines()
    assert names == ["5", '3 1 "fluid"', '2 2 "wing"', '2 3 "farfield"', '2 4 "front"', '2 5 "back"']
    elements = text.split("$Elements\n")[1].split("$EndElements")[0].splitlines()[1:]
    kinds = Counter((e.split()[1], e.split()[3]) for e in elements)
    cells = sharp["cells"]
    assert kinds == {
        ("5", "1"): cells,
        ("3", "2"): len(sharp["edges"]["wing"]),
        ("3", "3"): len(sharp["edges"]["farfield"]),
        ("3", "4"): cells,
        ("3", "5"): cells,
    }
    zs = {line.split()[3] for line in text.split("$Nodes\n")[1].split("$EndNodes")[0].splitlines()[1:]}
    assert zs == {"0", "0.1"}
    # A hexahedron's bottom face runs counter-clockwise seen from +z: gmshToFoam keeps it as it is.
    first = elements[0].split()
    node = {line.split()[0]: line.split()[1:] for line in text.split("$Nodes\n")[1].split("$EndNodes")[0].splitlines()[1:]}
    bottom = [tuple(float(v) for v in node[i][:2]) for i in first[5:9]]
    assert _area(bottom) > 0
