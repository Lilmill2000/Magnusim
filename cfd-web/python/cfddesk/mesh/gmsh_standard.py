"""Standard (SimScale-style) meshing via gmsh BREP → MSH 2.2 for gmshToFoam.

v1: tetrahedral volume fill, no boundary layers, physics Distance fields for
inlet/outlet bias. Host-side gmsh; OpenFOAM conversion stays on WSL.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from cfddesk.cad.step import LoadedSolid
from cfddesk.mesh.patches import emit_all_patches
from cfddesk.project.model import Project
from cfddesk.project.settings import MeshRefinement


@dataclass(frozen=True)
class GmshHostResult:
    step_path: Path
    msh_path: Path
    n_nodes: int
    n_tets: int
    patch_surface_tags: dict[str, list[int]]
    log_text: str


@dataclass(frozen=True)
class GmshSurfaceResult:
    """OCC 2D surface mesh with Physical patch names (body-fit Phase 1)."""

    step_path: Path
    msh_path: Path
    n_nodes: int
    n_tris: int
    nodes: np.ndarray
    tris: np.ndarray
    tri_patch: tuple[str, ...]
    patch_surface_tags: dict[str, list[int]]
    watertight: bool
    log_text: str
    vertex_gate: object | None = field(default=None)


def write_scaled_step(solid: LoadedSolid, out_path: Path, *, scale_to_metres: float) -> Path:
    """Write a STEP of the solid scaled into metres (gmsh / OpenFOAM frame)."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.gp import gp_Trsf
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    s = float(scale_to_metres)
    if s <= 0:
        raise ValueError(f"invalid scale_to_metres={s}")
    shape = solid.shape
    if abs(s - 1.0) > 1e-15:
        trsf = gp_Trsf()
        trsf.SetScaleFactor(s)
        shape = BRepBuilderAPI_Transform(shape, trsf, True).Shape()
    writer = STEPControl_Writer()
    status = writer.Transfer(shape, STEPControl_AsIs)
    if int(status) == 0:
        raise RuntimeError("STEP transfer failed for Standard mesh geometry")
    wstat = writer.Write(str(out_path))
    if wstat != IFSelect_RetDone:
        raise RuntimeError(f"STEP write failed ({wstat}): {out_path}")
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
    for i, (fid, (tx, ty, tz)) in enumerate(targets):
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
    surface is used once.
    """
    pairs: list[tuple[float, float, int, int]] = []
    for fid, (tx, ty, tz), fa in targets:
        for tag, (cx, cy, cz), sa in surfaces:
            d = math.sqrt((cx - tx) ** 2 + (cy - ty) ** 2 + (cz - tz) ** 2)
            if d >= tol:
                continue
            ref = max(abs(fa), abs(sa), 1e-30)
            rel_area = abs(fa - sa) / ref
            pairs.append((rel_area, d, fid, tag))
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
        fid = _match_surface_tag(remaining, com, tol=tol)
        if fid is not None:
            out[fid] = tag
            used_tags.add(tag)
    return out


def run_gmsh_volume_mesh(
    solid: LoadedSolid,
    project: Project,
    *,
    step_path: Path,
    msh_path: Path,
    base_cell_m: float,
    refinement: MeshRefinement,
) -> GmshHostResult:
    """Import metres STEP, mesh volume, write ASCII MSH 2.2 with Physical groups."""
    try:
        import gmsh
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "Python package 'gmsh' is required for Standard meshing. "
            "Install with: pip install gmsh"
        ) from exc

    scale = float(project.scale_to_metres)
    lc = max(float(base_cell_m), 1e-6)
    emitted = emit_all_patches(project)
    if not emitted:
        raise RuntimeError("no emitted patches for Standard mesh")

    # Build face_id → patch name (extensive: one face per patch).
    face_to_patch: dict[int, str] = {}
    for ep in emitted:
        for fid in ep.face_ids:
            face_to_patch[int(fid)] = ep.name

    targets = [
        (fid, _face_centroid_m(solid, fid, scale)) for fid in face_to_patch
    ]
    # Matching tolerance: fraction of bbox diagonal, floored by a few cells.
    from cfddesk.cad.step import shape_diagonal

    diag_m = float(shape_diagonal(solid)) * scale
    match_tol = max(diag_m * 0.02, lc * 2.0, 1e-4)

    log_lines: list[str] = []
    # MeshWorker runs off the Qt main thread; gmsh's default interruptible=True
    # registers SIGINT handlers and raises ValueError in worker threads.
    gmsh.initialize(interruptible=False)
    try:
        gmsh.model.add("cfddesk_standard")
        gmsh.option.setNumber("General.Terminal", 1)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", lc)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", max(lc * 0.25, 1e-6))
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 20)
        # MSH 2.2 ASCII — required by OpenFOAM gmshToFoam.
        gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
        gmsh.option.setNumber("Mesh.Binary", 0)

        gmsh.model.occ.importShapes(str(step_path))
        gmsh.model.occ.synchronize()

        vols = gmsh.model.getEntities(3)
        surfs = gmsh.model.getEntities(2)
        if not vols:
            raise RuntimeError(
                "gmsh OCC import produced no volume — geometry may not be a closed solid"
            )
        if not surfs:
            raise RuntimeError("gmsh OCC import produced no surfaces")

        # Map each CAD face → gmsh surface tag via centroid match.
        face_to_tag: dict[int, int] = {}
        remaining = list(targets)
        for _dim, tag in surfs:
            com = gmsh.model.occ.getCenterOfMass(2, tag)
            fid = _match_surface_tag(
                remaining, (float(com[0]), float(com[1]), float(com[2])), tol=match_tol
            )
            if fid is not None:
                face_to_tag[fid] = int(tag)

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

        # Physical groups (names become OpenFOAM patches).
        for pname, tags in sorted(patch_tags.items()):
            pg = gmsh.model.addPhysicalGroup(2, tags)
            gmsh.model.setPhysicalName(2, pg, pname)
        vol_tags = [t for _d, t in vols]
        vpg = gmsh.model.addPhysicalGroup(3, vol_tags)
        gmsh.model.setPhysicalName(3, vpg, "internal")

        # Physics-based inlet/outlet size fields (v1) — use BC semantic, not name.
        inlet_tags: list[int] = []
        outlet_tags: list[int] = []
        bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
        for ep in emitted:
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
                tag = face_to_tag[int(fid)]
                if semantic == "inlet" or pname in ("inlet", "velocity_inlet") or pname.startswith(
                    "inlet_"
                ):
                    inlet_tags.append(tag)
                elif semantic == "outlet" or pname in (
                    "outlet",
                    "pressure_outlet",
                ) or pname.startswith("outlet_"):
                    outlet_tags.append(tag)

        field_ids: list[int] = []
        next_fid = 1

        def _threshold_for(surface_tags: list[int], level: int) -> int | None:
            nonlocal next_fid
            if not surface_tags:
                return None
            size_min = lc / (2 ** max(0, int(level)))
            dist_id = next_fid
            next_fid += 1
            thr_id = next_fid
            next_fid += 1
            gmsh.model.mesh.field.add("Distance", dist_id)
            gmsh.model.mesh.field.setNumbers(dist_id, "SurfacesList", surface_tags)
            gmsh.model.mesh.field.setNumber(dist_id, "Sampling", 100)
            gmsh.model.mesh.field.add("Threshold", thr_id)
            gmsh.model.mesh.field.setNumber(thr_id, "InField", dist_id)
            gmsh.model.mesh.field.setNumber(thr_id, "SizeMin", size_min)
            gmsh.model.mesh.field.setNumber(thr_id, "SizeMax", lc)
            gmsh.model.mesh.field.setNumber(thr_id, "DistMin", size_min)
            gmsh.model.mesh.field.setNumber(thr_id, "DistMax", lc * 4.0)
            return thr_id

        if project.mesh.physics_based:
            for tags, level in (
                (inlet_tags, refinement.inlet),
                (outlet_tags, refinement.outlet),
            ):
                tid = _threshold_for(tags, level)
                if tid is not None:
                    field_ids.append(tid)

        if field_ids:
            mid = next_fid
            gmsh.model.mesh.field.add("Min", mid)
            gmsh.model.mesh.field.setNumbers(mid, "FieldsList", field_ids)
            gmsh.model.mesh.field.setAsBackgroundMesh(mid)
            log_lines.append(f"physics_fields={field_ids} min={mid}")
        else:
            log_lines.append("physics_fields=none")

        gmsh.model.mesh.generate(3)
        msh_path = Path(msh_path)
        msh_path.parent.mkdir(parents=True, exist_ok=True)
        gmsh.write(str(msh_path))

        _, node_coords, _ = gmsh.model.mesh.getNodes()
        n_nodes = len(node_coords) // 3
        tet_types, tet_tags, _ = gmsh.model.mesh.getElements(3)
        n_tets = sum(len(t) for t in tet_tags) if tet_tags else 0
        log_lines.append(f"n_nodes={n_nodes}")
        log_lines.append(f"n_tets={n_tets}")
        log_lines.append(f"patches={sorted(patch_tags)}")
        log_lines.append(f"lc={lc}")
        log_lines.append(f"msh={msh_path}")
    finally:
        gmsh.finalize()

    return GmshHostResult(
        step_path=Path(step_path),
        msh_path=Path(msh_path),
        n_nodes=n_nodes,
        n_tets=n_tets,
        patch_surface_tags=patch_tags,
        log_text="\n".join(log_lines) + "\n",
    )


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
            tag = face_to_tag[int(fid)]
            if semantic == "inlet" or pname in ("inlet", "velocity_inlet") or pname.startswith(
                "inlet_"
            ):
                inlet_tags.append(tag)
            elif semantic == "outlet" or pname in (
                "outlet",
                "pressure_outlet",
            ) or pname.startswith("outlet_"):
                outlet_tags.append(tag)
    return inlet_tags, outlet_tags


def _add_distance_threshold(gmsh, surface_tags: list[int], size_min: float, lc: float, next_fid: int) -> tuple[int, int]:
    """Return (threshold_field_id, next_fid)."""
    dist_id = next_fid
    next_fid += 1
    thr_id = next_fid
    next_fid += 1
    gmsh.model.mesh.field.add("Distance", dist_id)
    gmsh.model.mesh.field.setNumbers(dist_id, "SurfacesList", surface_tags)
    gmsh.model.mesh.field.setNumber(dist_id, "Sampling", 100)
    gmsh.model.mesh.field.add("Threshold", thr_id)
    gmsh.model.mesh.field.setNumber(thr_id, "InField", dist_id)
    gmsh.model.mesh.field.setNumber(thr_id, "SizeMin", size_min)
    gmsh.model.mesh.field.setNumber(thr_id, "SizeMax", lc)
    gmsh.model.mesh.field.setNumber(thr_id, "DistMin", size_min)
    gmsh.model.mesh.field.setNumber(thr_id, "DistMax", lc * 4.0)
    return thr_id, next_fid


def _snap_open_vertices(
    nodes: np.ndarray,
    tris: np.ndarray,
    *,
    snap_tol: float,
) -> tuple[np.ndarray, np.ndarray, int]:
    """Merge nearby vertices that sit on unmatched (open) edges."""
    from collections import Counter

    from scipy.spatial import cKDTree

    tris = np.asarray(tris, dtype=np.int64)
    edges: list[tuple[int, int]] = []
    for a, b, c in tris:
        edges.append(tuple(sorted((int(a), int(b)))))
        edges.append(tuple(sorted((int(b), int(c)))))
        edges.append(tuple(sorted((int(c), int(a)))))
    open_verts = sorted(
        {v for e, n in Counter(edges).items() if n == 1 for v in e}
    )
    if len(open_verts) < 2:
        return nodes, tris, 0
    idx = np.asarray(open_verts, dtype=np.int64)
    tree = cKDTree(np.asarray(nodes[idx], dtype=float))
    parent = {int(i): int(i) for i in idx}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    nmerge = 0
    for i, j in tree.query_pairs(float(snap_tol)):
        a, b = find(int(idx[i])), find(int(idx[j]))
        if a != b:
            parent[b] = a
            nmerge += 1
    if not nmerge:
        return nodes, tris, 0
    remap = np.arange(len(nodes), dtype=np.int64)
    for i in idx:
        remap[int(i)] = find(int(i))
    return nodes, remap[tris], nmerge


def _unique_triangles(
    tris: np.ndarray, face_ids: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Drop duplicate triangles (same vertex set)."""
    seen: set[tuple[int, int, int]] = set()
    keep_t: list[np.ndarray] = []
    keep_f: list[int] = []
    for t, fid in zip(np.asarray(tris, dtype=np.int64), face_ids):
        key = (int(t[0]), int(t[1]), int(t[2]))
        skey = tuple(sorted(key))
        if skey in seen:
            continue
        seen.add(skey)  # type: ignore[arg-type]
        keep_t.append(t)
        keep_f.append(int(fid))
    if not keep_t:
        return np.zeros((0, 3), dtype=np.int64), np.zeros((0,), dtype=np.int64)
    return np.vstack(keep_t), np.asarray(keep_f, dtype=np.int64)


