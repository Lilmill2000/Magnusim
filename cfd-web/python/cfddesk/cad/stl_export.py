"""Per-BC STL export in metres (mesh-resolution-tied tessellation)."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from cfddesk.cad.step import LoadedSolid, tessellate_faces
from cfddesk.cad.stl_quality import stl_deflection_for_bc
from cfddesk.project.model import Project


class UnitsNotConfirmedError(RuntimeError):
    """Refuse STL export until scale_to_metres is explicitly confirmed."""


class RolesUnverifiedError(RuntimeError):
    """Refuse progressing past STL when required CFD roles are missing."""


class UnassignedFacesError(RuntimeError):
    """Hard block: every face must belong to a BC before meshing."""


def _write_binary_stl(path: Path, points: np.ndarray, triangles: np.ndarray) -> None:
    """Write a binary STL (metres)."""
    n_tri = len(triangles)
    header = b"cfddesk metres" + b"\0" * (80 - len(b"cfddesk metres"))
    buf = bytearray()
    buf.extend(header)
    buf.extend(np.asarray([n_tri], dtype=np.uint32).tobytes())
    for i0, i1, i2 in triangles:
        p0, p1, p2 = points[i0], points[i1], points[i2]
        n = np.cross(p1 - p0, p2 - p0)
        norm = np.linalg.norm(n)
        if norm > 0:
            n = n / norm
        else:
            n = np.zeros(3, dtype=np.float64)
        tri = np.array([*n, *p0, *p1, *p2], dtype=np.float32)
        buf.extend(tri.tobytes())
        buf.extend(b"\0\0")
    path.write_bytes(buf)


def export_bc_stls(
    solid: LoadedSolid,
    project: Project,
    out_dir: str | Path,
    *,
    require_units_confirmed: bool = True,
    require_all_assigned: bool = True,
    legacy_deflection: bool = False,
) -> dict[str, Path]:
    """Export ``{patch_name}.stl`` for each emitted patch (metres).

    Intensive BCs write one STL; extensive BCs write one STL per face
    (``<patch>_1`` … ``<patch>_N``). Tessellation deflection is derived from
    the parent BC's refinement; each emitted patch filters to its face_ids.
    """
    from cfddesk.mesh.patches import emit_all_patches

    if require_units_confirmed and not project.units_confirmed:
        raise UnitsNotConfirmedError(
            "units.confirmed is false — confirm scale_to_metres before STL export"
        )
    if project.scale_to_metres <= 0:
        raise ValueError(f"invalid scale_to_metres={project.scale_to_metres}")

    emitted = emit_all_patches(project)
    if not emitted:
        raise RolesUnverifiedError(
            "no boundary conditions with faces — assign faces to at least one BC"
        )

    if require_all_assigned:
        unassigned = project.unassigned_face_ids()
        if unassigned:
            preview = ", ".join(str(i) for i in unassigned[:40])
            more = f" (+{len(unassigned) - 40} more)" if len(unassigned) > 40 else ""
            raise UnassignedFacesError(
                f"unassigned faces must be assigned before meshing: "
                f"[{preview}{more}]"
            )

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
    # Cache tessellation by deflection so extensive N-face BCs don't remesh N times.
    tess_cache: dict[tuple[float, float], tuple] = {}

    written: dict[str, Path] = {}
    for ep in emitted:
        bc = bc_by_id.get(ep.bc_id)
        if bc is None:
            raise RuntimeError(f"emitted patch {ep.name!r}: missing BC id {ep.bc_id!r}")
        face_set = set(ep.face_ids)
        if legacy_deflection:
            lin, ang = 1.0, 0.5
        else:
            lin, ang, _target = stl_deflection_for_bc(solid, project, bc)
        key = (float(lin), float(ang))
        if key not in tess_cache:
            tess_cache[key] = tessellate_faces(
                solid, linear_deflection=lin, angular_deflection=ang
            )
        points, faces, face_ids = tess_cache[key]
        points_m = points * float(project.scale_to_metres)
        mask = np.isin(face_ids, list(face_set))
        tri = faces[mask]
        if len(tri) == 0:
            raise RuntimeError(f"patch {ep.name!r}: no triangles")
        used = np.unique(tri.ravel())
        remap = {int(old): new for new, old in enumerate(used)}
        pts = points_m[used]
        tris = np.asarray(
            [[remap[int(a)], remap[int(b)], remap[int(c)]] for a, b, c in tri]
        )
        path = out_dir / f"{ep.name}.stl"
        _write_binary_stl(path, pts, tris)
        written[ep.name] = path

    return written


def export_role_stls(
    solid: LoadedSolid,
    project: Project,
    out_dir: str | Path,
    *,
    require_units_confirmed: bool = True,
    require_cfd_roles: bool = True,
    legacy_deflection: bool = False,
) -> dict[str, Path]:
    """Thin wrapper: export STLs via BC ownership (migration-compatible)."""
    # require_cfd_roles historically meant inlet+outlet+walls present; under BC
    # ownership we require at least one BC with faces (+ all assigned when True).
    return export_bc_stls(
        solid,
        project,
        out_dir,
        require_units_confirmed=require_units_confirmed,
        require_all_assigned=require_cfd_roles,
        legacy_deflection=legacy_deflection,
    )
