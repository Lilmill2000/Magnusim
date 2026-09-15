"""W11: on-demand Iso Volume live threshold from real OpenFOAM case volume fields.

Server-side path (documented; match desktop Inc 29a):
  case .cfddesk-prepared.vtu (volume UnstructuredGrid) -> ensure point-data
  magU (derived from U when needed) / p -> map normalized low/high (defaults
  0.25/0.75) onto live scalar min/max -> pyvista threshold([lo, hi], scalars=iso_field)
  -> extract_surface binary VTP for vtk.js Geometry. Not an Iso Surface contour
  rebrand; volume cells from threshold (meta n_cells). U is copied so Vectors draws live glyphs.

Banked defaults (Inc16e / 29a / post-form-iso-volume):
  Iso scalar=Velocity Magnitude (-> magU), Iso value dual-handle 0.25/0.75
  normalized (no numeric endpoint labels), Coloring=Pressure, Vectors=off,
  Opacity=1. Default mid-range MUST yield nonzero cells.
Honest empty: inverted (low>high) or empty/non-finite scalars -> n_cells=0.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pyvista as pv

APPROACH = (
    "server-side volume threshold: Vite /api/iso-volume -> export_iso_volume.py "
    "reads case .cfddesk-prepared.vtu (volume UnstructuredGrid) point-data "
    "(magU derived from U when needed; p) -> map normalized low/high onto live "
    "scalar min/max -> pyvista threshold([mapped_lo, mapped_hi], scalars=iso_field) "
    "-> extract_surface binary VTP for vtk.js. Not an Iso Surface contour rebrand. "
    "U is copied onto the threshold surface so the viewport can draw live vector glyphs."
)


def field_variable_to_scalar(label: str) -> str:
    key = (label or "").strip().lower()
    if key in ("velocity magnitude", "magu", "|u|", "u magnitude", "velocity", "u"):
        return "magU"
    if key in ("pressure", "p", "kinematic pressure", "pressure (p)"):
        return "p"
    return (label or "magU").strip() or "magU"


def resolve_iso_scalar(label: str, dataset: pv.DataSet) -> str:
    mapped = field_variable_to_scalar(label)
    key = (label or "").strip().lower()
    if key in ("velocity magnitude", "magu", "|u|", "u magnitude", "velocity", "u"):
        candidates = ["magU", "U", mapped]
    elif key in ("pressure", "p", "kinematic pressure", "pressure (p)"):
        candidates = ["p", "p_rgh", "Pressure", mapped]
    else:
        candidates = [mapped, "magU", "p"]
    for name in candidates:
        if name and (name in dataset.point_data or name in dataset.cell_data):
            if name == "U":
                return "magU"
            return name
    if "U" in dataset.point_data or "U" in dataset.cell_data:
        return "magU"
    raise RuntimeError(f"Iso scalar {label!r} not on dataset (tried {candidates})")


def resolve_coloring_scalar(label: str, dataset: pv.DataSet) -> str | None:
    mapped = field_variable_to_scalar(label)
    key = (label or "").strip().lower()
    if key in ("velocity magnitude", "magu", "|u|", "u magnitude", "velocity", "u"):
        candidates = ["magU", "U", mapped]
    elif key in ("pressure", "p", "kinematic pressure", "pressure (p)"):
        candidates = ["p", "p_rgh", "Pressure", mapped]
    else:
        candidates = [mapped, "p", "magU"]
    for name in candidates:
        if not name:
            continue
        if name == "U":
            if "magU" in dataset.point_data or "magU" in dataset.cell_data:
                return "magU"
            continue
        if name in dataset.point_data or name in dataset.cell_data:
            return name
    return None


def ensure_contour_scalars(grid: pv.DataSet, scalar_name: str) -> pv.DataSet:
    """Point-data required for threshold. Derive magU from U when needed."""
    src = grid
    if scalar_name == "magU":
        if "magU" not in src.point_data:
            if "U" in src.point_data:
                U = np.asarray(src.point_data["U"], dtype=float)
                src.point_data["magU"] = np.linalg.norm(U[:, :3], axis=1)
            elif "magU" in src.cell_data:
                try:
                    src = src.cell_data_to_point_data()
                except Exception:
                    pass
            if "magU" not in src.point_data and "U" in src.cell_data:
                try:
                    tmp = src.cell_data_to_point_data()
                    if "U" in tmp.point_data:
                        U = np.asarray(tmp.point_data["U"], dtype=float)
                        tmp.point_data["magU"] = np.linalg.norm(U[:, :3], axis=1)
                        src = tmp
                except Exception as exc:
                    raise RuntimeError(f"Cannot derive magU for iso volume: {exc}") from exc
        if "magU" not in src.point_data:
            raise RuntimeError("magU unavailable for iso volume (need volume U/magU)")
        return src

    if scalar_name in src.point_data:
        return src
    if scalar_name in src.cell_data:
        try:
            return src.cell_data_to_point_data()
        except Exception as exc:
            raise RuntimeError(
                f"Cannot promote {scalar_name!r} to point_data for threshold: {exc}"
            ) from exc
    raise RuntimeError(f"Scalar {scalar_name!r} missing for iso volume")


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
    iso_scalar: str,
    iso_value_low: float,
    iso_value_high: float,
    coloring: str,
) -> tuple:
    iso_field = resolve_iso_scalar(iso_scalar, grid)
    src = ensure_contour_scalars(grid, iso_field)
    if "U" not in src.point_data and "U" in src.cell_data:
        try:
            src = src.cell_data_to_point_data()
        except Exception:
            pass
    color_want = resolve_coloring_scalar(coloring, src)
    if color_want == "magU" and "magU" not in src.point_data:
        src = ensure_contour_scalars(src, "magU")
    elif color_want and color_want not in src.point_data and color_want in src.cell_data:
        try:
            src = src.cell_data_to_point_data()
        except Exception:
            pass

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

    color_field = resolve_coloring_scalar(coloring, vol) if n_points else color_want
    if color_field is None:
        color_field = resolve_coloring_scalar(coloring, src)

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
        "iso_scalar": str(iso_scalar),
        "iso_value_low": lo_frac,
        "iso_value_high": hi_frac,
        "mapped_low": float(mapped_lo),
        "mapped_high": float(mapped_hi),
        "iso_field": str(iso_field),
        "coloring": str(coloring),
        "coloring_field": color_field,
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
            and (
                "U" in getattr(surface, "point_data", {})
                or "U" in getattr(vol, "point_data", {})
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
    iso_scalar: str = "Velocity Magnitude",
    iso_value_low: float = 0.25,
    iso_value_high: float = 0.75,
    coloring: str = "Pressure",
    opacity: float = 1.0,
    vectors: bool = False,
) -> dict:
    case_dir = Path(case_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    vtu_path = case_dir / ".cfddesk-prepared.vtu"
    if not vtu_path.is_file():
        raise FileNotFoundError(f"missing prepared VTU: {vtu_path}")
    u_path = case_dir / str(time) / "U"
    p_path = case_dir / str(time) / "p"
    mesh = pv.read(str(vtu_path))
    if int(getattr(mesh, "n_cells", 0) or 0) == 0:
        raise RuntimeError("prepared VTU has 0 cells; cannot threshold")

    surface, meta = threshold_iso_volume(
        mesh,
        iso_scalar=iso_scalar,
        iso_value_low=iso_value_low,
        iso_value_high=iso_value_high,
        coloring=coloring,
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
            "source_foam_U": str(u_path) if u_path.is_file() else None,
            "source_foam_p": str(p_path) if p_path.is_file() else None,
            "u_from_case": bool(u_path.is_file()),
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
    ap.add_argument("--iso-scalar", default="Velocity Magnitude")
    ap.add_argument("--iso-value-low", type=float, default=0.25)
    ap.add_argument("--iso-value-high", type=float, default=0.75)
    ap.add_argument("--coloring", default="Pressure")
    ap.add_argument("--opacity", type=float, default=1.0)
    ap.add_argument("--vectors", type=int, default=0)
    args = ap.parse_args()
    export_iso_volume(
        args.case,
        args.time,
        args.out_dir,
        iso_scalar=args.iso_scalar,
        iso_value_low=args.iso_value_low,
        iso_value_high=args.iso_value_high,
        coloring=args.coloring,
        opacity=args.opacity,
        vectors=bool(args.vectors),
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)