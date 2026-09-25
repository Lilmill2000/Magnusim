"""Make a CAD-exported STL fit for gmsh's discrete reparametrization.

CAD tools tessellate for size, not shape: a cylinder becomes strips of needle
triangles hundreds of times longer than wide. gmsh cannot parametrize those
reliably (inverted elements, overlapping facets, a failed volume fill). This
module splits edges longer than the target size, then flips coplanar edges to
Delaunay, so every surface is covered by well-shaped triangles lying exactly on
the original facets. Surface ids (``groups``) are carried to the new triangles.
"""
from __future__ import annotations

import numpy as np

# Flips, smoothing and crease detection: triangles this close to coplanar count as
# one plane. A CAD strip is planar to the file's float32 rounding; a finely
# faceted curved body folds by a few tenths of a degree per facet and needs to be
# treated as flat too, or its needles stay (0.05 degrees here: 5x slower surface
# meshing, 19 bad faces on a 118k-facet STL). Smoothing moves points only along
# the surface, so a fold this small shifts it by about 1% of the move. Flipping
# across 1-5 degree folds was tried: 0.15% volume lost and worse triangles.
_COPLANAR_COS = float(np.cos(np.radians(0.5)))
_FLIP_COS = _COPLANAR_COS
_MAX_SPLIT_PASSES = 40
_MAX_FLIP_ROUNDS = 200


