"""One cell across (2D), a Hex-dominant mesh setting (the validation set's gap G5).

A quasi-2D part (a slab: a straight extrusion between two parallel flat faces that carry a
Symmetry boundary condition) meshed as a slab costs many cells across its depth near every
surface. With this setting the mesh is one cell across: exactly 2D, as the solve makes the two
end faces (the study's Symmetry patch) ``empty``, so nothing is solved across the depth
(incompressible_flow.writer.two_d_empty_patches; as mirror planes the depth's velocity was
solved too, its residual round-off that never settled).

OpenFOAM v2606's snappyHexMesh has no 2D mode (checked in its source): its refinement
(``hexRef8``) splits a cell in all three directions, and its directional refinement
(``levelIncrement``) works only inside or outside a closed shell, never near a surface. So the
mesher meshes the slab in 3D, as cheaply as it can: the background block is exactly the part's
depth, one cell deep, its two ends the block's own patches (``FRONT``, ``BACK``: never
snapped, so they stay flat), and only the side faces are surfaces, stretched along the axis
past both ends (``stretched``). Then ``extrudeMesh`` builds the 2D mesh: one layer of the
part's depth from the low end's faces, the patch of every face around them kept; the mesh is
checked as a 2D mesh (its two ends ``empty`` for ``checkMesh``), and ``createPatch`` puts the
two ends on the study's Symmetry patch (``snappy_hexdominant.sh``), which the solve makes
``empty`` again (that Symmetry is on the ends only: :func:`plan_two_d`). Near the finest surfaces
the 3D slab still has 2^level cells across its depth for each 2D cell: it is a step on the way.

When it applies (:func:`plan_two_d`): the part is one body of a CAD file; along x, y or z it
is a straight extrusion between two end planes (every face is either flat on one of the two
ends or parallel to that axis everywhere, so its section is the same at every depth); and the
faces at each end carry one boundary condition of a Symmetry family that is on the ends only.
Otherwise it says why, in
words the Mesh panel, Generate and the Assistant all use.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

AXES = ("x", "y", "z")
# The background block's two ends in the 3D slab: their own patches until createPatch puts
# them on the study's Symmetry patch (which holds the ends only).
FRONT = "magnusim_2d_front"
BACK = "magnusim_2d_back"
# The 3D slab's own case folder inside the WSL case: extrudeMesh's source.
SLAB_CASE = "mgf3d"
# A normal component under this counts as none (a face parallel to the axis); a flat face's
# normal within it of an axis is perpendicular to that axis.
_ALONG = 1e-6
# A position along the axis within this times the part's size is on an end plane.
_ON_PLANE = 1e-6
# The point inside the mesh sits at this fraction of the depth from the low end: never on a
# cell face of the one-cell background or of its refinement levels (halves, quarters, ...).
LOCATION_DEPTH = 0.3719
_SAMPLES = (0.1, 0.3, 0.5, 0.7, 0.9)


@dataclass(frozen=True)
class FaceShape:
    """What a CAD face is along each axis."""

    face_id: int  # 0-based (cad.step FaceRecord.face_id)
    plane_axis: int | None  # a flat face perpendicular to x, y or z: that axis (0, 1, 2)
    coord: float | None  # where it lies along that axis (the STEP's units)
    along: tuple[bool, bool, bool]  # its normal has no component along x / y / z anywhere


@dataclass(frozen=True)
class Ends:
    """A part along one axis: its two end planes, their faces, and the faces that keep it from
    being a straight extrusion between them."""

    axis: int
    lo: float
    hi: float
    lo_faces: tuple[int, ...]
    hi_faces: tuple[int, ...]
    breaks: tuple[int, ...] = ()

    @property
    def prism(self) -> bool:
        return bool(self.lo_faces) and bool(self.hi_faces) and not self.breaks and self.hi > self.lo


@dataclass(frozen=True)
class TwoDPlan:
    """How a part is meshed one cell across: the axis, the two ends (metres), their faces
    (0-based ids) and the patch and boundary condition of each end."""

    axis: int
    lo_m: float
    hi_m: float
    front_faces: tuple[int, ...]
    back_faces: tuple[int, ...]
    front_patch: str
    back_patch: str
    front_bc: str
    back_bc: str
    labels: dict[int, str] = field(default_factory=dict)

    @property
    def depth_m(self) -> float:
        return self.hi_m - self.lo_m

    def summary(self) -> dict[str, Any]:
        """What the mesh record, its facts, the Mesh panel and the Assistant read."""
        return {
            "axis": AXES[self.axis],
            "depth_m": _sig(self.depth_m),
            "lo_m": self.lo_m,
            "hi_m": self.hi_m,
            "cells_across": 1,
            "front": {"faces": [self.labels.get(f, _label(f)) for f in self.front_faces], "bc": self.front_bc, "patch": self.front_patch},
            "back": {"faces": [self.labels.get(f, _label(f)) for f in self.back_faces], "bc": self.back_bc, "patch": self.back_patch},
        }


def _sig(v: float, digits: int = 6) -> float:
    return float(f"{v:.{digits}g}") if math.isfinite(v) else v


def _label(face_id: int, body: int = 1) -> str:
    return f"Face {int(face_id) + 1}@Body{int(body)}"


# ---------------------------------------------------------------------------
# The part's faces (OCP)
# ---------------------------------------------------------------------------


def face_shapes(solid: Any) -> list[FaceShape]:
    """Each CAD face of a ``cad.step.LoadedSolid``: its plane's axis and position when it is a
    flat face perpendicular to x, y or z, and along which axes its normal never points (a flat
    face's own normal; any other surface sampled at 5 x 5 points of its parameter range)."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.BRepTools import BRepTools
    from OCP.GeomAbs import GeomAbs_Plane

    out: list[FaceShape] = []
    for rec in solid.faces:
        surf = BRepAdaptor_Surface(rec.face)
        if surf.GetType() == GeomAbs_Plane:
            pln = surf.Plane()
            d = pln.Axis().Direction()
            n = (d.X(), d.Y(), d.Z())
            loc = pln.Location()
            p = (loc.X(), loc.Y(), loc.Z())
            axis = next((k for k in range(3) if abs(n[k]) >= 1.0 - _ALONG), None)
            out.append(
                FaceShape(
                    int(rec.face_id),
                    axis,
                    float(p[axis]) if axis is not None else None,
                    (abs(n[0]) <= _ALONG, abs(n[1]) <= _ALONG, abs(n[2]) <= _ALONG),
                )
            )
            continue
        umin, umax, vmin, vmax = BRepTools.UVBounds_s(rec.face)
        worst = [0.0, 0.0, 0.0]
        for fu in _SAMPLES:
            for fv in _SAMPLES:
                props = BRepLProp_SLProps(surf, umin + fu * (umax - umin), vmin + fv * (vmax - vmin), 1, 1e-9)
                if not props.IsNormalDefined():
                    continue
                nd = props.Normal()
                for k, c in enumerate((nd.X(), nd.Y(), nd.Z())):
                    worst[k] = max(worst[k], abs(c))
        out.append(FaceShape(int(rec.face_id), None, None, (worst[0] <= _ALONG, worst[1] <= _ALONG, worst[2] <= _ALONG)))
    return out


def part_ends(shapes: Sequence[FaceShape], size: float) -> list[Ends]:
    """For each axis with flat faces perpendicular to it: its two end planes (the lowest and the
    highest of them), their faces, and every other face whose normal points along it somewhere
    (``breaks``: such a part is not a straight extrusion between them). ``size`` is the part's
    size (its box's diagonal, the STEP's units)."""
    tol = _ON_PLANE * max(float(size), 1e-12)
    out: list[Ends] = []
    for k in range(3):
        planes = [s for s in shapes if s.plane_axis == k and s.coord is not None]
        if not planes:
            continue
        lo = min(float(s.coord) for s in planes if s.coord is not None)
        hi = max(float(s.coord) for s in planes if s.coord is not None)
        lo_faces = tuple(s.face_id for s in planes if s.coord is not None and abs(s.coord - lo) <= tol)
        hi_faces = tuple(s.face_id for s in planes if s.coord is not None and abs(s.coord - hi) <= tol)
        if hi - lo <= tol:
            continue
        ends = set(lo_faces) | set(hi_faces)
        breaks = tuple(s.face_id for s in shapes if s.face_id not in ends and not s.along[k])
        out.append(Ends(k, lo, hi, lo_faces, hi_faces, breaks))
    return out


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BcFaces:
    """A boundary condition as the plan reads it: its name, whether its family is a Symmetry
    (a mirror plane), and its faces (0-based ids)."""

    name: str
    symmetry: bool
    faces: tuple[int, ...]


def plan_two_d(
    solid: Any,
    scale: float,
    bcs: Iterable[BcFaces],
    face_to_patch: dict[int, str],
    *,
    bodies: dict[int, int] | None = None,
    shapes: Sequence[FaceShape] | None = None,
) -> TwoDPlan | str:
    """How ``solid`` (a ``cad.step.LoadedSolid``) is meshed one cell across, or why it can't
    be: a sentence the Mesh panel shows under the setting and Generate refuses with.

    ``scale`` turns the STEP's units into metres; ``bcs`` are the study's boundary conditions;
    ``face_to_patch`` names the patch each face meshes under (the meshers' map), so the plan's
    patches are the ones the solve writes the BCs on; ``bodies`` gives each face's body for the
    face labels (``Face N@BodyB``).
    """
    if getattr(solid, "mesh_triangles", None) is not None:
        return "This geometry is a mesh (an STL or OBJ import): one cell across needs a CAD part (a STEP file) whose flat faces it can read."
    n_bodies = len(getattr(solid, "volumes", None) or [])
    if n_bodies > 1:
        return f"The part has {n_bodies} bodies: one cell across meshes a part of one body."
    rows = [b for b in bcs if b.faces]
    if not any(b.symmetry for b in rows):
        return "No boundary condition is a Symmetry. Put one Symmetry on the two parallel flat faces at the part's ends (its front and back)."
    body_of = bodies or {}
    labels = {int(r.face_id): _label(int(r.face_id), body_of.get(int(r.face_id), 1)) for r in solid.faces}
    shapes = list(shapes) if shapes is not None else face_shapes(solid)
    ends = part_ends(shapes, _size(solid))
    if not ends:
        return "The part has no flat faces perpendicular to x, y or z, so it has no two parallel end faces to mesh between."
    bc_of: dict[int, BcFaces] = {}
    for b in rows:
        for f in b.faces:
            bc_of.setdefault(int(f), b)

    def sym_ends(e: Ends) -> int:
        return sum(1 for f in (*e.lo_faces, *e.hi_faces) if bc_of.get(f) is not None and bc_of[f].symmetry)

    def end_ok(faces: tuple[int, ...]) -> bool:
        names = {bc_of[f].name if f in bc_of else None for f in faces}
        return len(names) == 1 and None not in names and all(bc_of[f].symmetry for f in faces)

    def off_ends(e: Ends) -> list[int]:
        """The faces off the two ends that the ends' boundary conditions also hold."""
        on_ends = {*e.lo_faces, *e.hi_faces}
        held = {id(bc_of[f]) for f in on_ends}
        return sorted({int(f) for b in rows if id(b) in held for f in b.faces} - on_ends)

    prisms = [e for e in ends if e.prism]
    good = [e for e in prisms if end_ok(e.lo_faces) and end_ok(e.hi_faces)]
    # The ends' Symmetry must be on the ends only: the solve makes that patch empty (exactly 2D),
    # and an empty patch can't also hold side faces (it would stay a mirror plane, whose depth
    # velocity never settles). A box qualifies along more than one axis: the thinnest is the
    # slab's depth.
    own = [e for e in good if not off_ends(e)]
    if good and not own:
        e = min(good, key=lambda x: (x.hi - x.lo, -x.axis))
        extra = off_ends(e)
        end_bcs = sorted({bc_of[f].name for f in (*e.lo_faces, *e.hi_faces)})
        listed = " and ".join(f'"{n}"' for n in end_bcs)
        shown = ", ".join(labels.get(f, _label(f)) for f in extra[:3]) + (f" and {len(extra) - 3} more" if len(extra) > 3 else "")
        return (
            f"{listed} is also on {shown}, off the part's ends along {AXES[e.axis]}: "
            "give the two end faces a Symmetry of their own, so the solve can make them the 2D ends."
        )
    if own:
        e = min(own, key=lambda x: (x.hi - x.lo, -x.axis))
        lo_bc, hi_bc = bc_of[e.lo_faces[0]], bc_of[e.hi_faces[0]]
        front = {face_to_patch.get(f, "") for f in e.lo_faces}
        back = {face_to_patch.get(f, "") for f in e.hi_faces}
        if len(front) != 1 or len(back) != 1 or "" in front or "" in back:
            return f"The faces at the part's ends along {AXES[e.axis]} mesh on more than one patch; give each end one Symmetry boundary condition."
        return TwoDPlan(
            axis=e.axis,
            lo_m=float(e.lo) * float(scale),
            hi_m=float(e.hi) * float(scale),
            front_faces=tuple(sorted(e.lo_faces)),
            back_faces=tuple(sorted(e.hi_faces)),
            front_patch=front.pop(),
            back_patch=back.pop(),
            front_bc=lo_bc.name,
            back_bc=hi_bc.name,
            labels=labels,
        )
    # Why not: along the axis whose ends carry the most Symmetry faces (the one meant).
    best = max(ends, key=lambda e: (sym_ends(e), e.prism, -(e.hi - e.lo)))
    ax = AXES[best.axis]
    if not best.prism:
        f = best.breaks[0]
        return (
            f"The part is not a straight extrusion between its two end faces along {ax}: "
            f"{labels.get(f, _label(f))} is neither on an end nor parallel to {ax}."
        )
    for faces in (best.lo_faces, best.hi_faces):
        names = {bc_of[f].name for f in faces if f in bc_of}
        if len(names) > 1:
            listed = " and ".join(f'"{n}"' for n in sorted(names))
            return f"The faces at one end along {ax} carry {listed}: give each end one Symmetry boundary condition."
        for f in faces:
            on = bc_of.get(f)
            if on is None:
                return f"{labels.get(f, _label(f))}, at the part's end along {ax}, has no boundary condition: both end faces need a Symmetry."
            if not on.symmetry:
                return f'{labels.get(f, _label(f))}, at the part\'s end along {ax}, has "{on.name}", not a Symmetry: both end faces need a Symmetry.'
    return f"The part's two end faces along {ax} can't be meshed one cell across."


def _size(solid: Any) -> float:
    """The part's box diagonal in the STEP's units."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.Add_s(solid.shape, box)
    if box.IsVoid():
        return 1.0
    x0, y0, z0, x1, y1, z1 = box.Get()
    return math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) or 1.0


# ---------------------------------------------------------------------------
# The dictionaries
# ---------------------------------------------------------------------------


# Each end face of the background block (vertices as two_d.background orders them), outward.
_END_FACES = {
    0: ("(0 4 7 3)", "(2 6 5 1)"),
    1: ("(1 5 4 0)", "(3 7 6 2)"),
    2: ("(0 3 2 1)", "(4 5 6 7)"),
}


def background(
    bounds_m: dict[str, float], base_m: float, axis: int, lo_m: float, hi_m: float, pad: float
) -> tuple[list[tuple[float, float, float]], str, str]:
    """The background block of a 2D mesh: across the axis as a 3D mesh's (the part's box times
    ``pad``, cells of ``base_m``, at least 8, the section's long side at most 3 times its short
    one: the aspect cap of ``snappy_hexdominant.background_counts``, the depth left out of it);
    along it exactly
    the part's depth, one cell. Its two ends are the patches ``FRONT`` (low) and ``BACK``
    (high), the 2D mesh's two ends.
    Returns the 8 vertices, the cell counts ``(nx ny nz)`` and the ``boundary`` entries."""
    from cfddesk.mesh.snappy_hexdominant import background_counts

    lo_hi = [(float(bounds_m["xmin"]), float(bounds_m["xmax"])), (float(bounds_m["ymin"]), float(bounds_m["ymax"])), (float(bounds_m["zmin"]), float(bounds_m["zmax"]))]
    a: list[float] = []
    b: list[float] = []
    counts = background_counts([hi - lo for lo, hi in lo_hi], pad, base_m, (8, 8, 8), one_cell_axis=int(axis))
    for k in range(3):
        if k == axis:
            a.append(float(lo_m))
            b.append(float(hi_m))
            continue
        c = 0.5 * (lo_hi[k][0] + lo_hi[k][1])
        h = 0.5 * (lo_hi[k][1] - lo_hi[k][0]) * pad
        a.append(c - h)
        b.append(c + h)
    verts = [
        (a[0], a[1], a[2]),
        (b[0], a[1], a[2]),
        (b[0], b[1], a[2]),
        (a[0], b[1], a[2]),
        (a[0], a[1], b[2]),
        (b[0], a[1], b[2]),
        (b[0], b[1], b[2]),
        (a[0], b[1], b[2]),
    ]
    low, high = _END_FACES[int(axis)]
    boundary = (
        f"    {FRONT}\n    {{\n        type patch;\n        faces ({low});\n    }}\n"
        f"    {BACK}\n    {{\n        type patch;\n        faces ({high});\n    }}\n"
    )
    return verts, f"({counts[0]} {counts[1]} {counts[2]})", boundary


def stretched(points_m: Any, axis: int, lo_m: float, hi_m: float) -> Any:
    """``points_m`` stretched three times along the axis about the part's middle: the side
    faces (parallel to the axis everywhere) as surfaces that reach past both ends of the
    background, so snapping never pulls a point of an end off its plane."""
    import numpy as np

    pts = np.array(points_m, dtype=np.float64, copy=True)
    mid = 0.5 * (float(lo_m) + float(hi_m))
    pts[:, int(axis)] = mid + 3.0 * (pts[:, int(axis)] - mid)
    return pts


def inplane_base(fineness_cells_across: float, bounds_m: dict[str, float], axis: int) -> float:
    """The background cell of a 2D mesh: the part's section diagonal (its box without the
    depth) over the fineness's cells across, as a 3D mesh's is of its whole box."""
    span = [abs(float(bounds_m[f"{c}max"]) - float(bounds_m[f"{c}min"])) for c in AXES]
    diag = math.sqrt(sum(s * s for k, s in enumerate(span) if k != axis)) or 1.0
    return max(1e-5, min(1.0, diag / float(fineness_cells_across)))


def _header(obj: str) -> str:
    return "FoamFile\n{\n    version     2.0;\n    format      ascii;\n" f"    class       dictionary;\n    object      {obj};\n}}\n\n"


def extrude_mesh_dict(depth_m: float) -> str:
    """``system/extrudeMeshDict``: one layer of the part's depth from the low end's faces in
    the 3D slab (``SLAB_CASE``), into the part (``flipNormals``: a patch's normals point out
    of its mesh). ``plane`` makes the two ends ``empty`` so ``checkMesh`` checks a 2D mesh; the
    patch of every face around them is kept."""
    return _header("extrudeMeshDict") + "\n".join(
        [
            "constructFrom   patch;",
            f'sourceCase      "$FOAM_CASE/{SLAB_CASE}";',
            f"sourcePatches   ({FRONT});",
            f"exposedPatchName {BACK};",
            "flipNormals     true;",
            "extrudeModel    plane;",
            "nLayers         1;",
            "expansionRatio  1.0;",
            f"linearNormalCoeffs {{ thickness {float(depth_m):.10g}; }}",
            f"planeCoeffs     {{ thickness {float(depth_m):.10g}; }}",
            "mergeFaces      false;",
            "mergeTol        0;",
            "",
        ]
    )


def create_patch_dict(front_patch: str, back_patch: str) -> str:
    """``system/createPatchDict``: the two ends onto the study's patches (a Symmetry's patch,
    type ``patch`` as every BC patch is meshed; the solve sets its type), the temporary ones
    then removed as createPatch removes every patch left with no faces."""
    pairs = [(front_patch, [FRONT, BACK])] if front_patch == back_patch else [(front_patch, [FRONT]), (back_patch, [BACK])]
    entries = []
    for name, src in pairs:
        entries.append(
            "    {\n"
            f"        name {name};\n"
            "        patchInfo { type patch; }\n"
            "        constructFrom patches;\n"
            f"        patches ({' '.join(src)});\n"
            "    }"
        )
    return _header("createPatchDict") + "pointSync false;\n\npatches\n(\n" + "\n".join(entries) + "\n);\n"


# ---------------------------------------------------------------------------
# The study's boundary conditions
# ---------------------------------------------------------------------------


def bc_faces_of(web_bcs: Iterable[dict[str, Any]], n_faces: int) -> list[BcFaces]:
    """The study's boundary conditions (web records) as the plan reads them. A Symmetry is a
    BC whose family (any plugin's) is a mirror plane: its colour is ``symmetry``."""
    from cfddesk.mesh.web_refinements import face_ids_from_web_bc
    from cfddesk.project.web_adapter import bc_family_for

    out: list[BcFaces] = []
    for bc in web_bcs:
        if not isinstance(bc, dict):
            continue
        raw = str(bc.get("bc_type") or bc.get("type") or "")
        fam = bc_family_for(raw) or bc_family_for(raw.replace("_", " "))
        sym = str(getattr(fam, "color", "") or "") == "symmetry" if fam is not None else raw.strip().lower() in ("symmetry", "symmetry plane")
        name = str(bc.get("name") or (getattr(fam, "label", "") if fam is not None else "") or raw or "a boundary condition")
        out.append(BcFaces(name, sym, tuple(int(f) for f in face_ids_from_web_bc(bc, n_faces))))
    return out


def refusal_words(reason: str) -> str:
    """What Generate says when the part can't be meshed one cell across."""
    return f"One cell across (2D) can't mesh this part: {reason} Or turn One cell across off."
