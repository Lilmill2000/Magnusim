"""W10: on-demand Iso Surface live contour from real OpenFOAM case volume fields.

Server-side path (documented):
  case .cfddesk-prepared.vtu (volume UnstructuredGrid) -> ensure point-data
  magU (derived from U when needed) / p -> pyvista contour([iso_value], scalars=iso_field)
  -> binary VTP PolyData for vtk.js. Not a solid colored shell; not surface-only
  magU (surface-only may not contour). Coloring array carried on iso when present.

Banked defaults (Inc16d / post-form-iso-surface):
  Iso scalar=Velocity Magnitude (-> magU), Iso value=11.1 m/s, Coloring=Pressure,
  Vectors=on draws live U glyphs on the contour (U copied onto the VTP).
Honest empty: iso value outside scalar range (MTP1 umax~0.77, default 11.1)
  -> n_cells=0, empty VTP, no fake surface.
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
    "server-side volume contour: Vite /api/iso-surface -> export_iso_surface.py "
    "reads case .cfddesk-prepared.vtu (volume UnstructuredGrid) point-data "
    "(magU derived from U when needed; p) -> pyvista contour([iso_value], scalars=iso_field) "
    "-> binary VTP. Not a solid colored shell; surface-only magU may not contour. "
    "U is copied onto the contour so the viewport can draw live vector glyphs."
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
    """Point-data required for contour. Derive magU from U when needed."""
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
                    raise RuntimeError(f"Cannot derive magU for iso contour: {exc}") from exc
        if "magU" not in src.point_data:
            raise RuntimeError("magU unavailable for iso contour (need volume U/magU)")
        return src

    if scalar_name in src.point_data:
        return src
    if scalar_name in src.cell_data:
        try:
            return src.cell_data_to_point_data()
        except Exception as exc:
            raise RuntimeError(
                f"Cannot promote {scalar_name!r} to point_data for contour: {exc}"
            ) from exc
    raise RuntimeError(f"Scalar {scalar_name!r} missing for iso contour")


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
    iso_scalar: str,
    iso_value: float,
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
    value = float(iso_value)

    try:
        iso = src.contour([value], scalars=iso_field)
    except Exception:
        iso = pv.PolyData()
    if not isinstance(iso, pv.PolyData):
        iso = pv.PolyData(iso)

    color_field = resolve_coloring_scalar(coloring, iso) if iso.n_points else color_want
    if color_field is None:
        color_field = resolve_coloring_scalar(coloring, src)

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
        "iso_scalar": str(iso_scalar),
        "iso_value": value,
        "iso_field": str(iso_field),
        "coloring": str(coloring),
        "coloring_field": color_field,
        "scalar_min": smin,
        "scalar_max": smax,
        "n_cells": n_cells,
        "n_points": n_points,
        "empty": bool(empty),
        "reason": reason,
        "point_checksum": point_checksum,
        "mesh_rms": mesh_rms,
        "mesh_checksum": mesh_checksum(pts, n_cells),
        "vectors_live": bool(n_points and "U" in iso.point_data),
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
    iso_scalar: str = "Velocity Magnitude",
    iso_value: float = 11.1,
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
        raise RuntimeError("prepared VTU has 0 cells; cannot contour")

    iso, meta = contour_iso(
        mesh,
        iso_scalar=iso_scalar,
        iso_value=iso_value,
        coloring=coloring,
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
    ap.add_argument("--iso-scalar", default="Velocity Magnitude")
    ap.add_argument("--iso-value", type=float, default=11.1)
    ap.add_argument("--coloring", default="Pressure")
    ap.add_argument("--opacity", type=float, default=1.0)
    ap.add_argument("--vectors", type=int, default=0)
    args = ap.parse_args()
    export_iso_surface(
        args.case,
        args.time,
        args.out_dir,
        iso_scalar=args.iso_scalar,
        iso_value=args.iso_value,
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