def _edges(tris: np.ndarray):
    """Unique undirected edges and, per triangle slot (v0v1, v1v2, v2v0), its edge index."""
    tris = np.asarray(tris, dtype=np.int64)
    slots = np.stack([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]], axis=1).reshape(-1, 2)
    lo, hi = slots.min(axis=1), slots.max(axis=1)
    base = int(hi.max()) + 1 if len(hi) else 1
    keys, inverse = np.unique(lo * base + hi, return_inverse=True)
    return np.stack([keys // base, keys % base], axis=1), inverse.reshape(-1, 3)


def _twins(tri: np.ndarray, n_points: int):
    """Half-edges p -> q (slot order) and the index of their twin q -> p, if any."""
    p = tri.reshape(-1)
    q = tri[:, [1, 2, 0]].reshape(-1)
    key = p * (n_points + 1) + q
    twin_key = q * (n_points + 1) + p
    order = np.argsort(key)
    pos = np.minimum(np.searchsorted(key, twin_key, sorter=order), len(order) - 1)
    twin = order[pos]
    return p, q, twin, key[twin] == twin_key


def _flat_edges(pts, tri, grp, edges, slot_edge) -> np.ndarray:
    """Per edge: True when its two triangles are on one surface and coplanar."""
    flat_slot = slot_edge.reshape(-1)
    owner = np.repeat(np.arange(len(tri)), 3)
    order = np.argsort(flat_slot, kind="stable")
    e_sorted = flat_slot[order]
    first = np.searchsorted(e_sorted, np.arange(len(edges)), side="left")
    count = np.searchsorted(e_sorted, np.arange(len(edges)), side="right") - first
    ok = count == 2
    t1 = np.where(ok, owner[order[np.minimum(first, len(order) - 1)]], 0)
    t2 = np.where(ok, owner[order[np.minimum(first + 1, len(order) - 1)]], 0)
    n = _unit_normals(pts, tri)
    return ok & (grp[t1] == grp[t2]) & (np.einsum("ij,ij->i", n[t1], n[t2]) >= _COPLANAR_COS)


def split_long_edges(
    points, tris, groups, max_len: float, *, max_tris: int = 3_000_000, flip: bool = True, creases_only: bool = False
):
    """Conforming refinement until no edge is longer than ``max_len``.

    Each pass marks every edge over the limit and splits each triangle by its
    marked edges (1: bisect, 2: corner plus the shorter quad diagonal, 3: four
    similar triangles), so neighbours always agree. With ``flip`` the result of
    each pass is flipped to Delaunay first: otherwise a needle's long diagonals
    are split again and again, piling points along its sides. ``creases_only``
    splits only edges on a crease, a surface boundary or an open border, so a
    flat strip gets points along its sides before anything splits its diagonal.
    Stops early rather than exceed ``max_tris``.
    """
    pts = np.asarray(points, dtype=np.float64)
    tri = np.asarray(tris, dtype=np.int64)
    grp = np.asarray(groups, dtype=np.int64)
    for _ in range(_MAX_SPLIT_PASSES):
        edges, slot_edge = _edges(tri)
        length = np.linalg.norm(pts[edges[:, 0]] - pts[edges[:, 1]], axis=1)
        marked = length > max_len
        if creases_only:
            marked &= ~_flat_edges(pts, tri, grp, edges, slot_edge)
        if not marked.any():
            break
        mark = marked[slot_edge]  # (m, 3)
        count = mark.sum(axis=1)
        # Growth estimate: each pattern adds count (+1 for red) triangles.
        if len(tri) + int(count.sum()) + int((count == 3).sum()) > max_tris:
            break
        mid_index = np.full(len(edges), -1, dtype=np.int64)
        mid_index[marked] = len(pts) + np.arange(int(marked.sum()))
        pts = np.vstack([pts, 0.5 * (pts[edges[marked, 0]] + pts[edges[marked, 1]])])
        mid = mid_index[slot_edge]  # (m, 3), -1 where not split

        out_t = [tri[count == 0]]
        out_g = [grp[count == 0]]

        # Rotate each triangle to a canonical pattern: rot r maps slot j -> (j + r) % 3.
        def rotated(sel, rot, tri=tri, mid=mid, grp=grp):
            idx = (np.arange(3)[None, :] + rot[:, None]) % 3
            rows = np.nonzero(sel)[0][:, None]
            return tri[rows, idx], mid[rows, idx], grp[sel]

        # One marked edge: move it to slot 0 -> (a, m, c), (m, b, c).
        sel = count == 1
        if sel.any():
            rot = np.argmax(mark[sel], axis=1)
            v, m, g = rotated(sel, rot)
            a, b, c, m0 = v[:, 0], v[:, 1], v[:, 2], m[:, 0]
            out_t += [np.stack([a, m0, c], 1), np.stack([m0, b, c], 1)]
            out_g += [g, g]
        # Two marked: unmarked edge to slot 2 -> corner (m0, b, m1) + quad (a, m0, m1, c).
        sel = count == 2
        if sel.any():
            rot = (np.argmin(mark[sel], axis=1) + 1) % 3
            v, m, g = rotated(sel, rot)
            a, b, c, m0, m1 = v[:, 0], v[:, 1], v[:, 2], m[:, 0], m[:, 1]
            out_t.append(np.stack([m0, b, m1], 1))
            out_g.append(g)
            d_am1 = np.linalg.norm(pts[a] - pts[m1], axis=1)
            d_m0c = np.linalg.norm(pts[m0] - pts[c], axis=1)
            short = d_am1 <= d_m0c
            first = np.where(short[:, None], np.stack([a, m0, m1], 1), np.stack([a, m0, c], 1))
            second = np.where(short[:, None], np.stack([a, m1, c], 1), np.stack([m0, m1, c], 1))
            out_t += [first, second]
            out_g += [g, g]
        # Three marked: four similar triangles.
        sel = count == 3
        if sel.any():
            v, m, g = rotated(sel, np.zeros(int(sel.sum()), dtype=np.int64))
            a, b, c, m0, m1, m2 = v[:, 0], v[:, 1], v[:, 2], m[:, 0], m[:, 1], m[:, 2]
            out_t += [np.stack(x, 1) for x in ((a, m0, m2), (m0, b, m1), (m2, m1, c), (m0, m1, m2))]
            out_g += [g, g, g, g]
        tri = np.concatenate(out_t)
        grp = np.concatenate(out_g)
        if flip:
            tri = flip_to_delaunay(pts, tri, grp)
            if not creases_only:
                # Crease-only passes add points on creases, which never move.
                pts = smooth_flat_interior(pts, tri, grp)
                tri = flip_to_delaunay(pts, tri, grp)
    return pts, tri, grp


def _unit_normals(pts, tri):
    n = np.cross(pts[tri[:, 1]] - pts[tri[:, 0]], pts[tri[:, 2]] - pts[tri[:, 0]])
    return n / np.maximum(np.linalg.norm(n, axis=1), 1e-300)[:, None]


def smooth_flat_interior(points, tris, groups, *, iterations: int = 3, weight: float = 0.5):
    """Move each vertex inside a flat region toward the mean of its neighbours.

    A vertex is free when every triangle around it is on one surface and in one
    plane; its neighbours then lie in that plane too, so the move keeps it on
    the original facets. Crease and surface-boundary vertices stay put. A move
    that would fold a triangle is undone.
    """
    pts = np.array(points, dtype=np.float64, copy=True)
    tri = np.asarray(tris, dtype=np.int64)
    grp = np.asarray(groups, dtype=np.int64)
    nv = len(pts)
    corner_v = tri.reshape(-1)
    corner_t = np.repeat(np.arange(len(tri)), 3)
    n0 = _unit_normals(pts, tri)
    # Free: one group and all incident normals within the coplanar tolerance of the mean.
    g_min = np.full(nv, np.iinfo(np.int64).max)
    g_max = np.full(nv, -1)
    np.minimum.at(g_min, corner_v, grp[corner_t])
    np.maximum.at(g_max, corner_v, grp[corner_t])
    mean_n = np.zeros((nv, 3))
    np.add.at(mean_n, corner_v, n0[corner_t])
    mean_n /= np.maximum(np.linalg.norm(mean_n, axis=1), 1e-300)[:, None]
    dots = np.einsum("ij,ij->i", n0[corner_t], mean_n[corner_v])
    min_dot = np.full(nv, np.inf)
    np.minimum.at(min_dot, corner_v, dots)
    # Open-border vertices (edge used once) are never free.
    edges, slot_edge = _edges(tri)
    use = np.bincount(slot_edge.ravel(), minlength=len(edges))
    border = np.zeros(nv, dtype=bool)
    border[edges[use != 2].ravel()] = True
    free = (g_min == g_max) & (min_dot >= _COPLANAR_COS) & ~border
    if not free.any():
        return pts
    a, b = edges[:, 0], edges[:, 1]
    deg = np.bincount(np.r_[a, b], minlength=nv).astype(np.float64)
    for _ in range(iterations):
        acc = np.zeros((nv, 3))
        np.add.at(acc, a, pts[b])
        np.add.at(acc, b, pts[a])
        target = acc / np.maximum(deg, 1.0)[:, None]
        # Tangential move only: drop the component along the vertex normal, so a
        # point in a region that is only nearly flat stays on the surface.
        move = weight * (target[free] - pts[free])
        n_free = mean_n[free]
        move -= np.einsum("ij,ij->i", move, n_free)[:, None] * n_free
        trial = pts.copy()
        trial[free] += move
        # Undo moves around any triangle that would turn over, until none do.
        for _undo in range(10):
            flipped = np.einsum("ij,ij->i", _unit_normals(trial, tri), n0) < 0.5
            if not flipped.any():
                break
            bad = np.unique(tri[flipped].reshape(-1))
            trial[bad] = pts[bad]
        pts = trial
    return pts


def _opposite_angle(pts, apex, p, q):
    u = pts[p] - pts[apex]
    v = pts[q] - pts[apex]
    cos = np.einsum("ij,ij->i", u, v) / np.maximum(np.linalg.norm(u, axis=1) * np.linalg.norm(v, axis=1), 1e-300)
    return np.arccos(np.clip(cos, -1.0, 1.0))


def flip_to_delaunay(points, tris, groups):
    """Flip edges between coplanar triangles of the same surface until locally Delaunay.

    Only triangles with a coplanar neighbour on their surface can ever flip, so
    the rounds run on that subset (flat strips), not on a finely curved body.
    """
    pts = np.asarray(points, dtype=np.float64)
    tri = np.array(tris, dtype=np.int64, copy=True)
    grp = np.asarray(groups, dtype=np.int64)
    if not len(tri):
        return tri
    p, _q, twin, has = _twins(tri, len(pts))
    owner = np.repeat(np.arange(len(tri)), 3)
    normal = _unit_normals(pts, tri)
    h = np.nonzero(has)[0]
    ta, tb = owner[h], owner[twin[h]]
    flat = (grp[ta] == grp[tb]) & (np.einsum("ij,ij->i", normal[ta], normal[tb]) >= _FLIP_COS)
    active = np.unique(ta[flat])
    if not len(active):
        return tri
    sub = tri[active]
    sub_grp = grp[active]
    m = len(sub)
    for _ in range(_MAX_FLIP_ROUNDS):
        p, q, twin, has = _twins(sub, len(pts))
        r = sub[:, [2, 0, 1]].reshape(-1)
        owner = np.repeat(np.arange(m), 3)
        # Each interior edge once: from the half-edge with p < q.
        h1 = np.nonzero(has & (p < q))[0]
        h2 = twin[h1]
        t1, t2 = owner[h1], owner[h2]
        n = _unit_normals(pts, sub)
        ok = (sub_grp[t1] == sub_grp[t2]) & (t1 != t2) & (r[h1] != r[h2])
        ok[ok] = np.einsum("ij,ij->i", n[t1[ok]], n[t2[ok]]) >= _FLIP_COS
        h1, h2, t1, t2 = h1[ok], h2[ok], t1[ok], t2[ok]
        r1, r2 = r[h1], r[h2]
        excess = _opposite_angle(pts, r1, p[h1], q[h1]) + _opposite_angle(pts, r2, p[h1], q[h1]) - np.pi
        # The flipped pair (p, r2, r1), (r2, q, r1) must stay within the fold limit
        # and keep its orientation (a folded quad could turn a triangle over).
        pp, qq = p[h1], q[h1]
        na = np.cross(pts[r2] - pts[pp], pts[r1] - pts[pp])
        nb = np.cross(pts[qq] - pts[r2], pts[r1] - pts[r2])
        na /= np.maximum(np.linalg.norm(na, axis=1), 1e-300)[:, None]
        nb /= np.maximum(np.linalg.norm(nb, axis=1), 1e-300)[:, None]
        mean = n[t1] + n[t2]
        valid = (
            (np.einsum("ij,ij->i", na, nb) >= _FLIP_COS)
            & (np.einsum("ij,ij->i", na, mean) > 0)
            & (np.einsum("ij,ij->i", nb, mean) > 0)
        )
        cand = np.nonzero((excess > 1e-9) & valid)[0]
        if not len(cand):
            break
        # Independent set: an edge flips when it is the worst candidate of both its triangles.
        best = np.full(m, -np.inf)
        np.maximum.at(best, t1[cand], excess[cand])
        np.maximum.at(best, t2[cand], excess[cand])
        win = cand[(excess[cand] >= best[t1[cand]]) & (excess[cand] >= best[t2[cand]])]
        # Ties can pick two edges of one triangle; keep the first per triangle.
        pair = np.concatenate([t1[win], t2[win]])
        _u, first_at = np.unique(pair, return_index=True)
        used = np.zeros(len(pair), dtype=bool)
        used[first_at] = True
        keep = win[used[: len(win)] & used[len(win):]]
        if not len(keep):
            break
        pk, qk, r1k, r2k = p[h1[keep]], q[h1[keep]], r1[keep], r2[keep]
        # t1 = (p, q, r1), t2 = (q, p, r2) -> (p, r2, r1), (r2, q, r1): same winding.
        sub[t1[keep]] = np.stack([pk, r2k, r1k], 1)
        sub[t2[keep]] = np.stack([r2k, qk, r1k], 1)
    tri[active] = sub
    return tri


def _refine(points, tris, groups, target: float):
    pts, tri, grp = split_long_edges(points, tris, groups, float(target), creases_only=True)
    tri = flip_to_delaunay(pts, tri, grp)
    return split_long_edges(pts, tri, grp, float(target))


def collapse_short_edges(points, tris, groups, tol: float):
    """Collapse sliver-cap edges: shorter than ``tol`` and than a tenth of their triangles.

    A CAD tessellation leaves caps such as a 10-micron edge beside 1 mm ones; a
    finely faceted small radius has many short edges that are not caps, and those
    stay. One end moves onto the other: the end on more surface boundaries stays,
    so boundaries and corners keep their shape; an edge joining two boundary
    points across a surface is left alone. A collapse is made only when it keeps
    the manifold (link condition) and improves the worst triangle it touches.
    Returns (points, tris, groups).
    """
    pts = np.asarray(points, dtype=np.float64)
    tri = np.array(tris, dtype=np.int64, copy=True)
    grp = np.asarray(groups, dtype=np.int64)
    edges, slot = _edges(tri)
    length = np.linalg.norm(pts[edges[:, 0]] - pts[edges[:, 1]], axis=1)
    tri_long = length[slot].max(axis=1)
    beside = np.full(len(edges), np.inf)
    np.minimum.at(beside, slot.reshape(-1), np.repeat(tri_long, 3))
    short = np.nonzero((length < float(tol)) & (length < 0.1 * beside))[0]
    if not len(short):
        return pts, tri, grp
    short = short[np.argsort(length[short])]
    # Vertex -> incident triangles, and the surfaces around each vertex.
    corner_v = tri.reshape(-1)
    corner_t = np.repeat(np.arange(len(tri)), 3)
    order = np.argsort(corner_v, kind="stable")
    cv, ct = corner_v[order], corner_t[order]
    starts = np.searchsorted(cv, np.arange(len(pts) + 1))
    touched = {int(v) for e in short for v in edges[e]}
    inc: dict[int, set[int]] = {v: set(ct[starts[v]:starts[v + 1]].tolist()) for v in touched}
    alive = np.ones(len(tri), dtype=bool)
    normal = _unit_normals(pts, tri)

    def ring(v):
        return {int(x) for t in inc[v] if alive[t] for x in tri[t]} - {v}

    def n_groups(v):
        return len({int(grp[t]) for t in inc[v] if alive[t]})

    for e in short.tolist():
        a, b = int(edges[e, 0]), int(edges[e, 1])
        if a not in inc or b not in inc:
            continue
        shared = [t for t in inc[a] & inc[b] if alive[t]]
        if len(shared) != 2:
            continue
        opposite = {int(x) for t in shared for x in tri[t]} - {a, b}
        if ring(a) & ring(b) != opposite:
            continue  # link condition: would pinch the surface
        ga, gb = n_groups(a), n_groups(b)
        across = grp[shared[0]] != grp[shared[1]]
        if not across and ga > 1 and gb > 1:
            continue  # two boundary points across one surface
        keep, drop = (a, b) if ga >= gb else (b, a)
        moved = [t for t in inc[drop] if alive[t] and t not in shared]
        new = tri[moved].copy()
        new[new == drop] = keep
        c = pts[new]
        nn = np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0])
        nl = np.linalg.norm(nn, axis=1)
        if (nl <= 0).any() or (np.einsum("ij,ij->i", nn / nl[:, None], normal[moved]) < 0.9).any():
            continue  # would turn or fold a triangle
        if triangle_gamma(pts, new).min() <= triangle_gamma(pts, tri[moved + shared]).min():
            continue  # no better than the sliver it removes
        alive[shared] = False
        tri[moved] = new
        inc[keep] = (inc[keep] | set(moved)) - set(shared)
        del inc[drop]
        for x in opposite:
            if x in inc:
                inc[x] -= set(shared)
    return pts, tri[alive], grp[alive]


