"""What a plan's Hex-dominant mesh will be, worked out before Generate with the mesher's own
sizing functions (``cfddesk.mesh.snappy_hexdominant``): the background block (at least 8
cells across y and 12 across z, whatever the fineness, and along a long thin part as many as
keep its cells within 3 times as long as their side across y), the cell size on each axis at the
walls' level and at each custom size's level (a custom size becomes a level of the
diagonal's base size, so on a thin part its cells come out finer and flatter than asked),
the wall layers' stack against the wall cell, and a rough cell count.

The count is an order of magnitude, not a prediction: the background block's cells inside
the part, plus about three cells deep at each surface's level (or, for a custom size with a
Refine out to, its band out to that distance: the faces' area times the distance, grown as
around a sphere of the same area), plus the layers. It reads about 1.3 to 1.4 times case 1's
real meshes. The driver refuses to Generate a plan whose count is
over its cap (``MAGNUSIM_VALIDATION_MAX_CELLS``), so a probe never asks WSL for a mesh it
cannot hold.

With One cell across (2D) on (``mesher_settings.one_cell_across``) and the plan's depth axis
(``mesh.two_d_axis``) the estimate is of the 2D mesh: the background block one cell deep and
sized from the section's diagonal (``base_cell_size(two_d_axis=...)``, as the mesher does), each
side face's cells along its length, a Refine out to's band as a ring around a circle of the
faces' length, and the two end faces left out.
"""

from __future__ import annotations

import math
from typing import Any

# Cells deep at a surface's level: snappy's nCellsBetweenLevels (2, as the mesher writes it)
# and the cell the surface cuts.
BAND_CELLS = 3
# A layer stack this many times the smallest wall cell or more is likely to be shrunk or dropped.
STACK_WARN = 3.0
AXES = ("x", "y", "z")


