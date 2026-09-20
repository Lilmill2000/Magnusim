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
    n_surface_layers: int | None = None,
    expansion_ratio: float | None = None,
    final_layer_thickness: float | None = None,
    min_thickness: float | None = None,
    layer_specs: list[tuple[str, int]] | None = None,
) -> str:
    """Build ``addLayersControls``; surface entries only when layers are enabled.

    ``layer_specs`` (Inc 7b inflate): explicit ``(surface_name, nSurfaceLayers)``.
    Otherwise wall patches use ``n_surface_layers`` or ``LAYER_N_SURFACE``.
    """
    n_surf = int(LAYER_N_SURFACE if n_surface_layers is None else n_surface_layers)
    specs = list(layer_specs) if layer_specs else None
    if add_layers and specs:
        layer_entries = "\n".join(
            f"""        {name}
        {{
            nSurfaceLayers {int(n_layers)};
        }}"""
            for name, n_layers in specs
        )
        layers_body = f"\n{layer_entries}\n    "
        expansion = float(
            LAYER_EXPANSION_RATIO if expansion_ratio is None else expansion_ratio
        )
        final_t = float(
            LAYER_FINAL_THICKNESS
            if final_layer_thickness is None
            else final_layer_thickness
        )
        min_t = float(LAYER_MIN_THICKNESS if min_thickness is None else min_thickness)
        n_relax = 5
        n_smooth_surf = 3
        n_smooth_norm = 10
        feature_angle = 130
        slip_angle = 30
        max_face_thick = 0.5
        max_medial = 0.3
        n_buffer = 0
        n_layer_iter = 50
    elif add_layers and wall_patch_names:
        layer_entries = "\n".join(
            f"""        {name}
        {{
            nSurfaceLayers {n_surf};
        }}"""
            for name in wall_patch_names
        )
        layers_body = f"\n{layer_entries}\n    "
        expansion = float(
            LAYER_EXPANSION_RATIO if expansion_ratio is None else expansion_ratio
        )
        final_t = float(
            LAYER_FINAL_THICKNESS
            if final_layer_thickness is None
            else final_layer_thickness
        )
        min_t = float(LAYER_MIN_THICKNESS if min_thickness is None else min_thickness)
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



def geometry_derived_block_cells(
    bbox_m: tuple[float, float, float, float, float, float],
    base_cell_m: float,
    *,
    pad_m: float = 0.05,
) -> tuple[int, int, int]:
    """Level-0 blockMesh cell counts from CAD bbox + base cell (Hex helper).

    Same formula Hex-dominant has always used when ``n_cells`` is omitted:
    ``ceil((extent + 2*pad) / base_cell)`` per axis. Inc 14a.2-ship: Hex-dominant
    parametric product Level-0 uses this helper (not SimScale 67/62/24, not a
    hardcoded 33/33/74).
    """
    xmin, ymin, zmin, xmax, ymax, zmax = bbox_m
    dx = (xmax - xmin) + 2.0 * float(pad_m)
    dy = (ymax - ymin) + 2.0 * float(pad_m)
    dz = (zmax - zmin) + 2.0 * float(pad_m)
    h = float(base_cell_m)
    if h <= 0.0:
        raise ValueError(f"base_cell_m must be > 0, got {base_cell_m!r}")
    nx = max(1, int(math.ceil(dx / h)))
    ny = max(1, int(math.ceil(dy / h)))
    nz = max(1, int(math.ceil(dz / h)))
    return nx, ny, nz


def write_block_mesh_dict(
    path: Path,
    *,
    bbox_m: tuple[float, float, float, float, float, float],
    base_cell_m: float,
    pad_m: float = 0.05,
    n_cells: tuple[int, int, int] | None = None,
) -> tuple[int, int, int]:
    xmin, ymin, zmin, xmax, ymax, zmax = bbox_m
    xmin -= pad_m
    ymin -= pad_m
    zmin -= pad_m
    xmax += pad_m
    ymax += pad_m
    zmax += pad_m

    if n_cells is not None:
        nx = max(1, int(n_cells[0]))
        ny = max(1, int(n_cells[1]))
        nz = max(1, int(n_cells[2]))
    else:
        # Reuse geometry_derived_block_cells; pad already applied above, so pad_m=0.
        nx, ny, nz = geometry_derived_block_cells(
            (xmin, ymin, zmin, xmax, ymax, zmax),
            base_cell_m,
            pad_m=0.0,
        )

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