def flip_bad_triangles(points, tris, groups, max_shift: float, *, gamma_below: float = 0.1, rounds: int = 20):
    """Flip the longest edge of a poorly shaped triangle when the surface barely moves.

    Nearly flat obtuse triangles on a curved part cannot be fixed by coplanar
    flips, and gmsh cannot parametrize around them. Their longest edge is
    flipped when the pair stays on one surface, the worse triangle of the pair
    improves by half again, and the flip sweeps the surface by at most
    ``max_shift`` (height of the swept tetrahedron over the pair's area).
    """
    pts = np.asarray(points, dtype=np.float64)
    tri = np.array(tris, dtype=np.int64, copy=True)
    grp = np.asarray(groups, dtype=np.int64)
    for _ in range(rounds):
        gamma = triangle_gamma(pts, tri)
        bad = np.nonzero(gamma < gamma_below)[0]
        if not len(bad):
            break
        p, q, twin, has = _twins(tri, len(pts))
        r = tri[:, [2, 0, 1]].reshape(-1)
        owner = np.repeat(np.arange(len(tri)), 3)
        c = pts[tri[bad]]
        longest = np.argmax(np.linalg.norm(c[:, [1, 2, 0]] - c, axis=2), axis=1)
        h1 = 3 * bad + longest
        ok = has[h1]
        h1 = h1[ok]
        h2 = twin[h1]
        t1, t2 = owner[h1], owner[h2]
        pp, qq, r1, r2 = p[h1], q[h1], r[h1], r[h2]
        keep = (grp[t1] == grp[t2]) & (r1 != r2)
        # New pair (p, r2, r1), (r2, q, r1).
        new1 = np.stack([pp, r2, r1], 1)
        new2 = np.stack([r2, qq, r1], 1)
        before = np.minimum(gamma[t1], gamma[t2])
        after = np.minimum(triangle_gamma(pts, new1), triangle_gamma(pts, new2))
        n_old = _unit_normals(pts, tri[t1]) + _unit_normals(pts, tri[t2])
        facing = (np.einsum("ij,ij->i", _unit_normals(pts, new1), n_old) > 0) & (
            np.einsum("ij,ij->i", _unit_normals(pts, new2), n_old) > 0
        )
        vol = np.abs(np.einsum("ij,ij->i", pts[qq] - pts[pp], np.cross(pts[r1] - pts[pp], pts[r2] - pts[pp]))) / 6.0
        area = 0.5 * (
            np.linalg.norm(np.cross(pts[qq] - pts[pp], pts[r1] - pts[pp]), axis=1)
            + np.linalg.norm(np.cross(pts[qq] - pts[pp], pts[r2] - pts[pp]), axis=1)
        )
        shift = 3.0 * vol / np.maximum(area, 1e-300)
        keep &= facing & (after > 1.5 * before) & (shift <= float(max_shift))
        idx = np.nonzero(keep)[0]
        if not len(idx):
            break
        # One flip per triangle per round.
        pair = np.concatenate([t1[idx], t2[idx]])
        _u, first_at = np.unique(pair, return_index=True)
        used = np.zeros(len(pair), dtype=bool)
        used[first_at] = True
        idx = idx[used[: len(idx)] & used[len(idx):]]
        tri[t1[idx]] = new1[idx]
        tri[t2[idx]] = new2[idx]
    return tri


