"""Standard + Hex element core via cfMesh ``cartesianMesh``.

Replaces the old gmsh inscribed-box hexcore. Produces native OpenFOAM
polyMesh (bulk Cartesian hex + polyhedra near walls/size jumps).

SimScale docs describe pyr+tet transition; cfMesh uses polyhedra instead —
documented in ``runs/phase5c/SIMSCALE-HEXCORE-RESEARCH.md``.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from cfddesk.cad.step import LoadedSolid, tessellate_faces
from cfddesk.cad.stl_quality import stl_deflection_for_bc
from cfddesk.mesh.patches import emit_all_patches
from cfddesk.project.model import Project

# Keep STL edges ≤ wall/skin cell so cartesianMesh can resolve barrels / cones
# (OCCT IncrementalMesh emits full-height cylinder slivers otherwise).
# Floor ~8 mm: ultra-fine STL flattens smooth-cone dihedrals → 0 corners.
# Cap 12 mm: 15 mm (previous coarse path) regressed cone p95 to ~8 mm / 0 corners.
_MAX_EDGE_FRAC_OF_BCS = 1.0  # edge ≤ sizing input (prefer skin cell)
_MAX_EDGE_HARD_CAP_M = 0.012
_MIN_EDGE_FLOOR_M = 0.006  # was 8 mm; Fine skin ~3 mm needs finer STL without floor fight
_FEATURE_EDGE_ANGLE_DEG = 30.0  # 45° missed corners on Coarse STL

# Visible fine poly skin then hex bulk — LOCKED recipe.
#
# Do not thrash these knobs independently; they fight each other:
# - Deep localRef (thickness ≥ 3×skin or ".*") → ~9-layer / volume flood
# - minCellSize = skin with no localRef → peel only on curved walls (flat
#   shoulders look bare); cone body-fit weak on Coarse
# - STL edge from boundary (=max/2) → hits 12–15 mm cap → cone gaps / 0 corners
#
# Working combo (thin peel on ALL walls + body-fit):
# - bulk boundary = max/2, minCellSize = bulk (no global flood)
# - localRefinement walls only, cellSize = skin (=max/4), thickness = 1×skin
# - STL edge ≈ skin (8–12 mm) + surfaceFeatureEdges → .fms + keepCells
_SKIN_LAYERS = 0.5  # localRef thickness ≈ half-skin → ~2–3 skin-sized elements
_BULK_CELL_FRAC_OF_MAX = 0.5
_SKIN_CELL_FRAC_OF_MAX = 0.25
# Keep bulk-size zone shallow so the peel stays ~3 cells, not a deep ramp.
_BOUNDARY_THICKNESS_LAYERS = 1.0
# Skip walls localRef when skin < 4 mm (Fine only). Standard keeps a thin
# walls localRef so flat shoulders get a ~3-cell peel; Fine body-fit comes from
# small boundaryCellSize + STL + face-split edges.
_LOCALREF_MIN_SKIN_M = 0.004
# Face-split pins CAD edges. Edge refine uses cellSize=skin (not deep levels)
# so Fine keeps edge adherence without a 6-layer peel.
_EDGE_THICK_FRAC_OF_SKIN = 1.0


def sizing_from_base_cell(base_cell_m: float) -> tuple[float, float, float]:
    """Map fineness → (maxCellSize, boundaryCellSize, skinCellSize).

    - max: octree root cap
    - boundary: visual hex-core / bulk cell (≈ max/2)
    - skin: fine near-wall peel via walls localRef (≈ max/4)
    """
    max_cell = max(float(base_cell_m), 1e-6)
    boundary = max(max_cell * _BULK_CELL_FRAC_OF_MAX, 1e-6)
    skin = max(max_cell * _SKIN_CELL_FRAC_OF_MAX, 1e-6)
    return max_cell, boundary, skin


def skin_thickness_m(skin_cell_m: float, *, layers: float = _SKIN_LAYERS) -> float:
    """localRefinement thickness: ``layers × skin`` (default 1×)."""
    return max(float(skin_cell_m), 1e-6) * max(float(layers), 0.5)


def max_stl_edge_m(sizing_cell_m: float) -> float:
    """Max allowed STL edge length (metres) for cfMesh body-fit.

    Pass the *skin* cell (not bulk boundary): coarse used to pass boundary=max/2
    which hit the old 15 mm cap and lost cone body-fit / corners.
    """
    cell = max(float(sizing_cell_m), 1e-6)
    target = cell * _MAX_EDGE_FRAC_OF_BCS
    return min(_MAX_EDGE_HARD_CAP_M, max(_MIN_EDGE_FLOOR_M, target))


def refine_triangles_max_edge(
    points: np.ndarray,
    tris: np.ndarray,
    max_edge: float,
    *,
    max_rounds: int = 24,
) -> tuple[np.ndarray, np.ndarray]:
    """Subdivide triangles until every edge length ≤ ``max_edge``.

    Kills OCCT full-height cylinder/cone slivers by inserting mid-edge vertices
    (including mid-height points on barrels).
    """
    max_edge = float(max_edge)
    if max_edge <= 0:
        raise ValueError("max_edge must be > 0")
    pts = [np.asarray(p, dtype=np.float64) for p in points]
    faces = [tuple(int(i) for i in t) for t in tris]
    if not faces:
        return np.asarray(points, dtype=np.float64), np.asarray(tris, dtype=np.int64)

    edge_mid: dict[tuple[int, int], int] = {}

    def midpoint(i: int, j: int) -> int:
        key = (i, j) if i < j else (j, i)
        mid = edge_mid.get(key)
        if mid is not None:
            return mid
        mid = len(pts)
        pts.append(0.5 * (pts[i] + pts[j]))
        edge_mid[key] = mid
        return mid

    for _ in range(max_rounds):
        new_faces: list[tuple[int, int, int]] = []
        split_any = False
        for a, b, c in faces:
            lab = float(np.linalg.norm(pts[a] - pts[b]))
            lbc = float(np.linalg.norm(pts[b] - pts[c]))
            lca = float(np.linalg.norm(pts[c] - pts[a]))
            if lab <= max_edge and lbc <= max_edge and lca <= max_edge:
                new_faces.append((a, b, c))
                continue
            split_any = True
            # Always bisect the single longest edge (Rivara). Prefer this over
            # 4-way splits so full-height cylinder needles refine along the
            # generator without combinatorial explosion.
            if lab >= lbc and lab >= lca:
                m = midpoint(a, b)
                new_faces.extend(((a, m, c), (m, b, c)))
            elif lbc >= lab and lbc >= lca:
                m = midpoint(b, c)
                new_faces.extend(((a, b, m), (a, m, c)))
            else:
                m = midpoint(c, a)
                new_faces.extend(((a, b, m), (m, b, c)))
        faces = new_faces
        if not split_any:
            break
    else:
        worst = 0.0
        for a, b, c in faces:
            for i, j in ((a, b), (b, c), (c, a)):
                worst = max(worst, float(np.linalg.norm(pts[i] - pts[j])))
        if worst > max_edge * 1.01:
            raise RuntimeError(
                f"STL edge refine failed: max edge {worst:.6g} m still > "
                f"limit {max_edge:.6g} m after {max_rounds} rounds"
            )

    return _weld_and_drop_degenerate(
        np.asarray(pts, dtype=np.float64),
        np.asarray(faces, dtype=np.int64),
        tol=max(1e-9, max_edge * 1e-4),
    )


def _weld_and_drop_degenerate(
    points: np.ndarray,
    tris: np.ndarray,
    *,
    tol: float,
    face_ids: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray] | tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Merge near-duplicate vertices and drop zero-area / collapsed triangles.

    cfMesh aborts on duplicated-point triangles (quadricFitting FATAL).
    When ``face_ids`` is provided (one per input tri), returns a third array of
    kept face ids aligned with the output triangles.
    """
    if len(tris) == 0:
        if face_ids is None:
            return points, tris
        return points, tris, np.asarray([], dtype=np.int64)
    tol = max(float(tol), 1e-12)
    # Quantize to weld grid.
    q = np.round(points / tol).astype(np.int64)
    # Stable unique rows
    _, inv, counts = np.unique(q, axis=0, return_inverse=True, return_counts=True)
    # Representative = first occurrence of each quantized key
    rep = np.full(len(counts), -1, dtype=np.int64)
    for i, key in enumerate(inv):
        if rep[key] < 0:
            rep[key] = i
    new_index = rep[inv]
    # Compact points
    used = np.unique(new_index)
    remap = {int(old): i for i, old in enumerate(used)}
    pts_out = points[used]
    kept: list[list[int]] = []
    kept_fids: list[int] = []
    min_edge = tol * 2.0
    min_area = tol * tol
    fid_list = None if face_ids is None else [int(f) for f in face_ids]
    for ti, (a0, b0, c0) in enumerate(tris):
        a, b, c = remap[int(new_index[a0])], remap[int(new_index[b0])], remap[
            int(new_index[c0])
        ]
        if a == b or b == c or a == c:
            continue
        pa, pb, pc = pts_out[a], pts_out[b], pts_out[c]
        e1 = float(np.linalg.norm(pb - pa))
        e2 = float(np.linalg.norm(pc - pb))
        e3 = float(np.linalg.norm(pa - pc))
        if min(e1, e2, e3) < min_edge:
            continue
        area = 0.5 * float(np.linalg.norm(np.cross(pb - pa, pc - pa)))
        if area < min_area:
            continue
        kept.append([a, b, c])
        if fid_list is not None:
            kept_fids.append(fid_list[ti])
    if not kept:
        raise RuntimeError("all triangles degenerate after weld")
    tri_out = np.asarray(kept, dtype=np.int64)
    if face_ids is None:
        return pts_out, tri_out
    return pts_out, tri_out, np.asarray(kept_fids, dtype=np.int64)


