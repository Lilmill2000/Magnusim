"""CAD face → gmsh surface matching must not depend on surface order (faceted STL parts)."""
from __future__ import annotations

import random

from cfddesk.mesh.gmsh_standard import _assign_faces_to_surfaces


def _grid(n: int, step: float):
    """n x n small facets on a plane: centroids 1 step apart, equal areas."""
    return [
        (i * n + j, (i * step, j * step, 0.0), step * step / 2)
        for i in range(n)
        for j in range(n)
    ]


def test_every_facet_matches_whatever_order_gmsh_lists_surfaces():
    targets = _grid(40, 0.01)  # 1,600 faces, 1 cm apart; tolerance is 3 cm
    rng = random.Random(7)
    for _ in range(3):
        surfaces = [(fid + 1000, (x + 1e-5, y - 1e-5, z), a) for fid, (x, y, z), a in targets]
        rng.shuffle(surfaces)
        out = _assign_faces_to_surfaces(targets, surfaces, tol=0.03)
        assert len(out) == len(targets)
        assert all(tag == fid + 1000 for fid, tag in out.items())


def test_concentric_faces_are_told_apart_by_area():
    targets = [(0, (0.0, 0.0, 0.0), 1.0), (1, (0.0, 0.0, 0.0), 9.0)]
    surfaces = [(10, (0.0, 0.0, 0.0), 9.02), (11, (0.0, 0.0, 0.0), 1.01)]
    assert _assign_faces_to_surfaces(targets, surfaces, tol=0.1) == {0: 11, 1: 10}


def test_nothing_within_tolerance_matches_nothing():
    assert _assign_faces_to_surfaces([(0, (0.0, 0.0, 0.0), 1.0)], [(5, (1.0, 0.0, 0.0), 1.0)], tol=0.1) == {}


def test_equal_area_faces_pair_by_distance_not_float_noise():
    # Two facets of the same area 2 cm apart; the far surface's area is closer by
    # float noise only. Distance must decide, or a face steals its neighbour's surface.
    targets = [(0, (0.0, 0.0, 0.0), 1.0e-4), (1, (0.02, 0.0, 0.0), 1.0e-4)]
    surfaces = [
        (10, (0.0, 0.0, 0.0), 1.0e-4 * (1 + 3e-12)),
        (11, (0.02, 0.0, 0.0), 1.0e-4 * (1 + 1e-12)),
    ]
    assert _assign_faces_to_surfaces(targets, surfaces, tol=0.03) == {0: 10, 1: 11}
