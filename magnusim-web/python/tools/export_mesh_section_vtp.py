#!/usr/bin/env python3
"""W25b: Export polyMesh cutting-plane section as VTP for live SPA mesh inspect."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True)
    ap.add_argument("--out", required=True, help="VTP output path")
    ap.add_argument("--axis", default="x", choices=["x", "y", "z"])
    ap.add_argument("--frac", type=float, default=0.5)
    ap.add_argument("--meta", default="")
    args = ap.parse_args()

    import pyvista as pv

    case = Path(args.case)
    foam = case / "case.foam"
    if not foam.is_file():
        foam.write_text("", encoding="ascii")

    reader = pv.OpenFOAMReader(str(foam))
    try:
        reader.set_active_time_value(reader.time_values[0] if reader.time_values else 0)
    except Exception:
        pass
    try:
        reader.disable_all_patch_arrays()
        reader.enable_patch_array("internalMesh")
    except Exception:
        pass
    mesh = reader.read()
    if isinstance(mesh, pv.MultiBlock):
        internal = None
        for i in range(mesh.n_blocks):
            block = mesh[i]
            if block is None:
                continue
            name = mesh.get_block_name(i) if hasattr(mesh, "get_block_name") else str(i)
            if "internal" in str(name).lower() or internal is None:
                internal = block
        mesh = internal if internal is not None else mesh.combine()
    if mesh is None or mesh.n_cells < 1:
        print("EMPTY_MESH", file=sys.stderr)
        sys.exit(3)

    # cellVolume for mesh-inspect coloring
    try:
        if "cellVolume" not in mesh.cell_data:
            mesh = mesh.compute_cell_sizes(length=False, area=False, volume=True)
            if "Volume" in mesh.cell_data:
                mesh.cell_data["cellVolume"] = mesh.cell_data["Volume"]
    except Exception as e:
        print("CELLVOL_WARN", e, file=sys.stderr)

    bounds = mesh.bounds
    ax = {"x": 0, "y": 1, "z": 2}[args.axis]
    lo, hi = bounds[ax * 2], bounds[ax * 2 + 1]
    origin = [
        0.5 * (bounds[0] + bounds[1]),
        0.5 * (bounds[2] + bounds[3]),
        0.5 * (bounds[4] + bounds[5]),
    ]
    # slight offset like prove zoom (better wall/skin catch)
    origin[ax] = lo + (hi - lo) * float(args.frac)
    normal = [0.0, 0.0, 0.0]
    normal[ax] = 1.0

    sliced = mesh.slice(normal=normal, origin=origin)
    if sliced.n_points < 1:
        print("EMPTY_SLICE", file=sys.stderr)
        sys.exit(4)

    # Promote cellVolume to point data for vtk.js scalar coloring if needed
    try:
        if "cellVolume" in sliced.cell_data and "cellVolume" not in sliced.point_data:
            sliced = sliced.cell_data_to_point_data()
    except Exception:
        pass

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sliced.save(str(out), binary=True)

    meta = {
        "case": str(case),
        "out": str(out),
        "bytes": out.stat().st_size,
        "n_cells_volume": int(mesh.n_cells),
        "n_points_volume": int(mesh.n_points),
        "n_cells_slice": int(sliced.n_cells),
        "n_points_slice": int(sliced.n_points),
        "bounds": list(bounds),
        "origin": origin,
        "normal": normal,
        "axis": args.axis,
        "frac": args.frac,
        "scalars": list(sliced.array_names),
    }
    if args.meta:
        Path(args.meta).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print("W25B_SECTION_VTP_OK", json.dumps(meta))
    return 0

if __name__ == "__main__":
    sys.exit(main() or 0)