def _refine_with_face_ids(
    points_m: np.ndarray,
    tris: np.ndarray,
    face_ids: np.ndarray,
    max_edge: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Refine long edges while propagating per-triangle BREP face ids."""
    max_edge = float(max_edge)
    pts = [np.asarray(p, dtype=np.float64) for p in points_m]
    faces = [tuple(int(i) for i in t) for t in tris]
    fids = [int(f) for f in face_ids]
    edge_mid: dict[tuple[int, int], int] = {}

    def midpoint(i: int, j: int) -> int:
        key = (i, j) if i < j else (j, i)
        mid = edge_mid.get(key)
        if mid is not None:
            return mid
        mid = len(pts)
        pts.append(0.5 * (pts[i] + pts[j]))
        edge_mid[key] = mid
        return mid

    for _ in range(24):
        new_faces: list[tuple[int, int, int]] = []
        new_fids: list[int] = []
        split_any = False
        for (a, b, c), fid in zip(faces, fids):
            lab = float(np.linalg.norm(pts[a] - pts[b]))
            lbc = float(np.linalg.norm(pts[b] - pts[c]))
            lca = float(np.linalg.norm(pts[c] - pts[a]))
            if lab <= max_edge and lbc <= max_edge and lca <= max_edge:
                new_faces.append((a, b, c))
                new_fids.append(fid)
                continue
            split_any = True
            if lab >= lbc and lab >= lca:
                m = midpoint(a, b)
                new_faces.extend(((a, m, c), (m, b, c)))
            elif lbc >= lab and lbc >= lca:
                m = midpoint(b, c)
                new_faces.extend(((a, b, m), (a, m, c)))
            else:
                m = midpoint(c, a)
                new_faces.extend(((a, b, m), (m, b, c)))
            new_fids.extend((fid, fid))
        faces, fids = new_faces, new_fids
        if not split_any:
            break

    return _weld_and_drop_degenerate(
        np.asarray(pts, dtype=np.float64),
        np.asarray(faces, dtype=np.int64),
        tol=max(1e-9, max_edge * 1e-4),
        face_ids=np.asarray(fids, dtype=np.int64),
    )


def face_split_solid_name(patch_name: str, face_id: int) -> str:
    """STL solid / cfMesh patch name for one BREP face under a BC patch."""
    return f"{patch_name}__f{int(face_id)}"


def _append_solid_triangles(
    lines: list[str],
    *,
    solid_name: str,
    points_m: np.ndarray,
    tris: np.ndarray,
) -> int:
    lines.append(f"solid {solid_name}")
    n_kept = 0
    for a, b, c in tris:
        ia, ib, ic = int(a), int(b), int(c)
        if ia == ib or ib == ic or ia == ic:
            continue
        p0, p1, p2 = points_m[ia], points_m[ib], points_m[ic]
        n = np.cross(p1 - p0, p2 - p0)
        norm = float(np.linalg.norm(n))
        if norm > 0:
            n = n / norm
        else:
            n = np.zeros(3)
        lines.append(f"  facet normal {n[0]:.8e} {n[1]:.8e} {n[2]:.8e}")
        lines.append("    outer loop")
        lines.append(f"      vertex {p0[0]:.8e} {p0[1]:.8e} {p0[2]:.8e}")
        lines.append(f"      vertex {p1[0]:.8e} {p1[1]:.8e} {p1[2]:.8e}")
        lines.append(f"      vertex {p2[0]:.8e} {p2[1]:.8e} {p2[2]:.8e}")
        lines.append("    endloop")
        lines.append("  endfacet")
        n_kept += 1
    if n_kept == 0:
        raise RuntimeError(f"patch {solid_name!r}: all triangles degenerate")
    lines.append(f"endsolid {solid_name}")
    return n_kept


def export_multisolid_stl_ascii(
    solid: LoadedSolid,
    project: Project,
    out_path: Path,
    *,
    max_edge_m: float | None = None,
    require_units_confirmed: bool = True,
    require_all_assigned: bool = True,
    split_wall_faces: bool = True,
) -> tuple[dict[str, int], dict[str, list[str]]]:
    """Write a closed multi-solid ASCII STL for cfMesh.

    Each STL ``solid`` name becomes a boundary patch. When ``split_wall_faces``
    is set, wall BCs with multiple BREP faces emit one solid per face
    (``walls__f14``, …). Shared CAD edges become **patch borders**, which
    cfMesh treats as hard feature constraints — without this, wall–wall
    shoulders are only soft dihedrals and get rounded.

    Returns ``(tri_counts, merge_map)`` where ``merge_map`` maps the final BC
    patch name → list of split solid names (empty list if not split).
    """
    if require_units_confirmed and not project.units_confirmed:
        raise RuntimeError("units.confirmed is false — confirm scale before STL export")
    if project.scale_to_metres <= 0:
        raise ValueError(f"invalid scale_to_metres={project.scale_to_metres}")

    emitted = emit_all_patches(project)
    if not emitted:
        raise RuntimeError("no boundary conditions with faces for cfMesh surface")

    if require_all_assigned:
        unassigned = project.unassigned_face_ids()
        if unassigned:
            preview = ", ".join(str(i) for i in unassigned[:20])
            raise RuntimeError(
                f"unassigned faces must be assigned before meshing: [{preview}]"
            )

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
    scale = float(project.scale_to_metres)
    tri_counts: dict[str, int] = {}
    merge_map: dict[str, list[str]] = {}
    edge_limit = float(max_edge_m) if max_edge_m is not None else None

    # One shared tessellation (finest deflection among BCs) so wall-face solids
    # meet exactly on CAD edges — independent per-patch refine drifts corners.
    best_lin = None
    best_ang = None
    for ep in emitted:
        bc = bc_by_id.get(ep.bc_id)
        if bc is None:
            raise RuntimeError(f"emitted patch {ep.name!r}: missing BC id {ep.bc_id!r}")
        lin, ang, defl_m = stl_deflection_for_bc(solid, project, bc)
        if edge_limit is not None:
            target_defl_m = min(float(defl_m), 0.5 * edge_limit)
            lin = max(target_defl_m / scale, 1e-9)
            ang = min(float(ang), 0.13)
        if best_lin is None or lin < best_lin:
            best_lin = float(lin)
        if best_ang is None or ang < best_ang:
            best_ang = float(ang)
    assert best_lin is not None and best_ang is not None
    points, faces, face_ids = tessellate_faces(
        solid, linear_deflection=best_lin, angular_deflection=best_ang
    )
    points_m = np.asarray(points, dtype=np.float64) * scale
    faces = np.asarray(faces, dtype=np.int64)
    face_ids = np.asarray(face_ids, dtype=np.int64)

    if edge_limit is not None:
        # Global refine so shared CAD edges keep identical vertices across solids.
        points_m, faces, face_ids = _refine_with_face_ids(
            points_m, faces, face_ids, edge_limit
        )

    lines: list[str] = []
    for ep in emitted:
        is_wall = str(ep.patch_type).lower() == "wall" or ep.name.lower() == "walls"
        split = bool(split_wall_faces) and is_wall and len(ep.face_ids) > 1
        if split:
            names: list[str] = []
            for fid in ep.face_ids:
                mask = face_ids == int(fid)
                tri = faces[mask]
                if len(tri) == 0:
                    raise RuntimeError(
                        f"patch {ep.name!r} face {fid}: no triangles"
                    )
                sname = face_split_solid_name(ep.name, int(fid))
                tri_counts[sname] = _append_solid_triangles(
                    lines, solid_name=sname, points_m=points_m, tris=tri
                )
                names.append(sname)
            merge_map[ep.name] = names
        else:
            mask = np.isin(face_ids, list(ep.face_ids))
            tri = faces[mask]
            if len(tri) == 0:
                raise RuntimeError(f"patch {ep.name!r}: no triangles")
            tri_counts[ep.name] = _append_solid_triangles(
                lines, solid_name=ep.name, points_m=points_m, tris=tri
            )
            merge_map[ep.name] = []

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return tri_counts, merge_map


def write_cfmesh_face_merge_create_patch_dict(
    path: Path,
    merge_map: dict[str, list[str]],
    *,
    patch_types: dict[str, str] | None = None,
) -> bool:
    """Write createPatchDict that merges ``walls__f*`` and retypes inlet/outlet.

    cfMesh marks every STL solid as ``type wall``. Inlet/outlet must be
    ``patch`` (SimScale / OpenFOAM) or simpleFoam fatals on fixedValue /
    inletOutlet. Split walls are merged; unsplit patches are retyped in place.

    Returns True when at least one block was written.
    """
    patch_types = patch_types or {}
    blocks: list[str] = []
    for final_name, parts in sorted(merge_map.items()):
        ptype = patch_types.get(final_name, "wall")
        # Empty parts = already the BC name (velocity_inlet / pressure_outlet).
        # Still emit a block so createPatch changes wall → patch.
        joined = " ".join(parts) if parts else final_name
        blocks.append(
            f"""    {{
        name {final_name};
        patchInfo
        {{
            type {ptype};
        }}
        constructFrom patches;
        patches ({joined});
    }}"""
        )
    if not blocks:
        return False
    text = f"""\
/*--------------------------------*- C++ -*----------------------------------*\\
| cfMesh face-split merge - restore intensive BC patch names                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      createPatchDict;
}}

pointSync false;

patches
(
{chr(10).join(blocks)}
);
"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\r\n", "\n").encode("ascii", errors="strict"))
    return True


def write_mesh_dict(
    path: Path,
    *,
    surface_file: str,
    max_cell_m: float,
    boundary_cell_m: float,
    skin_cell_m: float | None = None,
    keep_cells_intersecting_boundary: bool = True,
    skin_layers: float = _SKIN_LAYERS,
    edge_mesh_file: str | None = None,
    gap_refs: list | None = None,
    gap_objects: list | None = None,
    allow_gap_min_cell: bool = False,
) -> None:
    """Write ``system/meshDict`` for cfMesh ``cartesianMesh``.

    Bulk hex ≈ ``boundaryCellSize``. Fine peel on **all** ``walls`` via a
    *thin* localRefinement (default 1× skin). ``minCellSize`` stays at bulk so
    curvature auto-refine cannot flood the volume or skip flat shoulders.

    When ``edge_mesh_file`` is set (CAD ``featureEdgeMesh``),
    ``edgeMeshRefinement`` forces sharp BREP edges/corners onto the volume mesh
    — without this, Coarse often reports 0 corners and rounds CAD edges.
    """
    max_cell_m = max(float(max_cell_m), 1e-6)
    boundary_cell_m = max(float(boundary_cell_m), 1e-6)
    skin = (
        max(float(skin_cell_m), 1e-6)
        if skin_cell_m is not None
        else max(boundary_cell_m * 0.5, 1e-6)
    )
    skin = min(skin, boundary_cell_m)
    thick = skin_thickness_m(skin, layers=skin_layers)
    boundary_thick = boundary_cell_m * _BOUNDARY_THICKNESS_LAYERS
    min_cell = boundary_cell_m
    gap_entries = list(gap_refs or [])
    gap_obj_entries = list(gap_objects or [])
    if allow_gap_min_cell and (gap_entries or gap_obj_entries):
        # cfMesh stops all refinement at minCellSize. A thin-wall gap finer
        # than the bulk floor must drop that floor or local/object Ref is
        # ignored. This is not a volume-wide skin: curvature peel stays on
        # curved faces; volume flood is the deep localRef ".*" path.
        sizes = [float(g.cell_size_m) for g in gap_entries]
        sizes.extend(float(g.cell_size_m) for g in gap_obj_entries)
        min_cell = min(min_cell, min(sizes))
    keep = 1 if keep_cells_intersecting_boundary else 0
    # Shallow CAD-edge refine at *skin* size (not octree levels below max).
    # Levels=3 made Fine peel ~7 deep; levels=1 lost Fine edge p95. cellSize=skin
    # keeps edge adherence without undercutting the ~3-layer peel target.
    edge_cell = skin
    edge_thick = max(skin * _EDGE_THICK_FRAC_OF_SKIN, 1e-6)

    local_block = ""
    # Thin peel on walls when skin is large enough. On Fine (skin < 4 mm) skip
    # localRef — otherwise cell count explodes and peel grows to ~7 layers.
    # Fine body-fit comes from small boundaryCellSize + STL edge gate alone.
    # Wall faces are exported as walls__f* so CAD edges are patch borders;
    # localRef must match the split names (regex).
    local_lines: list[str] = []
    if skin < boundary_cell_m * 0.95 and skin >= _LOCALREF_MIN_SKIN_M:
        local_lines.append(
            f"""    "walls.*"
    {{
        cellSize {skin:.8g};
        refinementThickness {thick:.8g};
    }}"""
        )
    for g in gap_entries:
        local_lines.append(
            f"""    "{g.pattern}"
    {{
        cellSize {float(g.cell_size_m):.8g};
        refinementThickness {float(g.thickness_m):.8g};
    }}"""
        )
    local_block = ""
    if local_lines:
        note = (
            "// Thin peel on walls + optional gap localRef (thin-wall CAD).\n"
            f"// walls.* omitted when skin < {_LOCALREF_MIN_SKIN_M:g} m (Fine path).\n"
        )
        local_block = (
            "\n"
            + note
            + "localRefinement\n{\n"
            + "\n".join(local_lines)
            + "\n}\n"
        )

    obj_block = ""
    if gap_obj_entries:
        chunks = []
        for obj in gap_obj_entries:
            chunks.append(
                f"""    {obj.name}
    {{
        type hollowCone;
        cellSize {float(obj.cell_size_m):.8g};
        p0 ({obj.p0[0]:.8g} {obj.p0[1]:.8g} {obj.p0[2]:.8g});
        p1 ({obj.p1[0]:.8g} {obj.p1[1]:.8g} {obj.p1[2]:.8g});
        radius0_Inner {float(obj.r_inner_m):.8g};
        radius0_Outer {float(obj.r_outer_m):.8g};
        radius1_Inner {float(obj.r_inner_m):.8g};
        radius1_Outer {float(obj.r_outer_m):.8g};
    }}"""
            )
        obj_block = (
            "\n// Thin-wall CAD annulus (gap < 2×skin). hollowCone only — "
            "not a domain-wide refine.\n"
            "objectRefinements\n{\n"
            + "\n".join(chunks)
            + "\n}\n"
        )

    edge_block = ""
    if edge_mesh_file:
        edge_block = f"""
// CAD topological edges (featureEdgeMesh) — pin sharp corners/edges to the mesh.
// cellSize = skin (not deep additionalRefinementLevels) to keep peel ~3 cells.
edgeMeshRefinement
{{
    cadFeatures
    {{
        edgeFile "{edge_mesh_file}";
        cellSize {edge_cell:.8g};
        refinementThickness {edge_thick:.8g};
    }}
}}
"""

    text = f"""\
/*--------------------------------*- C++ -*----------------------------------*\\
| cfddesk Standard + Hex element core — cfMesh cartesianMesh                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      meshDict;
}}

surfaceFile "{surface_file}";

maxCellSize     {max_cell_m:.8g};
boundaryCellSize {boundary_cell_m:.8g};
// Bulk ≈ boundary; peel ≈ walls localRef (1×skin). minCellSize = bulk.
boundaryCellSizeRefinementThickness {boundary_thick:.8g};
minCellSize     {min_cell:.8g};

// Keep template cells that cross the CAD so steep slopes / junctions are not
// stripped during inside/outside classification (ROOT-CAUSE body-fit).
keepCellsIntersectingBoundary {keep};
{local_block}{obj_block}{edge_block}
// Wall prism layers deferred (SimScale Automatic BL = follow-on).
// nLayers 0: no extra prism stack; cartesianMesh still wraps one surface layer.
boundaryLayers
{{
    nLayers 0;
}}
"""
    Path(path).write_text(text, encoding="utf-8", newline="\n")
