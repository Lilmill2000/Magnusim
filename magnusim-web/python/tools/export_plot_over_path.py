"""W9: on-demand Plot-over-path live sample from real OpenFOAM case fields.

Server-side path (documented):
  case .cfddesk-prepared.vtu (point-data magU / p / U) -> polyline vertices
  -> pyvista sample_over_line per segment (resolution = subdivisions+1)
  -> JSON series (distance, value). Not a chrome-only / made-up chart.

Defaults match banked post-form-plot-over-path / Inc16c + Inc30a:
  Number of subdivisions=0, Field variable=Velocity Magnitude (-> magU),
  Selected points empty, Generate plot disabled until points exist.
Honest empty: <2 points or path misses mesh -> n_samples=0, no fake curve.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pyvista as pv

APPROACH = (
    "server-side sample_over_line: Vite /api/plot-over-path -> "
    "export_plot_over_path.py reads case .cfddesk-prepared.vtu "
    "point-data (magU/p/U) -> sample along polyline "
    "(resolution=subdivisions+1 per segment) -> JSON series. "
    "Not a chrome path line with a made-up chart."
)


def field_variable_to_scalar(label: str) -> str:
    key = (label or "").strip().lower()
    if key in ("velocity magnitude", "magu", "|u|", "u magnitude", "velocity", "u"):
        return "magU"
    if key in ("pressure", "p", "kinematic pressure", "pressure (p)"):
        return "p"
    if key == "magu":
        return "magU"
    return (label or "magU").strip() or "magU"


def resolve_scalar(label: str, dataset: pv.DataSet) -> str:
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
            return name
    if "U" in dataset.point_data or "U" in dataset.cell_data:
        return "magU"
    raise RuntimeError(f"field {label!r} not on dataset (tried {candidates})")


def ensure_scalars(grid: pv.DataSet, scalar_name: str) -> pv.DataSet:
    src = grid
    if scalar_name == "magU":
        if "magU" not in src.point_data:
            if "U" in src.point_data:
                U = np.asarray(src.point_data["U"], dtype=float)
                src.point_data["magU"] = np.linalg.norm(U[:, :3], axis=1)
            elif "U" in src.cell_data:
                src = src.cell_data_to_point_data()
                U = np.asarray(src.point_data["U"], dtype=float)
                src.point_data["magU"] = np.linalg.norm(U[:, :3], axis=1)
    elif scalar_name not in src.point_data and scalar_name in src.cell_data:
        src = src.cell_data_to_point_data()
    return src


def segment_resolution(subdivisions: int) -> int:
    return max(0, int(subdivisions)) + 1


def valid_mask(sampled: pv.DataSet) -> np.ndarray:
    n = int(getattr(sampled, "n_points", 0) or 0)
    if n == 0:
        return np.zeros(0, dtype=bool)
    if "vtkValidPointMask" in sampled.point_data:
        m = np.asarray(sampled.point_data["vtkValidPointMask"]).reshape(-1)
        return m.astype(bool)
    for key in sampled.point_data.keys():
        if str(key).startswith("vtk"):
            continue
        arr = np.asarray(sampled.point_data[key], dtype=float)
        if arr.ndim > 1:
            arr = np.linalg.norm(arr[:, :3], axis=1)
        return np.isfinite(arr)
    return np.ones(n, dtype=bool)


def parse_points(raw: str | None) -> list[list[float]]:
    """Parse 'x,y,z;x,y,z' or JSON list into [[x,y,z], ...]."""
    if raw is None:
        return []
    s = str(raw).strip()
    if not s:
        return []
    if s.startswith("["):
        try:
            data = json.loads(s)
        except json.JSONDecodeError:
            return []
        out = []
        for item in data:
            if isinstance(item, (list, tuple)) and len(item) >= 3:
                try:
                    out.append([float(item[0]), float(item[1]), float(item[2])])
                except (TypeError, ValueError):
                    continue
        return out
    out = []
    for seg in s.replace("|", ";").split(";"):
        seg = seg.strip()
        if not seg:
            continue
        parts = [p.strip() for p in seg.split(",") if p.strip()]
        if len(parts) < 3:
            continue
        try:
            out.append([float(parts[0]), float(parts[1]), float(parts[2])])
        except ValueError:
            continue
    return out


def sample_over_path(
    grid: pv.DataSet,
    points: list[list[float]],
    subdivisions: int,
    field_variable: str,
) -> dict:
    pts = [list(map(float, p[:3])) for p in (points or []) if p and len(p) >= 3]
    n_path = len(pts)
    subdiv = max(0, int(subdivisions))
    label = str(field_variable or "Velocity Magnitude")

    base = {
        "field_variable": label,
        "field_name": "",
        "subdivisions": subdiv,
        "n_path_points": n_path,
        "path_points": [list(p) for p in pts],
        "distances": [],
        "values": [],
        "sample_points": [],
        "n_samples": 0,
        "n_valid": 0,
        "empty": True,
        "value_checksum": 0.0,
        "value_mean": 0.0,
        "value_min": 0.0,
        "value_max": 0.0,
        "distance_max": 0.0,
        "reason": "",
        "approach": APPROACH,
        "method": "pyvista DataSet.sample_over_line",
        "proves_not_baked_only": True,
        "no_fake_curve": True,
    }

    if n_path == 0:
        base["reason"] = "no_points"
        return base
    if n_path < 2:
        base["reason"] = "need_two_points"
        return base

    resolved = resolve_scalar(label, grid)
    src = ensure_scalars(grid, resolved)
    scalar_key = resolved
    if scalar_key == "magU" and "magU" not in src.point_data and "U" in src.point_data:
        U = np.asarray(src.point_data["U"], dtype=float)
        src.point_data["magU"] = np.linalg.norm(U[:, :3], axis=1)

    resolution = segment_resolution(subdiv)
    all_dist: list[float] = []
    all_val: list[float] = []
    all_xyz: list[list[float]] = []
    cum = 0.0

    for i in range(n_path - 1):
        a = np.asarray(pts[i], dtype=float)
        b = np.asarray(pts[i + 1], dtype=float)
        seg_len = float(np.linalg.norm(b - a))
        try:
            sampled = src.sample_over_line(a, b, resolution=resolution)
        except Exception:
            continue
        if sampled is None or int(getattr(sampled, "n_points", 0) or 0) == 0:
            continue
        mask = valid_mask(sampled)
        sp = np.asarray(sampled.points, dtype=float)
        if scalar_key in sampled.point_data:
            raw = np.asarray(sampled.point_data[scalar_key], dtype=float)
        elif "magU" in sampled.point_data:
            raw = np.asarray(sampled.point_data["magU"], dtype=float)
            scalar_key = "magU"
        elif "U" in sampled.point_data:
            U = np.asarray(sampled.point_data["U"], dtype=float)
            raw = np.linalg.norm(U[:, :3], axis=1)
            scalar_key = "U_mag"
        else:
            continue
        if raw.ndim > 1:
            raw = np.linalg.norm(raw[:, :3], axis=1)
        if sp.shape[0] == 1:
            local_t = np.array([0.0])
        else:
            local_t = np.linspace(0.0, 1.0, sp.shape[0])
        start_j = 0 if i == 0 else 1
        for j in range(start_j, sp.shape[0]):
            if j >= len(mask) or not bool(mask[j]):
                continue
            v = float(raw[j])
            if not np.isfinite(v):
                continue
            all_dist.append(cum + float(local_t[j]) * seg_len)
            all_val.append(v)
            all_xyz.append([float(sp[j, 0]), float(sp[j, 1]), float(sp[j, 2])])
        cum += seg_len

    distances = np.asarray(all_dist, dtype=float)
    values = np.asarray(all_val, dtype=float)
    n_valid = int(values.size)
    empty = n_valid == 0
    base["field_name"] = str(scalar_key)
    base["distances"] = [float(x) for x in distances.tolist()]
    base["values"] = [float(x) for x in values.tolist()]
    base["sample_points"] = all_xyz
    base["n_samples"] = n_valid
    base["n_valid"] = n_valid
    base["empty"] = empty
    if empty:
        base["reason"] = "miss_mesh"
        base["distance_max"] = float(cum) if cum > 0 else 0.0
    else:
        base["reason"] = "ok"
        base["value_checksum"] = float(np.nansum(values))
        base["value_mean"] = float(np.nanmean(values))
        base["value_min"] = float(np.nanmin(values))
        base["value_max"] = float(np.nanmax(values))
        base["distance_max"] = float(np.nanmax(distances)) if distances.size else 0.0
    return base


def export_plot_over_path(
    case_dir: Path,
    time: str,
    out_dir: Path,
    *,
    points: list[list[float]],
    subdivisions: int = 0,
    field_variable: str = "Velocity Magnitude",
    field: str | None = None,
) -> dict:
    case_dir = Path(case_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    vtu_path = case_dir / ".cfddesk-prepared.vtu"
    if not vtu_path.is_file():
        raise FileNotFoundError(f"missing prepared VTU: {vtu_path}")
    # Prefer magU foam stamp proof
    u_path = case_dir / str(time) / "U"
    p_path = case_dir / str(time) / "p"
    mesh = pv.read(str(vtu_path))
    label = field_variable
    if field and not field_variable:
        label = "Velocity Magnitude" if field == "magU" else ("Pressure" if field == "p" else field)
    if field in ("magU", "p") and field_variable in ("", None, "Velocity Magnitude") and field == "p":
        label = "Pressure"
    series = sample_over_path(mesh, points, subdivisions, label)
    series.update(
        {
            "case_dir": str(case_dir),
            "time": str(time),
            "source_vtu": str(vtu_path),
            "source_foam_U": str(u_path) if u_path.is_file() else None,
            "source_foam_p": str(p_path) if p_path.is_file() else None,
            "u_from_case": bool(u_path.is_file()),
            "bounds": list(map(float, mesh.bounds)),
            "n_mesh_points": int(mesh.n_points),
            "n_mesh_cells": int(mesh.n_cells),
        }
    )
    out_meta = out_dir / "plot_over_path.meta.json"
    out_meta.write_text(json.dumps(series, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "meta": str(out_meta),
                "n_samples": series["n_samples"],
                "empty": series["empty"],
                "reason": series["reason"],
                "field_name": series["field_name"],
            }
        )
    )
    return series


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", type=Path, required=True, help="OpenFOAM case directory")
    ap.add_argument("--time", default="50")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--points", type=str, default="")
    ap.add_argument("--subdivisions", type=int, default=0)
    ap.add_argument("--field-variable", default="Velocity Magnitude")
    ap.add_argument("--field", default="")
    args = ap.parse_args()
    pts = parse_points(args.points)
    export_plot_over_path(
        args.case,
        args.time,
        args.out_dir,
        points=pts,
        subdivisions=args.subdivisions,
        field_variable=args.field_variable,
        field=args.field or None,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