def _fill_boundary_loops(
    nodes: np.ndarray,
    tris: np.ndarray,
    face_ids: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Fan-fill every open boundary loop."""
    from collections import Counter, defaultdict

    tris = np.asarray(tris, dtype=np.int64)
    face_ids = np.asarray(face_ids, dtype=np.int64)
    edges: list[tuple[int, int]] = []
    edge_face: dict[tuple[int, int], int] = {}
    for ti, (a, b, c) in enumerate(tris):
        fid = int(face_ids[ti])
        for u, v in ((int(a), int(b)), (int(b), int(c)), (int(c), int(a))):
            key = tuple(sorted((u, v)))
            edges.append(key)  # type: ignore[arg-type]
            edge_face.setdefault(key, fid)  # type: ignore[arg-type]
    open_e = [e for e, n in Counter(edges).items() if n == 1]
    if not open_e:
        return nodes, tris, face_ids, 0

    adj: dict[int, list[int]] = defaultdict(list)
    for a, b in open_e:
        adj[a].append(b)
        adj[b].append(a)

    seen: set[int] = set()
    new_tris: list[list[int]] = []
    new_fids: list[int] = []
    for start in list(adj):
        if start in seen:
            continue
        path = [start]
        seen.add(start)
        prev = None
        cur = start
        while True:
            nxts = [n for n in adj[cur] if n != prev]
            if not nxts:
                break
            nxt = nxts[0]
            path.append(nxt)
            if nxt in seen:
                break
            seen.add(nxt)
            prev, cur = cur, nxt
        verts = path[:-1] if len(path) > 1 and path[0] == path[-1] else path
        if len(verts) < 3:
            continue
        fid = edge_face.get(tuple(sorted((verts[0], verts[1]))), 0)
        v0 = int(verts[0])
        for i in range(1, len(verts) - 1):
            new_tris.append([v0, int(verts[i]), int(verts[i + 1])])
            new_fids.append(int(fid))
    if not new_tris:
        return nodes, tris, face_ids, 0
    tris = np.vstack([tris, np.asarray(new_tris, dtype=np.int64)])
    face_ids = np.concatenate([face_ids, np.asarray(new_fids, dtype=np.int64)])
    return nodes, tris, face_ids, len(new_tris)


def _occt_full_surface_mesh(
    solid: LoadedSolid,
    project: "Project",
    *,
    lc_m: float,
    scale: float,
    msh_path: Path,
    log_lines: list[str],
    write_msh: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Whole-shape OCCT tessellation + weld/snap/heal. Skips gmsh on huge CAD."""
    from cfddesk.cad.step import shape_diagonal, tessellate_faces
    from cfddesk.mesh.cfmesh_standard import _weld_and_drop_degenerate

    lc = max(float(lc_m), 1e-6)
    diag_native = float(shape_diagonal(solid))
    diag_m = diag_native * float(scale)
    # Same recipe that closed V12 (0 open edges): ~0.523 mm native
    # deflection, stitch from ~3.5 mm, snap/heal, keep final slivers.
    lin = max(diag_native * 0.005905, 1e-12)
    stitch_lc = max(diag_m * 0.0394, 0.0034)
    weld_tol = max(1e-9, stitch_lc * 5e-3)
    pts_n, tris, fids = tessellate_faces(
        solid, linear_deflection=lin, angular_deflection=0.25
    )
    nodes = np.asarray(pts_n, dtype=float) * float(scale)
    fids = np.asarray(fids, dtype=np.int64)
    nodes, tris, fids = _weld_and_drop_degenerate(
        nodes, tris, tol=weld_tol, face_ids=fids
    )
    log_lines.append(
        f"occt_full_surface n_faces={len(solid.faces)} lin_native={lin:.6g} "
        f"stitch_lc={stitch_lc:.6g} n_tris={len(tris)} weld_tol={weld_tol:.6g}"
    )

    for snap_frac in (0.04, 0.12, 0.25):
        if surface_mesh_watertight(tris):
            break
        snap_tol = max(weld_tol * 4.0, stitch_lc * snap_frac)
        nodes, tris, nsnap = _snap_open_vertices(nodes, tris, snap_tol=snap_tol)
        if nsnap:
            nodes, tris, fids = _weld_and_drop_degenerate(
                nodes, tris, tol=weld_tol, face_ids=fids
            )
            log_lines.append(f"occt_snap frac={snap_frac} merged={nsnap}")
        nodes, tris, fids, healed = _heal_open_triangle_holes(
            nodes, tris, fids, max_edge_m=max(stitch_lc * 6.0, snap_tol * 4.0)
        )
        if healed:
            nodes, tris, fids = _weld_and_drop_degenerate(
                nodes, tris, tol=weld_tol, face_ids=fids
            )
            log_lines.append(f"occt_holes_healed={healed}")

    if not surface_mesh_watertight(tris):
        nodes, tris, fids, healed = _heal_open_triangle_holes(
            nodes, tris, fids, max_edge_m=1.0, max_passes=16, strict=False
        )
        if healed:
            log_lines.append(f"occt_holes_final={healed}")

    if write_msh:
        from cfddesk.mesh.msh22 import TRI, write_msh22

        face_to_patch = _face_to_patch_map(project)
        patch_names = sorted({p for p in face_to_patch.values() if p})
        name_to_tag = {name: i + 1 for i, name in enumerate(patch_names)}
        phys = {tag: (2, name) for name, tag in name_to_tag.items()}
        boundary = []
        for tri, fid in zip(tris, fids):
            pname = face_to_patch.get(int(fid), "")
            ptag = name_to_tag.get(pname, 1)
            boundary.append((TRI, tri, ptag, pname))
        write_msh22(
            Path(msh_path),
            nodes,
            volume_cells=[],
            boundary_faces=boundary,
            physical_names=phys or {1: (2, "walls")},
        )
    return nodes, tris, fids


def _heal_open_triangle_holes(
    nodes: np.ndarray,
    tris: np.ndarray,
    face_ids: np.ndarray,
    *,
    max_edge_m: float,
    max_passes: int = 8,
    strict: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Add missing triangles when three open edges close a small hole."""
    from collections import Counter, defaultdict

    tris = np.asarray(tris, dtype=np.int64)
    face_ids = np.asarray(face_ids, dtype=np.int64)
    healed_total = 0

    for _ in range(max_passes):
        edge_count: Counter = Counter()
        edge_face: dict[tuple[int, int], int] = {}
        for ti, (a, b, c) in enumerate(tris):
            fid = int(face_ids[ti])
            for u, v in ((a, b), (b, c), (c, a)):
                key = tuple(sorted((int(u), int(v))))
                edge_count[key] += 1
                edge_face.setdefault(key, fid)

        open_set = {e for e, n in edge_count.items() if n == 1}
        if not open_set:
            break

        by_v: dict[int, set[int]] = defaultdict(set)
        for a, b in open_set:
            by_v[int(a)].add(int(b))
            by_v[int(b)].add(int(a))

        new_tris: list[list[int]] = []
        new_fids: list[int] = []
        used_keys: set[tuple[int, int, int]] = set()

        for e1 in open_set:
            a, b = int(e1[0]), int(e1[1])
            for c in by_v[a]:
                if c == b:
                    continue
                e2 = tuple(sorted((b, c)))
                e3 = tuple(sorted((c, a)))
                if e2 not in open_set or e3 not in open_set:
                    continue
                key = tuple(sorted((a, b, c)))
                if key in used_keys:
                    continue
                pa, pb, pc = nodes[a], nodes[b], nodes[c]
                elen = max(
                    float(np.linalg.norm(pb - pa)),
                    float(np.linalg.norm(pc - pb)),
                    float(np.linalg.norm(pa - pc)),
                )
                if strict and elen > max_edge_m:
                    continue
                area = 0.5 * float(np.linalg.norm(np.cross(pb - pa, pc - pa)))
                if strict and area <= 0:
                    continue
                new_tris.append([a, b, c])
                fid = edge_face.get(e1, edge_face.get(e2, edge_face.get(e3, 0)))
                new_fids.append(int(fid))
                used_keys.add(key)

        # 4-cycles of open edges (quad holes IncrementalMesh leaves at seams).
        if not new_tris:
            verts = sorted({v for e in open_set for v in e})
            if len(verts) >= 4:
                for i, a in enumerate(verts):
                    na = by_v.get(a, set())
                    if len(na) != 2:
                        continue
                    n1, n2 = tuple(na)
                    mid = (by_v.get(n1, set()) & by_v.get(n2, set())) - {a}
                    if len(mid) != 1:
                        continue
                    d = next(iter(mid))
                    key = tuple(sorted((a, n1, n2, d)))
                    if key in used_keys:
                        continue
                    used_keys.add(key)
                    pa, pb, pc, pd = nodes[a], nodes[n1], nodes[n2], nodes[d]
                    # Split on the shorter diagonal.
                    d_ac = float(np.linalg.norm(pc - pb))  # n1-n2
                    d_ad = float(np.linalg.norm(pd - pa))  # a-d
                    if d_ad <= d_ac:
                        new_tris.extend([[a, n1, d], [a, d, n2]])
                    else:
                        new_tris.extend([[a, n1, n2], [n1, d, n2]])
                    fid = edge_face.get(tuple(sorted((a, n1))), 0)
                    new_fids.extend([int(fid), int(fid)])

        if not new_tris:
            break
        tris = np.vstack([tris, np.asarray(new_tris, dtype=np.int64)])
        face_ids = np.concatenate([face_ids, np.asarray(new_fids, dtype=np.int64)])
        healed_total += len(new_tris)

    return nodes, tris, face_ids, healed_total


def _count_open_edges(tris: np.ndarray) -> int:
    from collections import Counter

    edges: list[tuple[int, int]] = []
    for a, b, c in np.asarray(tris, dtype=np.int64):
        edges.append(tuple(sorted((int(a), int(b)))))
        edges.append(tuple(sorted((int(b), int(c)))))
        edges.append(tuple(sorted((int(c), int(a)))))
    return int(sum(1 for n in Counter(edges).values() if n != 2))


def surface_mesh_watertight(tris: np.ndarray) -> bool:
    """Every edge appears on exactly two triangles."""
    if tris.size == 0:
        return False
    from collections import Counter

    edges: list[tuple[int, int]] = []
    for a, b, c in np.asarray(tris, dtype=np.int64):
        edges.append(tuple(sorted((int(a), int(b)))))  # type: ignore[arg-type]
        edges.append(tuple(sorted((int(b), int(c)))))  # type: ignore[arg-type]
        edges.append(tuple(sorted((int(c), int(a)))))  # type: ignore[arg-type]
    # Closed = no boundary. Count 4 (duplicate faces) is OK for hex flood;
    # IncrementalMesh stitch on huge CAD often leaves a few overlapping tris.
    return not any(n == 1 for n in Counter(edges).values())


def _empty_gmsh_surface_tags(gmsh) -> list[int]:
    """Surface tags gmsh left with zero 2D elements."""
    empty: list[int] = []
    for _dim, tag in gmsh.model.getEntities(2):
        _etypes, etags, _conn = gmsh.model.mesh.getElements(2, tag)
        if sum(len(t) for t in etags) == 0:
            empty.append(int(tag))
    return empty


def _extract_gmsh_tris(
    gmsh,
    *,
    tag_to_face: dict[int, int],
    tag_to_idx: dict[int, int],
    nodes_all: np.ndarray,
    skip_face_ids: set[int] | None = None,
) -> tuple[list[list[int]], list[int], set[int]]:
    """Pull triangle rows + CAD face_id per triangle from a meshed gmsh model."""
    skip = skip_face_ids or set()
    tri_rows: list[list[int]] = []
    face_ids: list[int] = []
    used: set[int] = set()
    for _dim, tag in gmsh.model.getEntities(2):
        fid = tag_to_face.get(int(tag))
        if fid is None or int(fid) in skip:
            continue
        etypes, _etags, conn = gmsh.model.mesh.getElements(2, tag)
        for etype, cflat in zip(etypes, conn):
            cflat = np.asarray(cflat, dtype=np.int64)
            if int(etype) == 2:  # triangle
                npp = 3
            elif int(etype) == 3:  # quad -> two tris
                for q in cflat.reshape(-1, 4):
                    ia, ib, ic, id_ = (tag_to_idx[int(x)] for x in q)
                    tri_rows.append([ia, ib, ic])
                    tri_rows.append([ia, ic, id_])
                    face_ids.extend([fid, fid])
                    used.update((ia, ib, ic, id_))
                continue
            else:
                continue
            for row in cflat.reshape(-1, npp):
                ids = [tag_to_idx[int(x)] for x in row]
                tri_rows.append(ids)
                face_ids.append(fid)
                used.update(ids)
    return tri_rows, face_ids, used


_PERIODIC_SURFACE_TYPES = frozenset({"Cylinder", "Torus", "Sphere"})


def _occt_fallback_tris(
    solid: LoadedSolid,
    *,
    empty_tags: list[int],
    tag_to_face: dict[int, int],
    lc_m: float,
    scale: float,
    node_offset: int,
    log_lines: list[str],
    also_face_ids: set[int] | None = None,
) -> tuple[np.ndarray, np.ndarray, list[int]]:
    """Fill gmsh-empty / periodic CAD faces with per-face OCCT IncrementalMesh."""
    from cfddesk.cad.step import tessellate_single_face_robust

    face_by_id = {rec.face_id: rec for rec in solid.faces}
    lc_native = max(float(lc_m) / float(scale), 1e-15)
    lin_def = max(lc_native * 0.1, 1e-12)
    ang_def = 0.35

    wanted: set[int] = set(also_face_ids or ())
    for tag in empty_tags:
        fid = tag_to_face.get(int(tag))
        if fid is not None:
            wanted.add(int(fid))

    point_blocks: list[np.ndarray] = []
    tri_blocks: list[np.ndarray] = []
    face_ids: list[int] = []
    offset = int(node_offset)

    for fid in sorted(wanted):
        rec = face_by_id.get(fid)
        if rec is None:
            log_lines.append(f"occt_fallback skip face={fid} (missing on solid)")
            continue
        try:
            pts_n, tris_n = tessellate_single_face_robust(
                rec.face,
                linear_deflection=lin_def,
                face_area_native=float(rec.area),
                angular_deflection=ang_def,
            )
        except RuntimeError as exc:
            log_lines.append(f"occt_fallback FAIL face={fid}: {exc}")
            continue
        pts_m = pts_n * float(scale)
        tris_g = tris_n + offset
        point_blocks.append(pts_m)
        tri_blocks.append(tris_g)
        face_ids.extend([int(fid)] * len(tris_n))
        log_lines.append(
            f"occt_fallback face={fid} type={rec.surface_type} "
            f"n_tris={len(tris_n)} lin_native={lin_def:.6g}"
        )
        offset += len(pts_m)

    if not point_blocks:
        return (
            np.zeros((0, 3), dtype=float),
            np.zeros((0, 3), dtype=np.int64),
            [],
        )
    return np.vstack(point_blocks), np.vstack(tri_blocks), face_ids


def run_gmsh_surface_mesh(
    solid: LoadedSolid,
    project: Project,
    *,
    step_path: Path,
    msh_path: Path,
    lc_m: float,
    refinement: MeshRefinement,
    extra_face_sizes: dict[int, float] | None = None,
) -> GmshSurfaceResult:
    """OCC 2D mesh. Vertices stay on BREP; Physical names match emit_all_patches."""
    try:
        import gmsh
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "Python package 'gmsh' is required for Standard meshing. "
            "Install with: pip install gmsh"
        ) from exc

    scale = float(project.scale_to_metres)
    lc = max(float(lc_m), 1e-6)
    extra_face_sizes = extra_face_sizes or {}
    log_lines: list[str] = []
    msh_path = Path(msh_path)
    msh_path.parent.mkdir(parents=True, exist_ok=True)
    face_to_patch = _face_to_patch_map(project)

    # Huge CAD: gmsh 1D+periodic faces take hours and still leave holes.
    # OCCT IncrementalMesh of the whole solid is seconds and stitchable.
    if len(solid.faces) >= 2000:
        nodes, tris, all_face_ids = _occt_full_surface_mesh(
            solid,
            project,
            lc_m=lc,
            scale=scale,
            msh_path=msh_path,
            log_lines=log_lines,
            write_msh=False,
        )
        tri_names = tuple(
            face_to_patch.get(int(fid), "") for fid in all_face_ids.tolist()
        )
        watertight = surface_mesh_watertight(tris)
        log_lines.append(f"n_nodes={len(nodes)}")
        log_lines.append(f"n_tris={len(tris)}")
        log_lines.append(f"watertight={watertight}")
        log_lines.append(f"patches={sorted(set(face_to_patch.values()))}")
        log_lines.append(f"lc={lc}")
        log_lines.append(f"msh={msh_path}")
        return GmshSurfaceResult(
            step_path=Path(step_path),
            msh_path=msh_path,
            n_nodes=int(len(nodes)),
            n_tris=int(len(tris)),
            nodes=nodes,
            tris=tris,
            tri_patch=tri_names,
            patch_surface_tags={},
            watertight=bool(watertight),
            log_text="\n".join(log_lines) + "\n",
        )

    gmsh.initialize(interruptible=False)
    try:
        gmsh.model.add("cfddesk_surface")
        gmsh.option.setNumber("General.Terminal", 1)
        gmsh.option.setNumber("General.AbortOnError", 0)
        gmsh.option.setNumber("Mesh.IgnorePeriodicity", 1)
        gmin = lc * 0.25
        if extra_face_sizes:
            gmin = min(gmin, min(float(v) for v in extra_face_sizes.values()))
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", lc)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", max(gmin, 1e-6))
        if len(solid.faces) >= 2000:
            gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
            log_lines.append("curvature_refinement=off (large_model)")
        else:
            gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 20)
        gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
        gmsh.option.setNumber("Mesh.Binary", 0)

        gmsh.model.occ.importShapes(str(step_path))
        gmsh.model.occ.synchronize()
        face_to_tag, patch_tags, vols, match_tol = _match_occ_surfaces(
            gmsh, solid, project, scale=scale, lc=lc
        )
        log_lines.append(f"match_tol={match_tol:.6g}")

        for pname, tags in sorted(patch_tags.items()):
            pg = gmsh.model.addPhysicalGroup(2, tags)
            gmsh.model.setPhysicalName(2, pg, pname)
        vol_tags = [t for _d, t in vols]
        vpg = gmsh.model.addPhysicalGroup(3, vol_tags)
        gmsh.model.setPhysicalName(3, vpg, "internal")

        field_ids: list[int] = []
        next_fid = 1
        inlet_tags, outlet_tags = _inlet_outlet_surface_tags(project, face_to_tag)
        if project.mesh.physics_based:
            for tags, level in (
                (inlet_tags, refinement.inlet),
                (outlet_tags, refinement.outlet),
            ):
                if not tags:
                    continue
                size_min = lc / (2 ** max(0, int(level)))
                tid, next_fid = _add_distance_threshold(
                    gmsh, tags, size_min, lc, next_fid
                )
                field_ids.append(tid)

        # Gap / thin-wall faces: local surface size (body-fit Phase 5).
        gap_groups: dict[float, list[int]] = {}
        for fid, sz in extra_face_sizes.items():
            tag = face_to_tag.get(int(fid))
            if tag is None:
                continue
            gap_groups.setdefault(round(float(sz), 9), []).append(int(tag))
        for sz, tags in gap_groups.items():
            tid, next_fid = _add_distance_threshold(
                gmsh, tags, max(float(sz), 1e-6), lc, next_fid
            )
            field_ids.append(tid)
            log_lines.append(f"gap_field size={sz:.6g} n_surf={len(tags)}")

        if field_ids:
            mid = next_fid
            gmsh.model.mesh.field.add("Min", mid)
            gmsh.model.mesh.field.setNumbers(mid, "FieldsList", field_ids)
            gmsh.model.mesh.field.setAsBackgroundMesh(mid)
            log_lines.append(f"physics_fields={field_ids} min={mid}")
        else:
            log_lines.append("physics_fields=none")

        gmsh.model.mesh.generate(2)
        msh_path = Path(msh_path)
        msh_path.parent.mkdir(parents=True, exist_ok=True)
        gmsh.write(str(msh_path))

        node_tags, coords, _ = gmsh.model.mesh.getNodes()
        node_tags = np.asarray(node_tags, dtype=np.int64)
        nodes_all = np.asarray(coords, dtype=float).reshape(-1, 3)
        tag_to_idx = {int(t): i for i, t in enumerate(node_tags)}
        tag_to_face = {int(tag): int(fid) for fid, tag in face_to_tag.items()}
        face_to_patch = _face_to_patch_map(project)
        large_model = len(solid.faces) >= 2000
        periodic_face_ids = {
            int(rec.face_id)
            for rec in solid.faces
            if rec.surface_type in _PERIODIC_SURFACE_TYPES
        }
        if large_model and periodic_face_ids:
            log_lines.append(f"occt_periodic_faces={len(periodic_face_ids)}")

        tri_rows, face_ids, used = _extract_gmsh_tris(
            gmsh,
            tag_to_face=tag_to_face,
            tag_to_idx=tag_to_idx,
            nodes_all=nodes_all,
            skip_face_ids=periodic_face_ids if large_model else None,
        )
        empty_tags = _empty_gmsh_surface_tags(gmsh)
        if empty_tags:
            log_lines.append(f"gmsh_empty_surfaces={len(empty_tags)}")

        if not tri_rows and not empty_tags and not periodic_face_ids:
            raise RuntimeError("gmsh surface mesh produced no triangles")

        used_list = sorted(used)
        remap = {old: new for new, old in enumerate(used_list)}
        gmsh_nodes = nodes_all[used_list]
        gmsh_tris = np.asarray(
            [[remap[i] for i in row] for row in tri_rows], dtype=np.int64
        )
        gmsh_face_ids = list(face_ids)

        occt_nodes, occt_tris, occt_face_ids = _occt_fallback_tris(
            solid,
            empty_tags=empty_tags,
            tag_to_face=tag_to_face,
            lc_m=lc,
            scale=scale,
            node_offset=len(gmsh_nodes),
            log_lines=log_lines,
            also_face_ids=periodic_face_ids if large_model else None,
        )

        if len(occt_nodes):
            nodes = np.vstack([gmsh_nodes, occt_nodes])
            tris = np.vstack([gmsh_tris, occt_tris])
            all_face_ids = np.asarray(gmsh_face_ids + occt_face_ids, dtype=np.int64)
        else:
            nodes = gmsh_nodes
            tris = gmsh_tris
            all_face_ids = np.asarray(gmsh_face_ids, dtype=np.int64)

        if len(tris):
            from cfddesk.mesh.cfmesh_standard import _weld_and_drop_degenerate

            weld_tol = max(1e-9, lc * 1e-4)
            if empty_tags:
                weld_tol = max(weld_tol, lc * 5e-3)
            nodes, tris, all_face_ids = _weld_and_drop_degenerate(
                nodes,
                tris,
                tol=weld_tol,
                face_ids=all_face_ids,
            )
            log_lines.append(f"surface_weld_tol={weld_tol:.6g}")
            if not surface_mesh_watertight(tris):
                nodes, tris, all_face_ids, healed = _heal_open_triangle_holes(
                    nodes,
                    tris,
                    all_face_ids,
                    max_edge_m=max(lc * 4.0, 1e-6),
                )
                if healed:
                    log_lines.append(f"surface_holes_healed={healed}")
                    nodes, tris, all_face_ids = _weld_and_drop_degenerate(
                        nodes,
                        tris,
                        tol=weld_tol,
                        face_ids=all_face_ids,
                    )

        tri_names = tuple(
            face_to_patch.get(int(fid), "") for fid in all_face_ids.tolist()
        )
        watertight = surface_mesh_watertight(tris)
        log_lines.append(f"n_nodes={len(nodes)}")
        log_lines.append(f"n_tris={len(tris)}")
        log_lines.append(f"watertight={watertight}")
        log_lines.append(f"patches={sorted(patch_tags)}")
        log_lines.append(f"lc={lc}")
        log_lines.append(f"msh={msh_path}")
    finally:
        gmsh.finalize()

    return GmshSurfaceResult(
        step_path=Path(step_path),
        msh_path=Path(msh_path),
        n_nodes=int(len(nodes)),
        n_tris=int(len(tris)),
        nodes=nodes,
        tris=tris,
        tri_patch=tri_names,
        patch_surface_tags=patch_tags,
        watertight=bool(watertight),
        log_text="\n".join(log_lines) + "\n",
    )


def parse_patch_types_txt(path: Path) -> dict[str, str]:
    """Parse ``name type`` lines from ``constant/triSurface/patch_types.txt``."""
    out: dict[str, str] = {}
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            out[parts[0]] = parts[1]
    return out


def apply_patch_types_from_txt(boundary_path: Path, types_txt: Path) -> int:
    """Rewrite polyMesh/boundary types from the mesher's patch_types.txt."""
    return apply_boundary_patch_types(boundary_path, parse_patch_types_txt(types_txt))


def apply_boundary_patch_types(boundary_path: Path, patch_types: dict[str, str]) -> int:
    """Rewrite ``type`` lines in polyMesh/boundary for known patch names.

    Returns the number of patches whose type was changed.
    """
    path = Path(boundary_path)
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines(keepends=True)
    changed = 0
    current: str | None = None
    out: list[str] = []
    skip_names = {"FoamFile", "version", "format", "arch", "class", "location", "object"}
    name_re = re.compile(r"^\s*([A-Za-z_]\w*)\s*$")
    type_re = re.compile(r"^(\s*type\s+)\S+(\s*;.*)$")
    for line in lines:
        raw = line.rstrip("\r\n")
        m_name = name_re.match(raw)
        if m_name and m_name.group(1) not in skip_names:
            current = m_name.group(1)
            out.append(line)
            continue
        stripped = raw.strip()
        if stripped == "}":
            current = None
            out.append(line)
            continue
        if current and current in patch_types:
            m_type = type_re.match(raw)
            if m_type:
                want = patch_types[current]
                nl = "\n" if line.endswith("\n") else ""
                new_line = f"{m_type.group(1)}{want}{m_type.group(2)}{nl}"
                if new_line.rstrip("\n") != raw:
                    changed += 1
                out.append(new_line)
                continue
        out.append(line)
    path.write_bytes("".join(out).replace("\r\n", "\n").encode("utf-8"))
    return changed


def emitted_patch_types(project: Project) -> dict[str, str]:
    """Map emitted patch name → OpenFOAM patch type (snappy-stage semantics)."""
    return {ep.name: ep.patch_type for ep in emit_all_patches(project)}
