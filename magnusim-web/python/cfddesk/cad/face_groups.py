"""Group a closed triangle mesh (STL / OBJ / PLY) into surfaces.

A mesh import has no CAD faces, only triangles. Neighbouring triangles whose
normals differ by less than ``FEATURE_ANGLE_DEG`` belong to the same surface, so
a 118k-triangle STL of a pipe becomes its wall and its two end caps instead of
118k selectable faces. Group ``g`` is the geometry's face id ``g`` (0-based) for
the viewport, boundary conditions and the mesher.
"""
from __future__ import annotations

from collections import deque

import numpy as np

FEATURE_ANGLE_DEG = 30.0
# A group this small (relative to the whole surface) is a tessellation defect,
# not a face anyone can pick: it joins the neighbour it shares the longest edge with.
_DEFECT_AREA_FRACTION = 1e-9
# Coplanar within this angle (and within ``_PLANAR_DIST`` of the fit plane,
# relative to the group's size) reports the group as a plane.
_PLANAR_ANGLE_DEG = 0.5
_PLANAR_DIST = 1e-6


def _edge_pairs(tris: np.ndarray):
    """Manifold edges as ``(a, b, u, v, same_dir)``: triangles a and b share edge (u, v).

    ``same_dir`` is True when both triangles traverse the edge the same way
    (inconsistent winding).
    """
    m = len(tris)
    directed = tris[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2)
    ends = np.sort(directed, axis=1)
    owner = np.repeat(np.arange(m), 3)
    order = np.lexsort((ends[:, 1], ends[:, 0]))
    ends, owner, directed = ends[order], owner[order], directed[order]
    same = np.all(ends[1:] == ends[:-1], axis=1)
    i = np.nonzero(same)[0]
    same_dir = directed[i, 0] == directed[i + 1, 0]
    return owner[i], owner[i + 1], ends[i, 0], ends[i, 1], same_dir


