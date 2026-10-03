r"""A structured C-mesh around a 2D section, built with Gmsh, for OpenFOAM.

The section (Selig order, chord 1) sits in a C-shaped domain: a half circle of
radius ``farfield`` chords round the trailing edge, straight top and bottom,
and an outlet ``wake`` chords behind the trailing edge. Every block is a
transfinite quad patch, so the mesh is all quads in the plane and all
hexahedra once it is one cell thick::

                 __________ T2 _______________ Otop
              TU/          |                  |
             /   far_ur    |   wake_far_u     |
            /  far_uf .----+---- wake_in_u ---|
       F---+--LE( wall layer )TE--------------O    (a blunt trailing edge has a
            \  far_lf '----+---- wake_in_l ---|     base block behind it)
             \   far_lr    |   wake_far_l     |
              BL\__________|__________________|
                           B2                 Obot

- The section is four smooth pieces (split at ``split_x`` of the chord on
  each surface and at the leading edge). Round it runs a wall layer
  ``layer`` chords thick whose lines leave the wall at a right angle: its
  outer edge is every wall node moved out along the surface normal. Cells
  next to the wall are only y+ ≈ 1 thick, and leaning ones make the solver
  diverge; transfinite interpolation alone leans them up to 50°.
- Outside the layer, the far blocks fan out to the half circle, each surface
  node getting its own stretch of it; the wake blocks follow the cut behind
  the trailing edge to the outlet. The outlet's side of each wake block is
  split in the same proportions as its side at the trailing edge, so each
  wake cell keeps its height to the outlet, as do the cells across the cut
  from it, and its centre stays over theirs. (Rows two
  chords long and 2e-5 high whose heights changed along them by slightly
  different factors put the line between centres 87° off their face's normal
  at Re 1e6, 89.9° at 5e7. Opening the wake layer towards the outlet, to make
  those cells less long for their height, raised the pressure residual the
  solver levels off at, in the wake, so the layer keeps its height.)
- A trailing edge with a gap (the NACA formula's own, or an imported file's)
  gets a block of its own behind its base; a gap below :data:`SHARP_GAP` is
  closed to a point.
- Wall-normal spacing starts at the first-cell height for y+ of about 1 at the
  study's Reynolds number (a flat-plate skin-friction estimate) and grows by
  the level's ratio to the far field.

The mesh is written as one layer of hexahedra (MSH 2.2, through
``magnusim_sdk.msh22``) with the boundary groups ``wing`` (the section, its
base included), ``farfield``, ``front`` and ``back``; ``gmshToFoam`` reads it
and ``extrudeMesh`` then makes ``front`` and ``back`` the empty pair at the
span the case uses. The caller initialises Gmsh (``magnusim_sdk.gmsh_helpers.
initialize_gmsh``, which keeps the process PATH).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from airfoil import geometry

# SPDX-License-Identifier: GPL-3.0-or-later

SHARP_GAP = 1.0e-4  # a trailing-edge gap below this (fraction of chord) is closed
PATCHES = ("wing", "farfield", "front", "back")
# Physical tags of the .msh file.
TAG_FLUID, TAG_WING, TAG_FARFIELD, TAG_FRONT, TAG_BACK = 1, 2, 3, 4, 5


@dataclass(frozen=True)
class MeshLevel:
    """How fine the mesh is: node counts along each curve, spacings, growth, and solver iterations."""

    key: str
    label: str
    n_front: int  # nodes from the split point to the leading edge (each surface)
    n_rear: int  # nodes from the trailing edge to the split point (each surface)
    n_wake: int  # nodes from the trailing edge to the outlet
    le_spacing: float  # along the surface at the leading edge (chords)
    te_spacing: float  # along the surface at the trailing edge (chords)
    growth: float  # wall-normal growth ratio (at most)
    iterations: int  # simpleFoam iterations (Cl settles within about half of them)


# Cl at α = 4° of NACA 2412, Re 1e6, open trailing edge: 0.6249, 0.6256 and 0.6267
# (about 15 000, 28 000 and 59 000 cells), so medium is within 0.2 % of fine. Cl settles
# within about 500 iterations on medium and fine; coarse keeps moving by about 0.004.
LEVELS: dict[str, MeshLevel] = {
    "coarse": MeshLevel("coarse", "Coarse", 35, 40, 40, 0.002, 0.004, 1.2, 1200),
    "medium": MeshLevel("medium", "Medium", 50, 60, 55, 0.0012, 0.0025, 1.15, 1500),
    "fine": MeshLevel("fine", "Fine", 75, 90, 80, 0.0008, 0.0015, 1.1, 2500),
}
DEFAULT_LEVEL = "medium"


@dataclass(frozen=True)
class MeshSpec:
    level: MeshLevel
    re: float
    farfield: float = 20.0  # radius of the C, chords
    wake: float = 20.0  # outlet distance behind the trailing edge, chords
    split_x: float = 0.3  # where the leading-edge blocks end on each surface (x/c)
    y_plus: float = 1.0  # first-cell target
    layer: float = 0.05  # thickness of the wall layer whose lines leave the wall at a right angle, chords


class MeshError(ValueError):
    """A section this mesher cannot wrap (the message says why)."""


def first_cell_height(re: float, y_plus: float = 1.0) -> float:
    """Wall-normal height (chords) of the first cell for ``y_plus`` at Reynolds number ``re``.

    Skin friction from the turbulent flat-plate estimate Cf = 0.026 / Re^(1/7);
    the friction velocity is U * sqrt(Cf / 2), so y = y+ * c / (Re * sqrt(Cf / 2)).
    """
    if not (math.isfinite(re) and re > 0):
        raise MeshError("The Reynolds number must be above 0.")
    cf = 0.026 / re ** (1.0 / 7.0)
    return y_plus / (re * math.sqrt(cf / 2.0))


def geometric_ratio(total: float, first: float, cells: int) -> float:
    """The ratio r of ``cells`` geometric cells that start at ``first`` and add up to ``total``."""
    if cells < 1 or total <= 0 or first <= 0:
        raise MeshError("A curve needs at least one cell and a positive length.")
    if abs(first * cells - total) < 1e-12 * total:
        return 1.0

    def length(r: float) -> float:
        if abs(r - 1.0) < 1e-12:
            return first * cells
        return first * (r**cells - 1.0) / (r - 1.0)

    lo, hi = (1.0, 2.0) if first * cells < total else (1e-3, 1.0)
    while first * cells < total and length(hi) < total:
        hi *= 2.0
        if hi > 1e6:
            raise MeshError("The first cell is too small for this many cells.")
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if length(mid) < total:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def first_cell(total: float, ratio: float, cells: int) -> float:
    """The first of ``cells`` geometric cells with ratio ``ratio`` that add up to ``total``."""
    if abs(ratio - 1.0) < 1e-12:
        return total / cells
    return total * (ratio - 1.0) / (ratio**cells - 1.0)


def wall_cells(length: float, first: float, growth: float) -> int:
    """How many geometric cells reach ``length`` from ``first`` growing by ``growth`` at most."""
    return max(8, math.ceil(math.log(1.0 + length * (growth - 1.0) / first) / math.log(growth)))


@dataclass
class Prepared:
    """The section split for the blocks: indices into x/y and the trailing-edge shape."""

    x: list[float]
    y: list[float]
    le: int  # leading edge
    iu: int  # split point on the upper surface
    il: int  # split point on the lower surface
    sharp: bool  # one trailing-edge point (no base block)
    gap: float  # the trailing-edge gap before closing (chords)


def prepare(x: Sequence[float], y: Sequence[float], split_x: float = 0.3) -> Prepared:
    """Check the section and pick the split points; a tiny trailing-edge gap is closed."""
    if len(x) != len(y) or len(x) < geometry.MIN_POINTS:
        raise MeshError(f"The section needs at least {geometry.MIN_POINTS} points.")
    xs, ys = [float(v) for v in x], [float(v) for v in y]
    if geometry.signed_area(xs, ys) <= 0:
        raise MeshError("The section must run from the upper trailing edge round the leading edge (Selig order).")
    le = geometry.leading_edge_index(xs)
    if le < 3 or le > len(xs) - 4:
        raise MeshError("Each surface needs at least 3 points between the leading and trailing edges.")
    chord = max(xs) - xs[le]
    if abs(chord - 1.0) > 1e-3 or abs(xs[le]) > 1e-3:
        raise MeshError("The section must have chord 1 with its leading edge at x = 0.")
    gap = math.hypot(xs[0] - xs[-1], ys[0] - ys[-1])
    sharp = gap < SHARP_GAP
    if sharp:
        mx, my = 0.5 * (xs[0] + xs[-1]), 0.5 * (ys[0] + ys[-1])
        xs[0], ys[0], xs[-1], ys[-1] = mx, my, mx, my
    elif ys[0] <= ys[-1]:
        raise MeshError("The upper trailing-edge point must lie above the lower one.")
    iu = min(range(1, le), key=lambda i: abs(xs[i] - split_x))
    il = min(range(le + 1, len(xs) - 1), key=lambda i: abs(xs[i] - split_x))
    if not (0 < iu < le < il < len(xs) - 1):
        raise MeshError("The section is too coarse to split for the mesh blocks.")
    return Prepared(xs, ys, le, iu, il, sharp, gap)


def build(x: Sequence[float], y: Sequence[float], spec: MeshSpec, gmsh: Any) -> dict[str, Any]:
    """Mesh the plane with Gmsh (already initialised by the caller); the quads and boundary edges.

    Two passes. First the section alone: four smooth pieces meshed along their
    length, which gives the wall nodes and the surface normal at each. Then the
    blocks: the wall layer's outer edge is the chain of points one layer
    thickness out along those normals, so every line across the layer leaves
    the wall at a right angle (transfinite interpolation alone tilts them by up
    to 50° near the leading edge, and cells 2e-5 chords thick that lean that far
    make the solver diverge).

    Returns ``{nodes: [(x, y)], quads: [(a, b, c, d)] counter-clockwise, edges:
    {"wing": [(a, b)], "farfield": [...]}, sharp, gap, h0, wall_cells, cells}``
    with node indices from 0.
    """
    p = prepare(x, y, spec.split_x)
    lv = spec.level
    radius, wake, d = spec.farfield, spec.wake, spec.layer
    h0 = first_cell_height(spec.re, spec.y_plus)
    n = len(p.x)
    tangent = tangents(p.x, p.y)
    tangent[0] = end_tangent(p.x, p.y, 0, forward=True)
    tangent[n - 1] = end_tangent(p.x, p.y, n - 1, forward=False)
    occ = gmsh.model.occ
    gmsh.model.add("airfoil_c_mesh")

    def pt(px: float, py: float) -> int:
        return occ.addPoint(px, py, 0.0)

    def transfinite(tag: int, nodes: int, first: float | None = None, *, from_end: bool = False, ratio: float | None = None) -> float:
        if ratio is None:
            ratio = 1.0 if first is None else geometric_ratio(_curve_length(gmsh, tag), first, nodes - 1)
            if from_end:
                ratio = 1.0 / ratio
        gmsh.model.mesh.setTransfiniteCurve(tag, nodes, "Progression", ratio)
        return ratio

    # Pass 1: the section. Each piece is an interpolating spline (OpenCASCADE: C2,
    # chord-length parameter) with a tangent at every point, the same on both sides of
    # a joint, so the surface is smooth through the leading edge and the split points;
    # only the trailing edge is a corner. (With the two end tangents alone OpenCASCADE
    # scales them to the whole curve's parameter, and the curve loops back near its end.)
    te_u = pt(p.x[0], p.y[0])
    te_l = te_u if p.sharp else pt(p.x[-1], p.y[-1])
    wall_ids = [te_u] + [pt(p.x[i], p.y[i]) for i in range(1, n - 1)] + [te_l]

    def spline(lo: int, hi: int) -> int:
        flat: list[float] = []
        for i in range(lo, hi + 1):
            flat += [tangent[i][0], tangent[i][1], 0.0]
        return occ.addSpline(wall_ids[lo : hi + 1], tangents=flat)

    order = ("ur", "uf", "lf", "lr")
    cut = {"ur": (0, p.iu), "uf": (p.iu, p.le), "lf": (p.le, p.il), "lr": (p.il, n - 1)}
    wall = {k: spline(*cut[k]) for k in order}
    occ.synchronize()
    count = {"ur": lv.n_rear, "uf": lv.n_front, "lf": lv.n_front, "lr": lv.n_rear}

    def wall_spacing() -> dict[str, float]:
        return {
            "uf": transfinite(wall["uf"], lv.n_front, lv.le_spacing, from_end=True),
            "lf": transfinite(wall["lf"], lv.n_front, lv.le_spacing),
            "ur": transfinite(wall["ur"], lv.n_rear, lv.te_spacing),
            "lr": transfinite(wall["lr"], lv.n_rear, lv.te_spacing, from_end=True),
        }

    ratio = wall_spacing()
    gmsh.model.mesh.generate(1)
    # Each piece's nodes in order along it, and the outward normal there (the section
    # runs counter-clockwise, so outward is the tangent turned clockwise).
    outer: dict[str, list[tuple[float, float]]] = {}
    for k in order:
        _tags, xyz, par = gmsh.model.mesh.getNodes(1, wall[k], includeBoundary=True)
        params = sorted(float(v) for v in par)
        if len(params) != count[k]:
            raise MeshError("Gmsh did not mesh the section as asked.")
        pts = gmsh.model.getValue(1, wall[k], params)
        der = gmsh.model.getDerivative(1, wall[k], params)
        row = []
        for j in range(len(params)):
            tx, ty = der[3 * j], der[3 * j + 1]
            norm = math.hypot(tx, ty)
            row.append((pts[3 * j] + d * ty / norm, pts[3 * j + 1] - d * tx / norm))
        outer[k] = row
        _check_layer(pts, row)
    # A joint inside the section is smooth: both pieces put its outer point in one place.
    for a, b in (("ur", "uf"), ("uf", "lf"), ("lf", "lr")):
        mx = 0.5 * (outer[a][-1][0] + outer[b][0][0])
        my = 0.5 * (outer[a][-1][1] + outer[b][0][1])
        outer[a][-1] = outer[b][0] = (mx, my)
    gmsh.model.mesh.clear()

    # Pass 2: the blocks.
    chain_pts: dict[str, list[int]] = {}
    shared: dict[tuple[float, float], int] = {}

    def keep(q: tuple[float, float]) -> int:
        if q not in shared:
            shared[q] = pt(*q)
        return shared[q]

    for k in order:
        chain_pts[k] = [keep(q) for q in outer[k]]
    line = occ.addLine
    chain = {k: [line(a, b) for a, b in zip(chain_pts[k][:-1], chain_pts[k][1:], strict=True)] for k in order}
    q_teu, q_tel = chain_pts["ur"][0], chain_pts["lr"][-1]
    q_pu, q_le, q_pl = chain_pts["uf"][0], chain_pts["lf"][0], chain_pts["lr"][0]
    qx_teu, qy_teu = outer["ur"][0]
    qx_tel, qy_tel = outer["lr"][-1]
    # The far field: a half circle round the trailing edge, so every surface node has its own
    # stretch of it (the split points' lines meet it in proportion to the node counts), then
    # straight top and bottom to the outlet.
    cx = qx_teu
    centre = pt(cx, 0.0)
    t2, f, b2 = pt(cx, radius), pt(cx - radius, 0.0), pt(cx, -radius)
    share = (lv.n_rear - 1) / (lv.n_rear + lv.n_front - 2)
    turn = math.pi / 2 * (1.0 + share)
    tu = pt(cx + radius * math.cos(turn), radius * math.sin(turn))
    bl = pt(cx + radius * math.cos(turn), -radius * math.sin(turn))
    xo = p.x[0] + wake
    o_top, o_bot = pt(xo, radius), pt(xo, -radius)
    o_u = pt(xo, p.y[0])
    o_l = o_u if p.sharp else pt(xo, p.y[-1])
    oi_u, oi_l = pt(xo, qy_teu), pt(xo, qy_tel)

    normal = {
        "teu": line(te_u, q_teu),
        "pu": line(wall_ids[p.iu], q_pu),
        "le": line(wall_ids[p.le], q_le),
        "pl": line(wall_ids[p.il], q_pl),
        "tel": line(te_l, q_tel),
    }
    radial = {
        "teu": line(q_teu, t2),
        "pu": line(q_pu, tu),
        "le": line(q_le, f),
        "pl": line(q_pl, bl),
        "tel": line(q_tel, b2),
    }
    arc = {
        "ur": occ.addCircleArc(t2, centre, tu),
        "uf": occ.addCircleArc(tu, centre, f),
        "lf": occ.addCircleArc(f, centre, bl),
        "lr": occ.addCircleArc(bl, centre, b2),
    }
    wake_u = line(te_u, o_u)
    wake_l = wake_u if p.sharp else line(te_l, o_l)
    wake_edge_u, wake_edge_l = line(q_teu, oi_u), line(q_tel, oi_l)
    far_top, far_bottom = line(t2, o_top), line(b2, o_bot)
    out_in_u, out_in_l = line(o_u, oi_u), line(o_l, oi_l)
    out_far_u, out_far_l = line(oi_u, o_top), line(oi_l, o_bot)
    # A blunt trailing edge: its base, and the cut behind it at the outlet, as chains of
    # points fine at both ends (the first cell's height, as on the wall next to them) and
    # coarser in the middle, so the cells behind the base match the wake layer's.
    base_chain: list[int] = []
    out_chain: list[int] = []
    if not p.sharp:
        fractions = base_fractions(p.gap, h0, lv.growth)
        (xu, yu), (xl, yl) = (p.x[0], p.y[0]), (p.x[-1], p.y[-1])
        base_pts = [te_u] + [pt(xu + f * (xl - xu), yu + f * (yl - yu)) for f in fractions[1:-1]] + [te_l]
        out_pts = [o_u] + [pt(xo, p.y[0] + f * (p.y[-1] - p.y[0])) for f in fractions[1:-1]] + [o_l]
        base_chain = [line(a, b) for a, b in zip(base_pts[:-1], base_pts[1:], strict=True)]
        out_chain = [line(a, b) for a, b in zip(out_pts[:-1], out_pts[1:], strict=True)]

    # Blocks: a loop of curves in order round each, and its four corners.
    ends = {"ur": (te_u, wall_ids[p.iu]), "uf": (wall_ids[p.iu], wall_ids[p.le]),
            "lf": (wall_ids[p.le], wall_ids[p.il]), "lr": (wall_ids[p.il], te_l)}
    sides = {"ur": ("teu", "pu"), "uf": ("pu", "le"), "lf": ("le", "pl"), "lr": ("pl", "tel")}
    blocks: dict[str, tuple[list[int], list[int]]] = {}
    for k in order:
        s0, s1 = sides[k]
        w0, w1 = ends[k]
        blocks[f"wall_{k}"] = (
            [wall[k], normal[s1], *reversed(chain[k]), normal[s0]],
            [w0, w1, chain_pts[k][-1], chain_pts[k][0]],
        )
    blocks["far_ur"] = ([*chain["ur"], radial["pu"], arc["ur"], radial["teu"]], [q_teu, q_pu, tu, t2])
    blocks["far_uf"] = ([*chain["uf"], radial["le"], arc["uf"], radial["pu"]], [q_pu, q_le, f, tu])
    blocks["far_lf"] = ([*chain["lf"], radial["pl"], arc["lf"], radial["le"]], [q_le, q_pl, bl, f])
    blocks["far_lr"] = ([*chain["lr"], radial["tel"], arc["lr"], radial["pl"]], [q_pl, q_tel, b2, bl])
    blocks["wake_in_u"] = ([wake_u, out_in_u, wake_edge_u, normal["teu"]], [te_u, o_u, oi_u, q_teu])
    blocks["wake_in_l"] = ([wake_l, out_in_l, wake_edge_l, normal["tel"]], [te_l, o_l, oi_l, q_tel])
    blocks["wake_far_u"] = ([wake_edge_u, out_far_u, far_top, radial["teu"]], [q_teu, oi_u, o_top, t2])
    blocks["wake_far_l"] = ([wake_edge_l, out_far_l, far_bottom, radial["tel"]], [q_tel, oi_l, o_bot, b2])
    if base_chain:
        blocks["base"] = ([*base_chain, wake_l, *reversed(out_chain), wake_u], [te_u, te_l, o_l, o_u])
    surfaces = {name: (occ.addPlaneSurface([occ.addCurveLoop(curves)]), corners) for name, (curves, corners) in blocks.items()}
    occ.synchronize()

    # Along the section, as in pass 1; each link of the layer's edge is one cell.
    ratio = wall_spacing()
    for k in order:
        for tag in chain[k]:
            gmsh.model.mesh.setTransfiniteCurve(tag, 2)
    # The far side of the outer blocks: a milder copy of the section's spacing.
    for k in order:
        transfinite(arc[k], count[k], ratio=ratio[k] ** 0.5)
    # The wake: from the trailing edge's spacing to the outlet; along the far field, from
    # the half circle's last cell there.
    for tag in dict.fromkeys([wake_u, wake_l, wake_edge_u, wake_edge_l]):
        transfinite(tag, lv.n_wake, lv.te_spacing)
    arc_first = first_cell(_curve_length(gmsh, arc["ur"]), ratio["ur"] ** 0.5, lv.n_rear - 1)
    transfinite(far_top, lv.n_wake, arc_first)
    transfinite(far_bottom, lv.n_wake, arc_first)
    # Across the wall layer: the first cell for y+ of about 1, growing to the layer's edge.
    n_layer = wall_cells(d, h0, lv.growth) + 1
    r_layer = geometric_ratio(d, h0, n_layer - 1)
    for tag in normal.values():
        transfinite(tag, n_layer, ratio=r_layer)
    last = h0 * r_layer ** (n_layer - 2)
    # Beyond it to the far field, carrying on from the layer's last cell.
    longest = max(_curve_length(gmsh, tag) for tag in radial.values())
    n_far = wall_cells(longest, last * r_layer, lv.growth) + 1
    for tag in radial.values():
        transfinite(tag, n_far, last * r_layer)
    # The outlet: each wake block's side there split in the same proportions as its side at
    # the trailing edge, so every wake cell keeps its height to the outlet, as its neighbours
    # above, below and across the cut do, and its centre stays over theirs.
    transfinite(out_in_u, n_layer, ratio=r_layer)
    transfinite(out_in_l, n_layer, ratio=r_layer)
    transfinite(out_far_u, n_far, last * r_layer)
    transfinite(out_far_l, n_far, last * r_layer)
    for tag in base_chain + out_chain:
        gmsh.model.mesh.setTransfiniteCurve(tag, 2)
    for tag, corners in surfaces.values():
        gmsh.model.mesh.setTransfiniteSurface(tag, "Left", corners)
        gmsh.model.mesh.setRecombine(2, tag)
    gmsh.model.mesh.generate(2)

    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    xyz = {int(t): (float(coords[3 * i]), float(coords[3 * i + 1])) for i, t in enumerate(node_tags)}
    used: dict[int, int] = {}
    nodes: list[tuple[float, float]] = []

    def index(tag: int) -> int:
        if tag not in used:
            used[tag] = len(nodes)
            nodes.append(xyz[tag])
        return used[tag]

    quads: list[tuple[int, int, int, int]] = []
    for tag, _corners in surfaces.values():
        types, _elems, conn = gmsh.model.mesh.getElements(2, tag)
        for etype, flat in zip(types, conn, strict=True):
            if int(etype) != 3:
                raise MeshError("Gmsh left a block that is not all quads.")
            for j in range(0, len(flat), 4):
                n0, n1, n2, n3 = (index(int(t)) for t in flat[j : j + 4])
                quads.append(_ccw((n0, n1, n2, n3), nodes))
    wing_curves = list(wall.values()) + base_chain
    far_curves = [*arc.values(), far_top, far_bottom, out_in_u, out_in_l, out_far_u, out_far_l]
    far_curves += out_chain
    edges: dict[str, list[tuple[int, int]]] = {"wing": [], "farfield": []}
    for name, curves in (("wing", wing_curves), ("farfield", far_curves)):
        for tag in dict.fromkeys(curves):
            types, _elems, conn = gmsh.model.mesh.getElements(1, tag)
            for etype, flat in zip(types, conn, strict=True):
                if int(etype) != 1:
                    continue
                for j in range(0, len(flat), 2):
                    edges[name].append((index(int(flat[j])), index(int(flat[j + 1]))))
    return {
        "nodes": nodes,
        "quads": quads,
        "edges": edges,
        "sharp": p.sharp,
        "gap": p.gap,
        "h0": h0,
        "wall_cells": n_layer + n_far - 2,
        "cells": len(quads),
    }


def base_fractions(gap: float, first: float, growth: float) -> list[float]:
    """Where the nodes across a blunt trailing edge go, 0 to 1: ``first`` (as a length) at
    both ends, growing by ``growth`` at most towards the middle."""
    half = gap / 2.0
    if half <= first:
        return [0.0, 1.0]
    cells = max(1, math.ceil(math.log(1.0 + half * (growth - 1.0) / first) / math.log(growth)))
    ratio = geometric_ratio(half, first, cells)
    pos = [0.0]
    step = first
    for _ in range(cells):
        pos.append(pos[-1] + step)
        step *= ratio
    pos[-1] = half
    side = [v / gap for v in pos]
    return side + [1.0 - v for v in reversed(side[:-1])]


def _check_layer(wall_xyz: Sequence[float], outer: list[tuple[float, float]]) -> None:
    """Refuse a wall layer that folds over: its edge must run the same way as the wall, without crossing itself."""
    for j in range(len(outer) - 1):
        ox, oy = outer[j + 1][0] - outer[j][0], outer[j + 1][1] - outer[j][1]
        sx, sy = wall_xyz[3 * j + 3] - wall_xyz[3 * j], wall_xyz[3 * j + 4] - wall_xyz[3 * j + 1]
        if ox * sx + oy * sy <= 0:
            raise MeshError(
                f"The section curves too tightly near x/c = {wall_xyz[3 * j]:.2f} for the mesh's wall layer "
                "(a concave dip sharper than the layer is thick)."
            )
    if geometry.first_crossing([q[0] for q in outer], [q[1] for q in outer]) is not None:
        raise MeshError("The section curves too tightly for the mesh's wall layer.")


def tangents(x: Sequence[float], y: Sequence[float]) -> list[tuple[float, float]]:
    """A unit tangent at every interior point, from the parabola through it and its neighbours.

    The parabola's slope (Bessel's tangent) weights the shorter side more, which
    suits the cosine spacing at the leading edge; the end points get (0, 0) here
    (see :func:`end_tangent`).
    """
    out: list[tuple[float, float]] = [(0.0, 0.0)] * len(x)
    for i in range(1, len(x) - 1):
        ax, ay = x[i] - x[i - 1], y[i] - y[i - 1]
        bx, by = x[i + 1] - x[i], y[i + 1] - y[i]
        h0, h1 = math.hypot(ax, ay), math.hypot(bx, by)
        if h0 == 0 or h1 == 0:
            raise MeshError("The section has two points in the same place.")
        w0, w1 = h1 / (h0 + h1), h0 / (h0 + h1)
        tx, ty = w0 * ax / h0 + w1 * bx / h1, w0 * ay / h0 + w1 * by / h1
        norm = math.hypot(tx, ty)
        out[i] = (tx / norm, ty / norm)
    return out


def end_tangent(x: Sequence[float], y: Sequence[float], i: int, *, forward: bool) -> tuple[float, float]:
    """The unit tangent at an end point (along the section's order), from the parabola through three points."""
    j, k = (i + 1, i + 2) if forward else (i - 1, i - 2)
    h0 = math.hypot(x[j] - x[i], y[j] - y[i])
    h1 = math.hypot(x[k] - x[j], y[k] - y[j])
    if h0 == 0 or h1 == 0:
        raise MeshError("The section has two points in the same place.")
    # d/ds at the end of the parabola through (0, h0, h0 + h1), pointing along the section's order.
    a = (2 * h0 + h1) / (h0 * (h0 + h1))
    b = (h0 + h1) / (h0 * h1)
    c = h0 / (h1 * (h0 + h1))
    tx = -a * x[i] + b * x[j] - c * x[k]
    ty = -a * y[i] + b * y[j] - c * y[k]
    if not forward:
        tx, ty = -tx, -ty
    norm = math.hypot(tx, ty)
    return (tx / norm, ty / norm)


def _curve_length(gmsh: Any, tag: int, samples: int = 400) -> float:
    lo, hi = gmsh.model.getParametrizationBounds(1, tag)
    ts = [lo[0] + (hi[0] - lo[0]) * i / samples for i in range(samples + 1)]
    pts = gmsh.model.getValue(1, tag, ts)
    total = 0.0
    for i in range(samples):
        total += math.dist(pts[3 * i : 3 * i + 2], pts[3 * i + 3 : 3 * i + 5])
    return total


def _ccw(q: tuple[int, int, int, int], nodes: list[tuple[float, float]]) -> tuple[int, int, int, int]:
    area = 0.0
    for i in range(4):
        x0, y0 = nodes[q[i]]
        x1, y1 = nodes[q[(i + 1) % 4]]
        area += x0 * y1 - x1 * y0
    if area <= 0:
        return (q[0], q[3], q[2], q[1])
    return q


def write_msh(path: Path, plane: dict[str, Any], span: float) -> dict[str, int]:
    """One layer of hexahedra from the plane mesh, as MSH 2.2 for gmshToFoam."""
    import numpy as np
    from magnusim_sdk.msh22 import HEX, QUAD, write_msh22

    pts2 = np.asarray(plane["nodes"], dtype=float)
    count = len(pts2)
    nodes = np.zeros((2 * count, 3))
    nodes[:count, :2] = pts2
    nodes[count:, :2] = pts2
    nodes[count:, 2] = span
    volume = [(HEX, np.array([a, b, c, d, a + count, b + count, c + count, d + count]), TAG_FLUID) for a, b, c, d in plane["quads"]]
    faces: list[tuple[int, Any, int, str]] = []
    for name, tag in (("wing", TAG_WING), ("farfield", TAG_FARFIELD)):
        for a, b in plane["edges"][name]:
            faces.append((QUAD, np.array([a, b, b + count, a + count]), tag, name))
    for a, b, c, d in plane["quads"]:
        faces.append((QUAD, np.array([a, d, c, b]), TAG_FRONT, "front"))
        faces.append((QUAD, np.array([a + count, b + count, c + count, d + count]), TAG_BACK, "back"))
    names = {
        TAG_FLUID: (3, "fluid"),
        TAG_WING: (2, "wing"),
        TAG_FARFIELD: (2, "farfield"),
        TAG_FRONT: (2, "front"),
        TAG_BACK: (2, "back"),
    }
    write_msh22(Path(path), nodes, volume_cells=volume, boundary_faces=faces, physical_names=names)
    return {"cells": len(volume), "points": int(2 * count)}
