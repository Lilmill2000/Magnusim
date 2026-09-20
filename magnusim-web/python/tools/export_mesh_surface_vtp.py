#!/usr/bin/env python3
"""Export the outer surface of a polyMesh as VTP so the SPA can show the full 3D mesh."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _internal_mesh(reader):
    import pyvista as pv

    mesh = reader.read()
    if mesh is None:
        return None
    if isinstance(mesh, pv.MultiBlock):
        internal = None
        for i in range(mesh.n_blocks):
            block = mesh[i]
            if block is None:
                continue
            name = mesh.get_block_name(i) if hasattr(mesh, "get_block_name") else str(i)
            if "internal" in str(name).lower():
                return block
            if internal is None:
                internal = block
        return internal if internal is not None else mesh.combine()
    return mesh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True)
    ap.add_argument("--out", required=True)
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

    mesh = _internal_mesh(reader)
    if mesh is None or getattr(mesh, "n_cells", 0) < 1:
        print("EMPTY_MESH", file=sys.stderr)
        sys.exit(3)

    surf = mesh.extract_surface()
    # Keep native face topology (quads/polys). Triangulating draws a
    # diagonal on every face and turns the viewport into a black hairball.
    if surf is None or surf.n_points < 1:
        print("EMPTY_SURFACE", file=sys.stderr)
        sys.exit(4)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    surf.save(str(out), binary=True)

    bounds = list(mesh.bounds)
    meta = {
        "case": str(case),
        "out": str(out),
        "bytes": out.stat().st_size,
        "n_cells_volume": int(mesh.n_cells),
        "n_points_volume": int(mesh.n_points),
        "n_cells_surface": int(surf.n_cells),
        "n_points_surface": int(surf.n_points),
        "bounds": bounds,
    }
    if args.meta:
        Path(args.meta).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print("MESH_SURFACE_VTP_OK", json.dumps(meta))
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