def orient_outward(points: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """Triangles with one consistent winding, normals pointing out of the enclosed volume."""
    tris = np.array(tris, dtype=np.int64, copy=True)
    a, b, _u, _v, same_dir = _edge_pairs(tris)
    if same_dir.any():
        # Flip triangles breadth-first so every shared edge is traversed both ways.
        m = len(tris)
        nbrs: list[list[tuple[int, bool]]] = [[] for _ in range(m)]
        for x, y, s in zip(a.tolist(), b.tolist(), same_dir.tolist(), strict=True):
            nbrs[x].append((y, s))
            nbrs[y].append((x, s))
        flip = np.zeros(m, dtype=bool)
        seen = np.zeros(m, dtype=bool)
        for start in range(m):
            if seen[start]:
                continue
            seen[start] = True
            queue = deque([start])
            while queue:
                t = queue.popleft()
                for n, s in nbrs[t]:
                    if not seen[n]:
                        seen[n] = True
                        flip[n] = flip[t] ^ s
                        queue.append(n)
        tris[flip] = tris[flip][:, [0, 2, 1]]
    corners = points[tris]
    signed = np.einsum("ij,ij->i", corners[:, 0], np.cross(corners[:, 1], corners[:, 2])).sum()
    if signed < 0:
        tris = tris[:, [0, 2, 1]]
    return tris


def triangle_normals(points: np.ndarray, tris: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Unit normals and areas per triangle (zero normal for a degenerate triangle)."""
    corners = points[tris]
    cross = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    twice = np.linalg.norm(cross, axis=1)
    normal = cross / np.where(twice > 0, twice, 1.0)[:, None]
    return normal, twice / 2.0


def group_triangles(points, tris, feature_angle_deg: float = FEATURE_ANGLE_DEG) -> np.ndarray:
    """Surface id (0-based) per triangle; ids follow the first triangle of each surface."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    points = np.asarray(points, dtype=np.float64)
    tris = np.asarray(tris, dtype=np.int64)
    m = len(tris)
    normal, area = triangle_normals(points, tris)
    a, b, u, v, _same = _edge_pairs(tris)
    smooth = np.einsum("ij,ij->i", normal[a], normal[b]) >= np.cos(np.radians(feature_angle_deg))
    graph = coo_matrix((np.ones(int(smooth.sum())), (a[smooth], b[smooth])), shape=(m, m))
    _k, labels = connected_components(graph, directed=False)

    # Fold defect groups (zero-area or hairline slivers) into a neighbour.
    group_area = np.bincount(labels, weights=area)
    tiny = group_area <= _DEFECT_AREA_FRACTION * max(float(area.sum()), 1e-300)
    if tiny.any():
        edge_len = np.linalg.norm(points[u] - points[v], axis=1)
        la, lb = labels[a], labels[b]
        cross_edge = la != lb
        best: dict[int, tuple[float, int]] = {}
        for x, y, w in zip(la[cross_edge].tolist(), lb[cross_edge].tolist(), edge_len[cross_edge].tolist(), strict=True):
            for g, other in ((x, y), (y, x)):
                if tiny[g] and not tiny[other] and w > best.get(g, (-1.0, -1))[0]:
                    best[g] = (w, other)
        remap = np.arange(len(group_area))
        for g, (_w, other) in best.items():
            remap[g] = other
        labels = remap[labels]

    # Renumber by first appearance so ids are stable for a given file.
    _uniq, first = np.unique(labels, return_index=True)
    order = np.argsort(first)
    rank = np.empty(len(order), dtype=np.int64)
    rank[order] = np.arange(len(order))
    dense = np.searchsorted(_uniq, labels)
    return rank[dense].astype(np.int32)


def group_properties(points, tris, groups) -> list[dict]:
    """Per surface: area, centroid, area-weighted normal, whether it is a plane, and its largest triangle."""
    points = np.asarray(points, dtype=np.float64)
    tris = np.asarray(tris, dtype=np.int64)
    groups = np.asarray(groups, dtype=np.int64)
    k = int(groups.max()) + 1 if len(groups) else 0
    normal, area = triangle_normals(points, tris)
    centroid = points[tris].mean(axis=1)
    g_area = np.bincount(groups, weights=area, minlength=k)
    g_cent = np.stack([np.bincount(groups, weights=area * centroid[:, j], minlength=k) for j in range(3)], axis=1)
    g_norm = np.stack([np.bincount(groups, weights=area * normal[:, j], minlength=k) for j in range(3)], axis=1)
    g_cent = g_cent / np.where(g_area > 0, g_area, 1.0)[:, None]
    nlen = np.linalg.norm(g_norm, axis=1)
    g_norm = g_norm / np.where(nlen > 0, nlen, 1.0)[:, None]
    # Largest triangle per group (its CAD face stands for the surface's orientation).
    order = np.lexsort((-area, groups))
    starts = np.r_[0, np.nonzero(np.diff(groups[order]))[0] + 1]
    largest = np.full(k, -1, dtype=np.int64)
    largest[groups[order][starts]] = order[starts]

    # Planar: every triangle's normal within _PLANAR_ANGLE_DEG of the group normal
    # and every vertex on the plane through the centroid.
    cos_tol = np.cos(np.radians(_PLANAR_ANGLE_DEG))
    dev = np.einsum("ij,ij->i", normal, g_norm[groups])
    min_dot = np.full(k, np.inf)
    np.minimum.at(min_dot, groups, np.where(area > 0, dev, np.inf))
    span = float(np.ptp(points, axis=0).max()) or 1.0
    off = np.abs(np.einsum("tij,tj->ti", points[tris] - g_cent[groups][:, None, :], g_norm[groups])).max(axis=1)
    max_off = np.zeros(k)
    np.maximum.at(max_off, groups, off)
    planar = (min_dot >= cos_tol) & (max_off <= _PLANAR_DIST * span)
    return [
        {
            "area": float(g_area[g]),
            "centroid": tuple(float(x) for x in g_cent[g]),
            "normal": tuple(float(x) for x in g_norm[g]),
            "planar": bool(planar[g]),
            "largest_triangle": int(largest[g]),
        }
        for g in range(k)
    ]


def group_boundary_edges(tris, groups) -> np.ndarray:
    """(n, 2) vertex pairs of edges between two surfaces or on an open border."""
    tris = np.asarray(tris, dtype=np.int64)
    groups = np.asarray(groups)
    ends = np.sort(tris[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    owner = np.repeat(np.arange(len(tris)), 3)
    order = np.lexsort((ends[:, 1], ends[:, 0]))
    ends, owner = ends[order], owner[order]
    starts = np.r_[True, np.any(ends[1:] != ends[:-1], axis=1)]
    first = np.nonzero(starts)[0]
    counts = np.diff(np.r_[first, len(ends)])
    border = first[counts == 1]
    pair = first[counts == 2]
    between = pair[groups[owner[pair]] != groups[owner[pair + 1]]]
    return ends[np.r_[border, between]]
