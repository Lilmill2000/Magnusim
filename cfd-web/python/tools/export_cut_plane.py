"""Volume cutting-plane slice for Results.

pyvista DataSet.slice on the OpenFOAM volume (or prepared VTU) at the
requested origin/normal. That is a filled 2-D mesh with field scalars —
not a surface-skin polyline.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pyvista as pv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from case_units import case_density, pressure_meta, scale_pressure  # noqa: E402
from case_volume import load_volume  # noqa: E402


def read_volume_at_time(case_dir: Path, time: str):
    return load_volume(case_dir, time)


def ensure_field(mesh, field: str):
    if field == "magU":
        if "magU" not in mesh.point_data and "magU" not in mesh.cell_data:
            if "U" in mesh.point_data:
                U = np.asarray(mesh.point_data["U"])
                mesh.point_data["magU"] = np.linalg.norm(U[:, :3], axis=1)
            elif "U" in mesh.cell_data:
                U = np.asarray(mesh.cell_data["U"])
                mesh.cell_data["magU"] = np.linalg.norm(U[:, :3], axis=1)
            else:
                raise RuntimeError("mesh missing magU/U")
        return
    if "p" not in mesh.point_data and "p" not in mesh.cell_data:
        raise RuntimeError("mesh missing p")


def export_cut_plane(
    case_dir: Path,
    time: str,
    out_dir: Path,
    *,
    ox: float,
    oy: float,
    oz: float,
    nx: float,
    ny: float,
    nz: float,
    field: str = "magU",
    mesh=None,
    source: str | None = None,
) -> dict:
    case_dir = Path(case_dir).resolve()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    field = "p" if field == "p" else "magU"

    if mesh is None:
        mesh, source = read_volume_at_time(case_dir, str(time))
    elif not source:
        source = "worker-cache"
    if mesh is None or int(getattr(mesh, "n_cells", 0) or 0) < 1:
        raise RuntimeError(f"volume read failed: {case_dir}")
    ensure_field(mesh, field)

    origin = [float(ox), float(oy), float(oz)]
    normal = [float(nx), float(ny), float(nz)]
    nlen = float(np.linalg.norm(normal))
    if nlen < 1e-18:
        normal = [0.0, 1.0, 0.0]
    else:
        normal = [c / nlen for c in normal]

    sliced = mesh.slice(normal=normal, origin=origin)
    if sliced is None:
        sliced = pv.PolyData()
    if not isinstance(sliced, pv.PolyData):
        sliced = sliced.extract_surface() if hasattr(sliced, "extract_surface") else pv.PolyData(sliced)

    ensure_field(sliced, field)
    try:
        ensure_field(sliced, "magU")
    except RuntimeError:
        pass
    rho = case_density(case_dir)
    if field == "p" or "p" in sliced.point_data or "p" in sliced.cell_data:
        try:
            scale_pressure(sliced, rho)
        except Exception:
            pass
    keep = {field, "U", "magU", "p", "T", "TKelvin", "thermo:T"}
    need_promote = any(
        name in sliced.cell_data and name not in sliced.point_data
        for name in keep
    )
    if need_promote:
        try:
            sliced = sliced.cell_data_to_point_data(pass_cell_data=True)
        except Exception:
            sliced = sliced.cell_data_to_point_data()

    present = {
        k for k in keep
        if k in sliced.point_data or k in sliced.cell_data
    }
    present.add(field)
    for k in list(sliced.point_data.keys()):
        if k not in present:
            del sliced.point_data[k]
    for k in list(sliced.cell_data.keys()):
        if k not in present:
            del sliced.cell_data[k]

    out_vtp = out_dir / "cut_plane.vtp"
    out_meta = out_dir / "cut_plane.meta.json"
    n_points = int(getattr(sliced, "n_points", 0) or 0)
    n_cells = int(getattr(sliced, "n_cells", 0) or 0)
    empty = n_points < 3 or n_cells < 1
    if empty:
        pv.PolyData().save(str(out_vtp), binary=True)
        arr = None
    else:
        sliced.save(str(out_vtp), binary=True)
        arr = np.asarray(sliced.point_data[field]) if field in sliced.point_data else None

    h = hashlib.sha256()
    with out_vtp.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)

    meta = {
        "case_dir": str(case_dir),
        "time": str(time),
        "field": field,
        "origin": origin,
        "normal": normal,
        "source": source,
        "n_points": n_points,
        "n_cells": n_cells,
        "empty": bool(empty),
        "umin": float(np.nanmin(arr)) if arr is not None and arr.size else None,
        "umax": float(np.nanmax(arr)) if arr is not None and arr.size else None,
        "volume_n_cells": int(getattr(mesh, "n_cells", 0) or 0),
        "asset_sha256": h.hexdigest(),
        "vtp": str(out_vtp),
        "method": "pyvista DataSet.slice on volume",
        "field_unit": "Pa" if field == "p" else "m/s",
        **pressure_meta(rho),
    }
    out_meta.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "n_cells": n_cells, "n_points": n_points, "empty": empty}))
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", type=Path, required=True)
    ap.add_argument("--time", required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--ox", type=float, required=True)
    ap.add_argument("--oy", type=float, required=True)
    ap.add_argument("--oz", type=float, required=True)
    ap.add_argument("--nx", type=float, required=True)
    ap.add_argument("--ny", type=float, required=True)
    ap.add_argument("--nz", type=float, required=True)
    ap.add_argument("--field", default="magU")
    args = ap.parse_args()
    try:
        export_cut_plane(
            args.case,
            args.time,
            args.out_dir,
            ox=args.ox,
            oy=args.oy,
            oz=args.oz,
            nx=args.nx,
            ny=args.ny,
            nz=args.nz,
            field=args.field,
        )
    except Exception as exc:
        print(f"export_cut_plane failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
