"""Write OpenFOAM snappyHexMesh case (stock ESI v2606) for BC STLs."""

from __future__ import annotations

import math
from pathlib import Path

from cfddesk.cad.location import LocationInMesh
from cfddesk.cad.passage import PassageMeshCheck
from cfddesk.cad.step import LoadedSolid
from cfddesk.cad.stl_export import export_bc_stls
from cfddesk.cad.units import shape_bbox
from cfddesk.mesh.patches import emit_all_patches
from cfddesk.project.defaults import MESH_BASE_CELL_M, MESH_REFINEMENT_LEVEL_INOUT
from cfddesk.project.model import Project
from cfddesk.project.settings import MeshRefinement


def _fmt(v: float) -> str:
    return f"{v:.8g}"


# Conservative Phase 5 boundary-layer defaults (not y+ tuned).
# Industrial CAD usually leaves a few high-skew faces after layer insertion;
# mesh_run soft-accepts skewness-only checkMesh failures when addLayers is on.
LAYER_N_SURFACE = 2
LAYER_EXPANSION_RATIO = 1.1
LAYER_FINAL_THICKNESS = 0.3  # relativeSizes true
LAYER_MIN_THICKNESS = 0.2


def _write_foam(path: Path, text: str) -> None:
    """Write OpenFOAM dict with Unix newlines (CRLF breaks Foam parsers)."""
    path.write_bytes(text.replace("\r\n", "\n").encode("ascii", errors="strict"))


def _foam_header(object_name: str) -> str:
    # No C++ banner: a trailing '\\' on the banner line comments out FoamFile.
    return (
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        "    class       dictionary;\n"
        f"    object      {object_name};\n"
        "}\n"
        "// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //\n"
    )


def _refinement_level_for_patch(
    levels: MeshRefinement,
    *,
    name: str,
    patch_type: str,
    bc,
    emitted_level: int,
) -> int:
    """Prefer ``MeshSettings.refinement`` for inlet/outlet/wall semantics.

    Physics-based / Advanced role levels live on ``MeshSettings.refinement``.
    Per-BC ``refinement_level`` is used only for non-role patches.
    """
    semantic = None
    if bc is not None:
        try:
            from cfddesk.case.bc_menu import registry_key_for_bc
            from cfddesk.case.bc_registry import get_type

            semantic = str(get_type(registry_key_for_bc(bc)).semantic).lower()
        except Exception:
            semantic = None
    pname = (bc.patch_name if bc is not None else name).lower()
    if semantic == "inlet" or pname == "inlet":
        return int(levels.inlet)
    if semantic == "outlet" or pname == "outlet":
        return int(levels.outlet)
    if semantic == "wall" or patch_type == "wall" or pname in ("walls", "wall"):
        return int(levels.walls)
    level = int(emitted_level)
    return level if level > 0 else 1


def _add_layers_controls_block(
    *,
    add_layers: bool,
    wall_patch_names: list[str],
) -> str:
    """Build ``addLayersControls``; wall entries only when layers are enabled."""
    if add_layers and wall_patch_names:
        layer_entries = "\n".join(
            f"""        {name}
        {{
            nSurfaceLayers {LAYER_N_SURFACE};
        }}"""
            for name in wall_patch_names
        )
        layers_body = f"\n{layer_entries}\n    "
        expansion = LAYER_EXPANSION_RATIO
        final_t = LAYER_FINAL_THICKNESS
        min_t = LAYER_MIN_THICKNESS
        # Extra smoothing / relaxation when layers are actually requested.
        n_relax = 5
        n_smooth_surf = 3
        n_smooth_norm = 10
        feature_angle = 130
        slip_angle = 30
        max_face_thick = 0.5
        max_medial = 0.3
        n_buffer = 0
        n_layer_iter = 50
    else:
        layers_body = "\n    "
        expansion = 1.0
        final_t = 0.3
        min_t = 0.1
        n_relax = 3
        n_smooth_surf = 1
        n_smooth_norm = 3
        feature_angle = 60
        slip_angle = 30
        max_face_thick = 0.5
        max_medial = 0.3
        n_buffer = 0
        n_layer_iter = 50
    return f"""addLayersControls
{{
    relativeSizes true;
    layers
    {{{layers_body}}}
    expansionRatio {expansion};
    finalLayerThickness {final_t};
    minThickness {min_t};
    nGrow 0;
    featureAngle {feature_angle};
    slipFeatureAngle {slip_angle};
    nRelaxIter {n_relax};
    nSmoothSurfaceNormals {n_smooth_surf};
    nSmoothNormals {n_smooth_norm};
    nSmoothThickness 10;
    maxFaceThicknessRatio {max_face_thick};
    maxThicknessToMedialRatio {max_medial};
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude {n_buffer};
    nLayerIter {n_layer_iter};
}}"""