def _inflate_layer_write_config(project: Project) -> dict | None:
    """Inc 7b/7c: Inflate boundary layer -> snappy addLayers values.

    Supports Hex-dominant parametric (7b: final_layer_thickness) and
    Hex-dominant (7c: surface_layer_relative_thickness -> finalLayerThickness
    with relativeSizes). Returns None for Standard (Inc 7d is UI+persist
    only ? do NOT invent snappy addLayers; cfMesh ``boundaryLayers nLayers 0``
    is unrelated and not mapped from Standard Inflate), or when no inflate
    stub has Assigned Faces (incomplete -- no invent).
    """
    algo = str(getattr(project.mesh, "algorithm", "") or "")
    if algo not in ("hex-dominant-parametric", "hex-dominant"):
        return None
    sim = project.primary_simulation()
    if sim is None:
        return None
    from cfddesk.mesh.patches import emit_all_patches
    from cfddesk.project.mesh_refinements import INFLATE_TYPE

    stubs = [
        r
        for r in sim.active_mesh().refinements
        if r.type == INFLATE_TYPE and r.face_ids
    ]
    if not stubs:
        return None
    # Face id -> emitted patch name(s).
    face_to_patches: dict[int, list[str]] = {}
    for ep in emit_all_patches(project):
        for fid in ep.face_ids:
            face_to_patches.setdefault(int(fid), []).append(ep.name)
    # Per-surface nSurfaceLayers; globals from first complete stub.
    surface_layers: dict[str, int] = {}
    primary = stubs[0]
    for stub in stubs:
        n_layers = max(0, int(stub.layers))
        for fid in stub.face_ids:
            for pname in face_to_patches.get(int(fid), []):
                # Prefer max if same surface appears in multiple stubs.
                prev = surface_layers.get(pname, 0)
                if n_layers > prev:
                    surface_layers[pname] = n_layers
    if not surface_layers:
        return None
    specs = sorted(surface_layers.items(), key=lambda kv: kv[0])
    if algo == "hex-dominant":
        # Inc 7c: Surface layer relative thickness maps to snappy
        # finalLayerThickness (relativeSizes true). Do not use parametric
        # final_layer_thickness.
        final_t = float(primary.surface_layer_relative_thickness)
    else:
        final_t = float(primary.final_layer_thickness)
    return {
        "add_layers": True,
        "layer_specs": specs,
        "n_surface_layers": int(primary.layers),
        "expansion_ratio": float(primary.expansion_ratio),
        "final_layer_thickness": final_t,
        "min_thickness": float(primary.min_thickness),
        "algo": algo,
    }




def _surface_refinement_level_overrides(project: Project) -> dict[str, tuple[int, int]]:
    """Inc 8a: parametric Surface refinement -> patch name -> (min, max) levels.

    Only hex-dominant-parametric. Maps assigned face_ids (and volume_ids via
    faces_for_volumes) onto emitted patch names. Cell zone "Without cell zone"
    writes no cellZone (OpenFOAM default). Incomplete stubs (no faces/volumes)
    are skipped.

    Inc 8b Hex-dominant Surface (min_length/max_length meters) is persist-only:
    there is no existing Hex length -> snappy level write hook, so this helper
    returns {} for algorithm=hex-dominant and must NOT invent levels from meters.
    """
    algo = str(getattr(project.mesh, "algorithm", "") or "")
    if algo != "hex-dominant-parametric":
        return {}
    sim = project.primary_simulation()
    if sim is None:
        return {}
    from cfddesk.mesh.patches import emit_all_patches
    from cfddesk.project.mesh_refinements import SURFACE_REFINEMENT_TYPE

    stubs = [
        r
        for r in sim.active_mesh().refinements
        if r.type == SURFACE_REFINEMENT_TYPE and r.surface_complete()
    ]
    if not stubs:
        return {}
    face_to_patches: dict[int, list[str]] = {}
    for ep in emit_all_patches(project):
        for fid in ep.face_ids:
            face_to_patches.setdefault(int(fid), []).append(ep.name)
    overrides: dict[str, tuple[int, int]] = {}
    for stub in stubs:
        face_ids = list(stub.face_ids)
        if stub.volume_ids:
            for fid in project.faces_for_volumes(list(stub.volume_ids)):
                if int(fid) not in face_ids:
                    face_ids.append(int(fid))
        lo = max(0, int(stub.min_level))
        hi = max(0, int(stub.max_level))
        if hi < lo:
            lo, hi = hi, lo
        for fid in face_ids:
            for pname in face_to_patches.get(int(fid), []):
                prev = overrides.get(pname)
                if prev is None:
                    overrides[pname] = (lo, hi)
                else:
                    # Prefer finer envelope when multiple stubs share a surface.
                    overrides[pname] = (max(prev[0], lo), max(prev[1], hi))
    return overrides



