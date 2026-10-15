"""Which CAD face a point lies on: the face of the nearest tessellation triangle.

A Force result control splits the mesh faces of the CAD faces the user picked into
patches of their own; each mesh boundary face is given the CAD face its centre is
nearest to. Exact (the nearest triangle, by point-to-triangle distance), and
vectorised for the hundreds of thousands of wall faces of a large mesh: see
FaceIndex. About 40 microseconds a point on a 42 000-triangle part.
"""

from __future__ import annotations

from typing import Any

import numpy as np

# Points per batch.
CHUNK = 20_000


def _radius(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """The largest distance from each triangle's centroid to its corners."""
    g = (a + b + c) / 3.0
    return np.sqrt(np.max(np.stack([((v - g) ** 2).sum(axis=1) for v in (a, b, c)]), axis=0))


def subdivided(points: np.ndarray, tris: np.ndarray, fids: np.ndarray, r0: float) -> tuple[np.ndarray, np.ndarray]:
    """Corner arrays ``(n, 3, 3)`` and face ids of the triangles, each cut in two across
    its longest edge until its radius <= r0 (thin slivers take a few cuts, not 4**k)."""
    corners = points[tris]
    ids = np.asarray(fids, dtype=np.int64)
    out_c: list[np.ndarray] = []
    out_f: list[np.ndarray] = []
    for _ in range(60):
        r = _radius(corners[:, 0], corners[:, 1], corners[:, 2])
        small = r <= r0
        out_c.append(corners[small])
        out_f.append(ids[small])
        corners, ids = corners[~small], ids[~small]
        if not len(corners):
            break
        # Rotate each triangle so its longest edge runs from corner 0 to corner 1.
        e = np.stack([((corners[:, (i + 1) % 3] - corners[:, i]) ** 2).sum(1) for i in range(3)], axis=1)
        k = e.argmax(axis=1)
        rows = np.arange(len(corners))
        a, b, c = corners[rows, k], corners[rows, (k + 1) % 3], corners[rows, (k + 2) % 3]
        m = (a + b) / 2
        corners = np.concatenate([np.stack((a, m, c), axis=1), np.stack((m, b, c), axis=1)], axis=0)
        ids = np.tile(ids, 2)
    if len(corners):
        out_c.append(corners)
        out_f.append(ids)
    return np.concatenate(out_c, axis=0), np.concatenate(out_f, axis=0)


def point_triangle_distance2(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Squared distance from each point to its triangle (rows matched), after Ericson's
    ClosestPtPointTriangle."""
    ab, ac, ap = b - a, c - a, p - a
    d1 = (ab * ap).sum(1)
    d2 = (ac * ap).sum(1)
    bp = p - b
    d3 = (ab * bp).sum(1)
    d4 = (ac * bp).sum(1)
    cp = p - c
    d5 = (ab * cp).sum(1)
    d6 = (ac * cp).sum(1)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    denom = va + vb + vc
    with np.errstate(divide="ignore", invalid="ignore"):
        v = np.where(denom != 0, vb / denom, 0.0)
        w = np.where(denom != 0, vc / denom, 0.0)
        q = a + ab * v[:, None] + ac * w[:, None]  # inside the face
        # Edges.
        t_ab = np.where(d1 - d3 != 0, d1 / (d1 - d3), 0.0)
        q = np.where(((vc <= 0) & (d1 >= 0) & (d3 <= 0))[:, None], a + ab * t_ab[:, None], q)
        t_ac = np.where(d2 - d6 != 0, d2 / (d2 - d6), 0.0)
        q = np.where(((vb <= 0) & (d2 >= 0) & (d6 <= 0))[:, None], a + ac * t_ac[:, None], q)
        den_bc = (d4 - d3) + (d5 - d6)
        t_bc = np.where(den_bc != 0, (d4 - d3) / den_bc, 0.0)
        q = np.where(((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0))[:, None], b + (c - b) * t_bc[:, None], q)
    # Corners.
    q = np.where(((d1 <= 0) & (d2 <= 0))[:, None], a, q)
    q = np.where(((d3 >= 0) & (d4 <= d3))[:, None], b, q)
    q = np.where(((d6 >= 0) & (d5 <= d6))[:, None], c, q)
    return ((p - q) ** 2).sum(1)


class FaceIndex:
    """Nearest CAD face of points, for one tessellation (points in metres).

    Triangles are grouped by size (radius classes of a factor of two), each group
    with its own KD tree of centroids. A point's nearest triangle in group ``b``
    (radius at most ``R_b``) has its centroid within ``d + R_b``, where ``d`` is the
    exact distance to any triangle at all: the few nearest centroids of each group
    give a tight ``d`` (zero for a point on a big flat face), so each group's ball
    holds only the triangles around the point.
    """

    def __init__(self, points: np.ndarray, tris: np.ndarray, fids: np.ndarray) -> None:
        from scipy.spatial import cKDTree

        points = np.asarray(points, dtype=np.float64)
        tris = np.asarray(tris, dtype=np.int64)
        c0 = points[tris]
        r0 = _radius(c0[:, 0], c0[:, 1], c0[:, 2]) if len(tris) else np.zeros(0)
        # Long thin triangles (a cylinder's slivers) are cut to a few times the typical
        # size: their radius would put them in every ball around them.
        cap = 4.0 * float(np.median(r0)) if len(r0) else 1.0
        self.corners, self.fids = subdivided(points, tris, np.asarray(fids, dtype=np.int64), cap if cap > 0 else 1.0)
        r = _radius(self.corners[:, 0], self.corners[:, 1], self.corners[:, 2])
        rmin = max(float(r[r > 0].min()) if np.any(r > 0) else 1.0, 1e-300)
        level = np.floor(np.log2(np.maximum(r, rmin) / rmin)).astype(np.int64)
        self.groups: list[tuple[np.ndarray, float, Any]] = []
        for lv in np.unique(level):
            members = np.nonzero(level == lv)[0]
            radius = float(r[members].max())
            self.groups.append((members, radius, cKDTree(self.corners[members].mean(axis=1))))

    def nearest(self, query: np.ndarray) -> np.ndarray:
        """The face id (as given) of the triangle nearest each point."""
        query = np.asarray(query, dtype=np.float64).reshape(-1, 3)
        out = np.empty(len(query), dtype=np.int64)
        for s in range(0, len(query), CHUNK):
            out[s : s + CHUNK] = self._nearest(query[s : s + CHUNK])
        return out

    def _measure(self, q: np.ndarray, owner: np.ndarray, tri: np.ndarray, best_d: np.ndarray, best_t: np.ndarray) -> None:
        if not len(tri):
            return
        c = self.corners[tri]
        d2 = point_triangle_distance2(q[owner], c[:, 0], c[:, 1], c[:, 2])
        order = np.lexsort((d2, owner))
        first = np.ones(len(order), dtype=bool)
        first[1:] = owner[order][1:] != owner[order][:-1]
        pick = order[first]
        who, dist = owner[pick], d2[pick]
        better = dist < best_d[who]
        best_d[who[better]] = dist[better]
        best_t[who[better]] = tri[pick][better]

    def _nearest(self, q: np.ndarray) -> np.ndarray:
        n = len(q)
        best_d = np.full(n, np.inf)
        best_t = np.zeros(n, dtype=np.int64)
        rows = np.arange(n)
        # A tight first bound: the few nearest centroids of every group, measured exactly.
        for members, _radius_b, tree in self.groups:
            k = min(4, len(members))
            _d, idx = tree.query(q, k=k)
            idx = np.asarray(idx).reshape(n, k)
            self._measure(q, np.repeat(rows, k), members[idx.ravel()], best_d, best_t)
        # Then every triangle that could be nearer.
        for members, radius_b, tree in self.groups:
            lists = tree.query_ball_point(q, r=np.sqrt(best_d) + radius_b + 1e-12)
            sizes = np.fromiter((len(x) for x in lists), dtype=np.int64, count=n)
            if not sizes.sum():
                continue
            local = np.fromiter((i for x in lists for i in x), dtype=np.int64, count=int(sizes.sum()))
            self._measure(q, np.repeat(rows, sizes), members[local], best_d, best_t)
        return self.fids[best_t]
