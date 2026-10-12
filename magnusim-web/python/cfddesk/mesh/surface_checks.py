"""Checks on a closed triangulated surface before the volume fill.

The tet fill (HXT or Delaunay) needs a surface that does not touch itself. A
surface meshed from sound CAD can still do so: two faces of a sheet 2.5 mm
thick, curved at a 236 mm radius and meshed at 50-90 mm, sag across each
other between their nodes. gmsh then stops with "PLC Error: A segment and a
facet intersect". ``crossing_pairs`` finds those triangles so the surface can
be meshed finer there first.
"""

from __future__ import annotations

import numpy as np


def triangle_spheres(nodes: np.ndarray, tris: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Centroid and bounding radius (centroid to farthest corner) of each triangle."""
    corners = np.asarray(nodes, dtype=float)[np.asarray(tris, dtype=np.int64)]
    cent = corners.mean(axis=1)
    rad = np.sqrt(((corners - cent[:, None, :]) ** 2).sum(axis=2)).max(axis=1)
    return cent, rad


def near_triangle_pairs(cent: np.ndarray, rad: np.ndarray, pad: float) -> tuple[np.ndarray, np.ndarray]:
    """Pairs (i < j) of triangles whose bounding spheres come within ``pad``.

    Triangles are grouped by size (radius classes a factor 2 apart) and each
    class is searched against itself and the smaller classes with the radius
    those sizes need, so a refined patch of small triangles next to a coarse
    surface does not blow the search up to every pair within the coarse reach.
    """
    from scipy.spatial import cKDTree

    n = len(cent)
    if n < 2:
        return np.zeros(0, np.int64), np.zeros(0, np.int64)
    pad = float(pad)
    r_lo = max(float(rad.max()) * 1e-6, 1e-300)
    cls = np.floor(np.log2(np.maximum(rad, r_lo) / r_lo)).astype(np.int64)
    groups = [np.flatnonzero(cls == c) for c in np.unique(cls)]  # smallest first
    trees = [cKDTree(cent[g]) for g in groups]
    r_max = [float(rad[g].max()) for g in groups]
    first: list[np.ndarray] = []
    second: list[np.ndarray] = []
    for k, gk in enumerate(groups):
        for m in range(k + 1):
            reach = r_max[k] + r_max[m] + pad
            if m == k:
                pairs = trees[k].query_pairs(reach, output_type="ndarray")
                a, b = gk[pairs[:, 0]], gk[pairs[:, 1]]
            else:
                hits = trees[k].sparse_distance_matrix(trees[m], reach, output_type="ndarray")
                a, b = gk[hits["i"]], groups[m][hits["j"]]
            keep = np.linalg.norm(cent[a] - cent[b], axis=1) <= rad[a] + rad[b] + pad
            a, b = a[keep], b[keep]
            first.append(np.minimum(a, b).astype(np.int64))
            second.append(np.maximum(a, b).astype(np.int64))
    return np.concatenate(first), np.concatenate(second)


def _segment_hits_triangle(p0, p1, a, b, c, tol: float) -> np.ndarray:
    """Row-wise: does segment p0-p1 touch or cross triangle abc (not coplanar)?"""
    e1 = b - a
    e2 = c - a
    d = p1 - p0
    h = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, h)
    scale = np.linalg.norm(e1, axis=1) * np.linalg.norm(e2, axis=1) * np.linalg.norm(d, axis=1)
    ok = np.abs(det) > 1e-14 * scale
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s = p0 - a
    u = np.einsum("ij,ij->i", s, h) * inv
    q = np.cross(s, e1)
    v = np.einsum("ij,ij->i", d, q) * inv
    t = np.einsum("ij,ij->i", e2, q) * inv
    return ok & (u >= -tol) & (v >= -tol) & (u + v <= 1 + tol) & (t >= -tol) & (t <= 1 + tol)


def crossing_pairs(nodes: np.ndarray, tris: np.ndarray, *, tol: float = 1e-9) -> np.ndarray:
    """Triangle pairs (k, 2) where the surface touches or crosses itself.

    Neighbours that share an edge are never a crossing. Triangles that share one
    corner cross when the edge of one opposite that corner meets the other.
    Touching counts (barycentric slack ``tol``): the volume fill cannot use a
    node that lies on another face either.
    """
    pts = np.asarray(nodes, dtype=float)
    tri = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
    if len(tri) < 2:
        return np.zeros((0, 2), np.int64)
    cent, rad = triangle_spheres(pts, tri)
    ii, jj = near_triangle_pairs(cent, rad, 0.0)
    xs = pts[tri]  # (T, 3, 3) corners
    lo = xs.min(axis=1)
    hi = xs.max(axis=1)
    slack = 1e-9 * float(np.max(hi - lo))
    box = np.all((lo[ii] <= hi[jj] + slack) & (lo[jj] <= hi[ii] + slack), axis=1)
    ii, jj = ii[box], jj[box]
    shared = np.zeros((len(ii), 3), dtype=bool)  # corner a of ii is a corner of jj
    for a in range(3):
        for b in range(3):
            shared[:, a] |= tri[ii, a] == tri[jj, b]
    n_shared = shared.sum(axis=1)
    hit = np.zeros(len(ii), dtype=bool)
    chunk = 1_000_000
    m0 = np.flatnonzero(n_shared == 0)
    for s in range(0, len(m0), chunk):
        sel = m0[s : s + chunk]
        h = np.zeros(len(sel), dtype=bool)
        for one, other in ((ii[sel], jj[sel]), (jj[sel], ii[sel])):
            for e0, e1 in ((0, 1), (1, 2), (2, 0)):
                h |= _segment_hits_triangle(xs[one, e0], xs[one, e1], xs[other, 0], xs[other, 1], xs[other, 2], tol)
        hit[sel] = h
    m1 = np.flatnonzero(n_shared == 1)
    if len(m1):
        i1, j1 = ii[m1], jj[m1]
        corner_i = np.argmax(shared[m1], axis=1)  # the shared corner, as a corner of i1
        shared_j = np.zeros((len(m1), 3), dtype=bool)
        for b in range(3):
            for a in range(3):
                shared_j[:, b] |= tri[j1, b] == tri[i1, a]
        corner_j = np.argmax(shared_j, axis=1)
        r = np.arange(len(m1))
        h = np.zeros(len(m1), dtype=bool)
        for one, other, c in ((i1, j1, corner_i), (j1, i1, corner_j)):
            own = xs[one]
            far0 = own[r, (c + 1) % 3]
            far1 = own[r, (c + 2) % 3]
            h |= _segment_hits_triangle(far0, far1, xs[other, 0], xs[other, 1], xs[other, 2], tol)
        hit[m1] = h
    return np.column_stack([ii[hit], jj[hit]])