def _feature_refinement_distance_levels(
    project: Project,
) -> list[tuple[float, int]] | None:
    """Inc 9a: parametric Feature distance/level table -> snappy features.levels.

    Returns a non-empty ``[(distance_m, level), ...]`` when a Feature refinement
    stub exists under hex-dominant-parametric; otherwise ``None`` so the caller
    keeps the fineness-based single ``level`` policy.

    Included angle is intentionally **not** mapped here:
    - Feature edges come from CAD topology (``cadFeatures.eMesh``), not
      surfaceFeatureExtract ``includedAngle``.
    - ``resolveFeatureAngle`` is a separate castellated MeshForm control.
    Mapping Included angle onto either would invent / collide — persist-only.

    Inc 9b Hex-dominant Feature (Distance / Maximum edge length meters) is
    intentionally **not** mapped here: algorithm must be hex-dominant-parametric.
    There is no existing Hex feature-length write hook that maps max edge length
    onto snappy `features.levels` — do NOT invent that conversion.
    """
    algo = str(getattr(project.mesh, "algorithm", "") or "")
    if algo != "hex-dominant-parametric":
        return None
    sim = project.primary_simulation()
    if sim is None:
        return None
    from cfddesk.project.mesh_refinements import FEATURE_REFINEMENT_TYPE

    rows: list[tuple[float, int]] = []
    for stub in sim.active_mesh().refinements:
        if stub.type != FEATURE_REFINEMENT_TYPE:
            continue
        for item in stub.distance_levels or []:
            if not isinstance(item, dict):
                continue
            try:
                rows.append((float(item.get("distance", 0.0)), int(item.get("level", 0))))
            except (TypeError, ValueError):
                continue
    return rows if rows else None


def _bb_layer_snappy_write(project: Project) -> None:
    """Inc 12a: Bounding box layer addition -> snappy (no invent).

    Parametric DA fields (Face Min X, Layers, Expansion ratio, Min thickness,
    Final thickness) persist on the stub. A real mesher write would require a
    Bounding-box-face layer path distinct from Inflate ``addLayers``.

    Do NOT invent that path by copying Inflate addLayers / Assigned Faces
    wall-patch layer controls. There is no existing BB-face -> snappy
    layer-control writer for Min X (or other BB faces) of the blockMesh
    background box.

    Therefore Face / Layers / thicknesses are **persist-only** here.
    Returns None always (no invent). Callers must not treat BB-layer stubs
    as Inflate layer sources.
    """
    _ = project  # read for future mapped write; intentionally unused
    return None



def _extrusion_mesh_write(project: Project) -> None:
    """Inc 13a/15a: Extrusion mesh refinement -> mesher (no invent).

    Standard DA fields (Sweep sizing type, Thickness / Number of elements,
    Surface element type, Specify start/end mesh size, Enable Grading,
    Start faces, End faces) plus Inc 15a On-toggle fields (Maximum edge
    length, First element thickness, Growth rate, Side Start face | End
    face | Both) persist on the stub. There is no existing OpenFOAM/
    snappy/cfMesh extrusion / grading write path for these fields.

    Do NOT invent an extrusion write by mapping Thickness / Number of
    elements / Start-End faces / grading onto snappy layers or cfMesh
    boundaryLayers.

    Therefore Extrusion fields are **persist-only** here.
    Returns None always (no invent).
    """
    _ = project  # read for future mapped write; intentionally unused
    return None


