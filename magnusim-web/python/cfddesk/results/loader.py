"""Load OpenFOAM / VTK result meshes for the results viewer."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyvista as pv

# VTK_POLYHEDRON — snappyHexMesh produces these; vtkPolyhedron cannot contour/slice them.
_VTK_POLYHEDRON = 42


# The case sidecar the solve writes next to its case (w27-case.json); its
# ``result_fields`` list the analysis's result fields in order.
CASE_SIDECAR = "w27-case.json"


@dataclass
class ResultMesh:
    path: Path
    grid: pv.UnstructuredGrid | pv.PolyData
    n_cells: int
    n_points: int
    field_name: str
    # True when the mesh carries a vector (or a vector magnitude already derived).
    has_magnitude: bool
    reader: str = "vtu"  # "foam" | "vtu"
    polyhedra_decomposed: bool = False


def _is_user_scalar_name(name: str) -> bool:
    """Skip VTK bookkeeping arrays (e.g. vtkOriginalCellIds after triangulate)."""
    return bool(name) and not str(name).lower().startswith("vtk")


def _magnitude_base(name: str) -> str:
    """``X`` for a shown name ``magX``, else ''."""
    name = str(name or "")
    return name[3:] if name.startswith("mag") and len(name) > 3 else ""


def _is_vector(arr: object) -> bool:
    a = np.asarray(arr)
    return a.ndim == 2 and a.shape[1] == 3


def _vector_names(grid: pv.DataSet) -> list[str]:
    """Names of the 3-component arrays on the grid (cell data first, then points)."""
    out: list[str] = []
    for data in (grid.cell_data, grid.point_data):
        for name in data.keys():
            name = str(name)
            if _is_user_scalar_name(name) and name not in out and _is_vector(data[name]):
                out.append(name)
    return out


def _derive_magnitude(grid: pv.DataSet, name: str) -> bool:
    """Put ``mag<X>`` (|X|) wherever vector ``X`` is; False when the grid has no such vector.

    Always recomputed, so prep / cache / cut paths cannot keep a stale magnitude."""
    base = _magnitude_base(name)
    found = False
    if base:
        for data in (grid.cell_data, grid.point_data):
            if base in data and _is_vector(data[base]):
                data[name] = np.linalg.norm(np.asarray(data[base])[:, :3], axis=1)
                found = True
    return found


def has_vector_magnitude(grid: pv.DataSet, field_name: str = "") -> bool:
    """True when ``field_name`` is a vector magnitude, or the grid holds a vector or a derived magnitude."""
    if _magnitude_base(field_name) or _vector_names(grid):
        return True
    return any(_magnitude_base(str(n)) for n in grid.cell_data.keys())


def case_result_fields(case_dir: str | Path) -> list[str]:
    """The keys of the analysis's result fields the case sidecar lists, in order ([] when none)."""
    try:
        doc = json.loads((Path(case_dir) / CASE_SIDECAR).read_text(encoding="utf-8"))
    except Exception:
        return []
    rows = doc.get("result_fields") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        return []
    keys: list[str] = []
    for row in rows:
        key = row.get("key") if isinstance(row, dict) else row
        key = str(key or "").strip()
        if key and key not in keys:
            keys.append(key)
    return keys


def _shown_name(grid: pv.DataSet, key: str) -> str:
    """The name ``key`` is shown by on this grid: ``mag<key>`` for a vector, the key for a
    scalar (or an already-derived magnitude); '' when the grid does not carry it."""
    for data in (grid.cell_data, grid.point_data):
        if key in data:
            arr = np.asarray(data[key])
            if _is_vector(arr):
                return "mag" + key
            return key if arr.ndim == 1 else ""
    return key if _derive_magnitude(grid, key) else ""


def ensure_colour_field(grid: pv.DataSet, defaults: Sequence[str] = ()) -> str:
    """A field to colour by; return its name.

    The first of ``defaults`` (result field keys, in the analysis's order) the grid
    carries; else the magnitude of the grid's first vector; else a magnitude already
    derived; else its first scalar. Raises when the grid has none.
    """
    for key in defaults:
        name = _shown_name(grid, key)
        if name:
            if _magnitude_base(name):
                _derive_magnitude(grid, name)
            return name
    vectors = _vector_names(grid)
    if vectors:
        name = "mag" + vectors[0]
        _derive_magnitude(grid, name)
        return name
    scalars: list[str] = []
    for data in (grid.cell_data, grid.point_data):
        for name in data.keys():
            name = str(name)
            if _is_user_scalar_name(name) and np.asarray(data[name]).ndim == 1:
                scalars.append(name)
    for name in scalars:
        if _magnitude_base(name):
            return name
    if scalars:
        return scalars[0]
    raise RuntimeError("No suitable scalar field for colouring")


def _pick_field(
    grid: pv.DataSet,
    prefer: str | None,
    *,
    require_field: bool = True,
    defaults: Sequence[str] = (),
) -> str:
    if prefer:
        if prefer in grid.cell_data or prefer in grid.point_data:
            return prefer
        if _derive_magnitude(grid, prefer):
            return prefer
    try:
        return ensure_colour_field(grid, defaults)
    except RuntimeError:
        if require_field:
            raise
        # Geometry-only (mesh with no 0/ fields) — callers that colour must
        # still call ensure_colour_field / handle empty field_name explicitly.
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
    defaults: Sequence[str] = (),
) -> str:
    """Pick a display field; empty string when the case is geometry-only.

    ``defaults`` are the case's result field keys in order (:func:`case_result_fields`).
    ``require_field=False`` (default) lets Mesh Cut / ResultsSession open a
    freshly meshed case with no ``0/`` solution fields. Results colouring still
    calls :func:`ensure_colour_field`, which raises if nothing is available.
    ``after_prep`` is kept for callers; a magnitude is recomputed either way.
    """
    field = _pick_field(grid, prefer_field, require_field=require_field, defaults=defaults)
    if field:
        # A magnitude read from a cache or carried through prep is recomputed from its vector.
        _derive_magnitude(grid, field)
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
        grid, prefer_field, require_field=require_field, defaults=case_result_fields(case_dir)
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
            field = _finalize_field(
                grid, prefer_field or field, after_prep=True, defaults=case_result_fields(case_dir)
            )
    return ResultMesh(
        path=foam,
        grid=grid,
        n_cells=int(grid.n_cells),
        n_points=int(grid.n_points),
        field_name=field,
        has_magnitude=has_vector_magnitude(grid, field),
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
    field = ensure_colour_field(grid)
    return ResultMesh(
        path=path,
        grid=grid,
        n_cells=int(grid.n_cells),
        n_points=int(grid.n_points),
        field_name=field,
        has_magnitude=has_vector_magnitude(grid, field),
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
    try:
        field = _finalize_field(grid, prefer_field, require_field=True)
    except RuntimeError:
        names = list(grid.cell_data.keys()) + list(grid.point_data.keys())
        if not names:
            raise
        field = str(names[0])
    return ResultMesh(
        path=paths[0].parent,
        grid=grid,
        n_cells=int(grid.n_cells),
        n_points=int(grid.n_points),
        field_name=field,
        has_magnitude=has_vector_magnitude(grid, field),
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