def write_block_mesh_dict(
    path: Path,
    *,
    bbox_m: tuple[float, float, float, float, float, float],
    base_cell_m: float,
    pad_m: float = 0.05,
) -> tuple[int, int, int]:
    xmin, ymin, zmin, xmax, ymax, zmax = bbox_m
    xmin -= pad_m
    ymin -= pad_m
    zmin -= pad_m
    xmax += pad_m
    ymax += pad_m
    zmax += pad_m

    nx = max(1, int(math.ceil((xmax - xmin) / base_cell_m)))
    ny = max(1, int(math.ceil((ymax - ymin) / base_cell_m)))
    nz = max(1, int(math.ceil((zmax - zmin) / base_cell_m)))

    text = (
        _foam_header("blockMeshDict")
        + f"""
scale   1;

vertices
(
    ({_fmt(xmin)} {_fmt(ymin)} {_fmt(zmin)})
    ({_fmt(xmax)} {_fmt(ymin)} {_fmt(zmin)})
    ({_fmt(xmax)} {_fmt(ymax)} {_fmt(zmin)})
    ({_fmt(xmin)} {_fmt(ymax)} {_fmt(zmin)})
    ({_fmt(xmin)} {_fmt(ymin)} {_fmt(zmax)})
    ({_fmt(xmax)} {_fmt(ymin)} {_fmt(zmax)})
    ({_fmt(xmax)} {_fmt(ymax)} {_fmt(zmax)})
    ({_fmt(xmin)} {_fmt(ymax)} {_fmt(zmax)})
);

blocks
(
    hex (0 1 2 3 4 5 6 7) ({nx} {ny} {nz}) simpleGrading (1 1 1)
);

boundary
(
    blockBounds
    {{
        type patch;
        faces
        (
            (0 3 2 1)
            (4 5 6 7)
            (0 1 5 4)
            (2 3 7 6)
            (1 2 6 5)
            (3 0 4 7)
        );
    }}
);

// ************************************************************************* //
"""
    )
    _write_foam(path, text)
    return nx, ny, nz


def write_snappy_hex_mesh_dict(
    path: Path,
    *,
    location_m: tuple[float, float, float],
    patches: list[tuple[str, int, str]] | None = None,
    refinement_inlet: int | None = None,
    refinement_outlet: int | None = None,
    refinement_walls: int | None = None,
    add_layers: bool = False,
    feature_edge_file: str | None = None,
    feature_level: int = 2,
    snap_n_smooth_patch: int = 3,
    snap_tolerance: float = 2.0,
    snap_n_solve_iter: int = 100,
    snap_n_relax_iter: int = 5,
    snap_n_feature_snap_iter: int = 15,
) -> None:
    """Write snappyHexMeshDict.

    ``patches``: list of ``(patch_name, refinement_level, patch_type)``.
    When ``add_layers`` is True, ``addLayers true`` and wall patches get a
    minimal ``nSurfaceLayers`` entry under ``addLayersControls``.

    When ``feature_edge_file`` is set (e.g. ``cadFeatures.eMesh`` under
    ``constant/triSurface``), castellated feature refinement + explicit
    feature snap are enabled so CAD edges are not cut by coarse hex faces.
    """
    if not patches:
        ri = 2 if refinement_inlet is None else refinement_inlet
        ro = 2 if refinement_outlet is None else refinement_outlet
        rw = 1 if refinement_walls is None else refinement_walls
        patches = [
            ("inlet", ri, "patch"),
            ("outlet", ro, "patch"),
            ("walls", rw, "wall"),
        ]
    lx, ly, lz = location_m
    geom_blocks = []
    refine_blocks = []
    wall_names: list[str] = []
    for name, level, ptype in patches:
        geom_blocks.append(
            f"""    {name}.stl
    {{
        type triSurfaceMesh;
        name {name};
    }}"""
        )
        refine_blocks.append(
            f"""        {name}
        {{
            level ({level} {level});
            patchInfo {{ type {ptype}; }}
        }}"""
        )
        if ptype == "wall":
            wall_names.append(name)
    geometry = "\n".join(geom_blocks)
    refinement = "\n".join(refine_blocks)
    layers_flag = "true" if add_layers else "false"
    layers_controls = _add_layers_controls_block(
        add_layers=bool(add_layers),
        wall_patch_names=wall_names,
    )
    feat_lvl = max(0, int(feature_level))
    if feature_edge_file:
        features_block = f"""
    {{
        file "{feature_edge_file}";
        level {feat_lvl};
    }}"""
        explicit_snap = "true"
    else:
        features_block = ""
        explicit_snap = "false"
    text = (
        _foam_header("snappyHexMeshDict")
        + f"""
castellatedMesh true;
snap            true;
addLayers       {layers_flag};

geometry
{{
{geometry}
}}

castellatedMeshControls
{{
    maxLocalCells 2000000;
    maxGlobalCells 4000000;
    minRefinementCells 0;
    maxLoadUnbalance 0.10;
    nCellsBetweenLevels 2;

    features
    (
{features_block}
    );

    refinementSurfaces
    {{
{refinement}
    }}

    resolveFeatureAngle 20;

    refinementRegions
    {{
    }}

    locationInMesh ({_fmt(lx)} {_fmt(ly)} {_fmt(lz)});
    allowFreeStandingZoneFaces true;
}}

snapControls
{{
    nSmoothPatch {int(snap_n_smooth_patch)};
    tolerance {float(snap_tolerance):.8g};
    nSolveIter {int(snap_n_solve_iter)};
    nRelaxIter {int(snap_n_relax_iter)};
    nFeatureSnapIter {int(snap_n_feature_snap_iter)};
    implicitFeatureSnap true;
    explicitFeatureSnap {explicit_snap};
    multiRegionFeatureSnap false;
}}

{layers_controls}

meshQualityControls
{{
    #include "meshQualityDict"

    // Allow temporary quality slip during layer addition; final checkMesh
    // still uses stock thresholds.
    relaxed
    {{
        maxNonOrtho 75;
    }}
}}

writeFlags
(
);

mergeTolerance 1e-6;

// ************************************************************************* //
"""
    )
    _write_foam(path, text)


