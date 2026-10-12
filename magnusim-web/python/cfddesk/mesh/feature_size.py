"""Automatic feature refinement for the Standard mesher.

A part meshed at one uniform size ``h`` keeps its large shapes, but a feature
much smaller than ``h`` (a 1.5 mm louver tab on a 3 m plate, a 0.2 mm slit, a
13 mm hole) is cut across by triangles of size ``h``: the surface turns into
needles there, the tets next to it are slivers, and the solver diverges on
them. Here the mesh is made finer around such features on its own, the way
SimScale's automatic sizing does:

* sources: points on the CAD with the size a cell there should have:
  - curves shorter than ``FEATURE_FRACTION`` x h (their length),
  - faces narrower than that (width = 2 x area / perimeter),
  - narrow gaps of fluid between two walls (their width, measured on a first
    surface mesh at size h);
* the size field: from each source, the size grows with distance at the
  mesh's own gradation (each cell at most ``gradation`` times its
  neighbour), up to ``h``;
* a floor: no cell smaller than ``h / 2**FLOOR_HALVINGS`` (and not below the
  small feature suppression size); when the estimated number of cells would
  pass ``CELL_BUDGET`` times what the part takes at a uniform size h, the
  floor is raised until it fits, so no part can explode.

The field is given to gmsh as a background mesh (a PostView on an octree of
boxes, each about the local size), so the surface and the tets both follow
it, in whichever gmsh model the volume is filled.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass

import numpy as np

# Curves shorter, and faces or fluid gaps narrower, than this x h are features.
FEATURE_FRACTION = 0.25
# Smallest feature cell: h / 2**FLOOR_HALVINGS (a fineness step changes h).
FLOOR_HALVINGS = 4
# The floor goes up in steps of this factor until the estimate fits the budget.
FLOOR_STEP = math.sqrt(2.0)
# Most cells the refinement may lead to, in units of the cells the part takes at
# a uniform size h.
CELL_BUDGET = 6.0
# Tetrahedra gmsh makes per cube of the local size (calibrated on Standard meshes).
TETS_PER_SIZE3 = 6.0
# A narrow face counts when it meets its neighbours at more than this angle
# along more than half of its rim.
_SMOOTH_ANGLE_DEG = 30.0
# Curves shorter than this (metres) are degenerate (a cone's apex, a sphere's pole).
_DEGENERATE_M = 1e-9
# Bucket sizes for the field: a source's size is rounded down to the nearest
# floor x 2**(k / _BUCKETS_PER_OCTAVE).
_BUCKETS_PER_OCTAVE = 4
# Octree boxes are split while larger than this x the size at their centre: finer
# for the background field gmsh reads, coarser for the cell estimate (which
# changes by a few percent between the two).
_BOX_PER_SIZE_FIELD = 1.5
_BOX_PER_SIZE_ESTIMATE = 3.0
# Most octree boxes kept for the background field (memory: 32 doubles a box).
_MAX_BOXES = 1_200_000


@dataclass
class SizeSources:
    """Points on the part and the cell size each asks for (before the floor)."""

    points: np.ndarray  # (n, 3)
    sizes: np.ndarray  # (n,)
    n_curves: int = 0
    n_faces: int = 0
    n_gaps: int = 0

    @staticmethod
    def empty() -> SizeSources:
        return SizeSources(np.zeros((0, 3)), np.zeros(0))

    def __len__(self) -> int:
        return int(len(self.sizes))

    def joined(self, other: SizeSources) -> SizeSources:
        return SizeSources(
            np.vstack([self.points, other.points]),
            np.concatenate([self.sizes, other.sizes]),
            self.n_curves + other.n_curves,
            self.n_faces + other.n_faces,
            self.n_gaps + other.n_gaps,
        )


class GradedSize:
    """size(x) = min(h, min over sources of size_i + slope x |x - p_i|), size_i >= floor.

    Sources are bucketed by size (a quarter octave apart, rounded down) with a
    k-d tree per bucket, so one evaluation is a few nearest-point queries.
    """

    def __init__(self, sources: SizeSources, *, h: float, floor: float, slope: float):
        from scipy.spatial import cKDTree

        self.h = float(h)
        self.floor = float(floor)
        self.slope = max(float(slope), 1e-3)
        s = np.clip(np.asarray(sources.sizes, dtype=float), self.floor, self.h)
        keep = s < self.h * 0.999
        pts = np.asarray(sources.points, dtype=float)[keep]
        s = s[keep]
        k = np.floor(np.log2(s / self.floor) * _BUCKETS_PER_OCTAVE + 1e-9).astype(np.int64)
        self.buckets: list[tuple[float, object]] = []
        for b in np.unique(k):
            sel = k == b
            size = self.floor * 2.0 ** (float(b) / _BUCKETS_PER_OCTAVE)
            self.buckets.append((size, cKDTree(pts[sel])))
        self.n_points = int(len(pts))

    def __bool__(self) -> bool:
        return bool(self.buckets)

    def capped(self, cap: float) -> GradedSize:
        """The same field growing on up to ``cap`` instead of h (tets without a hex
        core grow past h away from the walls)."""
        from copy import copy

        out = copy(self)
        out.h = float(cap)
        return out

    def __call__(self, x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=float).reshape(-1, 3)
        out = np.full(len(x), self.h)
        for size, tree in self.buckets:
            reach = (self.h - size) / self.slope
            d, _ = tree.query(x, distance_upper_bound=reach, workers=-1)  # type: ignore[attr-defined]
            np.minimum(out, size + self.slope * d, out=out)
        return out


# ------------------------------------------------------------------ sources --


def _curve_samples(gmsh, curve: int, length: float, spacing: float) -> np.ndarray:
    lo, hi = gmsh.model.getParametrizationBounds(1, int(curve))
    n = max(2, int(math.ceil(length / max(spacing, 1e-12))) + 1)
    t = np.linspace(float(lo[0]), float(hi[0]), n)
    return np.asarray(gmsh.model.getValue(1, int(curve), t.tolist()), dtype=float).reshape(-1, 3)


@dataclass
class FeatureCurves:
    """CAD curves of short curves and narrow faces, with the size each asks for."""

    size: dict[int, float]  # curve -> cell size (its length, or its narrow face's width)
    length: dict[int, float]
    n_curves: int
    n_faces: int


def _normal_at(gmsh, face: int, point: np.ndarray) -> np.ndarray | None:
    try:
        uv = gmsh.model.getParametrization(2, int(face), point.tolist())
        n = np.asarray(gmsh.model.getNormal(int(face), list(uv)), dtype=float)[:3]
    except Exception:
        return None
    ln = float(np.linalg.norm(n))
    return n / ln if ln > 0 else None


def bends_from_neighbours(gmsh, face: int, curves: list[int], faces_of: dict[int, list[int]], length: dict[int, float]) -> bool:
    """Does ``face`` meet its neighbours at an angle along most of its rim (a
    fin's rim, a hole's wall: an edge on each long side)?

    A narrow face that continues a neighbour smoothly along a long side (a sliver
    a CAD split left in a smooth surface, even along a real edge of the part) is
    no feature of its own: meshing it finer would only refine around a split line
    the part does not have."""
    limit = math.cos(math.radians(_SMOOTH_ANGLE_DEG))
    rim = sum(length[c] for c in curves if _DEGENERATE_M < length.get(c, 0.0) < math.inf)
    bent = 0.0
    for c in curves:
        if not (_DEGENERATE_M < length.get(c, 0.0) < math.inf):
            continue
        others = [f for f in faces_of.get(c, []) if f != face]
        if not others:
            continue
        try:
            lo, hi = gmsh.model.getParametrizationBounds(1, int(c))
            p = np.asarray(gmsh.model.getValue(1, int(c), [0.5 * (float(lo[0]) + float(hi[0]))]), dtype=float)[:3]
        except Exception:
            bent += length[c]
            continue
        n0 = _normal_at(gmsh, face, p)
        normals = [_normal_at(gmsh, f, p) for f in others]
        if n0 is None or any(n1 is None or abs(float(n0 @ n1)) < limit for n1 in normals):
            bent += length[c]
        if bent > 0.5 * rim:
            return True
    return False


def feature_curves(gmsh, surfs: list[int], *, h: float) -> FeatureCurves:
    """Curves shorter than ``FEATURE_FRACTION`` x h ask for their length; the rim of
    a face narrower than that (2 x area / perimeter) asks for the face's width when
    the face bends away from a neighbour. Degenerate (zero-length) curves do not
    count."""
    limit = FEATURE_FRACTION * float(h)
    curves_of: dict[int, list[int]] = {}
    length: dict[int, float] = {}
    for s in surfs:
        bnd = gmsh.model.getBoundary([(2, int(s))], combined=False, oriented=False, recursive=False)
        cs = [abs(int(c)) for _d, c in bnd]
        curves_of[int(s)] = cs
        for c in cs:
            if c not in length:
                try:
                    length[c] = float(gmsh.model.occ.getMass(1, c))
                except Exception:
                    length[c] = math.inf
    want: dict[int, float] = {c: L for c, L in length.items() if _DEGENERATE_M < L < limit}
    faces_of: dict[int, list[int]] = {}
    for s, cs in curves_of.items():
        for c in cs:
            faces_of.setdefault(c, []).append(s)
    n_curves = len(want)
    n_faces = 0
    for s, cs in curves_of.items():
        perimeter = sum(length[c] for c in cs if math.isfinite(length[c]))
        if perimeter <= 0:
            continue
        try:
            area = float(gmsh.model.occ.getMass(2, s))
        except Exception:
            continue
        width = 2.0 * area / perimeter
        if width >= limit or not bends_from_neighbours(gmsh, s, cs, faces_of, length):
            continue
        n_faces += 1
        for c in cs:
            if _DEGENERATE_M < length[c] < math.inf:
                want[c] = min(want.get(c, math.inf), width)
    return FeatureCurves(want, length, n_curves, n_faces)


def cad_sources(gmsh, surfs: list[int], *, h: float, spacing: float, curves: FeatureCurves | None = None) -> SizeSources:
    """Short curves and narrow faces of the surfaces ``surfs`` (OCC model) as sources.

    Each feature curve is sampled about ``spacing`` apart (the smallest size the
    field can ask for, so the field is sound between samples). A narrow face is
    sampled along its boundary: every point of a face of width w lies within w
    of its rim.
    """
    fc = curves if curves is not None else feature_curves(gmsh, surfs, h=h)
    pts: list[np.ndarray] = []
    sizes: list[np.ndarray] = []
    for c, size in fc.size.items():
        try:
            p = _curve_samples(gmsh, c, fc.length[c], max(spacing, min(size, fc.length[c] / 2.0)))
        except Exception:
            continue
        pts.append(p)
        sizes.append(np.full(len(p), float(size)))
    if not pts:
        return SizeSources.empty()
    return SizeSources(np.vstack(pts), np.concatenate(sizes), n_curves=fc.n_curves, n_faces=fc.n_faces)


def points_inside(nodes: np.ndarray, tris: np.ndarray, pts: np.ndarray, *, chunk: int = 200_000) -> np.ndarray:
    """Inside test against a closed triangulated surface: ray parity along +z.

    Triangles are binned on an x-y grid; each point is tested against the
    triangles of its bin only. The ray is shifted by a tiny fraction so it
    does not run through a node or along an edge.
    """
    nodes = np.asarray(nodes, dtype=float)
    tris = np.asarray(tris, dtype=np.int64)
    pts = np.asarray(pts, dtype=float).reshape(-1, 3)
    out = np.zeros(len(pts), dtype=bool)
    if not len(tris) or not len(pts):
        return out
    corners = nodes[tris]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    det = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    ok = np.abs(det) > 1e-30
    a, b, c, det = a[ok], b[ok], c[ok], det[ok]
    lo = np.minimum(np.minimum(a, b), c)[:, :2]
    hi = np.maximum(np.maximum(a, b), c)[:, :2]
    ext = hi - lo
    span = nodes.max(axis=0)[:2] - nodes.min(axis=0)[:2]
    cell = max(float(np.median(ext.max(axis=1))) * 2.0, float(span.max()) / 2048.0, 1e-12)
    origin = nodes.min(axis=0)[:2] - cell
    nx = int(math.ceil((span[0] + 2 * cell) / cell)) + 1
    i0 = np.floor((lo - origin) / cell).astype(np.int64)
    i1 = np.floor((hi - origin) / cell).astype(np.int64)
    ni = i1[:, 0] - i0[:, 0] + 1
    nj = i1[:, 1] - i0[:, 1] + 1
    cnt = ni * nj
    tri = np.repeat(np.arange(len(a)), cnt)
    k = np.arange(int(cnt.sum())) - np.repeat(np.cumsum(cnt) - cnt, cnt)
    bins = (i0[tri, 0] + k // nj[tri]) * (nx + 1) + (i0[tri, 1] + k % nj[tri])
    order = np.argsort(bins, kind="stable")
    bins, tri = bins[order], tri[order]
    jitter = np.array([0.123456789e-7, 0.234567891e-7]) * cell
    for s0 in range(0, len(pts), chunk):
        q = pts[s0 : s0 + chunk]
        qxy = q[:, :2] + jitter
        qi = np.floor((qxy - origin) / cell).astype(np.int64)
        qb = qi[:, 0] * (nx + 1) + qi[:, 1]
        start = np.searchsorted(bins, qb, side="left")
        stop = np.searchsorted(bins, qb, side="right")
        n = stop - start
        if not n.sum():
            continue
        qp = np.repeat(np.arange(len(q)), n)
        kk = np.arange(int(n.sum())) - np.repeat(np.cumsum(n) - n, n)
        t = tri[np.repeat(start, n) + kk]
        px, py = qxy[qp, 0], qxy[qp, 1]
        at, bt, ct, dt = a[t], b[t], c[t], det[t]
        l1 = ((px - at[:, 0]) * (ct[:, 1] - at[:, 1]) - (ct[:, 0] - at[:, 0]) * (py - at[:, 1])) / dt
        l2 = ((bt[:, 0] - at[:, 0]) * (py - at[:, 1]) - (px - at[:, 0]) * (bt[:, 1] - at[:, 1])) / dt
        hit = (l1 >= 0) & (l2 >= 0) & (l1 + l2 <= 1)
        zc = at[:, 2] + l1 * (bt[:, 2] - at[:, 2]) + l2 * (ct[:, 2] - at[:, 2])
        above = hit & (zc > q[qp, 2])
        crossings = np.bincount(qp[above], minlength=len(q))
        out[s0 : s0 + chunk] = (crossings % 2) == 1
    return out


def fluid_gap_sources(nodes: np.ndarray, tris: np.ndarray, *, h: float) -> SizeSources:
    """Narrow gaps of fluid: two walls facing each other closer than
    ``FEATURE_FRACTION`` x h, with fluid between them (a thin sheet cut out of
    the fluid, a baffle, is not a gap). Measured on a surface mesh of size about h:
    each triangle's centroid is projected onto the triangles near it."""
    from cfddesk.mesh.surface_checks import near_triangle_pairs, triangle_spheres

    tris = np.asarray(tris, dtype=np.int64)
    nodes = np.asarray(nodes, dtype=float)
    if len(tris) < 2:
        return SizeSources.empty()
    t_max = FEATURE_FRACTION * float(h)
    corners = nodes[tris]
    cent, rad = triangle_spheres(nodes, tris)
    nrm = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    nlen = np.linalg.norm(nrm, axis=1)
    good = nlen > 0
    nrm[good] /= nlen[good][:, None]
    i, j = near_triangle_pairs(cent, rad, t_max)
    if not len(i):
        return SizeSources.empty()
    sel = (nrm[i] * nrm[j]).sum(axis=1) < -0.5
    for p in range(3):
        for q in range(3):
            sel &= tris[i, p] != tris[j, q]
    i, j = i[sel], j[sel]
    if not len(i):
        return SizeSources.empty()

    def _onto(src, dst):
        d = ((cent[src] - corners[dst, 0]) * nrm[dst]).sum(axis=1)
        foot = cent[src] - d[:, None] * nrm[dst]
        v0 = corners[dst, 1] - corners[dst, 0]
        v1 = corners[dst, 2] - corners[dst, 0]
        v2 = foot - corners[dst, 0]
        d00 = (v0 * v0).sum(axis=1)
        d01 = (v0 * v1).sum(axis=1)
        d11 = (v1 * v1).sum(axis=1)
        d20 = (v2 * v0).sum(axis=1)
        d21 = (v2 * v1).sum(axis=1)
        den = d00 * d11 - d01 * d01
        den = np.where(np.abs(den) > 0, den, 1.0)
        bv = (d11 * d20 - d01 * d21) / den
        bw = (d00 * d21 - d01 * d20) / den
        inside = (bv >= -0.05) & (bw >= -0.05) & (bv + bw <= 1.05)
        return np.abs(d), foot, inside

    d_ij, f_ij, in_ij = _onto(i, j)
    d_ji, f_ji, in_ji = _onto(j, i)
    use_ij = in_ij & (~in_ji | (d_ij <= d_ji))
    t = np.where(use_ij, d_ij, np.where(in_ji, d_ji, np.inf))
    foot = np.where(use_ij[:, None], f_ij, f_ji)
    base = np.where(use_ij[:, None], cent[i], cent[j])
    hit = np.isfinite(t) & (t > 1e-12) & (t < t_max)
    if not hit.any():
        return SizeSources.empty()
    i, j, t = i[hit], j[hit], t[hit]
    mid = 0.5 * (base[hit] + foot[hit])
    fluid = points_inside(nodes, tris, mid)
    if not fluid.any():
        return SizeSources.empty()
    i, j, t, mid = i[fluid], j[fluid], t[fluid], mid[fluid]
    pts = np.vstack([cent[i], cent[j], mid])
    sizes = np.concatenate([t, t, t])
    return SizeSources(pts, sizes, n_gaps=int(len(t)))


