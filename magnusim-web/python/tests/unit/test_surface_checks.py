"""Surface checks before the Standard volume fill: crossing triangles, gaps.

A thin curved sheet (2.54 mm thick, 600 mm radius) meshed at 130 mm sags its
two sides through each other; gmsh then stops with "PLC Error: A segment and a
facet intersect". The gap refinement missed it (it paired triangles by
centroid distance, and coarse triangles' centroids are far apart), and nothing
checked the surface before the fill.
"""

from __future__ import annotations

import numpy as np
import pytest

from cfddesk.mesh import standard_hexcore as sh
from cfddesk.mesh.surface_checks import crossing_pairs, near_triangle_pairs, triangle_spheres


def _pairs(nodes, tris) -> set[tuple[int, int]]:
    return {tuple(sorted(map(int, p))) for p in crossing_pairs(np.asarray(nodes, float), np.asarray(tris))}


def test_crossing_triangles_are_found():
    nodes = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0.5, 0.5, -1], [0.5, 0.5, 1], [1.5, 0.5, 0]]
    assert _pairs(nodes, [[0, 1, 2], [3, 4, 5]]) == {(0, 1)}


def test_separate_and_neighbouring_triangles_do_not_cross():
    nodes = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [5, 5, 5], [6, 5, 5], [5, 6, 5]]
    # 0-1 share an edge at a right angle, 2 is far away
    assert _pairs(nodes, [[0, 1, 2], [0, 1, 3], [4, 5, 6]]) == set()


def test_a_node_on_another_face_counts():
    # The corner (0.5, 0.5, 0) of the second triangle lies on the first one.
    nodes = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0.5, 0.5, 0], [0.5, 0.5, 1], [1.0, 0.5, 1]]
    assert _pairs(nodes, [[0, 1, 2], [3, 4, 5]]) == {(0, 1)}


def test_triangles_sharing_a_corner_cross_through_the_far_edge():
    # Both use node 0; the far edge 4-5 of the second passes through the first.
    nodes = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 0], [0.6, 0.3, -1], [0.6, 0.3, 1]]
    tris = [[0, 1, 2], [0, 4, 5]]
    assert _pairs(nodes, tris) == {(0, 1)}
    # Folded away from it, they only meet at the corner.
    assert _pairs([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 0], [-0.6, -0.3, -1], [-0.6, -0.3, 1]], tris) == set()


def test_near_pairs_include_one_big_triangle():
    rng = np.random.default_rng(1)
    small = rng.uniform(0, 1, size=(400, 3))
    nodes = np.vstack([small, [[-50, -50, 0.5], [60, -50, 0.5], [0, 60, 0.5]]])
    tris = np.vstack([np.arange(399).reshape(-1, 3), [[400, 401, 402]]])
    cent, rad = triangle_spheres(nodes, tris)
    i, j = near_triangle_pairs(cent, rad, 0.0)
    big = len(tris) - 1
    # every small triangle lies within the big one's sphere
    assert set(i[j == big].tolist()) | set(j[i == big].tolist()) == set(range(len(tris) - 1))
    brute = {
        (a, b)
        for a in range(len(tris))
        for b in range(a + 1, len(tris))
        if np.linalg.norm(cent[a] - cent[b]) <= rad[a] + rad[b]
    }
    assert set(zip(i.tolist(), j.tolist(), strict=True)) == brute


def _square(z: float, shift: float, flip: bool, base: int) -> tuple[np.ndarray, np.ndarray]:
    s = 0.09
    pts = np.array([[0, 0, z], [s, 0, z], [s, s, z], [0, s, z]], float) + [shift, 0, 0]
    tris = np.array([[0, 1, 2], [0, 2, 3]]) + base
    return pts, (tris[:, ::-1] if flip else tris)


def test_gap_found_between_coarse_triangles():
    """Two 90 mm faces 2.5 mm apart, offset by 40 mm: their centroids are ~40 mm
    apart, beyond the old centroid search (1.05 x 0.05 x h = 4.7 mm)."""
    h = 0.09
    a, ta = _square(0.0, 0.0, False, 0)
    b, tb = _square(0.0025, 0.04, True, 4)
    sizes = sh._gap_sizes(np.vstack([a, b]), np.vstack([ta, tb]), h=h, gap_factor=0.05, log=lambda m: None)
    assert sizes is not None
    refined = np.isclose(sizes, 0.0025 / 0.05)
    # Each face has a triangle over the other one, and it gets gap size / factor.
    assert refined[:2].any() and refined[2:].any()
    assert np.all(refined | np.isclose(sizes, h))


