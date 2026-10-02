"""gmsh helpers for the Standard mesher: BREP export, face-to-surface matching,
patch types. The mesher itself is ``standard_hexcore`` (``tools/generate_standard.py``).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from magnusim_sdk.gmsh_helpers import (  # noqa: F401 (re-export)
    apply_boundary_patch_types,
    initialize_gmsh,
)

from cfddesk.cad.step import LoadedSolid
from cfddesk.mesh.patches import emit_all_patches
from cfddesk.project.model import Project


def write_gmsh_brep(shape, out_path: Path, *, scale_to_metres: float = 1.0) -> Path:
    """Write ``shape`` (optionally scaled) as an OCC BREP for gmsh to import.

    gmsh reads BREP natively and far faster than STEP: a 118k-face faceted STL
    solid takes ~270 s as STEP and ~7 s as BREP, with the same surfaces. BREP has
    no unit header, so coordinates are exactly the in-memory ones (the matcher's).
    """
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Trsf

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    s = float(scale_to_metres)
    if s <= 0:
        raise ValueError(f"invalid scale_to_metres={s}")
    if abs(s - 1.0) > 1e-15:
        trsf = gp_Trsf()
        trsf.SetScaleFactor(s)
        shape = BRepBuilderAPI_Transform(shape, trsf, True).Shape()
    if not BRepTools.Write_s(shape, str(out_path)):
        raise RuntimeError(f"BREP write failed for gmsh geometry: {out_path}")
    return out_path


def _face_centroid_m(
    solid: LoadedSolid, face_id: int, scale: float
) -> tuple[float, float, float]:
    for fr in solid.faces:
        if int(fr.face_id) == int(face_id):
            c = fr.centroid
            return (c[0] * scale, c[1] * scale, c[2] * scale)
    raise KeyError(f"face_id {face_id} not found on solid")


def _face_area_m2(solid: LoadedSolid, face_id: int, scale: float) -> float:
    for fr in solid.faces:
        if int(fr.face_id) == int(face_id):
            return float(fr.area) * float(scale) * float(scale)
    raise KeyError(f"face_id {face_id} not found on solid")


def _match_surface_tag(
    targets: list[tuple[int, tuple[float, float, float]]],
    com: tuple[float, float, float],
    *,
    tol: float,
) -> int | None:
    """Return face_id of nearest unused centroid within ``tol``, or None."""
    best_i: int | None = None
    best_d = tol
    cx, cy, cz = com
    for i, (_fid, (tx, ty, tz)) in enumerate(targets):
        d = math.sqrt((cx - tx) ** 2 + (cy - ty) ** 2 + (cz - tz) ** 2)
        if d < best_d:
            best_d = d
            best_i = i
    if best_i is None:
        return None
    fid, _ = targets.pop(best_i)
    return fid


def _assign_faces_to_surfaces(
    targets: list[tuple[int, tuple[float, float, float], float]],
    surfaces: list[tuple[int, tuple[float, float, float], float]],
    *,
    tol: float,
) -> dict[int, int]:
    """Map CAD face_id → gmsh surface tag using centroid *and* area.

    Centroid alone is ambiguous for concentric faces (a pipe end and the
    annular lid around it share a centroid, so do coaxial cylinders). Pairs
    are ranked by area mismatch first, centroid distance second, and each
    surface is used once. Candidate pairs come from a KD-tree (each surface's
    nearest faces within ``tol``) so faceted STL geometry with thousands of
    faces matches in linear-ish time, and globally rather than in surface order.
    """
    if not targets or not surfaces:
        return {}
    import numpy as np
    from scipy.spatial import cKDTree

    t_xyz = np.array([c for _fid, c, _a in targets], dtype=np.float64)
    tree = cKDTree(t_xyz)
    k = min(16, len(targets))
    pairs: list[tuple[float, float, int, int]] = []
    for tag, (cx, cy, cz), sa in surfaces:
        dists, idxs = tree.query((cx, cy, cz), k=k, distance_upper_bound=tol)
        for d, i in zip(np.atleast_1d(dists), np.atleast_1d(idxs), strict=True):
            if not np.isfinite(d) or i >= len(targets):
                continue
            fid, _c, fa = targets[int(i)]
            ref = max(abs(fa), abs(sa), 1e-30)
            # Round the area mismatch to 0.1 %: faceted parts have many faces of the
            # same area, and float noise there must not outrank centroid distance.
            pairs.append((round(abs(fa - sa) / ref, 3), float(d), fid, tag))
    pairs.sort()
    used_faces: set[int] = set()
    used_tags: set[int] = set()
    out: dict[int, int] = {}
    for rel_area, _d, fid, tag in pairs:
        if fid in used_faces or tag in used_tags:
            continue
        # healing / re-import can perturb areas slightly; anything beyond 25 %
        # is a different face even if the centroids coincide.
        if rel_area > 0.25:
            continue
        out[fid] = tag
        used_faces.add(fid)
        used_tags.add(tag)
    # fallback for faces whose area changed a lot (e.g. merged by healing):
    # nearest unused centroid, as before
    remaining = [(fid, c) for fid, c, _a in targets if fid not in out]
    for tag, com, _sa in surfaces:
        if not remaining:
            break
        if tag in used_tags:
            continue
        matched_fid = _match_surface_tag(remaining, com, tol=tol)
        if matched_fid is not None:
            out[matched_fid] = tag
            used_tags.add(tag)
    return out


def _face_to_patch_map(project: Project) -> dict[int, str]:
    face_to_patch: dict[int, str] = {}
    for ep in emit_all_patches(project):
        for fid in ep.face_ids:
            face_to_patch[int(fid)] = ep.name
    return face_to_patch


def _match_occ_surfaces(gmsh, solid: LoadedSolid, project: Project, *, scale: float, lc: float):
    """Import already done. Map CAD face_id → gmsh surface tag."""
    from cfddesk.cad.step import shape_diagonal

    face_to_patch = _face_to_patch_map(project)
    if not face_to_patch:
        raise RuntimeError("no emitted patches for Standard mesh")
    targets = [
        (fid, _face_centroid_m(solid, fid, scale), _face_area_m2(solid, fid, scale))
        for fid in face_to_patch
    ]
    diag_m = float(shape_diagonal(solid)) * scale
    match_tol = max(diag_m * 0.02, lc * 2.0, 1e-4)
    surfs = gmsh.model.getEntities(2)
    vols = gmsh.model.getEntities(3)
    if not vols:
        raise RuntimeError(
            "gmsh OCC import produced no volume — geometry may not be a closed solid"
        )
    if not surfs:
        raise RuntimeError("gmsh OCC import produced no surfaces")
    surfaces: list[tuple[int, tuple[float, float, float], float]] = []
    for _dim, tag in surfs:
        com = gmsh.model.occ.getCenterOfMass(2, tag)
        try:
            area = float(gmsh.model.occ.getMass(2, tag))
        except Exception:
            area = 0.0
        surfaces.append((int(tag), (float(com[0]), float(com[1]), float(com[2])), area))
    face_to_tag = _assign_faces_to_surfaces(targets, surfaces, tol=match_tol)
    missing = [fid for fid in face_to_patch if fid not in face_to_tag]
    if missing:
        preview = ", ".join(str(f) for f in missing[:20])
        raise RuntimeError(
            f"Standard mesh: failed to match {len(missing)} CAD face(s) to gmsh "
            f"surfaces (tol={match_tol:.4g} m). Missing face_ids: {preview}"
        )
    patch_tags: dict[str, list[int]] = {}
    for fid, pname in face_to_patch.items():
        patch_tags.setdefault(pname, []).append(face_to_tag[fid])
    return face_to_tag, patch_tags, vols, match_tol


def _suppress_small_surfaces(pts, tris, groups, face_to_patch: dict[int, str], min_size: float):
    """Merge each surface smaller than ``min_size`` across into a neighbour on the same patch.

    A coarse STL can carry flat facets of a square millimetre between sharp
    folds; as their own surfaces they force the mesh down to their size (skewed
    cells, failed layers). Like CAD small-feature suppression, they join the
    neighbour they share the longest edge with, but only when both go to the
    same patch, so a face with its own boundary condition is never absorbed.
    Returns ``(groups, {small: target})``.
    """
    from cfddesk.cad.face_groups import _edge_pairs, triangle_normals

    groups = np.asarray(groups, dtype=np.int64)
    n_groups = int(groups.max()) + 1
    _n, area = triangle_normals(pts, tris)
    g_area = np.bincount(groups, weights=area, minlength=n_groups)
    small = np.sqrt(g_area) < float(min_size)
    if not small.any():
        return groups, {}
    a, b, u, v, _same = _edge_pairs(np.asarray(tris, dtype=np.int64))
    ga, gb = groups[a], groups[b]
    cross = ga != gb
    length = np.linalg.norm(pts[u[cross]] - pts[v[cross]], axis=1)
    shared: dict[tuple[int, int], float] = {}
    for x, y, w in zip(ga[cross].tolist(), gb[cross].tolist(), length.tolist(), strict=True):
        shared[(x, y)] = shared.get((x, y), 0.0) + w
        shared[(y, x)] = shared.get((y, x), 0.0) + w
    merged: dict[int, int] = {}
    for g in sorted(np.nonzero(small)[0].tolist(), key=lambda k: g_area[k]):
        best, best_w = None, 0.0
        for (x, y), w in shared.items():
            if x != g or small[y] or face_to_patch.get(y) != face_to_patch.get(g):
                continue
            if w > best_w:
                best, best_w = y, w
        if best is not None:
            merged[g] = best
    if not merged:
        return groups, {}
    remap = np.arange(n_groups)
    for g, t in merged.items():
        remap[g] = t
    return remap[groups], merged


def import_grouped_triangles(gmsh, solid: LoadedSolid, project: Project, *, scale: float, lc: float | None = None, log=None):
    """Discrete gmsh geometry for a grouped mesh import (``solid.mesh_triangles``).

    A faceted STL read as OCC CAD is one plane per triangle: gmsh then meshes
    100k tiny faces and their slivers. Instead each surface of triangles
    (``cad.face_groups``) becomes one discrete surface; gmsh builds the curves
    between them, splits only where a surface needs it to be parametrized, and
    reparametrizes each piece so it can be remeshed at the Standard size.

    CAD-exported STLs are strips of needle triangles, which gmsh cannot
    parametrize reliably; with ``lc`` they are first refined to well-shaped
    triangles of about ``2 * lc`` on the same facets (``stl_refine``).

    Returns ``(face_to_tags, patch_tags, vols, 0.0)`` like ``_match_occ_surfaces``,
    except that a face id maps to a list of surface tags.
    """
    import math
    import time

    from cfddesk.mesh.stl_refine import refine_for_parametrization, triangle_gamma

    face_to_patch = _face_to_patch_map(project)
    if not face_to_patch:
        raise RuntimeError("no emitted patches for Standard mesh")
    if solid.mesh_triangles is None:
        raise RuntimeError("grouped triangles need a mesh import (STL/OBJ/PLY)")
    points, tris, groups = solid.mesh_triangles
    pts = np.asarray(points, dtype=np.float64) * float(scale)
    tris = np.asarray(tris, dtype=np.int64)
    groups = np.asarray(groups, dtype=np.int64)
    n_groups = int(groups.max()) + 1
    merged: dict[int, int] = {}
    if lc:
        groups, merged = _suppress_small_surfaces(pts, tris, groups, face_to_patch, 0.5 * float(lc))
        if merged and log is not None:
            log(
                f"small surfaces suppressed: face(s) {', '.join(str(g + 1) for g in sorted(merged))} "
                f"(under {0.5 * float(lc):.3g} m across) meshed with their neighbour"
            )
    if lc:
        t0 = time.monotonic()
        before = float(np.percentile(triangle_gamma(pts, tris), 1))
        n_before = len(tris)
        # Sliver edges collapse at the same tolerance the OCC path stitches with.
        pts, tris, groups = refine_for_parametrization(
            pts, tris, groups, 2.0 * float(lc), collapse_tol=min(3.0e-4, 0.05 * float(lc))
        )
        if log is not None:
            log(
                f"surface triangles refined for parametrization: {n_before} -> {len(tris)}, "
                f"1st-percentile shape {before:.3f} -> {float(np.percentile(triangle_gamma(pts, tris), 1)):.3f} "
                f"({time.monotonic() - t0:.1f}s)"
            )
    gmsh.model.add("standard")
    order = np.argsort(groups, kind="stable")
    cuts = np.searchsorted(groups[order], np.arange(n_groups + 1))
    nodes_added = False
    for g in range(n_groups):
        idx = order[cuts[g]:cuts[g + 1]]
        if not len(idx):
            continue  # merged into a neighbour
        surf = gmsh.model.addDiscreteEntity(2)
        if not nodes_added:
            gmsh.model.mesh.addNodes(2, surf, np.arange(1, len(pts) + 1).tolist(), pts.ravel().tolist())
            nodes_added = True
        gmsh.model.mesh.addElementsByType(surf, 2, (idx + 1).tolist(), (tris[idx] + 1).ravel().tolist())
    gmsh.model.mesh.createTopology()
    # Patches of at most 5,000 triangles: gmsh's default (250,000) leaves a large
    # curved body in one piece whose parametrization it then spends minutes on
    # (309 s against 6 s for the surface mesh of a 118k-facet STL).
    gmsh.option.setNumber("Mesh.ReparamMaxTriangles", 5000)
    # Angle pi: no new feature split, the group boundaries are the curves; only
    # split what cannot be parametrized as one piece.
    gmsh.model.mesh.classifySurfaces(math.pi, True, True, math.pi)
    gmsh.model.mesh.createGeometry()
    face_to_tags: dict[int, list[int]] = {}
    surfaces = [int(t) for _d, t in gmsh.model.getEntities(2)]
    for tag in surfaces:
        _types, elem_tags, _nodes = gmsh.model.mesh.getElements(2, tag)
        if not len(elem_tags):
            continue
        rows = np.concatenate([np.asarray(e, dtype=np.int64) for e in elem_tags]) - 1
        rows = rows[(rows >= 0) & (rows < len(tris))]
        if not len(rows):
            continue
        g = int(np.bincount(groups[rows], minlength=n_groups).argmax())
        face_to_tags.setdefault(g, []).append(tag)
    for g, target in merged.items():
        face_to_tags[g] = list(face_to_tags.get(target, []))
    loop = gmsh.model.geo.addSurfaceLoop(surfaces)
    vol = gmsh.model.geo.addVolume([loop])
    gmsh.model.geo.synchronize()
    missing = [fid for fid in face_to_patch if fid not in face_to_tags]
    if missing:
        preview = ", ".join(str(f) for f in missing[:20])
        raise RuntimeError(
            f"Standard mesh: {len(missing)} surface(s) of the mesh import have no gmsh surface. "
            f"Missing face_ids: {preview}"
        )
    patch_tags: dict[str, list[int]] = {}
    for fid, pname in face_to_patch.items():
        tags = patch_tags.setdefault(pname, [])
        tags.extend(t for t in face_to_tags[fid] if t not in tags)
    return face_to_tags, patch_tags, [(3, int(vol))], 0.0


def surface_tags_of(face_to_tag: dict, fid: int) -> list[int]:
    """gmsh surface tags of CAD face ``fid`` (one for OCC CAD, one or more for a grouped mesh import)."""
    tag = face_to_tag.get(int(fid))
    if tag is None:
        return []
    return [int(t) for t in tag] if isinstance(tag, (list, tuple)) else [int(tag)]


def _inlet_outlet_surface_tags(project: Project, face_to_tag: dict[int, int]) -> tuple[list[int], list[int]]:
    inlet_tags: list[int] = []
    outlet_tags: list[int] = []
    bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
    for ep in emit_all_patches(project):
        bc = bc_by_id.get(ep.bc_id)
        semantic = ""
        if bc is not None:
            try:
                from cfddesk.case.bc_menu import registry_key_for_bc
                from cfddesk.case.bc_registry import get_type

                semantic = str(get_type(registry_key_for_bc(bc)).semantic).lower()
            except Exception:
                semantic = ""
        pname = ep.name.lower()
        for fid in ep.face_ids:
            tags = surface_tags_of(face_to_tag, fid)
            if semantic == "inlet" or pname in ("inlet", "velocity_inlet") or pname.startswith(
                "inlet_"
            ):
                inlet_tags.extend(tags)
            elif semantic == "outlet" or pname in (
                "outlet",
                "pressure_outlet",
            ) or pname.startswith("outlet_"):
                outlet_tags.extend(tags)
    return inlet_tags, outlet_tags


def coerce_gmsh_leftover_walls(boundary_path: Path) -> int:
    """gmshToFoam leftover ``defaultFaces`` are prism / CAD caps — they are walls.

    Wall functions require ``type wall``. Leaving them as ``patch`` aborts
    pimpleFoam / simpleFoam at RAS setup.
    """
    return apply_boundary_patch_types(Path(boundary_path), {"defaultFaces": "wall"})


# apply_boundary_patch_types is magnusim_sdk.gmsh_helpers' (imported above).


def emitted_patch_types(project: Project) -> dict[str, str]:
    """Map emitted patch name → OpenFOAM patch type (snappy-stage semantics)."""
    return {ep.name: ep.patch_type for ep in emit_all_patches(project)}