# ------------------------------------------------------------------ octree ---


@dataclass
class SizeOctree:
    """Boxes covering the part, each about the local size or smaller."""

    lo: np.ndarray  # (n, 3) box corner
    edge: np.ndarray  # (n,) box edge length
    centre_size: np.ndarray  # (n,) field at the box centre
    root: np.ndarray  # (n,) the box of edge h it was split from
    root_centres: np.ndarray  # (m, 3)
    root_shape: tuple[int, int, int]
    root_origin: np.ndarray  # (3,) centre of root box 0
    h: float

    def __len__(self) -> int:
        return int(len(self.edge))

    def inside(self, nodes: np.ndarray, tris: np.ndarray) -> np.ndarray:
        """Boxes whose root box centre lies in the fluid (ray parity on a lattice:
        quick, and exact enough for a cell estimate)."""
        from cfddesk.mesh.standard_hexcore import _lattice_inside

        nx, ny, nz = self.root_shape
        o = self.root_origin
        gx = o[0] + self.h * np.arange(nx)
        gy = o[1] + self.h * np.arange(ny)
        gz = o[2] + self.h * np.arange(nz)
        roots = _lattice_inside(nodes, tris, gx, gy, gz, self.h).ravel()
        return roots[self.root]


def build_octree(
    field: GradedSize, bmin, bmax, *, box_per_size: float = _BOX_PER_SIZE_FIELD, max_boxes: int = _MAX_BOXES
) -> SizeOctree:
    """Boxes of edge h over the bounding box, split in eight while larger than
    ``box_per_size`` x the size at their centre (never below half the floor)."""
    h = field.h
    bmin = np.asarray(bmin, dtype=float) - 0.5 * h
    bmax = np.asarray(bmax, dtype=float) + 0.5 * h
    n = np.maximum(np.ceil((bmax - bmin) / h).astype(np.int64), 1)
    ii = np.stack(np.meshgrid(*(np.arange(k) for k in n), indexing="ij"), axis=-1).reshape(-1, 3)
    lo = bmin + ii * h
    edge: np.ndarray = np.full(len(lo), h)
    root: np.ndarray = np.arange(len(lo), dtype=np.int64)
    root_centres = lo + 0.5 * h
    out_lo, out_edge, out_size, out_root = [], [], [], []
    total = 0
    min_edge = 0.5 * field.floor
    off = np.array([[a, b, c] for a in (0, 1) for b in (0, 1) for c in (0, 1)], dtype=float)
    while len(lo):
        size = field(lo + 0.5 * edge[:, None])
        split = (edge > box_per_size * size) & (edge * 0.5 >= min_edge)
        if total + int((~split).sum()) + 8 * int(split.sum()) > max_boxes:
            split[:] = False
        out_lo.append(lo[~split])
        out_edge.append(edge[~split])
        out_size.append(size[~split])
        out_root.append(root[~split])
        total += int((~split).sum())
        lo, edge, root = lo[split], edge[split] * 0.5, root[split]
        if not len(lo):
            break
        lo = (lo[:, None, :] + off[None, :, :] * edge[:, None, None]).reshape(-1, 3)
        edge = np.repeat(edge, 8)
        root = np.repeat(root, 8)
    return SizeOctree(
        np.vstack(out_lo), np.concatenate(out_edge), np.concatenate(out_size), np.concatenate(out_root),
        root_centres, (int(n[0]), int(n[1]), int(n[2])), bmin + 0.5 * h, float(h),
    )


