"""W11: on-demand Iso Volume live threshold from real OpenFOAM case volume fields.

Server-side path (documented; match desktop Inc 29a):
  case volume at time (case_volume.load_volume; legacy .cfddesk-prepared.vtu
  only as fallback) -> the iso field on the point data (a vector's magnitude
  mag<X> derived when needed) -> map normalized low/high (defaults 0.25/0.75)
  onto live field min/max -> pyvista threshold([lo, hi], scalars=iso_field)
  -> extract_surface binary VTP for vtk.js Geometry. Not an Iso Surface contour
  rebrand; volume cells from threshold (meta n_cells). The case's velocity
  vector is carried so Vectors draws live glyphs.

Fields are names (a scalar by its own name, a vector X as magX); '' is the
case's default shown field. Iso value dual-handle 0.25/0.75 normalized,
Vectors=off, Opacity=1 (banked Inc16e / 29a form). Default mid-range MUST
yield nonzero cells.
Honest empty: inverted (low>high) or empty/non-finite field -> n_cells=0.
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
    "server-side volume threshold: Vite /api/iso-volume -> export_iso_volume.py "
    "reads the case volume at time (OpenFOAM fields; legacy prepared VTU fallback) point-data "
    "(a vector's magnitude derived when needed) -> map normalized low/high onto live "
    "field min/max -> pyvista threshold([mapped_lo, mapped_hi], scalars=iso_field) "
    "-> extract_surface binary VTP for vtk.js. Not an Iso Surface contour rebrand. "
    "The case's velocity vector is copied onto the threshold surface so the viewport "
    "can draw live vector glyphs."
)


def map_normalized_range(
    smin: float, smax: float, low_frac: float, high_frac: float
) -> tuple[float, float]:
    span = float(smax) - float(smin)
    lo = float(smin) + float(low_frac) * span
    hi = float(smin) + float(high_frac) * span
    return lo, hi


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


def threshold_iso_volume(
    grid: pv.DataSet,
    *,
    iso_field: str = "",
    iso_value_low: float,
    iso_value_high: float,
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
    lo_frac = float(iso_value_low)
    hi_frac = float(iso_value_high)
    mapped_lo, mapped_hi = map_normalized_range(smin, smax, lo_frac, hi_frac)

    reason = "ok"
    # Honest empty: inverted normalized range (do not auto-swap).
    if lo_frac > hi_frac:
        vol = pv.UnstructuredGrid()
        reason = "inverted_range"
    elif arr.size == 0 or not np.isfinite(smin) or not np.isfinite(smax):
        vol = pv.UnstructuredGrid()
        reason = "empty_scalars"
    else:
        try:
            vol = src.threshold([mapped_lo, mapped_hi], scalars=iso_field)
        except Exception:
            vol = pv.UnstructuredGrid()
            reason = "threshold_failed"
        if vol is None:
            vol = pv.UnstructuredGrid()
            reason = "threshold_none"

    n_cells = int(getattr(vol, "n_cells", 0) or 0)
    n_points = int(getattr(vol, "n_points", 0) or 0)
    empty = n_cells == 0 or n_points == 0
    if empty and reason == "ok":
        reason = "empty_threshold"

    pts = np.asarray(vol.points, dtype=float) if n_points else np.zeros((0, 3))
    point_checksum = float(pts.sum()) if pts.size else 0.0
    mesh_rms = float(np.sqrt(np.mean(pts * pts))) if pts.size else 0.0

    if empty:
        surface = pv.PolyData()
    else:
        try:
            surface = vol.extract_surface(algorithm='dataset_surface')
            if not isinstance(surface, pv.PolyData):
                surface = pv.PolyData(surface)
        except Exception:
            surface = pv.PolyData()

    meta = {
        "iso_value_low": lo_frac,
        "iso_value_high": hi_frac,
        "mapped_low": float(mapped_lo),
        "mapped_high": float(mapped_hi),
        "iso_field": str(iso_field),
        "coloring_field": color_field,
        "vector_field": vector or None,
        "scalar_min": smin,
        "scalar_max": smax,
        "n_cells": n_cells,
        "n_points": n_points,
        "surface_n_cells": int(getattr(surface, "n_cells", 0) or 0),
        "surface_n_points": int(getattr(surface, "n_points", 0) or 0),
        "empty": bool(empty),
        "reason": reason,
        "point_checksum": point_checksum,
        "mesh_rms": mesh_rms,
        "mesh_checksum": mesh_checksum(pts, n_cells),
        "vectors_live": bool(
            (not empty)
            and vector
            and (
                vector in getattr(surface, "point_data", {})
                or vector in getattr(vol, "point_data", {})
            )
        ),
        "vectors_persist_only": False,
        "approach": APPROACH,
        "method": "pyvista DataSet.threshold on volume VTU (extract_surface for VTP)",
        "proves_not_baked_only": True,
        "no_fake_volume": True,
        "not_iso_surface_rebrand": True,
        "source_is_volume": True,
        "volume_n_cells": int(getattr(src, "n_cells", 0) or 0),
        "volume_n_points": int(getattr(src, "n_points", 0) or 0),
    }
    return surface, meta


def export_iso_volume(
    case_dir: Path,
    time: str,
    out_dir: Path,
    *,
    iso_field: str = "",
    iso_value_low: float = 0.25,
    iso_value_high: float = 0.75,
    color_field: str = "",
    vector: str = "",
    opacity: float = 1.0,
    vectors: bool = False,
) -> dict:
    case_dir = Path(case_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Shared loader (see export_iso_surface): runs never write the legacy
    # .cfddesk-prepared.vtu, so it is only a fallback, not a requirement.
    mesh, vtu_path = load_volume(case_dir, str(time))
    if int(getattr(mesh, "n_cells", 0) or 0) == 0:
        raise RuntimeError("volume has 0 cells; cannot threshold")
    # Kinematic fields in Pa, like every other result view: the iso value the
    # page sends is in the units its legend shows. This process loaded its
    # own copy of the volume, so scaling it in place is safe.
    scale_kinematic(mesh, case_dir)

    surface, meta = threshold_iso_volume(
        mesh,
        iso_field=iso_field,
        iso_value_low=iso_value_low,
        iso_value_high=iso_value_high,
        color_field=color_field,
        vector=dataset_vector(case_dir, str(time), mesh, vector),
        default=default_shown_field(case_dir, str(time)),
    )
    out_vtp = out_dir / "iso_volume.vtp"
    if meta["empty"]:
        empty = pv.PolyData()
        empty.save(str(out_vtp), binary=True)
    else:
        surface.save(str(out_vtp), binary=True)

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
    out_meta = out_dir / "iso_volume.meta.json"
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
                "mapped_low": meta["mapped_low"],
                "mapped_high": meta["mapped_high"],
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
    ap.add_argument("--iso-field", default="", help="shown field to threshold ('' = the case's default)")
    ap.add_argument("--iso-value-low", type=float, default=0.25)
    ap.add_argument("--iso-value-high", type=float, default=0.75)
    ap.add_argument("--color-field", default="", help="shown field to colour by ('' = the case's default)")
    ap.add_argument("--vector", default="", help="vector to carry for glyphs ('' = the case's velocity)")
    ap.add_argument("--opacity", type=float, default=1.0)
    ap.add_argument("--vectors", type=int, default=0)
    args = ap.parse_args()
    export_iso_volume(
        args.case,
        args.time,
        args.out_dir,
        iso_field=args.iso_field,
        iso_value_low=args.iso_value_low,
        iso_value_high=args.iso_value_high,
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
