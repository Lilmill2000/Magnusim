"""Faces two bodies share: the inside of a multi-body part.

Two solids that touch over a whole face (a conformal multi-body part, as a
General Fuse makes it) visit that face once per body (``preview.face_visits``),
so it has one id per body: face 2@Body1 and face 7@Body2 on
``tests/fixtures/geometry/two-boxes-shared-face.brep``. Every body of a part is
meshed as one fluid region, so that face is inside the fluid. It gets no patch,
each mesher meshes through it, and a boundary condition on it is refused
(``bc_refusal``; the BC panel refuses the pick with the same words).

Two visits in different bodies are the same face when OCCT says so (``IsSame``:
the binary sidecar shares the face), or when they are copies of one face: areas
and centroids equal to a millionth, normals opposite. The STEP copy, like most
CAD systems' multi-body STEP files, gives each body its own copy of the face.
"""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np

# Copies of one face: centroids within this fraction of the part's size, areas
# within this fraction of each other.
_COPY_REL = 1e-6


def _outward_normal(face) -> np.ndarray | None:
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Pnt, gp_Vec

    try:
        umin, umax, vmin, vmax = BRepTools.UVBounds_s(face)
        pnt, vec = gp_Pnt(), gp_Vec()
        BRepGProp_Face(face).Normal(0.5 * (umin + umax), 0.5 * (vmin + vmax), pnt, vec)
    except Exception:
        return None
    n = np.array([vec.X(), vec.Y(), vec.Z()], dtype=np.float64)
    length = float(np.linalg.norm(n))
    return n / length if length > 0 else None


def pairs(entries: Iterable[tuple[int, int | None, float, tuple[float, float, float], object]]) -> dict[int, int]:
    """``{id: id of the same face in the other body}`` for every shared face visit.

    ``entries`` are ``(id, body, area, centroid, face)`` per face visit; a visit
    with no body (a face outside every solid) is never shared.
    """
    from OCP.TopTools import TopTools_IndexedMapOfShape

    visits = [e for e in entries if e[1] is not None]
    out: dict[int, int] = {}
    shapes = TopTools_IndexedMapOfShape()
    same: dict[int, list] = {}
    for e in visits:
        same.setdefault(int(shapes.Add(e[4])), []).append(e)
    for group in same.values():
        if len(group) == 2 and group[0][1] != group[1][1]:
            a, b = group
            out[a[0]] = b[0]
            out[b[0]] = a[0]
    rest = [e for e in visits if e[0] not in out]
    if len(rest) < 2:
        return out
    from scipy.spatial import cKDTree

    xyz = np.asarray([e[3] for e in rest], dtype=np.float64)
    size = float(np.linalg.norm(xyz.max(axis=0) - xyz.min(axis=0))) or 1.0
    for i, j in sorted(cKDTree(xyz).query_pairs(_COPY_REL * size)):
        a, b = rest[i], rest[j]
        if a[1] == b[1] or a[0] in out or b[0] in out:
            continue
        if abs(a[2] - b[2]) > _COPY_REL * max(abs(a[2]), abs(b[2])):
            continue
        na, nb = _outward_normal(a[4]), _outward_normal(b[4])
        if na is None or nb is None or float(na @ nb) > -0.999:
            continue
        out[a[0]] = b[0]
        out[b[0]] = a[0]
    return out


def face_bodies(solid) -> dict[int, int]:
    """0-based face id -> 1-based body (``Body<n>`` in face labels)."""
    return {int(f): i + 1 for i, v in enumerate(solid.volumes) for f in v.face_ids}


def shared_face_ids(solid) -> dict[int, int]:
    """``pairs`` for a ``LoadedSolid``, in its 0-based face ids. Empty for a mesh import."""
    if solid.mesh_triangles is not None or len(solid.volumes) < 2:
        return {}
    body = face_bodies(solid)
    return pairs((r.face_id, body.get(int(r.face_id)), r.area, r.centroid, r.face) for r in solid.faces)


def inside_text(face_id: int, other: int, bodies: dict[int, int]) -> str:
    """``Face 7@Body2 is inside the part (Body1 and Body2 share it)``."""
    a, b = sorted((bodies.get(int(face_id), 1), bodies.get(int(other), 1)))
    return f"Face {int(face_id) + 1}@Body{bodies.get(int(face_id), 1)} is inside the part (Body{a} and Body{b} share it)"


def bc_refusal(named_faces: Iterable[tuple[str, Iterable[int]]], shared: dict[int, int], bodies: dict[int, int]) -> str | None:
    """Why the mesh can't be made when a boundary condition is on a shared face; else None.

    ``named_faces`` are ``(BC name, its 0-based face ids)``. The BC panel refuses
    the pick with the same first sentence.
    """
    for name, fids in named_faces:
        for fid in fids:
            if int(fid) in shared:
                return (
                    f"{inside_text(int(fid), shared[int(fid)], bodies)}, so it can't take a "
                    f'boundary condition. Remove it from "{name}".'
                )
    return None