def _estimate_with(field: GradedSize, bmin, bmax, nodes, tris) -> tuple[SizeOctree, float]:
    tree = build_octree(field, bmin, bmax, box_per_size=_BOX_PER_SIZE_ESTIMATE, max_boxes=8 * _MAX_BOXES)
    return tree, estimate_cells(tree, tree.inside(nodes, tris))


def estimate_cells(tree: SizeOctree, inside: np.ndarray | None = None) -> float:
    """Tetrahedra the field asks for: sum over boxes in the fluid of volume / size^3."""
    vol = tree.edge**3
    n = TETS_PER_SIZE3 * vol / np.maximum(tree.centre_size, 1e-300) ** 3
    if inside is not None:
        n = n[inside]
    return float(n.sum())


_CORNERS = np.array(
    [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)], dtype=float
)


def add_size_view(
    gmsh, field: GradedSize, tree: SizeOctree, name: str = "feature_size", *, cap: float | None = None
) -> int:
    """A gmsh list-data view (scalar hexahedra) of the field on the octree boxes,
    growing up to ``cap`` (default h)."""
    if cap is not None:
        field = field.capped(cap)
    corners = tree.lo[:, None, :] + _CORNERS[None, :, :] * tree.edge[:, None, None]  # (n,8,3)
    vals = field(corners.reshape(-1, 3)).reshape(-1, 8)
    data = np.concatenate(
        [corners[:, :, 0], corners[:, :, 1], corners[:, :, 2], vals], axis=1
    ).ravel()
    view = gmsh.view.add(name)
    gmsh.view.addListData(view, "SH", len(tree), np.ascontiguousarray(data, dtype=np.float64))
    return int(view)