def write_mesh_quality_dict(path: Path) -> None:
    _write_foam(
        path,
        _foam_header("meshQualityDict")
        + """
maxNonOrtho 65;
maxBoundarySkewness 20;
maxInternalSkewness 4;
maxConcave 80;
minVol -1e30;
minTetQuality 1e-30;
minArea -1;
minTwist 0.02;
minDeterminant 0.001;
minFaceWeight 0.05;
minVolRatio 0.01;
minTriangleTwist -1;
nSmoothScale 4;
errorReduction 0.75;

// ************************************************************************* //
""",
    )


def write_control_dict(path: Path) -> None:
    _write_foam(
        path,
        _foam_header("controlDict")
        + """
application     snappyHexMesh;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         0;
deltaT          1;
writeControl    timeStep;
writeInterval   1;
purgeWrite      0;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

// ************************************************************************* //
""",
    )


def write_fv_schemes(path: Path) -> None:
    _write_foam(
        path,
        _foam_header("fvSchemes")
        + """
ddtSchemes { default Euler; }
gradSchemes { default Gauss linear; }
divSchemes { default none; }
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }

// ************************************************************************* //
""",
    )


def write_fv_solution(path: Path) -> None:
    _write_foam(
        path,
        _foam_header("fvSolution")
        + """
solvers {}

// ************************************************************************* //
""",
    )


