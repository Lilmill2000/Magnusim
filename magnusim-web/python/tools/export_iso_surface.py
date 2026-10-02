"""W10: on-demand Iso Surface live contour from real OpenFOAM case volume fields.

Server-side path (documented):
  case volume at time (case_volume.load_volume; legacy .cfddesk-prepared.vtu
  only as fallback) -> the iso field on the point data (a vector's magnitude
  mag<X> derived when needed) -> pyvista contour([iso_value], scalars=iso_field)
  -> binary VTP PolyData for vtk.js. Not a solid colored shell. The colour field
  and the case's velocity vector are carried on the contour.

Fields are names (a scalar by its own name, a vector X as magX); '' is the
case's default shown field. Iso value default 11.1 (banked Inc16d form).
Honest empty: iso value outside the field's range -> n_cells=0, empty VTP, no
fake surface.
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
from case_units import scale_kinematic  # noqa: E402
from case_volume import load_volume  # noqa: E402
from result_names import (  # noqa: E402
    dataset_vector,
    default_shown_field,
    filter_fields,
    foam_sources,
)

APPROACH = (
    "server-side volume contour: Vite /api/iso-surface -> export_iso_surface.py "
    "reads the case volume at time (OpenFOAM fields; legacy prepared VTU fallback) point-data "
    "(a vector's magnitude derived when needed) -> pyvista contour([iso_value], scalars=iso_field) "
    "-> binary VTP. Not a solid colored shell. The case's velocity vector is copied onto "
    "the contour so the viewport can draw live vector glyphs."
)


def mesh_checksum(pts: np.ndarray, n_cells: int) -> str:
    if pts is None or pts.size == 0:
        return "00000000"
    flat = np.asarray(pts, dtype=np.float64).ravel()
    h = 2166136261
    for v in (float(flat.size), float(n_cells)):
        h ^= int(v) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    step = max(1, flat.size // 256)
    for i in range(0, flat.size, step):
        x = int(flat[i] * 1e6)
        h ^= x & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    for i in range(max(0, flat.size - 24), flat.size):
        x = int(flat[i] * 1e6)
        h ^= x & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    return f"{h:08x}"


def asset_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def contour_iso(
    grid: pv.DataSet,
    *,
    iso_field: str = "",
    iso_value: float,
    color_field: str = "",
    vector: str = "",
    default: str = "",
) -> tuple:
    src, iso_field, color_field, vector = filter_fields(
        grid, field=iso_field, color_field=color_field, vector=vector, default=default, what="Iso field"
    )
    arr = np.asarray(src.point_data[iso_field], dtype=float)
    smin = float(np.nanmin(arr)) if arr.size else 0.0
    smax = float(np.nanmax(arr)) if arr.size else 0.0
    value = float(iso_value)

    try:
        iso = src.contour([value], scalars=iso_field)
    except Exception:
        iso = pv.PolyData()
    if not isinstance(iso, pv.PolyData):
        iso = pv.PolyData(iso)

    n_cells = int(iso.n_cells)
    n_points = int(iso.n_points)
    empty = n_cells == 0 or n_points == 0
    pts = np.asarray(iso.points, dtype=float) if n_points else np.zeros((0, 3))
    point_checksum = float(pts.sum()) if pts.size else 0.0
    mesh_rms = float(np.sqrt(np.mean(pts * pts))) if pts.size else 0.0
    reason = "ok"
    if empty:
        if value > smax or value < smin:
            reason = "out_of_range"
        else:
            reason = "empty_contour"

    meta = {
        "iso_value": value,
        "iso_field": str(iso_field),
        "coloring_field": color_field,
        "vector_field": vector or None,
        "scalar_min": smin,
        "scalar_max": smax,
        "n_cells": n_cells,
        "n_points": n_points,
        "empty": bool(empty),
        "reason": reason,
        "point_checksum": point_checksum,
        "mesh_rms": mesh_rms,
        "mesh_checksum": mesh_checksum(pts, n_cells),
        "vectors_live": bool(n_points and vector and vector in iso.point_data),
        "vectors_persist_only": False,
        "approach": APPROACH,
        "method": "pyvista DataSet.contour on volume VTU",
        "proves_not_baked_only": True,
        "no_fake_surface": True,
        "no_solid_shell": True,
        "source_is_volume": True,
        "volume_n_cells": int(getattr(src, "n_cells", 0) or 0),
        "volume_n_points": int(getattr(src, "n_points", 0) or 0),
    }
    return iso, meta


def export_iso_surface(
    case_dir: Path,
    time: str,
    out_dir: Path,
    *,
    iso_field: str = "",
    iso_value: float = 11.1,
    color_field: str = "",
    vector: str = "",
    opacity: float = 1.0,
    vectors: bool = False,
) -> dict:
    case_dir = Path(case_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Same loader as cut plane / inspect: native fields at this time, the
    # legacy .cfddesk-prepared.vtu only when the time has none. Runs never
    # write the prepared VTU, so requiring it 500'd every fresh result.
    mesh, vtu_path = load_volume(case_dir, str(time))
    if int(getattr(mesh, "n_cells", 0) or 0) == 0:
        raise RuntimeError("volume has 0 cells; cannot contour")
    # Kinematic fields in Pa, like every other result view: the iso value the
    # page sends is in the units its legend shows. This process loaded its
    # own copy of the volume, so scaling it in place is safe.
    scale_kinematic(mesh, case_dir)

    iso, meta = contour_iso(
        mesh,
        iso_field=iso_field,
        iso_value=iso_value,
        color_field=color_field,
        vector=dataset_vector(case_dir, str(time), mesh, vector),
        default=default_shown_field(case_dir, str(time)),
    )
    out_vtp = out_dir / "iso_surface.vtp"
    if meta["empty"]:
        empty = pv.PolyData()
        empty.save(str(out_vtp), binary=True)
    else:
        iso.save(str(out_vtp), binary=True)

    meta.update(
        {
            "case_dir": str(case_dir),
            "time": str(time),
            "source_vtu": str(vtu_path),
            "source_foam": foam_sources(
                case_dir / str(time), (meta["iso_field"], meta["coloring_field"], meta["vector_field"])
            ),
            "opacity": float(opacity),
            "vectors": bool(vectors),
            "vectors_actor": False,
            "bounds": list(map(float, mesh.bounds)),
            "asset_sha256": asset_sha256(out_vtp),
            "vtp": str(out_vtp),
        }
    )
    out_meta = out_dir / "iso_surface.meta.json"
    out_meta.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "vtp": str(out_vtp),
                "meta": str(out_meta),
                "n_cells": meta["n_cells"],
                "empty": meta["empty"],
                "reason": meta["reason"],
                "iso_field": meta["iso_field"],
                "scalar_max": meta["scalar_max"],
            }
        )
    )
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", type=Path, required=True, help="OpenFOAM case directory")
    ap.add_argument("--time", default="50")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--iso-field", default="", help="shown field to contour ('' = the case's default)")
    ap.add_argument("--iso-value", type=float, default=11.1)
    ap.add_argument("--color-field", default="", help="shown field to colour by ('' = the case's default)")
    ap.add_argument("--vector", default="", help="vector to carry for glyphs ('' = the case's velocity)")
    ap.add_argument("--opacity", type=float, default=1.0)
    ap.add_argument("--vectors", type=int, default=0)
    args = ap.parse_args()
    export_iso_surface(
        args.case,
        args.time,
        args.out_dir,
        iso_field=args.iso_field,
        iso_value=args.iso_value,
        color_field=args.color_field,
        vector=args.vector,
        opacity=args.opacity,
        vectors=bool(args.vectors),
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
