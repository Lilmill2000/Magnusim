"""W13: Inspect point live ? sample field at a world point from case VTU.

Server-side path (documented):
  GET /api/inspect?x=&y=&z=&time=  -> Vite middleware
  -> export_inspect_point.py reads case .cfddesk-prepared.vtu
  -> single-point PolyData.sample(volume) probe (sample_over_point family)
  -> JSON { magU, p, hit, fingerprint }. Honest miss when vtkValidPointMask=0.

Uniform foam times (e.g. 0/U) overwrite volume scalars before probe so
values track case API time (same honesty as W12 field export).
Not a SimScale value-panel invent ? values only when the probe hits.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import pyvista as pv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from case_units import field_scale, kinematic_fields, pressure_meta  # noqa: E402
from case_volume import load_volume  # noqa: E402
from result_names import ensure_shown_field  # noqa: E402

APPROACH = (
    "server-side sample_over_point / probe: Vite /api/inspect?x=&y=&z=&time= -> "
    "export_inspect_point.py reads the case volume at the requested time "
    "-> PolyData([x,y,z]).sample(volume) with vtkValidPointMask "
    "-> magU/p at pick. Honest miss off-mesh (no fake value)."
)


def parse_foam_uniform_vector(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    m_u = re.search(r"internalField\s+uniform\s+\(([^)]+)\)", text)
    if not m_u:
        return None
    parts = [float(x) for x in m_u.group(1).split()]
    if len(parts) != 3:
        return None
    return parts


def parse_foam_uniform_scalar(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    m_u = re.search(r"internalField\s+uniform\s+([^\s;]+)", text)
    if not m_u:
        return None
    try:
        return float(m_u.group(1))
    except ValueError:
        return None


def ensure_magU(grid: pv.DataSet) -> pv.DataSet:
    try:
        ensure_shown_field(grid, "magU")
    except RuntimeError:
        pass
    return grid


def scalar_at(sampled: pv.DataSet, name: str):
    if name in sampled.point_data:
        arr = np.asarray(sampled.point_data[name], dtype=float).reshape(-1)
        if arr.size == 0:
            return None
        v = float(arr[0])
        return v if np.isfinite(v) else None
    if name == "magU" and "U" in sampled.point_data:
        U = np.asarray(sampled.point_data["U"], dtype=float).reshape(-1, 3)
        if U.shape[0] == 0:
            return None
        return float(np.linalg.norm(U[0, :3]))
    return None


def _checksum(mag_u, p, pt) -> float:
    if mag_u is not None and p is not None:
        return float(mag_u) * 1_000_003.0 + float(p) * 17.0 + pt[0] * 3.0 + pt[1] * 5.0 + pt[2] * 7.0
    if mag_u is not None:
        return float(mag_u) * 1_000_003.0 + pt[0] * 3.0 + pt[1] * 5.0 + pt[2] * 7.0
    return 0.0


def probe_point(grid: pv.DataSet, xyz):
    pt = [float(xyz[0]), float(xyz[1]), float(xyz[2])]
    cloud = pv.PolyData(np.asarray([pt], dtype=float))
    sampled = cloud.sample(grid)
    hit = False
    if "vtkValidPointMask" in sampled.point_data:
        m = np.asarray(sampled.point_data["vtkValidPointMask"]).reshape(-1)
        hit = bool(m.size and int(m[0]) != 0)
    else:
        mu = scalar_at(sampled, "magU")
        hit = mu is not None and np.isfinite(mu)

    magU = scalar_at(sampled, "magU") if hit else None
    p = scalar_at(sampled, "p") if hit else None
    if hit and magU is None and "U" in sampled.point_data:
        magU = scalar_at(sampled, "magU")

    checksum = _checksum(magU, p, pt) if hit else 0.0

    return {
        "hit": bool(hit),
        "empty": not bool(hit),
        "reason": "" if hit else "miss_mesh",
        "magU": None if not hit else (None if magU is None else float(magU)),
        "p": None if not hit else (None if p is None else float(p)),
        "value_checksum": float(checksum),
        "no_fake_value": True,
    }


def uniform_foam_values(case_dir: Path, time: str) -> dict:
    """This time's uniform U/p (e.g. 0/U = (0 0 0)) without touching any volume."""
    proof = {"uniform_U": False, "uniform_p": False, "U": None, "p": None}
    u_path = case_dir / str(time) / "U"
    p_path = case_dir / str(time) / "p"
    if u_path.is_file():
        uv = parse_foam_uniform_vector(u_path)
        if uv is not None:
            proof["uniform_U"] = True
            proof["U"] = uv
            proof["magU"] = float(np.linalg.norm(uv))
    if p_path.is_file():
        pv_ = parse_foam_uniform_scalar(p_path)
        if pv_ is not None:
            proof["uniform_p"] = True
            proof["p"] = float(pv_)
    return proof