def shape_bounds_and_volume(shape: Any) -> tuple[list[float], float]:
    """The shape's bounding box ([xmin, xmax, ymin, ymax, zmin, zmax], mm) and volume (mm³)."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return [xmin, xmax, ymin, ymax, zmin, zmax], abs(float(props.Mass()))


def _label_ids(labels: list[str]) -> set[int]:
    out = set()
    for s in labels:
        head = str(s).split("@", 1)[0].strip().lower()
        if head.startswith("face "):
            out.add(int(head[5:]))
    return out


def _tangent_area(face: dict[str, Any], dims: list[float]) -> float:
    """The area of one cell's face on the surface (mm²): the two in-plane sizes for a flat
    face square to an axis, else the mean of the three pairs."""
    n = face.get("normal")
    if face.get("surface_type") == "Plane" and n:
        k = max(range(3), key=lambda i: abs(float(n[i])))
        if abs(float(n[k])) > 0.999:
            a, b = (dims[i] for i in range(3) if i != k)
            return a * b
    return (dims[0] * dims[1] + dims[1] * dims[2] + dims[0] * dims[2]) / 3.0


def estimate(mesh: dict[str, Any], faces: list[dict[str, Any]], bounds_mm: list[float],
             volume_mm3: float) -> dict[str, Any] | None:
    """The Hex-dominant mesh a plan's ``mesh`` asks for (None for another mesher)."""
    settings = mesh.get("settings") or {}
    if (settings.get("advanced") or {}).get("mesh_engine") != "snappy_hexdominant":
        return None
    if (settings.get("mesher_settings") or {}).get("one_cell_across") and mesh.get("two_d_axis") in AXES:
        return _estimate_2d(mesh, faces, bounds_mm, volume_mm3, AXES.index(str(mesh["two_d_axis"])))
    from cfddesk.mesh.snappy_hexdominant import (
        _PAD,
        DEFAULT_BAND_CELLS,
        base_cell_size,
        fineness_params,
        refine_distance_m,
        refinement_level_for_size,
    )
    from cfddesk.mesh.web_refinements import (
        is_inflate,
        is_surface_custom,
        reach_metres,
        size_to_metres,
    )

    f = int(settings.get("fineness") or 5)
    physics = bool(settings.get("physics_based_meshing", True))
    b = [v / 1000.0 for v in bounds_mm]
    bounds_m = {"xmin": b[0], "xmax": b[1], "ymin": b[2], "ymax": b[3], "zmin": b[4], "zmax": b[5]}
    params = fineness_params(f, physics_based=physics, bounds_m=bounds_m)
    block = [int(v) for v in str(params["block"]).strip("()").split()]
    ext_mm = [bounds_mm[1] - bounds_mm[0], bounds_mm[3] - bounds_mm[2], bounds_mm[5] - bounds_mm[4]]
    base_mm = [ext_mm[i] * _PAD / block[i] for i in range(3)]
    walls_level = int(params["walls_level"])
    iso_base_m = base_cell_size(f, bounds_m) or 0.0

    def dims(level: int) -> list[float]:
        return [v / 2**level for v in base_mm]

    level_of = {int(fc["id"]): walls_level for fc in faces}
    customs = []
    for ref in mesh.get("refinements") or []:
        if not is_surface_custom(ref):
            continue
        size_m = size_to_metres(ref.get("default_size", 2), ref.get("default_size_unit") or "mm")
        level = refinement_level_for_size(iso_base_m, size_m)
        ids = _label_ids(ref.get("faces") or [])
        for i in ids:
            level_of[i] = max(level_of.get(i, 0), level)
        reach_m = reach_metres(ref)
        customs.append({"name": ref.get("name"), "size_mm": size_m * 1000.0, "level": level,
                        "cell_mm": [round(v, 4) for v in dims(level)], "faces": len(ids),
                        **({"reach_mm": reach_m * 1000.0,
                            "distance_mm": round(refine_distance_m(size_m, reach_m) * 1000.0, 4)} if reach_m else {})})
    by_id = {int(fc["id"]): fc for fc in faces}
    surface_cells = 0.0
    finest = walls_level
    face_cells: dict[int, float] = {}
    for fid, fc in by_id.items():
        lv = level_of.get(fid, walls_level)
        finest = max(finest, lv)
        face_cells[fid] = float(fc["area_mm2"]) / _tangent_area(fc, dims(lv))
        surface_cells += BAND_CELLS * face_cells[fid]
    # A custom size with a Refine out to: its band out to the distance in place of its faces'
    # three cells (the band's volume around a sphere of the faces' area, at the custom level).
    for c, ref in zip(customs, [r for r in mesh.get("refinements") or [] if is_surface_custom(r)], strict=True):
        # No distance, or one within the default band: the mesher writes the default band.
        if c.get("distance_mm", 0.0) <= DEFAULT_BAND_CELLS * c["size_mm"] * (1.0 + 1e-9):
            continue
        band_ids = [i for i in _label_ids(ref.get("faces") or []) if i in by_id]
        area = sum(float(by_id[i]["area_mm2"]) for i in band_ids)
        if area <= 0:
            continue
        d = float(c["distance_mm"])
        r_eq = math.sqrt(area / (4.0 * math.pi))
        band = area * d * (1.0 + d / r_eq + d * d / (3.0 * r_eq * r_eq))
        band_cell = dims(int(c["level"]))
        surface_cells += band / (band_cell[0] * band_cell[1] * band_cell[2]) - BAND_CELLS * sum(face_cells[i] for i in band_ids)
    fine = dims(finest)
    surface_cells = min(surface_cells, volume_mm3 / (fine[0] * fine[1] * fine[2]))
    box_mm3 = math.prod(e * _PAD for e in ext_mm)
    background = math.prod(block) * min(1.0, volume_mm3 / box_mm3)
    layers = []
    layer_cells = 0.0
    for ref in mesh.get("refinements") or []:
        if not is_inflate(ref):
            continue
        ids = _label_ids(ref.get("faces") or [])
        n_layers = int(ref.get("n_layers") or 0)
        stack_mm = size_to_metres(ref.get("total_thickness") or 0, ref.get("total_thickness_unit") or "mm") * 1000.0
        cell = min(min(dims(level_of.get(i, walls_level))) for i in ids) if ids else min(dims(walls_level))
        layer_cells += n_layers * sum(face_cells.get(i, 0.0) for i in ids)
        layers.append({"name": ref.get("name"), "n_layers": n_layers, "stack_mm": stack_mm,
                       "smallest_wall_cell_mm": round(cell, 4),
                       "stack_over_smallest_cell": round(stack_mm / cell, 3) if cell else None})
    warnings = [
        f"{x['name']}: the {x['stack_mm']:g} mm layer stack is {x['stack_over_smallest_cell']:g} times the smallest "
        f"wall cell ({x['smallest_wall_cell_mm']:g} mm); the layers may be shrunk or dropped"
        for x in layers
        if x["stack_over_smallest_cell"] and x["stack_over_smallest_cell"] >= STACK_WARN
    ]
    return {
        "mesher": "snappy_hexdominant",
        "fineness": f,
        "bounds_mm": [round(v, 4) for v in bounds_mm],
        "block": block,
        "base_cell_mm": [round(v, 4) for v in base_mm],
        "walls_level": walls_level,
        "wall_cell_mm": [round(v, 4) for v in dims(walls_level)],
        "custom_sizes": customs,
        "layers": layers,
        "n_cells": int(round(background + surface_cells + layer_cells, -3)),
        "n_cells_note": "an order of magnitude (1.3 to 1.4 times case 1's real meshes), not a prediction",
        "warnings": warnings,
    }