def _region_refinement_snappy_regions(project: Project) -> None:
    """Inc 11a/11b: Region persist fields -> snappy refinementRegions (no invent).

    Parametric (11a) DA fields (mode Inside, Level, Assigned Volumes,
    Geometry primitives, Background Mesh Box) and Hex (11b) DA fields
    (mode Inside, Maximum edge length, Assigned Volumes, Geometry
    primitives) persist on the stub. A real snappy write requires
    searchable geometry entries under snappyHexMeshDict.geometry that the
    Assigned Volumes / Geometry primitives can map onto.

    This slice does **not** invent that path:
    - Geometry primitives is an empty list + add affordance only (no
      primitive-row fields / searchableBox invent).
    - CAD volume_ids resolve to face ids via faces_for_volumes (used by
      Surface refinementSurfaces), but there is no existing volume ->
      searchable surface/region geometry writer.
    - Hex Maximum edge length must NOT be converted into snappy levels /
      refinementRegions entries (persist-only; no invent from meters).

    Therefore Level / max edge length are **persist-only** here:
    refinementRegions stays empty in write_snappy_hex_mesh_dict until a
    mapped assignment path exists. Returns None always (no invent).
    """
    _ = project  # read for future mapped write; intentionally unused
    return None


def write_snappy_hex_mesh_dict(
    path: Path,
    *,
    location_m: tuple[float, float, float],
    patches: list[tuple[str, int | tuple[int, int], str]] | None = None,
    refinement_inlet: int | None = None,
    refinement_outlet: int | None = None,
    refinement_walls: int | None = None,
    add_layers: bool = False,
    layer_n_surface: int | None = None,
    layer_expansion_ratio: float | None = None,
    layer_final_thickness: float | None = None,
    layer_min_thickness: float | None = None,
    layer_specs: list[tuple[str, int]] | None = None,
    feature_edge_file: str | None = None,
    feature_level: int = 2,
    feature_levels: list[tuple[float, int]] | None = None,
    snap_n_smooth_patch: int = 3,
    snap_tolerance: float = 2.0,
    snap_n_solve_iter: int = 100,
    snap_n_relax_iter: int = 5,
    snap_n_feature_snap_iter: int = 15,
    # Stock Hex-dominant defaults; Hex-dominant parametric passes SimScale values.
    max_local_cells: int = 2_000_000,
    max_global_cells: int = 4_000_000,
    min_refinement_cells: int = 0,
    max_load_unbalance: float = 0.10,
    n_cells_between_levels: int = 2,
    resolve_feature_angle: float = 20.0,
    allow_free_standing_zone_faces: bool = True,
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
        if isinstance(level, (tuple, list)) and len(level) >= 2:
            lvl_lo, lvl_hi = int(level[0]), int(level[1])
        else:
            lvl_lo = lvl_hi = int(level)
        refine_blocks.append(
            f"""        {name}
        {{
            level ({lvl_lo} {lvl_hi});
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
        n_surface_layers=layer_n_surface,
        expansion_ratio=layer_expansion_ratio,
        final_layer_thickness=layer_final_thickness,
        min_thickness=layer_min_thickness,
        layer_specs=layer_specs,
    )
    feat_lvl = max(0, int(feature_level))
    if feature_edge_file:
        # Inc 9a: when parametric Feature distance/level rows exist, write
        # snappy ``levels ((distance level) ...)`` — clean map. Otherwise keep
        # fineness-based single ``level``.
        if feature_levels:
            levels_txt = " ".join(
                f"({float(d):.8g} {int(lv)})" for d, lv in feature_levels
            )
            features_block = f"""
    {{
        file "{feature_edge_file}";
        levels ({levels_txt});
    }}"""
        else:
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
    maxLocalCells {int(max_local_cells)};
    maxGlobalCells {int(max_global_cells)};
    minRefinementCells {int(min_refinement_cells)};
    maxLoadUnbalance {float(max_load_unbalance):.8g};
    nCellsBetweenLevels {int(n_cells_between_levels)};

    features
    (
{features_block}
    );

    refinementSurfaces
    {{
{refinement}
    }}

    resolveFeatureAngle {float(resolve_feature_angle):.8g};

    refinementRegions
    {{
    }}

    locationInMesh ({_fmt(lx)} {_fmt(ly)} {_fmt(lz)});
    allowFreeStandingZoneFaces {"true" if allow_free_standing_zone_faces else "false"};
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
    algo = str(getattr(project.mesh, "algorithm", "hex-dominant") or "hex-dominant")
    # Inc 14a.2-ship (choice A): parametric Level-0 = geometry-derived Hex helper
    # (same path Hex uses). Do NOT consume SimScale-seeded bbox_resolution 67/62/24
    # and do NOT hardcode MTP1's 33/33/74.
    n_cells_override = None
    bbox_level0_source = "geometry_derived_hex_helper"
    nx, ny, nz = write_block_mesh_dict(
        system / "blockMeshDict",
        bbox_m=bbox_m,
        base_cell_m=base_cell_m,
        n_cells=n_cells_override,
    )
    levels = refinement if refinement is not None else MeshRefinement(
        inlet=refinement_level, outlet=refinement_level, walls=1
    )
    # Role levels come from MeshSettings.refinement (physics / Advanced).
    bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
    surf_overrides = _surface_refinement_level_overrides(project)
    patches: list[tuple[str, int | tuple[int, int], str]] = []
    for ep in emit_all_patches(project):
        bc = bc_by_id.get(ep.bc_id)
        level: int | tuple[int, int] = _refinement_level_for_patch(
            levels,
            name=ep.name,
            patch_type=ep.patch_type,
            bc=bc,
            emitted_level=int(ep.refinement_level),
        )
        if ep.name in surf_overrides:
            level = surf_overrides[ep.name]
        patches.append((ep.name, level, ep.patch_type))

    # CAD topological edges → explicit feature snap (preserves rims / sharp corners
    # that coarse hex faces would otherwise cut).
    from cfddesk.cad.step import shape_diagonal
    from cfddesk.mesh.feature_edges import write_cad_feature_emesh

    diag_m = float(shape_diagonal(solid)) * float(s)
    from cfddesk.mesh.cad_adherence import hex_writer_edge_sizing

    _edge_sz = hex_writer_edge_sizing(
        base_cell_m=float(base_cell_m),
        walls_level=int(levels.walls),
        diag_m=diag_m,
    )
    wall_cell = float(_edge_sz["wall_cell_m"])
    edge_defl_m = float(_edge_sz["edge_defl_m"])
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

    cast_kwargs: dict = {}
    if algo == "hex-dominant-parametric":
        m = project.mesh
        cast_kwargs = {
            "max_local_cells": int(getattr(m, "max_local_cells", 40_000_000)),
            "max_global_cells": int(getattr(m, "max_global_cells", 100_000_000)),
            "min_refinement_cells": int(getattr(m, "min_refinement_cells", 1)),
            "max_load_unbalance": float(getattr(m, "max_load_unbalance", 0.2)),
            "n_cells_between_levels": int(getattr(m, "cells_between_levels", 3)),
            "resolve_feature_angle": float(
                getattr(m, "resolve_feature_angle", 30.0)
            ),
            "allow_free_standing_zone_faces": bool(
                getattr(m, "allow_free_standing_zone_faces", False)
            ),
        }

    inflate_cfg = _inflate_layer_write_config(project)
    if inflate_cfg is not None:
        add_layers_flag = True
        layer_kwargs = {
            "layer_n_surface": inflate_cfg["n_surface_layers"],
            "layer_expansion_ratio": inflate_cfg["expansion_ratio"],
            "layer_final_thickness": inflate_cfg["final_layer_thickness"],
            "layer_min_thickness": inflate_cfg["min_thickness"],
            "layer_specs": inflate_cfg["layer_specs"],
        }
    else:
        add_layers_flag = bool(project.mesh.add_layers)
        layer_kwargs = {}

    feature_distance_levels = _feature_refinement_distance_levels(project)
    # Inc 11a: Region Level persist-only until searchable geometry mapped.
# Inc 12a: BB layer addition persist-only — do NOT invent Inflate addLayers.
    _region_refinement_snappy_regions(project)

    write_snappy_hex_mesh_dict(
        system / "snappyHexMeshDict",
        location_m=location.point_metres,
        patches=patches,
        add_layers=add_layers_flag,
        feature_edge_file=feature_file,
        feature_level=feature_level,
        feature_levels=feature_distance_levels,
        snap_n_smooth_patch=snap.n_smooth_patch,
        snap_tolerance=snap.tolerance,
        snap_n_solve_iter=snap.n_solve_iter,
        snap_n_relax_iter=snap.n_relax_iter,
        snap_n_feature_snap_iter=snap.n_feature_snap_iter,
        **layer_kwargs,
        **cast_kwargs,
    )
    write_mesh_quality_dict(system / "meshQualityDict")
    write_control_dict(system / "controlDict")
    write_fv_schemes(system / "fvSchemes")
    write_fv_solution(system / "fvSolution")

    return {
        "case_dir": str(case_dir),
        "stls": {k: str(v) for k, v in stls.items()},
        "algorithm": algo,
        "block_cells": (nx, ny, nz),
        "bbox_resolution": (nx, ny, nz),
        "bbox_level0_source": bbox_level0_source,
        "castellated": cast_kwargs or None,
        "refinement": levels.to_dict(),
        "add_layers": bool(add_layers_flag),
        "inflate_layers": inflate_cfg,
        "surface_refinement_levels": surf_overrides or None,
        "feature_refinement_levels": feature_distance_levels,

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
        "wall_cell_m": wall_cell,
        "edge_defl_m": edge_defl_m,
        "edge_threshold_m": float(_edge_sz["threshold_m"]),
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
    """Write Standard mesh case for gmsh (all-tet) or hexcore (cfMesh / body-fit).

    Product mapping:
    - ``hex_element_core=True`` + ``hexcore_backend=cfmesh`` (default) →
      multi-solid STL + ``meshDict`` for ``cartesianMesh``.
    - ``hex_element_core=True`` + ``hexcore_backend=bodyfit`` → OCC surface,
      Cartesian hex flood, Delaunay peel → ``geometry.msh`` for gmshToFoam.
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
    hexcore_backend = str(getattr(project.mesh, "hexcore_backend", "cfmesh") or "cfmesh")
    types = emitted_patch_types(project)
    type_lines = "\n".join(f"{n} {t}" for n, t in sorted(types.items()))
    (tri / "patch_types.txt").write_text(type_lines + "\n", encoding="utf-8")

    write_control_dict(system / "controlDict")
    write_fv_schemes(system / "fvSchemes")
    write_fv_solution(system / "fvSolution")
    write_mesh_quality_dict(system / "meshQualityDict")

    if want_hexcore and hexcore_backend == "bodyfit":
        from cfddesk.mesh.hexcore_bodyfit import run_hexcore_bodyfit

        loc_m = tuple(float(c) for c in location.point_metres)
        body = run_hexcore_bodyfit(
            solid,
            project,
            case_dir=case_dir,
            location_m=loc_m,  # type: ignore[arg-type]
            base_cell_m=float(base_cell_m),
            refinement=levels,
        )
        host_log = (
            "backend=bodyfit OCC-surface + Cartesian hex + Delaunay peel\n"
            "hex_core=ok\n"
            + body.log_text
        )
        (case_dir / "log.bodyfit_host.txt").write_text(host_log, encoding="utf-8")
        return {
            "case_dir": str(case_dir),
            "algorithm": "standard",
            "backend": "bodyfit",
            "hex_element_core": True,
            "hexcore_backend": "bodyfit",
            "hex_core": "ok",
            "msh": str(body.msh_path),
            "surface_msh": str(body.surface_msh_path),
            "n_hex": body.n_hex,
            "n_pyr": body.n_pyr,
            "n_prism": body.n_prism,
            "n_tet": body.n_tet,
            "n_nodes": body.n_nodes,
            "hex_volume_frac": body.hex_volume_frac,
            "peel_m": body.peel_m,
            "cell_m": body.cell_m,
            "surface_gate_ok": body.surface_gate_ok,
            "patches": sorted(types),
            "refinement": levels.to_dict(),
            "location_m": location.point_metres,
            "location_method": location.method,
            "passage": passage_check.message,
            "base_cell_m": float(base_cell_m),
            "bodyfit_log": host_log,
        }

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
