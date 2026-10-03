"""W13: Inspect point live: sample the shown fields at a world point.

Server-side path (documented):
  GET /api/inspect?x=&y=&z=&time=[&fields=a,b]  -> Vite middleware
  -> export_inspect_point.py reads the case volume at the requested time
  -> single-point PolyData.sample(volume) probe (sample_over_point family)
  -> JSON { values: {name: v}, hit, fingerprint }. Honest miss when vtkValidPointMask=0.

The fields are the frame's shown fields (a scalar by its name, a vector X as
magX) unless the caller names some. A field stored uniform at this time (e.g.
0/U) gives its uniform value, so values track the case time (same honesty as
the W12 field export). A field the case stores per unit density (its
kinematic_fields) is shown times rho. Values only when the probe hits.
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
from export_case_field import read_internal_field  # noqa: E402
from result_names import (  # noqa: E402
    FIELD_NAME,
    dataset_shown_fields,
    ensure_shown_field,
    foam_source,
    mag_base,
    shown_fields,
)

APPROACH = (
    "server-side sample_over_point / probe: Vite /api/inspect?x=&y=&z=&time= -> "
    "export_inspect_point.py reads the case volume at the requested time "
    "-> PolyData([x,y,z]).sample(volume) with vtkValidPointMask "
    "-> every shown field at pick. Honest miss off-mesh (no fake value)."
)

# Deprecated mirrors for the page's two fixed rows (it reads the top-level magU
# and p and their units); written only when the probe covers those fields.
LEGACY_MIRRORS = ("magU", "p")
LEGACY_UNITS = {"magU": "m/s", "p": "Pa"}

# Checksum weights: the first two keep the checksum the page already knew.
_CHECKSUM_WEIGHTS = {"magU": 1_000_003.0, "p": 17.0}


def value_at(sampled: pv.DataSet, name: str) -> float | None:
    """The probed value of shown field ``name`` (None when the probe has none)."""
    try:
        ensure_shown_field(sampled, name)
    except RuntimeError:
        return None
    if name not in sampled.point_data:
        return None
    arr = np.asarray(sampled.point_data[name], dtype=float).reshape(-1)
    if arr.size == 0:
        return None
    v = float(arr[0])
    return v if np.isfinite(v) else None


def _checksum(values: dict[str, float | None], pt) -> float:
    present = [(n, v) for n, v in sorted(values.items()) if v is not None]
    if not present:
        return 0.0
    total = sum(float(v) * _CHECKSUM_WEIGHTS.get(n, 101.0 + 2.0 * i) for i, (n, v) in enumerate(present))
    return total + pt[0] * 3.0 + pt[1] * 5.0 + pt[2] * 7.0


def _mirror(out: dict, values: dict[str, float | None]) -> None:
    for key in LEGACY_MIRRORS:
        if key in values:
            out[key] = values[key]


def _sample_once(grid: pv.DataSet, pt, names) -> tuple[pv.DataSet, bool]:
    cloud = pv.PolyData(np.asarray([pt], dtype=float))
    sampled = cloud.sample(grid)
    if "vtkValidPointMask" in sampled.point_data:
        m = np.asarray(sampled.point_data["vtkValidPointMask"]).reshape(-1)
        return sampled, bool(m.size and int(m[0]) != 0)
    return sampled, any(value_at(sampled, n) is not None for n in names)


# A point this close to the mesh (relative to its size) is on it: a pick on the
# domain's outer face lands on the boundary, a rounding error outside the cells.
_ON_MESH = 1e-6


def _inside_point(grid: pv.DataSet, pt) -> list[float] | None:
    """For a point on the mesh's outer boundary, a point just inside the cell it
    lies on; None when the point is off the mesh."""
    try:
        cell, closest = grid.find_closest_cell(np.asarray(pt, dtype=float), return_closest_point=True)
    except Exception:
        return None
    if int(cell) < 0:
        return None
    b = np.asarray(grid.bounds, dtype=float)
    diag = float(np.linalg.norm([b[1] - b[0], b[3] - b[2], b[5] - b[4]])) or 1.0
    closest = np.asarray(closest, dtype=float)
    if float(np.linalg.norm(closest - np.asarray(pt, dtype=float))) > _ON_MESH * diag:
        return None
    center = np.asarray(grid.extract_cells([int(cell)]).center, dtype=float)
    return [float(v) for v in closest + (center - closest) * 1e-4]


def probe_point(grid: pv.DataSet, xyz, names=None):
    """Probe ``names`` (default: every field the grid shows) at one point. A point
    on the mesh's outer boundary reads the cell it lies on."""
    pt = [float(xyz[0]), float(xyz[1]), float(xyz[2])]
    names = list(names) if names is not None else dataset_shown_fields(grid)
    sampled, hit = _sample_once(grid, pt, names)
    if not hit:
        inside = _inside_point(grid, pt)
        if inside is not None:
            sampled, hit = _sample_once(grid, inside, names)

    values: dict[str, float | None] = {n: (value_at(sampled, n) if hit else None) for n in names}
    out = {
        "hit": bool(hit),
        "empty": not bool(hit),
        "reason": "" if hit else "miss_mesh",
        "values": values,
        "value_checksum": float(_checksum(values, pt)) if hit else 0.0,
        "no_fake_value": True,
    }
    _mirror(out, values)
    return out