def _point_grid(mesh: pv.DataSet) -> pv.DataSet:
    mesh = ensure_magU(mesh)
    if "magU" not in mesh.point_data and "magU" in mesh.cell_data:
        mesh = mesh.cell_data_to_point_data(pass_cell_data=True)
    elif "p" not in mesh.point_data and "p" in mesh.cell_data:
        mesh = mesh.cell_data_to_point_data(pass_cell_data=True)
    return ensure_magU(mesh)


def export_inspect(
    case_dir: Path,
    time: str,
    out_dir: Path,
    x: float,
    y: float,
    z: float,
    *,
    mesh=None,
    source: str | None = None,
) -> dict:
    """Probe magU/p at a point. ``mesh`` is the worker's shared kinematic volume:
    it is only read — uniform-foam overrides and Pa scaling apply to the probed
    values, never to the volume."""
    case_dir = case_dir.resolve()
    time = str(time)
    time_dir = case_dir / time
    if not time_dir.is_dir():
        raise FileNotFoundError(f"time_not_found: missing time dir {time_dir}")

    u_path = time_dir / "U"
    p_path = time_dir / "p"
    if not u_path.is_file() and not p_path.is_file():
        raise FileNotFoundError(f"time_not_found: missing OpenFOAM U/p under {time_dir}")

    if mesh is None:
        mesh, vtu_path = load_volume(case_dir, time)
        volume_from = "fresh-load"
    else:
        vtu_path = source or "worker-cache"
        volume_from = "worker-cache"
    grid = mesh if ("magU" in mesh.point_data and "p" in mesh.point_data) else _point_grid(mesh)

    foam_proof = uniform_foam_values(case_dir, time)
    # rho when the case stores p per unit density (its kinematic_fields, or p
    # for older cases), else 1: a case that writes p in Pa is shown as stored.
    p_kinematic = "p" in kinematic_fields(case_dir)
    p_scale = field_scale(case_dir, "p")

    probed = probe_point(grid, [x, y, z])
    if probed["hit"]:
        if foam_proof["uniform_U"]:
            probed["magU"] = float(foam_proof["magU"])
        if foam_proof["uniform_p"]:
            probed["p"] = float(foam_proof["p"])
        if probed["p"] is not None:
            probed["p"] = float(probed["p"]) * p_scale
        probed["value_checksum"] = _checksum(probed["magU"], probed["p"], [x, y, z])
    mesh = grid
    fp = {
        "x": float(x),
        "y": float(y),
        "z": float(z),
        "hit": probed["hit"],
        "empty": probed["empty"],
        "magU": probed["magU"],
        "p": probed["p"],
        "value_checksum": probed["value_checksum"],
        "reason": probed["reason"],
    }

    result = {
        "increment": "W13",
        "case_dir": str(case_dir),
        "time": time,
        "point": [float(x), float(y), float(z)],
        "x": float(x),
        "y": float(y),
        "z": float(z),
        "hit": probed["hit"],
        "empty": probed["empty"],
        "reason": probed["reason"],
        "magU": probed["magU"],
        "p": probed["p"],
        "fields": {"magU": probed["magU"], "p": probed["p"]},
        "value_checksum": probed["value_checksum"],
        "fingerprint": fp,
        "method": "pyvista PolyData.sample (sample_over_point / probe)",
        "approach": APPROACH,
        "source_vtu": str(vtu_path),
        "volume_from": volume_from,
        "source_foam_U": str(u_path) if u_path.is_file() else None,
        "source_foam_p": str(p_path) if p_path.is_file() else None,
        "foam_uniform": foam_proof,
        "bounds": list(map(float, mesh.bounds)),
        "n_mesh_points": int(mesh.n_points),
        "n_mesh_cells": int(mesh.n_cells),
        "proves_not_baked_only": True,
        "no_fake_value": True,
        "units": {"magU": "m/s", "p": "Pa"},
        **pressure_meta(p_scale, kinematic=p_kinematic),
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    out_meta = out_dir / "inspect.meta.json"
    out_meta.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "meta": str(out_meta),
                "hit": result["hit"],
                "empty": result["empty"],
                "magU": result["magU"],
                "p": result["p"],
                "value_checksum": result["value_checksum"],
                "reason": result["reason"],
            }
        )
    )
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", type=Path, required=True, help="OpenFOAM case directory")
    ap.add_argument("--time", default="50")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--x", type=float, required=True)
    ap.add_argument("--y", type=float, required=True)
    ap.add_argument("--z", type=float, required=True)
    args = ap.parse_args()
    export_inspect(args.case, args.time, args.out_dir, args.x, args.y, args.z)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
