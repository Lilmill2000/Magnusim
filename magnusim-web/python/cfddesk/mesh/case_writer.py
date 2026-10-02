"""The cfMesh case writer, and the system dictionaries mesh cases share."""

from __future__ import annotations

from pathlib import Path

from magnusim_sdk.foam import dictionary_header, write_foam_text

from cfddesk.cad.location import LocationInMesh
from cfddesk.cad.passage import PassageMeshCheck
from cfddesk.cad.step import LoadedSolid
from cfddesk.project.defaults import MESH_BASE_CELL_M
from cfddesk.project.model import Project
from cfddesk.project.settings import MeshRefinement

# One copy of the dictionary header and writer, in magnusim_sdk.foam.
_write_foam = write_foam_text
_foam_header = dictionary_header


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
    """Write the cfMesh case: multi-solid STL + ``meshDict`` for ``cartesianMesh``.

    Needs ``hex_element_core=True`` (cfMesh is a hex core mesher). The Standard
    mesher without a hex core is ``tools/generate_standard.py``.

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
        from cfddesk.cad.gaps import smallest_unresolved_gap_m
        from cfddesk.cad.units import shape_bbox
        from cfddesk.mesh.cfmesh_standard import (
            export_multisolid_stl_ascii,
            hexcore_feature_defl_m,
            hexcore_surface_cell_m,
            hexcore_uniform_cell_m,
            skin_thickness_m,
            write_cfmesh_face_merge_create_patch_dict,
            write_mesh_dict,
        )
        from cfddesk.project.mesh_sizing import (
            characteristic_aabb_length_m,
            clamp_fineness,
        )

        # SimScale Automatic: characteristic length from the solid AABB, then
        # fineness = cells across that length. Not min(dx, dy) (thin-plate
        # over-refine) and not a millimetre table.
        bbox = shape_bbox(solid.shape, unit="native")
        scale = float(project.scale_to_metres)
        span_x = abs(bbox.xmax - bbox.xmin) * scale
        span_y = abs(bbox.ymax - bbox.ymin) * scale
        span_z = abs(bbox.zmax - bbox.zmin) * scale
        char_len = characteristic_aabb_length_m(span_x, span_y, span_z)
        if char_len <= 1e-6:
            char_len = float(base_cell_m)
        fineness = clamp_fineness(int(getattr(project.mesh, "fineness", 5) or 5))
        hex_h = hexcore_uniform_cell_m(char_len_m=char_len, fineness=fineness)
        surf_h = hexcore_surface_cell_m(hex_h)
        # SimScale Standard surface is ONE size on faces and edges.
        # Interior hex stays hex_h; surface is uniform at surf_h.
        # edgeMeshRefinement OFF — dark fine edge bands.
        # split_wall_faces OFF — walls__f* patch borders also force fine
        # corridors along every CAD edge (same visual as edgeMesh).
        max_cell = hex_h
        boundary_cell = surf_h
        skin_cell = surf_h
        edge_lim = surf_h
        stl_path = tri / "geometry.stl"
        tri_counts, merge_map = export_multisolid_stl_ascii(
            solid,
            project,
            stl_path,
            max_edge_m=edge_lim,
            split_wall_faces=False,
        )
        # Merge walls__f* → walls after cartesianMesh (no-op when not split).
        write_cfmesh_face_merge_create_patch_dict(
            system / "createPatchDict.cfmeshFaces",
            merge_map,
            patch_types=types,
        )
        edge_mesh_file = None
        n_feat = 0
        edge_defl_m = hexcore_feature_defl_m(hex_h)
        skin_thick = skin_thickness_m(skin_cell)
        # Hex larger than a wall thickness bridges the solid. Drop minCell
        # to the smallest measured gap so the wall exists on any CAD.
        # Keep hexes that straddle the CAD so 90° corners are not deleted
        # into a chamfer. Uniform surface: no edgeMeshRefinement peel.
        gap_floor = smallest_unresolved_gap_m(
            solid, scale_to_metres=scale, hex_cell_m=hex_h
        )
        min_floor = surf_h if gap_floor is None else min(surf_h, gap_floor)
        write_mesh_dict(
            system / "meshDict",
            surface_file="constant/triSurface/geometry.stl",
            max_cell_m=max_cell,
            boundary_cell_m=boundary_cell,
            skin_cell_m=skin_cell,
            keep_cells_intersecting_boundary=True,
            edge_mesh_file=None,
            gap_refs=[],
            gap_objects=[],
            allow_gap_min_cell=False,
            min_cell_m=min_floor,
            edge_cell_m=None,
        )
        n_split = sum(len(v) for v in merge_map.values())
        gap_target = float(gap_floor) if gap_floor is not None else None
        host_log = (
            "backend=cfmesh cartesianMesh\n"
            "hex_core=ok\n"
            f"maxCellSize={max_cell:.8g}\n"
            f"boundaryCellSize={boundary_cell:.8g} (uniform surface)\n"
            f"skinCellSize={skin_cell:.8g} (same as surface; no extra edge peel)\n"
            f"skin_localRef_thickness_m={skin_thick:.8g}\n"
            f"minCellSize={gap_target if gap_target is not None else boundary_cell:.8g} "
            f"(smallest CAD gap or surface; hex={max_cell:.8g})\n"
            + f"boundary_thickness_m={boundary_cell * 2.5:.8g}\n"
            + f"wall_face_split={n_split > 0} solids={n_split}\n"
            f"cad_feature_edges=0 (edgeMeshRefinement off — uniform surface)\n"
            f"edgeMeshRefinement=off\n"
            f"stl_max_edge_m={edge_lim:.8g}\n"
            f"stl_triangles={tri_counts}\n"
            "surface=geometry.stl (no .fms; no walls__f* edge corridors)\n"
            "keepCellsIntersectingBoundary=1 (do not strip 90° corners)\n"
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
            "wall_cell_m": float(boundary_cell),
            "edge_defl_m": edge_defl_m,
            "edge_threshold_m": max(edge_defl_m * 2.0, boundary_cell * 0.25),
            "wall_face_split": n_split > 0,
            "gap_count": 0,
            "gap_local_ref": [],
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

    # Standard without a hex core is tools/generate_standard.py; this writer is cfMesh's.
    raise ValueError("prepare_standard_mesh_case writes the cfMesh case, which needs hex_element_core")