def test_wedge_sides_are_not_a_gap():
    # Two triangles on one edge, folded to 6 degrees: opposing normals, but a wedge.
    ang = np.radians(6.0)
    nodes = np.array([[0, 0, 0], [0, 0.09, 0], [0.09, 0, 0], [0.09 * np.cos(ang), 0, 0.09 * np.sin(ang)]])
    tris = np.array([[0, 1, 2], [0, 3, 1]])
    assert sh._gap_sizes(nodes, tris, h=0.09, gap_factor=0.05, log=lambda m: None) is None


def _sheet_part(tmp_path):
    """A 5 m box of fluid crossed by a quarter cylinder sheet 2.54 mm thick, 600 mm radius."""
    ocp = pytest.importorskip("OCP.BRepPrimAPI")
    from generate_standard import _add_default_walls
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step
    from cfddesk.project.model import Project

    r, t, length, b = 600.0, 2.54, 6000.0, 2500.0
    ax = gp_Ax2(gp_Pnt(0, 0, -length / 2), gp_Dir(0, 0, 1))
    shell = BRepAlgoAPI_Cut(
        ocp.BRepPrimAPI_MakeCylinder(ax, r + t, length).Shape(), ocp.BRepPrimAPI_MakeCylinder(ax, r, length).Shape()
    ).Shape()
    quarter = ocp.BRepPrimAPI_MakeBox(gp_Pnt(0, 0, -length), gp_Pnt(2 * r, 2 * r, length)).Shape()
    sheet = BRepAlgoAPI_Common(shell, quarter).Shape()
    fluid = BRepAlgoAPI_Cut(ocp.BRepPrimAPI_MakeBox(gp_Pnt(-b, -b, -b), gp_Pnt(b, b, b)).Shape(), sheet).Shape()
    step = tmp_path / "sheet.step"
    write_step(fluid, step)
    solid = load_step(step)
    project = Project.from_solid(solid, scale_to_metres=0.001, units_confirmed=True)
    project = _add_default_walls(project, list(range(len(solid.faces))))
    return step, solid, project


@pytest.mark.occt
@pytest.mark.parametrize("gap_factor", [0.0, 0.05])
def test_thin_curved_sheet_meshes(tmp_path, gap_factor, monkeypatch):
    """Before the fix both failed: "PLC Error: A segment and a facet intersect"."""
    if not gap_factor:
        # The automatic feature refinement meshes the sheet's 2.54 mm rims finer, so
        # its faces no longer sag across each other; turned off here, the crossing
        # repair is what has to make the surface fillable.
        from cfddesk.mesh import feature_size

        monkeypatch.setattr(feature_size, "FEATURE_FRACTION", 0.0)
    step, solid, project = _sheet_part(tmp_path)
    sizing = sh.StandardSizing.automatic((5.0, 5.0, 5.0), fineness=1, gap_refinement_factor=gap_factor)
    lines: list[str] = []
    res = sh.build_standard_msh(
        step, solid, project, tmp_path / "mesh" / "geometry.msh",
        scale_to_metres=0.001, sizing=sizing, hex_core=True, n_threads=1, log=lines.append,
    )
    assert res.hex_core_applied and res.n_hex > 0
    # the first fill works (its thin edge faces may send it to Delaunay at once)
    assert "failed attempt" not in res.volume_fill_note
    assert res.assembly_error_rel is not None and res.assembly_error_rel < 1e-9
    repairs = [ln for ln in lines if ln.startswith("surface repair:")]
    if gap_factor:
        # The gap refinement now sees the sheet (the old search missed it).
        assert any(ln.startswith("gap refinement:") for ln in lines)
    else:
        # Without it the crossings are found and meshed finer before the fill.
        assert any("crossing triangle pair" in ln for ln in repairs)
    # Whatever crossings were left are gone before the fill.
    assert not any(ln.endswith("left after 3 round(s)") for ln in repairs)
    assert not repairs or repairs[-1].startswith("surface repair: no crossing triangles left")
