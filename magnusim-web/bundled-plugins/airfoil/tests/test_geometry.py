"""Section geometry (airfoil.geometry): thinning a fine section for XFOIL."""

from __future__ import annotations

import pytest

from airfoil import geometry, naca


@pytest.mark.parametrize("pps,max_points", [(200, 300), (250, 300), (81, 100), (151, 300), (250, 51)])
def test_decimate_keeps_the_ends_and_the_leading_edge_in_order(pps, max_points):
    sec = naca.generate("2412", pps)
    n = len(sec.x)
    assert n > max_points
    x, y = geometry.decimate(sec.x, sec.y, max_points)
    assert len(x) == len(y)
    assert max_points - 2 <= len(x) <= max_points
    pts = list(zip(sec.x, sec.y, strict=True))
    kept = list(zip(x, y, strict=True))
    # Both trailing-edge ends and the leading edge stay; every point kept is one of the
    # section's, in the section's order (Selig: upper trailing edge round to the lower).
    assert kept[0] == pts[0] and kept[-1] == pts[-1]
    le = geometry.leading_edge_index(sec.x)
    assert pts[le] in kept
    idx = [pts.index(p) for p in kept]
    assert idx == sorted(set(idx))
    # Both surfaces keep their share of the points (neither is thinned to a stub).
    upper = sum(1 for i in idx if i < le)
    lower = sum(1 for i in idx if i > le)
    assert abs(upper - lower) <= 2


def test_decimate_leaves_a_section_that_fits_as_it_is():
    sec = naca.generate("0012", 81)
    x, y = geometry.decimate(sec.x, sec.y, 300)
    assert (x, y) == (list(sec.x), list(sec.y))