def view_field(gmsh, view: int) -> int:
    f = gmsh.model.mesh.field.add("PostView")
    gmsh.model.mesh.field.setNumber(f, "ViewTag", int(view))
    return int(f)


# ------------------------------------------------------------------- plan ----


@dataclass
class FeatureRefinement:
    """What the automatic feature refinement decided for one mesh."""

    field: GradedSize
    tree: SizeOctree
    floor: float
    base_floor: float
    estimate: float
    uniform_estimate: float
    sources: SizeSources
    note: str


def plan_feature_refinement(
    gmsh,
    surfs: list[int],
    nodes: np.ndarray,
    tris: np.ndarray,
    *,
    h: float,
    gradation: float,
    small_feature_m: float,
    log=None,
) -> FeatureRefinement | None:
    """Sources from the CAD (``surfs`` in the current OCC model) and from the
    surface mesh ``nodes``/``tris`` (about size h), then the floor that keeps the
    estimated cell count within the budget. None when the part has no feature
    below ``FEATURE_FRACTION`` x h."""
    t0 = time.monotonic()
    h = float(h)
    slope = max(float(gradation) - 1.0, 0.05)
    base_floor = max(h / 2.0**FLOOR_HALVINGS, float(small_feature_m))
    if base_floor >= FEATURE_FRACTION * h:
        return None
    curves = feature_curves(gmsh, surfs, h=h)
    src = cad_sources(gmsh, surfs, h=h, spacing=base_floor, curves=curves)
    gaps = fluid_gap_sources(nodes, tris, h=h)
    src = src.joined(gaps)
    if not len(src):
        return None
    bmin = np.asarray(nodes, dtype=float).min(axis=0)
    bmax = np.asarray(nodes, dtype=float).max(axis=0)
    inside: np.ndarray | None = None

    def _estimate(floor: float) -> tuple[GradedSize, float]:
        nonlocal inside
        f = GradedSize(src, h=h, floor=floor, slope=slope)
        tree = build_octree(f, bmin, bmax, box_per_size=_BOX_PER_SIZE_ESTIMATE, max_boxes=8 * _MAX_BOXES)
        roots_in = tree.inside(nodes, tris) if inside is None else inside[tree.root]
        if inside is None:
            inside = np.zeros(len(tree.root_centres), dtype=bool)
            inside[tree.root] = roots_in
        return f, estimate_cells(tree, roots_in)

    uniform = GradedSize(SizeSources.empty(), h=h, floor=h, slope=slope)
    _u, u_est = _estimate_with(uniform, bmin, bmax, nodes, tris)
    budget = CELL_BUDGET * max(u_est, 1.0)
    floor = base_floor
    field, est = _estimate(floor)
    while est > budget and floor * FLOOR_STEP < FEATURE_FRACTION * h:
        floor *= FLOOR_STEP
        field, est = _estimate(floor)
    if not field:
        return None
    tree = build_octree(field, bmin, bmax)
    note = (
        f"feature refinement: {src.n_curves} short curve(s), {src.n_faces} narrow face(s), "
        f"{src.n_gaps} narrow gap(s) below {FEATURE_FRACTION * h:.3g} m; cells there down to "
        f"{floor:.3g} m"
        + (f" (raised from {base_floor:.3g} m to fit the cell budget)" if floor > base_floor * 1.0001 else "")
        + f", growing {gradation:g}x per cell; about {est / 1e6:.2f}M cells vs {u_est / 1e6:.2f}M uniform "
        f"({len(tree)} size boxes, {time.monotonic() - t0:.1f}s)"
    )
    if log is not None:
        log(note)
    return FeatureRefinement(
        field=field, tree=tree, floor=floor, base_floor=base_floor, estimate=est,
        uniform_estimate=u_est, sources=src, note=note,
    )
