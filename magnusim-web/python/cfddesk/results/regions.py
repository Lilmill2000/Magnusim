"""Results of a multi-region case (conjugate heat transfer, host API 1.8).

A multi-region case lists its regions in its ``w27-case.json`` (``regions``:
``[{name, role}]``, written by its analysis's case writer). Its mesh is split
into ``constant/<region>/polyMesh`` and each saved time holds a folder per
region (``<t>/<region>/T``); the unsplit ``constant/polyMesh`` stays beside them.

- The reader reads each region's ``/<region>/internalMesh`` and never the
  unsplit mesh (it would come back as a second mesh with no fields).
- The regions merge into one grid, points not merged (a region's points carry
  its own values). An array only some regions have (U in the fluid) is filled
  with NaN on the others, in the reader's dtype and width (VTK drops an array
  whose type differs between the pieces); the viewer shows NaN grey.
- :data:`REGION_ARRAY` on the points and the cells is each one's region (its
  index in the case's list), so a slice, an iso surface or a surface still says
  which region a point is in. VTK bookkeeping names (``vtk*``) are never offered
  as a field.

A case with no ``regions`` reads as before.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from cfddesk.wsl.region_rule import ROLES as _ROLES
from cfddesk.wsl.region_rule import parse_regions

REGION_ARRAY = "vtkRegion"
CASE_SIDECAR = "w27-case.json"
ROLES = _ROLES


def case_regions(case_dir: str | Path) -> list[dict[str, str]]:
    """The case's regions ``[{name, role}]`` from its sidecar, in its order; [] for
    a case of one region (or a list that is not valid by the one rule,
    ``cfddesk.wsl.region_rule.parse_regions``: the runner refuses such a case, so it
    never has region results). Other keys in a row are ignored."""
    try:
        doc = json.loads((Path(case_dir) / CASE_SIDECAR).read_text(encoding="utf-8"))
        return parse_regions(doc.get("regions") if isinstance(doc, dict) else None)
    except Exception:
        return []


def region_names(case_dir: str | Path) -> list[str]:
    return [r["name"] for r in case_regions(case_dir)]


def field_dirs(case_dir: str | Path, time: str) -> list[Path]:
    """Where a saved time's field files are: ``<t>/``, or each ``<t>/<region>/``."""
    base = Path(case_dir) / str(time)
    names = region_names(case_dir)
    return [base / r for r in names] if names else [base]


def mesh_dirs(case_dir: str | Path) -> list[Path]:
    """The case's ``polyMesh`` folders the results read: ``constant/polyMesh``, or
    each ``constant/<region>/polyMesh``."""
    names = region_names(case_dir)
    const = Path(case_dir) / "constant"
    return [const / r / "polyMesh" for r in names] if names else [const / "polyMesh"]


def stamp_files(case_dir: str | Path, time: str) -> list[Path]:
    """The files a cached read of this time depends on: every field file of the
    time (in every region) and each mesh's ``points``."""
    out: list[Path] = []
    for folder in field_dirs(case_dir, time):
        try:
            out.extend(sorted(f for f in folder.iterdir() if f.is_file() and not f.name.startswith(".")))
        except OSError:
            continue
    out.extend(p / "points" for p in mesh_dirs(case_dir) if (p / "points").is_file())
    return out


def regions_without(case_dir: str | Path, time: str, name: str) -> list[dict[str, str]]:
    """The regions whose folder of this time has no file for shown field ``name``
    (``mag<X>`` reads vector ``X``): where the field is not defined. [] for a case of
    one region."""
    base = name[3:] if name.startswith("mag") and len(name) > 3 else ""
    out = []
    for region in case_regions(case_dir):
        folder = Path(case_dir) / str(time) / region["name"]
        if not (folder / name).is_file() and not (base and (folder / base).is_file()):
            out.append(region)
    return out


# ---------------------------------------------------------------------------
# Reading (pyvista)
# ---------------------------------------------------------------------------


def enable_regions(reader: Any, regions: list[str]) -> None:
    """Read only each region's internal mesh, never the unsplit ``constant/polyMesh``."""
    reader.disable_all_patch_arrays()
    known = set(reader.patch_array_names)
    for name in regions:
        entry = f"/{name}/internalMesh"
        if entry in known:
            reader.enable_patch_array(entry)


def _internal(block: Any) -> Any:
    import pyvista as pv

    if isinstance(block, pv.UnstructuredGrid):
        return block if block.n_cells > 0 else None
    if isinstance(block, pv.MultiBlock):
        for key in block.keys():
            if key is not None and "internal" in str(key).lower():
                child = block[key]
                if child is not None and getattr(child, "n_cells", 0) > 0:
                    return child
        for child in block:
            found = _internal(child) if child is not None else None
            if found is not None:
                return found
    return None


def region_grids(mb: Any, regions: list[str]) -> list[tuple[str, Any]]:
    """``(region, internal mesh)`` of each region the reader's output holds, in the
    case's order."""
    keys = [str(k) for k in mb.keys() if k is not None]
    out = []
    for name in regions:
        if name in keys:
            grid = _internal(mb[name])
            if grid is not None:
                out.append((name, grid))
    return out


def _specs(parts: list[tuple[str, Any]], assoc: str) -> dict[str, tuple[Any, tuple[int, ...]]]:
    """name -> (dtype, trailing shape) of every float array any part has (first seen wins)."""
    specs: dict[str, tuple[Any, tuple[int, ...]]] = {}
    for _name, grid in parts:
        data = getattr(grid, assoc)
        for key in data.keys():
            arr = np.asarray(data[key])
            if key not in specs and np.issubdtype(arr.dtype, np.floating):
                specs[str(key)] = (arr.dtype, tuple(arr.shape[1:]))
    return specs


def merge_regions(parts: list[tuple[str, Any]], regions: list[str]) -> Any:
    """One grid of the regions' internal meshes (points not merged), every float
    array kept: NaN where a region has no such array, in the same dtype and width.
    :data:`REGION_ARRAY` is each point's and cell's region index in ``regions``."""
    import pyvista as pv

    point_specs = _specs(parts, "point_data")
    cell_specs = _specs(parts, "cell_data")
    pieces = []
    for name, grid in parts:
        grid = grid.copy(deep=False)
        for assoc, specs, n in (("point_data", point_specs, grid.n_points), ("cell_data", cell_specs, grid.n_cells)):
            data = getattr(grid, assoc)
            for key, (dtype, tail) in specs.items():
                if key not in data:
                    data[key] = np.full((n, *tail), np.nan, dtype=dtype)
                elif np.asarray(data[key]).dtype != dtype:
                    data[key] = np.asarray(data[key]).astype(dtype)
            data[REGION_ARRAY] = np.full(n, float(regions.index(name)), dtype=np.float32)
        pieces.append(grid)
    if len(pieces) == 1:
        merged = pieces[0]
    else:
        merged = pv.MultiBlock(pieces).combine(merge_points=False)
    if not isinstance(merged, pv.UnstructuredGrid):
        merged = merged.cast_to_unstructured_grid()
    return merged


def read_regions(reader: Any, regions: list[str]) -> Any:
    """The reader's active time, every region merged (:func:`merge_regions`); None
    when no region has cells."""
    enable_regions(reader, regions)
    parts = region_grids(reader.read(), regions)
    return merge_regions(parts, regions) if parts else None

