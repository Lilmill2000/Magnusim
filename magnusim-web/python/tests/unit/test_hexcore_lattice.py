"""Hex-core lattice inside test (ray parity) against exact answers."""

from __future__ import annotations

import numpy as np
import pyvista as pv

from cfddesk.mesh.standard_hexcore import _lattice_inside


def _surface(mesh: pv.PolyData) -> tuple[np.ndarray, np.ndarray]:
    tri = mesh.triangulate().clean()
    return np.asarray(tri.points, dtype=float), tri.faces.reshape(-1, 4)[:, 1:].astype(np.int64)


def _grid(lo: float, hi: float, h: float) -> np.ndarray:
    return lo + h * np.arange(int(round((hi - lo) / h)) + 1)


def test_sphere_matches_distance_from_centre():
    nodes, tris = _surface(pv.Sphere(radius=1.0, theta_resolution=90, phi_resolution=90))
    h = 0.05
    g = _grid(-1.3, 1.3, h)
    inside = _lattice_inside(nodes, tris, g, g, g, h)
    xx, yy, zz = np.meshgrid(g, g, g, indexing="ij")
    r = np.sqrt(xx**2 + yy**2 + zz**2)
    # The faceted sphere sits within ~0.001 of r = 1; judge vertices clear of it.
    clear = np.abs(r - 1.0) > 0.01
    assert np.array_equal(inside[clear], (r < 1.0)[clear])


def test_axis_aligned_box_with_faces_on_lattice_lines():
    # Faces, edges and corners lie exactly on lattice planes and columns: the rays
    # must still count each crossing once.
    nodes, tris = _surface(pv.Box(bounds=(-0.5, 0.5, -0.5, 0.5, -0.5, 0.5), level=3))
    h = 0.1
    g = _grid(-1.0, 1.0, h)
    inside = _lattice_inside(nodes, tris, g, g, g, h)
    xx, yy, zz = np.meshgrid(g, g, g, indexing="ij")
    m = np.maximum(np.maximum(np.abs(xx), np.abs(yy)), np.abs(zz))
    clear = np.abs(m - 0.5) > 1e-9
    assert np.array_equal(inside[clear], (m < 0.5)[clear])


def test_nothing_is_inside_an_empty_surface():
    g = _grid(0.0, 1.0, 0.25)
    empty = _lattice_inside(np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64), g, g, g, 0.25)
    assert empty.shape == (5, 5, 5) and not empty.any()
