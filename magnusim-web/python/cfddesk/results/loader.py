"""Load OpenFOAM / VTK result meshes for the results viewer."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyvista as pv

# VTK_POLYHEDRON — snappyHexMesh produces these; vtkPolyhedron cannot contour/slice them.
_VTK_POLYHEDRON = 42


@dataclass
class ResultMesh:
    path: Path
    grid: pv.UnstructuredGrid | pv.PolyData
    n_cells: int
    n_points: int
    field_name: str
    has_mag_u: bool
    reader: str = "vtu"  # "foam" | "vtu"
    polyhedra_decomposed: bool = False


def _is_user_scalar_name(name: str) -> bool:
    """Skip VTK bookkeeping arrays (e.g. vtkOriginalCellIds after triangulate)."""
    return bool(name) and not str(name).lower().startswith("vtk")


def ensure_mag_u(grid: pv.DataSet) -> str:
    """Ensure magU exists on cell or point data; return field name.

    Always recompute from ``U`` when present so prep/cache/cut paths cannot
    leave a stale or missing derived array.
    """
    cd = grid.cell_data
    pd = grid.point_data
    if "U" in cd:
        u = np.asarray(cd["U"])
        if u.ndim == 2 and u.shape[1] >= 3:
            cd["magU"] = np.linalg.norm(u[:, :3], axis=1)
            return "magU"
    if "U" in pd:
        u = np.asarray(pd["U"])
        if u.ndim == 2 and u.shape[1] >= 3:
            pd["magU"] = np.linalg.norm(u[:, :3], axis=1)
            return "magU"
    if "magU" in cd:
        return "magU"
    if "magU" in pd:
        return "magU"
    for name in list(cd.keys()) + list(pd.keys()):
        if not _is_user_scalar_name(str(name)):
            continue
        arr = cd[name] if name in cd else pd[name]
        if np.asarray(arr).ndim == 1:
            return name
    raise RuntimeError("No suitable scalar field for colouring")


def _ensure_mag_u(grid: pv.DataSet) -> str:
    return ensure_mag_u(grid)


def _pick_field(
    grid: pv.DataSet, prefer: str | None, *, require_field: bool = True
) -> str:
    if prefer:
        if prefer in grid.cell_data or prefer in grid.point_data:
            return prefer
        if prefer == "magU":
            try:
                return _ensure_mag_u(grid)
            except RuntimeError:
                if require_field:
                    raise
                return ""
    for name in ("T", "magU", "p", "p_rgh"):
        if name in grid.cell_data or name in grid.point_data:
            if name == "magU":
                return _ensure_mag_u(grid)
            return name
    try:
        return _ensure_mag_u(grid)
    except RuntimeError:
        if require_field:
            raise
        # Geometry-only (mesh with no 0/ fields) — callers that colour must
        # still call ensure_mag_u / handle empty field_name explicitly.
        return ""


def _extract_internal_grid(block: pv.DataSet) -> pv.DataSet | None:
    """Pull internalMesh from a region MultiBlock, or return the block itself."""
    if isinstance(block, pv.UnstructuredGrid) and block.n_cells > 0:
        return block
    if isinstance(block, pv.MultiBlock):
        for name in block.keys():
            if name is None:
                continue
            key = str(name).lower()
            if "internal" in key:
                child = block[name]
                if child is not None and getattr(child, "n_cells", 0) > 0:
                    return child
        best = None
        best_n = 0
        for child in block:
            if child is None:
                continue
            if isinstance(child, pv.MultiBlock):
                inner = _extract_internal_grid(child)
                if inner is not None and inner.n_cells > best_n:
                    best, best_n = inner, inner.n_cells
            elif isinstance(child, pv.UnstructuredGrid) and child.n_cells > best_n:
                best, best_n = child, child.n_cells
        return best
    return None


def _combine_foam_multiblock(mb: pv.MultiBlock) -> pv.UnstructuredGrid:
    """Merge region internalMeshes. Skip defaultRegion when named regions exist.

    Multi-region CHT cases expose both the pre-split ``defaultRegion`` (~full
    cell count) and per-region blocks that sum to the same count — combining
    both double-counts.
    """
    keys = [str(k) for k in mb.keys() if k is not None]
    region_keys = [k for k in keys if k != "defaultRegion"]
    use_keys = region_keys if region_keys else keys

    parts: list[pv.DataSet] = []
    for name in use_keys:
        child = mb[name]
        if child is None:
            continue
        internal = _extract_internal_grid(child)
        if internal is not None and internal.n_cells > 0:
            parts.append(internal)
    if not parts:
        # Fall back to defaultRegion / top-level internalMesh
        internal = _extract_internal_grid(mb)
        if internal is None:
            raise RuntimeError("OpenFOAM reader returned no internal mesh blocks")
        parts = [internal]
    if len(parts) == 1 and isinstance(parts[0], pv.UnstructuredGrid):
        return parts[0]
    combined = pv.MultiBlock(parts).combine(merge_points=False)
    if not isinstance(combined, pv.UnstructuredGrid):
        combined = pv.UnstructuredGrid(combined)
    return combined

def find_foam_marker(case_dir: Path) -> Path:
    case_dir = Path(case_dir)
    foams = list(case_dir.glob("*.foam"))
    if foams:
        return foams[0]
    raise FileNotFoundError(f"No *.foam marker under {case_dir}")


def _try_reader_decompose_polyhedra(reader: pv.OpenFOAMReader) -> bool:
    """Enable vtkOpenFOAMReader::SetDecomposePolyhedra when the VTK build has it.

    VTK 9.6's vtkOpenFOAMReader in this env has no Get/SetDecomposePolyhedra —
    PyVista still exposes the property and raises AttributeError. Returns True
    only when the flag was actually applied.
    """
    try:
        reader.decompose_polyhedra = True
        return bool(reader.decompose_polyhedra)
    except Exception:
        return False


def prepare_grid_for_slice(grid: pv.UnstructuredGrid) -> tuple[pv.UnstructuredGrid, bool]:
    """Ensure the grid can be sliced/contoured by VTK.

    snappyHexMesh polyhedra hit ``vtkPolyhedron`` non-manifold triangulation
    warnings and drop out of the slice. VTK 9.3+ removed reader-level
    ``SetDecomposePolyhedra``; triangulate **polyhedra only** and merge back
    with hex/prism cells (~2.5× expansion vs ~6.7× for full triangulate).
    """
    if not isinstance(grid, pv.UnstructuredGrid):
        grid = pv.UnstructuredGrid(grid)
    ct = np.asarray(grid.celltypes)
    if ct.size == 0:
        return grid, False
    poly_mask = ct == _VTK_POLYHEDRON
    if not np.any(poly_mask):
        return grid, False
    if np.all(poly_mask):
        tri = grid.triangulate()
        if not isinstance(tri, pv.UnstructuredGrid):
            tri = pv.UnstructuredGrid(tri)
        return tri, True
    poly = grid.extract_cells(poly_mask)
    rest = grid.extract_cells(~poly_mask)
    pt = poly.triangulate()
    merged = pv.MultiBlock([rest, pt]).combine(merge_points=True)
    if not isinstance(merged, pv.UnstructuredGrid):
        merged = pv.UnstructuredGrid(merged)
    return merged, True


def _finalize_field(
    grid: pv.UnstructuredGrid,
    prefer_field: str | None,
    *,
    after_prep: bool = False,
    require_field: bool = False,
) -> str:
    """Pick a display field; empty string when the case is geometry-only.

    ``require_field=False`` (default) lets Mesh Cut / ResultsSession open a
    freshly meshed case with no ``0/`` solution fields. Results colouring still
    calls :func:`ensure_mag_u`, which raises if nothing is available.
    """
    field = _pick_field(grid, prefer_field, require_field=require_field)
    if prefer_field in (None, "magU") and (
        field == "magU" or "U" in grid.cell_data or "U" in grid.point_data
    ):
        try:
            if "U" in grid.cell_data or "U" in grid.point_data:
                field = _ensure_mag_u(grid)
        except RuntimeError:
            if after_prep:
                field = _pick_field(
                    grid, prefer_field, require_field=require_field
                )
            elif require_field:
                raise
            else:
                field = ""
    return field


def read_foam_grid(
    case_dir: str | Path,
    *,
    prefer_field: str | None = None,
    require_field: bool = False,
) -> tuple[pv.UnstructuredGrid, Path, str, bool]:
    """Read OpenFOAM case to an UnstructuredGrid **without** polyhedra prep.

    Returns ``(grid, foam_path, field_name, reader_decompose_applied)``.
    ``field_name`` may be ``""`` when the mesh has no solution scalars
    (``require_field=False``, the default — needed for post-mesh Mesh Cut).
    """
    case_dir = Path(case_dir)
    foam = find_foam_marker(case_dir)
    reader = pv.OpenFOAMReader(str(foam))
    reader_decomposed = _try_reader_decompose_polyhedra(reader)
    try:
        reader.skip_zero_time = False
    except Exception:
        pass
    if reader.number_time_points > 0:
        reader.set_active_time_point(reader.number_time_points - 1)
    mb = reader.read()
    if not isinstance(mb, pv.MultiBlock):
        grid = mb
        if not isinstance(grid, pv.UnstructuredGrid):
            grid = pv.UnstructuredGrid(grid)
    else:
        grid = _combine_foam_multiblock(mb)
    field = _finalize_field(
        grid, prefer_field, require_field=require_field
    )
    return grid, foam, field, reader_decomposed


def load_foam_case(
    case_dir: str | Path,
    *,
    prefer_field: str | None = None,
    prepare: bool = True,
) -> ResultMesh:
    """Load a case via VTK/PyVista native OpenFOAM reader (production path).

    When ``prepare`` is True (default), selectively triangulate polyhedra so
    slices/streamlines work. Prefer :class:`ResultsSession` for caching.
    """
    grid, foam, field, reader_decomposed = read_foam_grid(
        case_dir, prefer_field=prefer_field
    )
    tri_decomposed = False
    if prepare:
        grid, tri_decomposed = prepare_grid_for_slice(grid)
        if tri_decomposed:
            field = _finalize_field(grid, prefer_field or field, after_prep=True)
    return ResultMesh(
        path=foam,
        grid=grid,
        n_cells=int(grid.n_cells),
        n_points=int(grid.n_points),
        field_name=field,
        has_mag_u=field == "magU" or "U" in grid.cell_data or "U" in grid.point_data,
        reader="foam",
        polyhedra_decomposed=reader_decomposed or tri_decomposed,
    )


def load_vtu(path: str | Path) -> ResultMesh:
    path = Path(path)
    grid = pv.read(path)
    if not isinstance(grid, (pv.UnstructuredGrid, pv.PolyData)):
        if isinstance(grid, pv.MultiBlock):
            grid = grid.combine()
        else:
            grid = pv.UnstructuredGrid(grid)
    if not isinstance(grid, pv.UnstructuredGrid):
        grid = pv.UnstructuredGrid(grid)
    grid, decomp = prepare_grid_for_slice(grid)
    field = _ensure_mag_u(grid)
    return ResultMesh(
        path=path,
        grid=grid,
        n_cells=int(grid.n_cells),
        n_points=int(grid.n_points),
        field_name=field,
        has_mag_u=field == "magU" or "U" in grid.cell_data or "U" in grid.point_data,
        reader="vtu",
        polyhedra_decomposed=decomp,
    )


def find_internal_vtu(case_or_vtk_dir: str | Path) -> Path:
    """Locate foamToVTK internal.vtu under a case or VTK directory (fallback)."""
    root = Path(case_or_vtk_dir)
    candidates = list(root.rglob("internal.vtu"))
    if not candidates:
        candidates = list(root.rglob("*.vtu"))
    if not candidates:
        raise FileNotFoundError(f"No VTU under {root}")
    return max(candidates, key=lambda p: p.stat().st_size)


def load_merged_vtus(paths: list[Path], *, prefer_field: str = "T") -> ResultMesh:
    """Merge multiple VTUs (legacy stress path — not Gate B0)."""
    grids = [pv.read(p) for p in paths]
    mb = pv.MultiBlock(grids)
    grid = mb.combine(merge_points=False)
    field = prefer_field
    if field not in grid.cell_data and field not in grid.point_data:
        try:
            field = _ensure_mag_u(grid)
        except RuntimeError:
            names = list(grid.cell_data.keys()) + list(grid.point_data.keys())
            if not names:
                raise
            field = names[0]
    elif field == "magU" or "U" in grid.cell_data:
        field = _ensure_mag_u(grid)
    return ResultMesh(
        path=paths[0].parent,
        grid=grid,
        n_cells=int(grid.n_cells),
        n_points=int(grid.n_points),
        field_name=field,
        has_mag_u="magU" in grid.cell_data or "U" in grid.cell_data,
        reader="vtu",
    )


def load_case_results(
    case_dir: str | Path,
    *,
    prefer_field: str | None = None,
    allow_vtu_fallback: bool = True,
) -> ResultMesh:
    """Production load: native OpenFOAM reader; VTU only as explicit fallback."""
    case_dir = Path(case_dir)
    try:
        return load_foam_case(case_dir, prefer_field=prefer_field)
    except FileNotFoundError:
        if not allow_vtu_fallback:
            raise
    except Exception:
        if not allow_vtu_fallback:
            raise
    vtu = find_internal_vtu(case_dir)
    mesh = load_vtu(vtu)
    if prefer_field and prefer_field in mesh.grid.cell_data:
        mesh.field_name = prefer_field
    return mesh