_UNIFORM_HEAD = re.compile(rb"internalField\s+uniform\b")


def _stored_uniform(path: Path) -> bool:
    """True when the file's internalField is uniform (read from its head only, so a
    large nonuniform field is never parsed here)."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(65536)
    except OSError:
        return False
    return bool(_UNIFORM_HEAD.search(head))


def uniform_values(case_dir: Path, time: str, names) -> dict[str, float]:
    """This time's uniform fields (e.g. 0/U = (0 0 0)) by shown name, as stored,
    without touching any volume. A vector gives its magnitude."""
    time_dir = Path(case_dir) / str(time)
    out: dict[str, float] = {}
    for name in names:
        src = foam_source(time_dir, name)
        if src is None:
            continue
        foam_name, kind = src
        path = time_dir / foam_name
        if not _stored_uniform(path):
            continue
        try:
            shape, data = read_internal_field(path, kind)
        except (OSError, RuntimeError, ValueError):
            continue
        if shape != "uniform":
            continue
        out[name] = float(np.linalg.norm(data)) if kind == "vector" else float(data)
    return out


def _point_grid(mesh: pv.DataSet, names=None) -> pv.DataSet:
    """The volume with every probed field on its points (cells promoted when needed)."""
    names = list(names) if names is not None else dataset_shown_fields(mesh)
    need_points = False
    for name in names:
        try:
            ensure_shown_field(mesh, name)
        except RuntimeError:
            continue
        if name not in mesh.point_data:
            need_points = True
    if not need_points:
        return mesh
    mesh = mesh.cell_data_to_point_data(pass_cell_data=True)
    for name in names:
        try:
            ensure_shown_field(mesh, name)
        except RuntimeError:
            pass
    return mesh


def _foam_name(time_dir: Path, name: str) -> str:
    src = foam_source(time_dir, name)
    if src is not None:
        return src[0]
    return mag_base(name) or name


def _field_names(fields, available: list[str]) -> list[str]:
    if not fields:
        return list(available)
    if isinstance(fields, str):
        fields = fields.replace(";", ",").split(",")
    names: list[str] = []
    for raw in fields:
        name = str(raw or "").strip()
        if not name:
            continue
        if not FIELD_NAME.match(name):
            raise ValueError(f"unsupported field name {name!r}")
        if name not in names:
            names.append(name)
    return names or list(available)


def export_inspect(
    case_dir: Path,
    time: str,
    out_dir: Path,
    x: float,
    y: float,
    z: float,
    *,
    fields=None,
    mesh=None,
    source: str | None = None,
) -> dict:
    """Probe the shown fields (or ``fields``) at a point. ``mesh`` is the worker's
    shared volume, as stored: it is only read (derived magnitudes aside), and the
    uniform-time overrides and density scaling apply to the probed values only."""
    case_dir = Path(case_dir).resolve()
    time = str(time)
    time_dir = case_dir / time
    if not time_dir.is_dir():
        raise FileNotFoundError(f"time_not_found: missing time dir {time_dir}")
    available = shown_fields(time_dir)
    if not available:
        raise FileNotFoundError(f"time_not_found: no result fields under {time_dir}")
    names = _field_names(fields, available)

    if mesh is None:
        mesh, vtu_path = load_volume(case_dir, time)
        volume_from = "fresh-load"
    else:
        vtu_path = source or "worker-cache"
        volume_from = "worker-cache"
    grid = _point_grid(mesh, names)

    uniform = uniform_values(case_dir, time, names)
    scales = {n: field_scale(case_dir, _foam_name(time_dir, n)) for n in names}

    probed = probe_point(grid, [x, y, z], names)
    values: dict[str, float | None] = dict(probed["values"])
    if probed["hit"]:
        for name in names:
            if name in uniform:
                values[name] = uniform[name]
            if values[name] is not None:
                values[name] = float(values[name]) * scales[name]
        probed["value_checksum"] = _checksum(values, [x, y, z])
    fp = {
        "x": float(x),
        "y": float(y),
        "z": float(z),
        "hit": probed["hit"],
        "empty": probed["empty"],
        "values": values,
        "value_checksum": probed["value_checksum"],
        "reason": probed["reason"],
    }
    _mirror(fp, values)

    sources = {}
    for name in names:
        src = foam_source(time_dir, name)
        if src is not None:
            sources[name] = str(time_dir / src[0])

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
        "values": values,
        "fields": names,
        "fields_available": available,
        "value_checksum": probed["value_checksum"],
        "fingerprint": fp,
        "method": "pyvista PolyData.sample (sample_over_point / probe)",
        "approach": APPROACH,
        "source_vtu": str(vtu_path),
        "volume_from": volume_from,
        "source_foam": sources,
        "foam_uniform": uniform,
        # Fields shown times the case's density (stored per unit density).
        "scaled_by_density": sorted(n for n, s in scales.items() if s != 1.0),
        "bounds": list(map(float, grid.bounds)),
        "n_mesh_points": int(grid.n_points),
        "n_mesh_cells": int(grid.n_cells),
        "proves_not_baked_only": True,
        "no_fake_value": True,
    }
    _mirror(result, values)
    units = {k: LEGACY_UNITS[k] for k in LEGACY_MIRRORS if k in values}
    if units:
        result["units"] = units
    if "p" in values:
        # rho when the case stores p per unit density (its kinematic_fields, or
        # p for older cases), else 1: a case that writes p in Pa is shown as stored.
        result.update(pressure_meta(scales["p"], kinematic="p" in kinematic_fields(case_dir)))

    out_dir.mkdir(parents=True, exist_ok=True)
    out_meta = out_dir / "inspect.meta.json"
    out_meta.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    summary = {
        "ok": True,
        "meta": str(out_meta),
        "hit": result["hit"],
        "empty": result["empty"],
        "values": values,
        "value_checksum": result["value_checksum"],
        "reason": result["reason"],
    }
    _mirror(summary, values)
    print(json.dumps(summary))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", type=Path, required=True, help="OpenFOAM case directory")
    ap.add_argument("--time", default="50")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--x", type=float, required=True)
    ap.add_argument("--y", type=float, required=True)
    ap.add_argument("--z", type=float, required=True)
    ap.add_argument("--fields", default="", help="comma-separated shown fields (default: all)")
    args = ap.parse_args()
    export_inspect(args.case, args.time, args.out_dir, args.x, args.y, args.z, fields=args.fields or None)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