def refine_for_parametrization(points, tris, groups, target: float, *, collapse_tol: float = 0.0):
    """Collapse sliver edges, then split to ``target`` edge length, flip and smooth.

    Returns (points, tris, groups). With ``collapse_tol`` edges shorter than it
    are collapsed first (``collapse_short_edges``). Then only flat regions
    (coplanar triangles of one surface) that hold an edge longer than ``target``
    are touched: their outer edges are all short, so nothing outside them splits,
    and a finely faceted body is left as it is. Triangles come back in a new
    order; ``groups`` follows them.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    pts = np.asarray(points, dtype=np.float64)
    tri = np.asarray(tris, dtype=np.int64)
    grp = np.asarray(groups, dtype=np.int64)
    if collapse_tol > 0:
        pts, tri, grp = collapse_short_edges(pts, tri, grp, collapse_tol)
    edges, slot = _edges(tri)
    length = np.linalg.norm(pts[edges[:, 0]] - pts[edges[:, 1]], axis=1)
    long_tri = (length[slot] > float(target)).any(axis=1)
    if not long_tri.any():
        if collapse_tol > 0:
            tri = flip_bad_triangles(pts, tri, grp, 0.1 * collapse_tol)
        return pts, tri, grp
    # Flat regions: components of triangles joined across coplanar same-surface edges.
    p, _q, twin, has = _twins(tri, len(pts))
    owner = np.repeat(np.arange(len(tri)), 3)
    h = np.nonzero(has)[0]
    ta, tb = owner[h], owner[twin[h]]
    normal = _unit_normals(pts, tri)
    flat = (grp[ta] == grp[tb]) & (np.einsum("ij,ij->i", normal[ta], normal[tb]) >= _COPLANAR_COS)
    graph = coo_matrix((np.ones(int(flat.sum())), (ta[flat], tb[flat])), shape=(len(tri), len(tri)))
    _k, region = connected_components(graph, directed=False)
    need = np.isin(region, np.unique(region[long_tri]))
    new_pts, sub_tri, sub_grp = _refine(pts, tri[need], grp[need], target)
    tri = np.concatenate([tri[~need], sub_tri])
    grp = np.concatenate([grp[~need], sub_grp])
    if collapse_tol > 0:
        tri = flip_bad_triangles(new_pts, tri, grp, 0.1 * collapse_tol)
    return new_pts, tri, grp


def triangle_gamma(points, tris) -> np.ndarray:
    """Shape quality 4*sqrt(3)*area / sum(edge^2): 1 for equilateral, 0 for a needle."""
    c = np.asarray(points)[np.asarray(tris)]
    e2 = sum(np.einsum("ij,ij->i", c[:, j] - c[:, i], c[:, j] - c[:, i]) for i, j in ((0, 1), (1, 2), (2, 0)))
    area = np.linalg.norm(np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0]), axis=1) / 2.0
    return 4.0 * np.sqrt(3.0) * area / np.maximum(e2, 1e-300)

