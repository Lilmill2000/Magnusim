"""Detect CAD radial gaps that a hexcore cell size will bridge.

The vortex-finder wall on Vortex CFD Test is two coaxial cylinders
(r=25.4 mm and r=30.175 mm) — a 4.775 mm annulus. F=5 skin is 5.7 mm,
so cartesianMesh with ``keepCellsIntersectingBoundary 1`` keeps the
template cells that span the metal. This module finds those gaps so
meshDict can request a *local* cell size of ``gap / min_cells`` on the
bounding faces and a hollow-cone object refinement in the annulus.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cylinder, GeomAbs_Plane
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

from cfddesk.cad.step import FaceRecord, LoadedSolid


@dataclass(frozen=True)
class RadialGap:
    face_a: int
    face_b: int
    gap_m: float
    r_inner_m: float
    r_outer_m: float
    axis: tuple[float, float, float]
    origin_m: tuple[float, float, float]
    kind: str
    s_min_m: float
    s_max_m: float


@dataclass(frozen=True)
class GapRefinement:
    """One ``localRefinement`` entry for meshDict."""

    pattern: str
    cell_size_m: float
    thickness_m: float
    gap_m: float
    face_ids: tuple[int, ...]


@dataclass(frozen=True)
class GapObjectRefinement:
    """One ``objectRefinements`` hollowCone covering a thin-wall annulus."""

    name: str
    cell_size_m: float
    p0: tuple[float, float, float]
    p1: tuple[float, float, float]
    r_inner_m: float
    r_outer_m: float
    gap_m: float


def _bbox(face) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    box = Bnd_Box()
    BRepBndLib.Add_s(face, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return (xmin, ymin, zmin), (xmax, ymax, zmax)


def _unit(v: tuple[float, float, float]) -> tuple[float, float, float] | None:
    n = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    if n < 1e-15:
        return None
    return (v[0] / n, v[1] / n, v[2] / n)


def _dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _proj(
    origin: tuple[float, float, float],
    axis_u: tuple[float, float, float],
    point: tuple[float, float, float],
) -> float:
    return _dot(
        (point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]),
        axis_u,
    )


def _axis_span(
    origin_m: tuple[float, float, float],
    axis: tuple[float, float, float],
    bb_min_m: tuple[float, float, float],
    bb_max_m: tuple[float, float, float],
) -> tuple[float, float]:
    u = _unit(axis)
    if u is None:
        return 0.0, 0.0
    xs = (bb_min_m[0], bb_max_m[0])
    ys = (bb_min_m[1], bb_max_m[1])
    zs = (bb_min_m[2], bb_max_m[2])
    vals = [
        _proj(origin_m, u, (x, y, z))
        for x in xs
        for y in ys
        for z in zs
    ]
    return min(vals), max(vals)


def _cylinder(rec: FaceRecord, scale: float) -> dict | None:
    adapt = BRepAdaptor_Surface(rec.face)
    if adapt.GetType() != GeomAbs_Cylinder:
        return None
    cyl = adapt.Cylinder()
    ax = cyl.Axis()
    loc = ax.Location()
    d = ax.Direction()
    (x0, y0, z0), (x1, y1, z1) = _bbox(rec.face)
    origin_m = (float(loc.X()) * scale, float(loc.Y()) * scale, float(loc.Z()) * scale)
    axis = (float(d.X()), float(d.Y()), float(d.Z()))
    bb_min_m = (x0 * scale, y0 * scale, z0 * scale)
    bb_max_m = (x1 * scale, y1 * scale, z1 * scale)
    s0, s1 = _axis_span(origin_m, axis, bb_min_m, bb_max_m)
    return {
        "face_id": rec.face_id,
        "r_m": float(cyl.Radius()) * scale,
        "origin_m": origin_m,
        "axis": axis,
        "s_min_m": s0,
        "s_max_m": s1,
    }


def _plane_circles(rec: FaceRecord, scale: float) -> list[dict]:
    adapt = BRepAdaptor_Surface(rec.face)
    if adapt.GetType() != GeomAbs_Plane:
        return []
    pl = adapt.Plane()
    n = pl.Axis().Direction()
    out: list[dict] = []
    eexp = TopExp_Explorer(rec.face, TopAbs_EDGE)
    while eexp.More():
        edge = TopoDS.Edge_s(eexp.Current())
        cad = BRepAdaptor_Curve(edge)
        if cad.GetType() == GeomAbs_Circle:
            circ = cad.Circle()
            c = circ.Location()
            origin_m = (
                float(c.X()) * scale,
                float(c.Y()) * scale,
                float(c.Z()) * scale,
            )
            axis = (float(n.X()), float(n.Y()), float(n.Z()))
            out.append(
                {
                    "face_id": rec.face_id,
                    "r_m": float(circ.Radius()) * scale,
                    "origin_m": origin_m,
                    "axis": axis,
                    # Axial coord is the circle centre itself (s=0 in local frame).
                    "s_min_m": 0.0,
                    "s_max_m": 0.0,
                }
            )
        eexp.Next()
    return out


def _parallel(a: tuple[float, float, float], b: tuple[float, float, float]) -> bool:
    ua, ub = _unit(a), _unit(b)
    if ua is None or ub is None:
        return False
    return abs(abs(_dot(ua, ub)) - 1.0) < 1e-3


def _on_axis(
    origin: tuple[float, float, float],
    axis: tuple[float, float, float],
    point: tuple[float, float, float],
    *,
    tol_m: float,
) -> bool:
    u = _unit(axis)
    if u is None:
        return False
    vx = point[0] - origin[0]
    vy = point[1] - origin[1]
    vz = point[2] - origin[2]
    cx = vy * u[2] - vz * u[1]
    cy = vz * u[0] - vx * u[2]
    cz = vx * u[1] - vy * u[0]
    return math.sqrt(cx * cx + cy * cy + cz * cz) <= tol_m


def _gap_pair(
    a: dict,
    b: dict,
    *,
    kind: str,
    min_gap_m: float,
    max_gap_m: float | None,
) -> RadialGap | None:
    if not _parallel(a["axis"], b["axis"]):
        return None
    if not _on_axis(a["origin_m"], a["axis"], b["origin_m"], tol_m=1e-4):
        return None
    r0, r1 = sorted((float(a["r_m"]), float(b["r_m"])))
    gap = r1 - r0
    if gap < min_gap_m:
        return None
    if max_gap_m is not None and gap > max_gap_m:
        return None
    return RadialGap(
        face_a=int(a["face_id"]),
        face_b=int(b["face_id"]),
        gap_m=float(gap),
        r_inner_m=float(r0),
        r_outer_m=float(r1),
        axis=tuple(a["axis"]),  # type: ignore[arg-type]
        origin_m=tuple(a["origin_m"]),  # type: ignore[arg-type]
        kind=kind,
        s_min_m=float(min(a["s_min_m"], b["s_min_m"])),
        s_max_m=float(max(a["s_max_m"], b["s_max_m"])),
    )


def measure_radial_gaps(
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
    min_gap_m: float = 1e-6,
    max_gap_m: float | None = None,
) -> list[RadialGap]:
    """Coaxial cylinder pairs and concentric coplanar circles (incl. annuli)."""
    scale = float(scale_to_metres)
    cylinders: list[dict] = []
    circles: list[dict] = []
    for rec in solid.faces:
        c = _cylinder(rec, scale)
        if c is not None:
            cylinders.append(c)
        circles.extend(_plane_circles(rec, scale))

    found: list[RadialGap] = []

    for i, a in enumerate(cylinders):
        for b in cylinders[i + 1 :]:
            g = _gap_pair(
                a, b, kind="coaxial_cylinders", min_gap_m=min_gap_m, max_gap_m=max_gap_m
            )
            if g is not None:
                found.append(g)

    for i, a in enumerate(circles):
        for b in circles[i + 1 :]:
            ua = _unit(a["axis"])
            if ua is None:
                continue
            dz = _proj(a["origin_m"], ua, b["origin_m"])
            if abs(dz) > 1e-3:
                continue
            kind = (
                "annular_face"
                if int(a["face_id"]) == int(b["face_id"])
                else "concentric_circles"
            )
            g = _gap_pair(a, b, kind=kind, min_gap_m=min_gap_m, max_gap_m=max_gap_m)
            if g is not None:
                found.append(g)

    uniq: list[RadialGap] = []
    seen: set[tuple] = set()
    for g in sorted(found, key=lambda x: (x.gap_m, x.kind, x.face_a, x.face_b)):
        key = (
            round(g.r_inner_m, 6),
            round(g.r_outer_m, 6),
            g.kind,
            int(g.face_a),
            int(g.face_b),
        )
        if key in seen:
            continue
        seen.add(key)
        uniq.append(g)
    return uniq


def unresolved_gaps(
    gaps: list[RadialGap],
    *,
    skin_cell_m: float,
) -> list[RadialGap]:
    """Gaps narrower than two skin cells — cartesianMesh will bridge them."""
    lim = 2.0 * max(float(skin_cell_m), 1e-9)
    return [g for g in gaps if g.gap_m < lim]


def _pattern_for_face(project, face_id: int) -> str | None:
    fid = int(face_id)
    for bc in project.boundary_conditions:
        if fid not in bc.face_ids:
            continue
        name = str(bc.patch_name)
        if name.lower() == "walls" or str(bc.type).startswith("wall"):
            return f"{name}__f{fid}"
        return name
    return None


def _endcap_face_ids(solid: LoadedSolid, gaps: list[RadialGap], scale: float) -> set[int]:
    """Small plane faces on a coaxial-cylinder gap (VF floor, not the whole roof)."""
    wanted: list[RadialGap] = [g for g in gaps if g.kind == "coaxial_cylinders"]
    if not wanted:
        return set()
    extra: set[int] = set()
    for rec in solid.faces:
        circles = _plane_circles(rec, scale)
        if not circles:
            continue
        max_r = max(float(c["r_m"]) for c in circles)
        for c in circles:
            for g in wanted:
                if not _parallel(c["axis"], g.axis):
                    continue
                if not _on_axis(g.origin_m, g.axis, c["origin_m"], tol_m=1e-4):
                    continue
                r = float(c["r_m"])
                if abs(r - g.r_inner_m) > 1e-5 and abs(r - g.r_outer_m) > 1e-5:
                    continue
                # Skip large plates that only *touch* the hole (roof annulus
                # out to the barrel). Those get the hollowCone at the rim.
                if max_r > g.r_outer_m + 2.0 * g.gap_m:
                    continue
                extra.add(int(c["face_id"]))
    return extra


def gap_refinements(
    gaps: list[RadialGap],
    project,
    *,
    min_cells: float,
    solid: LoadedSolid | None = None,
    scale_to_metres: float | None = None,
) -> list[GapRefinement]:
    """localRefinement entries: cell ≤ gap/min_cells on the bounding patches."""
    n = max(float(min_cells), 1.0)
    extra: set[int] = set()
    skip_large: set[int] = set()
    if solid is not None:
        scale = (
            float(scale_to_metres)
            if scale_to_metres is not None
            else float(getattr(project, "scale_to_metres", 1.0))
        )
        extra = _endcap_face_ids(solid, gaps, scale)
        by_id = {rec.face_id: rec for rec in solid.faces}
        for g in gaps:
            for fid in (g.face_a, g.face_b):
                rec = by_id.get(fid)
                if rec is None:
                    continue
                circles = _plane_circles(rec, scale)
                if not circles:
                    continue
                if max(float(c["r_m"]) for c in circles) > g.r_outer_m + 2.0 * g.gap_m:
                    skip_large.add(fid)

    by_pattern: dict[str, GapRefinement] = {}

    def _add(fid: int, cell: float, thick: float, gap: float) -> None:
        pattern = _pattern_for_face(project, fid)
        if pattern is None:
            return
        prev = by_pattern.get(pattern)
        if prev is None or cell < prev.cell_size_m:
            ids = tuple(sorted(set(prev.face_ids) | {fid})) if prev else (fid,)
            by_pattern[pattern] = GapRefinement(
                pattern=pattern,
                cell_size_m=cell,
                thickness_m=thick,
                gap_m=gap,
                face_ids=ids,
            )

    for g in gaps:
        cell = max(g.gap_m / n, 1e-6)
        # Thin peel around the wall — 3×gap on the roof plate was a 14 mm
        # domain band. 1.5×gap still covers the annulus with margin.
        thick = max(1.5 * g.gap_m, 2.0 * cell)
        for fid in (g.face_a, g.face_b):
            if fid in skip_large:
                continue
            _add(fid, cell, thick, g.gap_m)
        if g.kind == "coaxial_cylinders":
            for fid in extra:
                _add(fid, cell, thick, g.gap_m)
    return sorted(by_pattern.values(), key=lambda r: r.pattern)


def gap_object_refinements(
    gaps: list[RadialGap],
    *,
    min_cells: float,
) -> list[GapObjectRefinement]:
    """One hollowCone per unique (r_inner, r_outer) annulus."""
    n = max(float(min_cells), 1.0)
    grouped: dict[tuple[float, float], list[RadialGap]] = {}
    for g in gaps:
        grouped.setdefault((round(g.r_inner_m, 6), round(g.r_outer_m, 6)), []).append(g)

    def _world(g: RadialGap, s: float) -> tuple[float, float, float]:
        u = _unit(g.axis) or (0.0, 0.0, 1.0)
        return (
            g.origin_m[0] + u[0] * s,
            g.origin_m[1] + u[1] * s,
            g.origin_m[2] + u[2] * s,
        )

    out: list[GapObjectRefinement] = []
    for i, ((_ri, _ro), gs) in enumerate(sorted(grouped.items())):
        g0 = min(gs, key=lambda g: g.gap_m)
        cell = max(g0.gap_m / n, 1e-6)
        pad = max(g0.gap_m, cell)
        u = _unit(g0.axis) or (0.0, 0.0, 1.0)
        # Reproject every gap's local s-range into g0's axis frame.
        proj = []
        for g in gs:
            proj.append(_proj(g0.origin_m, u, _world(g, g.s_min_m)))
            proj.append(_proj(g0.origin_m, u, _world(g, g.s_max_m)))
        s0 = min(proj) - pad
        s1 = max(proj) + pad
        if abs(s1 - s0) < pad:
            s0 -= 0.5 * pad
            s1 += 0.5 * pad
        p0 = (
            g0.origin_m[0] + u[0] * s0,
            g0.origin_m[1] + u[1] * s0,
            g0.origin_m[2] + u[2] * s0,
        )
        p1 = (
            g0.origin_m[0] + u[0] * s1,
            g0.origin_m[1] + u[1] * s1,
            g0.origin_m[2] + u[2] * s1,
        )
        r_in = max(g0.r_inner_m - pad, 0.25 * g0.r_inner_m)
        r_out = g0.r_outer_m + pad
        if r_out <= r_in:
            r_out = g0.r_outer_m + pad
            r_in = max(g0.r_inner_m * 0.5, 1e-6)
        out.append(
            GapObjectRefinement(
                name=f"gap_{i}",
                cell_size_m=cell,
                p0=p0,
                p1=p1,
                r_inner_m=r_in,
                r_outer_m=r_out,
                gap_m=g0.gap_m,
            )
        )
    return out


def smallest_unresolved_gap_m(
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
    hex_cell_m: float,
) -> float | None:
    """Smallest CAD gap the hex cell would bridge. Any solid — not a part id."""
    gaps = measure_radial_gaps(solid, scale_to_metres=float(scale_to_metres))
    thin = unresolved_gaps(gaps, skin_cell_m=float(hex_cell_m))
    if not thin:
        return None
    return min(float(g.gap_m) for g in thin)


def hexcore_gap_controls(
    solid: LoadedSolid,
    project,
    *,
    skin_cell_m: float,
    cells_across_gap: float | None = None,
) -> tuple[list[GapRefinement], list[GapObjectRefinement], list[RadialGap]]:
    """Unresolved thin-wall gaps → localRef + hollowCone for meshDict.

    ``cells_across_gap=1`` is the Standard hexcore path: one cell in the
    annulus so the wall exists. Default (3) is the old gap/3 flood used by
    tests / the frozen backup recipe — do not use that on live Generate.
    """
    gaps = measure_radial_gaps(solid, scale_to_metres=float(project.scale_to_metres))
    thin = unresolved_gaps(gaps, skin_cell_m=float(skin_cell_m))
    min_cells = (
        float(cells_across_gap)
        if cells_across_gap is not None
        else float(getattr(project.mesh, "min_cells_across_passage", 3.0) or 3.0)
    )
    refs = gap_refinements(
        thin,
        project,
        min_cells=min_cells,
        solid=solid,
        scale_to_metres=float(project.scale_to_metres),
    )
    objs = gap_object_refinements(thin, min_cells=min_cells)
    return refs, objs, thin