def prepare_mesh_case(
    solid: LoadedSolid,
    project: Project,
    case_dir: Path,
    *,
    location: LocationInMesh,
    passage_check: PassageMeshCheck,
    base_cell_m: float = MESH_BASE_CELL_M,
    refinement_level: int = MESH_REFINEMENT_LEVEL_INOUT,
    refinement: MeshRefinement | None = None,
    legacy_stl_deflection: bool = False,
) -> dict:
    """Export STLs + write mesh dictionaries under ``case_dir`` (Windows path).

    ``refinement`` (per-role inlet/outlet/walls levels) takes precedence when
    given; otherwise all non-wall openings use ``refinement_level`` and walls
    default to level 1, preserving the pre-Slice-2 behaviour.
    """
    if not passage_check.ok:
        raise RuntimeError(passage_check.message)
    if not location.ok:
        raise RuntimeError("locationInMesh not inside solid")
    if not project.units_confirmed:
        raise RuntimeError("units not confirmed")

    case_dir = Path(case_dir)
    tri = case_dir / "constant" / "triSurface"
    system = case_dir / "system"
    tri.mkdir(parents=True, exist_ok=True)
    system.mkdir(parents=True, exist_ok=True)
    (case_dir / "constant").mkdir(parents=True, exist_ok=True)

    stls = export_bc_stls(
        solid, project, tri, legacy_deflection=legacy_stl_deflection
    )

    bbox = shape_bbox(solid.shape, unit="native")
    s = project.scale_to_metres
    bbox_m = (
        bbox.xmin * s,
        bbox.ymin * s,
        bbox.zmin * s,
        bbox.xmax * s,
        bbox.ymax * s,
        bbox.zmax * s,
    )
    nx, ny, nz = write_block_mesh_dict(
        system / "blockMeshDict",
        bbox_m=bbox_m,
        base_cell_m=base_cell_m,
    )
    levels = refinement if refinement is not None else MeshRefinement(
        inlet=refinement_level, outlet=refinement_level, walls=1
    )
    # Role levels come from MeshSettings.refinement (physics / Advanced).
    bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
    patches: list[tuple[str, int, str]] = []
    for ep in emit_all_patches(project):
        bc = bc_by_id.get(ep.bc_id)
        level = _refinement_level_for_patch(
            levels,
            name=ep.name,
            patch_type=ep.patch_type,
            bc=bc,
            emitted_level=int(ep.refinement_level),
        )
        patches.append((ep.name, level, ep.patch_type))

    # CAD topological edges → explicit feature snap (preserves rims / sharp corners
    # that coarse hex faces would otherwise cut).
    from cfddesk.cad.step import shape_diagonal
    from cfddesk.mesh.feature_edges import write_cad_feature_emesh

    diag_m = float(shape_diagonal(solid)) * float(s)
    wall_cell = float(base_cell_m) / (2 ** max(0, int(levels.walls)))
    edge_defl_m = min(wall_cell * 0.25, max(diag_m * 5e-4, 1e-5))
    n_feat = write_cad_feature_emesh(
        solid,
        tri / "cadFeatures.eMesh",
        scale_to_metres=float(s),
        linear_deflection_m=edge_defl_m,
    )
    feature_file = "cadFeatures.eMesh" if n_feat > 0 else None
    # Preferential edge cells: feature level must exceed walls and scale with
    # fineness (SimScale-style). Cap 4. Snap strength also scales with F.
    from cfddesk.mesh.snappy_policy import (
        feature_refinement_level,
        snap_controls_for_fineness,
    )

    fineness = int(getattr(project.mesh, "fineness", 5) or 5)
    feature_level = feature_refinement_level(
        int(levels.walls), fineness=fineness
    )
    snap = snap_controls_for_fineness(
        fineness, has_features=feature_file is not None
    )

    write_snappy_hex_mesh_dict(
        system / "snappyHexMeshDict",
        location_m=location.point_metres,
        patches=patches,
        add_layers=bool(project.mesh.add_layers),
        feature_edge_file=feature_file,
        feature_level=feature_level,
        snap_n_smooth_patch=snap.n_smooth_patch,
        snap_tolerance=snap.tolerance,
        snap_n_solve_iter=snap.n_solve_iter,
        snap_n_relax_iter=snap.n_relax_iter,
        snap_n_feature_snap_iter=snap.n_feature_snap_iter,
    )
    write_mesh_quality_dict(system / "meshQualityDict")
    write_control_dict(system / "controlDict")
    write_fv_schemes(system / "fvSchemes")
    write_fv_solution(system / "fvSolution")

    return {
        "case_dir": str(case_dir),
        "stls": {k: str(v) for k, v in stls.items()},
        "block_cells": (nx, ny, nz),
        "refinement": levels.to_dict(),
        "add_layers": bool(project.mesh.add_layers),
        "location_m": location.point_metres,
        "location_method": location.method,
        "passage": passage_check.message,
        "refined_cell_m": passage_check.refined_cell_m,
        "min_passage_m": passage_check.min_passage_m,
        "cells_across": passage_check.cells_across_min,
        "feature_edges": n_feat,
        "feature_level": feature_level,
        "fineness": fineness,
        "snap": snap.to_dict(),
    }