def _estimate_2d(mesh: dict[str, Any], faces: list[dict[str, Any]], bounds_mm: list[float], volume_mm3: float,
                 axis: int) -> dict[str, Any]:
    """The 2D (one cell across) Hex-dominant mesh a plan asks for, its depth along ``axis``."""
    from cfddesk.mesh.snappy_hexdominant import (
        _PAD,
        DEFAULT_BAND_CELLS,
        background_of,
        base_cell_size,
        fineness_params,
        refine_distance_m,
        refinement_level_for_size,
    )
    from cfddesk.mesh.web_refinements import (
        is_inflate,
        is_surface_custom,
        reach_metres,
        size_to_metres,
    )

    settings = mesh.get("settings") or {}
    f = int(settings.get("fineness") or 5)
    physics = bool(settings.get("physics_based_meshing", True))
    b = [v / 1000.0 for v in bounds_mm]
    bounds_m = {"xmin": b[0], "xmax": b[1], "ymin": b[2], "ymax": b[3], "zmin": b[4], "zmax": b[5]}
    params = fineness_params(f, physics_based=physics, bounds_m=bounds_m)
    walls_level = int(params["walls_level"])
    base_m = base_cell_size(f, bounds_m, two_d_axis=axis) or 0.0
    ext_mm = [bounds_mm[1] - bounds_mm[0], bounds_mm[3] - bounds_mm[2], bounds_mm[5] - bounds_mm[4]]
    depth_mm = ext_mm[axis]
    inplane = [k for k in range(3) if k != axis]
    # The mesher's own 2D background (two_d.background): at least 8 cells across the section, its
    # long side at most 3 times its short one (the aspect cap), one cell along the depth.
    block = background_of(f, bounds_m, two_d={"axis": axis, "base_m": base_m}) or [1, 1, 1]
    base_mm = [depth_mm if k == axis else ext_mm[k] * _PAD / block[k] for k in range(3)]

    def dims(level: int) -> list[float]:
        return [v if k == axis else v / 2**level for k, v in enumerate(base_mm)]

    def along(level: int) -> float:
        d = dims(level)
        return 0.5 * (d[inplane[0]] + d[inplane[1]])

    def area_cell(level: int) -> float:
        d = dims(level)
        return d[inplane[0]] * d[inplane[1]]

    def is_end(fc: dict[str, Any]) -> bool:
        n = fc.get("normal")
        if not n:
            return False
        return fc.get("surface_type") == "Plane" and abs(float(n[axis])) > 0.999

    sides = {int(fc["id"]): fc for fc in faces if not is_end(fc)}
    level_of = {fid: walls_level for fid in sides}
    customs = []
    for ref in mesh.get("refinements") or []:
        if not is_surface_custom(ref):
            continue
        size_m = size_to_metres(ref.get("default_size", 2), ref.get("default_size_unit") or "mm")
        level = refinement_level_for_size(base_m, size_m)
        ids = [i for i in _label_ids(ref.get("faces") or []) if i in sides]
        for i in ids:
            level_of[i] = max(level_of[i], level)
        reach_m = reach_metres(ref)
        customs.append({"name": ref.get("name"), "size_mm": size_m * 1000.0, "level": level,
                        "cell_mm": [round(v, 4) for v in dims(level)], "faces": len(ids), "ids": ids,
                        **({"reach_mm": reach_m * 1000.0,
                            "distance_mm": round(refine_distance_m(size_m, reach_m) * 1000.0, 4)} if reach_m else {})})
    length = {fid: float(fc["area_mm2"]) / depth_mm for fid, fc in sides.items()}
    face_cells = {fid: length[fid] / along(level_of[fid]) for fid in sides}
    surface_cells = sum(BAND_CELLS * n for n in face_cells.values())
    finest = max([walls_level, *level_of.values()])
    for c in customs:
        if c.get("distance_mm", 0.0) <= DEFAULT_BAND_CELLS * c["size_mm"] * (1.0 + 1e-9) or not c["ids"]:
            continue
        # The band around the faces: a ring of the distance around a circle of their length,
        # never more than the section itself (a band that reaches across all of it).
        d, perim = float(c["distance_mm"]), sum(length[i] for i in c["ids"])
        band = min(perim * d + math.pi * d * d, volume_mm3 / depth_mm if depth_mm else 0.0)
        surface_cells += band / area_cell(int(c["level"])) - BAND_CELLS * sum(face_cells[i] for i in c["ids"])
    section_mm2 = volume_mm3 / depth_mm if depth_mm else 0.0
    surface_cells = min(surface_cells, section_mm2 / area_cell(finest))
    box_mm2 = math.prod(ext_mm[k] * _PAD for k in inplane)
    background = block[inplane[0]] * block[inplane[1]] * min(1.0, section_mm2 / box_mm2)
    layers = []
    layer_cells = 0.0
    for ref in mesh.get("refinements") or []:
        if not is_inflate(ref):
            continue
        ids = [i for i in _label_ids(ref.get("faces") or []) if i in sides]
        n_layers = int(ref.get("n_layers") or 0)
        stack_mm = size_to_metres(ref.get("total_thickness") or 0, ref.get("total_thickness_unit") or "mm") * 1000.0
        walls = [min(dims(level_of[i])[k] for k in inplane) for i in ids] or [min(dims(walls_level)[k] for k in inplane)]
        cell = min(walls)
        layer_cells += n_layers * sum(face_cells[i] for i in ids)
        layers.append({"name": ref.get("name"), "n_layers": n_layers, "stack_mm": stack_mm,
                       "smallest_wall_cell_mm": round(cell, 4),
                       "stack_over_smallest_cell": round(stack_mm / cell, 3) if cell else None})
    warnings = [
        f"{x['name']}: the {x['stack_mm']:g} mm layer stack is {x['stack_over_smallest_cell']:g} times the smallest "
        f"wall cell ({x['smallest_wall_cell_mm']:g} mm); the layers may be shrunk or dropped"
        for x in layers
        if x["stack_over_smallest_cell"] and x["stack_over_smallest_cell"] >= STACK_WARN
    ]
    n_cells = background + surface_cells + layer_cells
    return {
        "mesher": "snappy_hexdominant",
        "one_cell_across": True,
        "two_d_axis": AXES[axis],
        "fineness": f,
        "bounds_mm": [round(v, 4) for v in bounds_mm],
        "block": block,
        "base_cell_mm": [round(v, 4) for v in base_mm],
        "walls_level": walls_level,
        "wall_cell_mm": [round(v, 4) for v in dims(walls_level)],
        "custom_sizes": [{k: v for k, v in c.items() if k != "ids"} for c in customs],
        "layers": layers,
        "n_cells": int(round(n_cells, -2)),
        # Before extrudeMesh the 3D slab has up to 2^level cells across its depth for each 2D
        # cell (cfddesk.mesh.two_d): at most about this many, all at the finest level.
        "slab_3d_cells_max": int(round(n_cells * 2**finest, -3)),
        "n_cells_note": "an order of magnitude of the 2D mesh (one cell across), not a prediction",
        "warnings": warnings,
    }