def prepare_standard_mesh_case(
    solid: LoadedSolid,
    project: Project,
    case_dir: Path,
    *,
    location: LocationInMesh,
    passage_check: PassageMeshCheck,
    base_cell_m: float = MESH_BASE_CELL_M,
    refinement: MeshRefinement | None = None,
) -> dict:
    """Write Standard mesh case for gmsh (all-tet) or cfMesh (hex element core).

    Product mapping:
    - ``hex_element_core=True`` → multi-solid STL + ``meshDict`` for
      ``cartesianMesh`` (bulk Cartesian hex + poly wall transition).
    - ``hex_element_core=False`` → metres STEP + MSH 2.2 for gmshToFoam.

    Does **not** write snappyHexMeshDict / blockMeshDict. Boundary layers are
    not supported on Standard in this step — callers should force
    ``add_layers=False``. The old gmsh inscribed-box hexcore is **not** used.
    """
    if not passage_check.ok:
        raise RuntimeError(passage_check.message)
    if not location.ok:
        raise RuntimeError("locationInMesh not inside solid")
    if not project.units_confirmed:
        raise RuntimeError("units not confirmed")

    from cfddesk.mesh.gmsh_standard import emitted_patch_types

    case_dir = Path(case_dir)
    tri = case_dir / "constant" / "triSurface"
    system = case_dir / "system"
    tri.mkdir(parents=True, exist_ok=True)
    system.mkdir(parents=True, exist_ok=True)
    (case_dir / "constant").mkdir(parents=True, exist_ok=True)

    levels = refinement if refinement is not None else MeshRefinement()
    want_hexcore = bool(getattr(project.mesh, "hex_element_core", True))
    types = emitted_patch_types(project)
    type_lines = "\n".join(f"{n} {t}" for n, t in sorted(types.items()))
    (tri / "patch_types.txt").write_text(type_lines + "\n", encoding="utf-8")

    write_control_dict(system / "controlDict")
    write_fv_schemes(system / "fvSchemes")
    write_fv_solution(system / "fvSolution")
    write_mesh_quality_dict(system / "meshQualityDict")

    if want_hexcore:
        from cfddesk.cad.gaps import hexcore_gap_controls
        from cfddesk.mesh.cfmesh_standard import (
            export_multisolid_stl_ascii,
            max_stl_edge_m,
            sizing_from_base_cell,
            skin_thickness_m,
            write_cfmesh_face_merge_create_patch_dict,
            write_mesh_dict,
        )
        from cfddesk.mesh.feature_edges import write_cad_feature_emesh

        max_cell, boundary_cell, skin_cell = sizing_from_base_cell(float(base_cell_m))
        # Tessellate to *skin* cell (8–12 mm). Passing boundary (=max/2) hit the old
        # 15 mm cap and lost cone body-fit / feature corners.
        edge_lim = max_stl_edge_m(skin_cell)
        stl_path = tri / "geometry.stl"
        tri_counts, merge_map = export_multisolid_stl_ascii(
            solid, project, stl_path, max_edge_m=edge_lim
        )
        # Merge walls__f* → walls after cartesianMesh (BC patch names).
        wrote_merge = write_cfmesh_face_merge_create_patch_dict(
            system / "createPatchDict.cfmeshFaces",
            merge_map,
            patch_types=types,
        )
        # CAD topological edges → featureEdgeMesh for edgeMeshRefinement (sharp corners).
        emesh_path = tri / "cadFeatures.eMesh"
        n_feat = write_cad_feature_emesh(
            solid,
            emesh_path,
            scale_to_metres=float(project.scale_to_metres),
            # Dense enough to resolve cyclone flange/cylinder junctions (~3 mm).
            linear_deflection_m=min(max(edge_lim * 0.35, 0.0025), 0.004),
        )
        edge_mesh_file = (
            "constant/triSurface/cadFeatures.eMesh" if n_feat > 0 else None
        )
        # surfaceFeatureEdges (WSL) converts STL → geometry.fms with corners.
        skin_thick = skin_thickness_m(skin_cell)
        gap_refs, gap_objs, thin_gaps = hexcore_gap_controls(
            solid, project, skin_cell_m=skin_cell
        )
        write_mesh_dict(
            system / "meshDict",
            surface_file="constant/triSurface/geometry.fms",
            max_cell_m=max_cell,
            boundary_cell_m=boundary_cell,
            skin_cell_m=skin_cell,
            keep_cells_intersecting_boundary=True,
            edge_mesh_file=edge_mesh_file,
            gap_refs=gap_refs,
            gap_objects=gap_objs,
            # Isolated remesh: hollowCone + localRef carve the VF wall
            # *without* dropping minCellSize (that path flooded the barrel
            # to 1.94M). cfMesh honours object/local cellSize below the bulk
            # floor in this octree.
            allow_gap_min_cell=False,
        )
        n_split = sum(len(v) for v in merge_map.values())
        gap_target = (
            min(float(g.cell_size_m) for g in list(gap_refs) + list(gap_objs))
            if (gap_refs or gap_objs)
            else None
        )
        host_log = (
            "backend=cfmesh cartesianMesh\n"
            "hex_core=ok\n"
            f"maxCellSize={max_cell:.8g}\n"
            f"boundaryCellSize={boundary_cell:.8g} (visual hex bulk)\n"
            f"skinCellSize={skin_cell:.8g} (walls localRef if skin>=4mm)\n"
            f"skin_localRef_thickness_m={skin_thick:.8g}\n"
            f"minCellSize={boundary_cell:.8g} (equals bulk; no volume flood)\n"
            + (
                f"gap_target_cell_m={gap_target:.8g} (local/object Ref only)\n"
                if gap_target is not None
                else ""
            )
            + f"boundary_thickness_m={boundary_cell * 2.5:.8g}\n"
            'localRefinement="walls.*" thickness~0.75*skin (skipped on Fine)\n'
            f"gap_localRef={len(gap_refs)} objectRef={len(gap_objs)} "
            f"thin_gaps={len(thin_gaps)}\n"
            + (
                "gap_faces="
                + ",".join(g.pattern for g in gap_refs)
                + "\n"
                if gap_refs
                else ""
            )
            + f"wall_face_split={wrote_merge} solids={n_split}\n"
            f"cad_feature_edges={n_feat}\n"
            f"edgeMeshRefinement={'on' if edge_mesh_file else 'off'}\n"
            f"stl_max_edge_m={edge_lim:.8g}\n"
            f"stl_triangles={tri_counts}\n"
            "surface=geometry.fms via surfaceFeatureEdges\n"
            "keepCellsIntersectingBoundary=1\n"
            "transition=polyhedra (not pyr+tet; see SIMSCALE-HEXCORE-RESEARCH.md)\n"
        )
        (case_dir / "log.cfmesh_host.txt").write_text(host_log, encoding="utf-8")
        return {
            "case_dir": str(case_dir),
            "algorithm": "standard",
            "backend": "cfmesh",
            "hex_element_core": True,
            "hex_core": "ok",
            "stl": str(stl_path),
            "mesh_dict": str(system / "meshDict"),
            "max_cell_m": max_cell,
            "boundary_cell_m": boundary_cell,
            "skin_cell_m": skin_cell,
            "skin_thickness_m": skin_thick,
            "stl_max_edge_m": edge_lim,
            "stl_triangles": tri_counts,
            "cad_feature_edges": n_feat,
            "edge_mesh_file": edge_mesh_file,
            "wall_face_split": wrote_merge,
            "gap_count": len(thin_gaps),
            "gap_local_ref": [g.pattern for g in gap_refs],
            "gap_min_cell_m": gap_target,
            "patch_merge_map": {k: v for k, v in merge_map.items() if v},
            "patches": sorted(types),
            "refinement": levels.to_dict(),
            "location_m": location.point_metres,
            "location_method": location.method,
            "passage": passage_check.message,
            "base_cell_m": float(base_cell_m),
            "cfmesh_log": host_log,
        }

    from cfddesk.mesh.gmsh_standard import run_gmsh_volume_mesh, write_scaled_step

    step_path = tri / "geometry_metres.step"
    msh_path = tri / "geometry.msh"
    write_scaled_step(solid, step_path, scale_to_metres=float(project.scale_to_metres))
    gmsh_res = run_gmsh_volume_mesh(
        solid,
        project,
        step_path=step_path,
        msh_path=msh_path,
        base_cell_m=float(base_cell_m),
        refinement=levels,
    )
    host_log = "backend=gmsh all-tet\nhex_core=off\n" + gmsh_res.log_text
    (case_dir / "log.gmsh_host.txt").write_text(host_log, encoding="utf-8")

    return {
        "case_dir": str(case_dir),
        "algorithm": "standard",
        "backend": "gmsh",
        "hex_element_core": False,
        "hex_core": "off",
        "step": str(step_path),
        "msh": str(msh_path),
        "n_nodes": gmsh_res.n_nodes,
        "n_tets": gmsh_res.n_tets,
        "patches": sorted(types),
        "refinement": levels.to_dict(),
        "location_m": location.point_metres,
        "location_method": location.method,
        "passage": passage_check.message,
        "base_cell_m": float(base_cell_m),
        "gmsh_log": host_log,
    }
