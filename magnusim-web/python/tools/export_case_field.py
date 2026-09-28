"""W6/W12: on-demand export of magU/p surface VTP from real OpenFOAM case tree.

Reads case_dir/<time>/U (or p) for fingerprint (uniform or nonuniform).
Builds surface from .cfddesk-prepared.vtu. For uniform foam fields (e.g. time 0
initial U=(0,0,0)), overwrites surface scalars with that uniform value so the
VTP fingerprint changes with time. Missing time dirs fail honestly (no fake field).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from case_units import (  # noqa: E402
    case_density,
    pressure_meta,
    pressure_stats_in_pa,
    scale_pressure,
)
from case_volume import load_volume  # noqa: E402


def read_internal_field(path: Path, kind: str):
    """``("uniform", value)`` or ``("nonuniform", array)`` for a field's internalField.

    Reads ascii and binary OpenFOAM files (``format binary;`` with the ``arch``
    scalar width). ``value`` is a float (scalar) or 3-list (vector); ``array`` is
    ``(n,)`` or ``(n, 3)`` float64.
    """
    raw = path.read_bytes()
    comp = "vector" if kind == "vector" else "scalar"
    if comp == "vector":
        m_u = re.search(rb"internalField\s+uniform\s+\(([^)]+)\)", raw)
        if m_u:
            parts = [float(x) for x in m_u.group(1).split()]
            if len(parts) != 3:
                raise RuntimeError(f"{path.name} uniform vector malformed")
            return "uniform", parts
    else:
        m_u = re.search(rb"internalField\s+uniform\s+([^\s;]+)", raw)
        if m_u:
            return "uniform", float(m_u.group(1))
    m = re.search(rb"internalField\s+nonuniform\s+List<" + comp.encode() + rb">\s*(\d+)\s*\(", raw)
    if not m:
        raise RuntimeError(f"{path.name} internalField not found ({comp})")
    n = int(m.group(1))
    width = 3 if comp == "vector" else 1
    head = raw[: m.start()]
    if re.search(rb"format\s+binary", head):
        dtype = "<f4" if re.search(rb"scalar\s*=\s*32", head) else "<f8"
        count = n * width
        if len(raw) < m.end() + count * np.dtype(dtype).itemsize:
            raise RuntimeError(f"{path.name} internalField truncated")
        arr = np.frombuffer(raw, dtype=dtype, count=count, offset=m.end()).astype(np.float64)
    else:
        body = raw[m.end() :]
        stop = body.find(b"\n)") if comp == "vector" else body.find(b")")
        if stop < 0:
            raise RuntimeError(f"{path.name} internalField terminator not found")
        # Vector rows are "(x y z)": drop the brackets, parse every number at once.
        arr = np.array(body[:stop].translate(None, b"()").split(), dtype=np.float64)
    if arr.size != n * width:
        name = "U" if comp == "vector" else "p"
        raise RuntimeError(f"{name} count mismatch {arr.size // width} != {n}")
    return "nonuniform", arr.reshape(n, 3) if comp == "vector" else arr


def parse_foam_scalar_or_vector(path: Path, kind: str):
    """Stats of an OpenFOAM internalField (ascii or binary); kind in ('vector','scalar')."""
    shape, data = read_internal_field(path, kind)
    if kind == "vector":
        if shape == "uniform":
            parts = [float(x) for x in data]
            mag = float(np.linalg.norm(parts))
            sample = np.asarray([mag] * 8, dtype=np.float64)
            h = hashlib.sha256()
            h.update(b"uniform-vector")
            h.update(np.asarray(parts, dtype="<f8").tobytes())
            return {
                "foam_object": "U",
                "uniform": True,
                "uniform_vector": parts,
                "n_cells_internal": 0,
                "umin": mag,
                "umax": mag,
                "umean": mag,
                "nonzero": 0 if mag == 0 else 1,
                "sample_checksum_sha256": h.hexdigest(),
                "sample_head": [float(x) for x in sample[:8]],
                "sample_tail": [float(x) for x in sample[:8]],
                "source_path": str(path),
            }
        n = int(data.shape[0])
        mag = np.linalg.norm(data, axis=1)
        sample = np.concatenate([mag[:64], mag[-64:]])
        h = hashlib.sha256()
        h.update(n.to_bytes(8, "little"))
        h.update(sample.astype("<f8").tobytes())
        return {
            "foam_object": "U",
            "uniform": False,
            "n_cells_internal": n,
            "umin": float(mag.min()),
            "umax": float(mag.max()),
            "umean": float(mag.mean()),
            "nonzero": int(np.count_nonzero(mag > 0)),
            "sample_checksum_sha256": h.hexdigest(),
            "sample_head": [float(x) for x in mag[:8]],
            "sample_tail": [float(x) for x in mag[-8:]],
            "source_path": str(path),
        }
    if shape == "uniform":
        val = float(data)
        sample = np.asarray([val] * 8, dtype=np.float64)
        h = hashlib.sha256()
        h.update(b"uniform-scalar")
        h.update(np.asarray([val], dtype="<f8").tobytes())
        return {
            "foam_object": "p",
            "uniform": True,
            "uniform_scalar": val,
            "n_cells_internal": 0,
            "pmin": val,
            "pmax": val,
            "pmean": val,
            "nonzero": 0 if val == 0 else 1,
            "sample_checksum_sha256": h.hexdigest(),
            "sample_head": [float(x) for x in sample[:8]],
            "sample_tail": [float(x) for x in sample[:8]],
            "source_path": str(path),
        }
    arr = data
    n = int(arr.shape[0])
    sample = np.concatenate([arr[:64], arr[-64:]])
    h = hashlib.sha256()
    h.update(n.to_bytes(8, "little"))
    h.update(sample.astype("<f8").tobytes())
    return {
        "foam_object": "p",
        "uniform": False,
        "n_cells_internal": n,
        "pmin": float(arr.min()),
        "pmax": float(arr.max()),
        "pmean": float(arr.mean()),
        "nonzero": int(np.count_nonzero(arr != 0)),
        "sample_checksum_sha256": h.hexdigest(),
        "sample_head": [float(x) for x in arr[:8]],
        "sample_tail": [float(x) for x in arr[-8:]],
        "source_path": str(path),
    }


def ensure_field_on_mesh(mesh, field: str):
    if field == "magU":
        if "magU" not in mesh.cell_data and "magU" not in mesh.point_data:
            if "U" in mesh.cell_data:
                U = np.asarray(mesh.cell_data["U"])
                mesh.cell_data["magU"] = np.linalg.norm(U, axis=1)
            elif "U" in mesh.point_data:
                U = np.asarray(mesh.point_data["U"])
                mesh.point_data["magU"] = np.linalg.norm(U, axis=1)
            else:
                raise RuntimeError("mesh missing magU/U")
        return
    if "p" not in mesh.cell_data and "p" not in mesh.point_data:
        raise RuntimeError("mesh missing p")


_FOAM_TIME = re.compile(r"^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$")


def list_field_times(case_dir: Path, field: str) -> list[str]:
    names: list[str] = []
    field = "magU" if field == "magU" else "p"
    foam_name = "U" if field == "magU" else "p"
    try:
        ents = list(Path(case_dir).iterdir())
    except OSError:
        return []
    for p in ents:
        if not p.is_dir() or not _FOAM_TIME.match(p.name):
            continue
        if (p / foam_name).is_file() or (p / f"{foam_name}.gz").is_file():
            names.append(p.name)
    names.sort(key=lambda s: float(s))
    return names


def series_field_range(case_dir: Path, field: str) -> dict:
    """Overall foam min/max across every saved time. No VTK, no per-frame legend."""
    field = "magU" if str(field).strip() == "magU" else "p"
    case_dir = Path(case_dir).resolve()
    times = list_field_times(case_dir, field)
    kind = "vector" if field == "magU" else "scalar"
    foam_name = "U" if field == "magU" else "p"
    # Surfaces show p in Pa, so the whole-run legend range must be Pa too.
    scale = 1.0 if field == "magU" else case_density(case_dir)
    frames = []
    lo = None
    hi = None
    for t in times:
        path = case_dir / t / foam_name
        if not path.is_file():
            continue
        stats = parse_foam_scalar_or_vector(path, kind)
        a = float(stats["umin"] if field == "magU" else stats["pmin"]) * scale
        b = float(stats["umax"] if field == "magU" else stats["pmax"]) * scale
        frames.append({"time": t, "min": a, "max": b, "uniform": bool(stats.get("uniform"))})
        lo = a if lo is None else min(lo, a)
        hi = b if hi is None else max(hi, b)
    return {
        "ok": True,
        "field": field,
        "case_dir": str(case_dir),
        "times": times,
        "n_times": len(times),
        "min": lo,
        "max": hi,
        "frames": frames,
        "series": True,
        "unit": "m/s" if field == "magU" else "Pa",
    }


def export_field(case_dir: Path, time: str, field: str, out_dir: Path, mesh=None, source_vtu=None):
    field = field.strip()
    if field not in ("magU", "p"):
        raise ValueError(f"unsupported field {field}; use magU or p")
    case_dir = case_dir.resolve()
    time = str(time)
    time_dir = case_dir / time
    if not time_dir.is_dir():
        raise FileNotFoundError(f"time_not_found: missing time dir {time_dir}")

    foam_stats = None
    if field == "magU":
        u_path = time_dir / "U"
        if not u_path.is_file():
            raise FileNotFoundError(f"time_not_found: missing OpenFOAM U: {u_path}")
        foam_stats = parse_foam_scalar_or_vector(u_path, "vector")
    else:
        p_path = time_dir / "p"
        if not p_path.is_file():
            raise FileNotFoundError(f"time_not_found: missing OpenFOAM p: {p_path}")
        foam_stats = parse_foam_scalar_or_vector(p_path, "scalar")

    if mesh is None:
        try:
            mesh, source_vtu = load_volume(case_dir, time)
        except Exception as exc:
            raise FileNotFoundError(
                f"missing prepared VTU and OpenFOAM read failed: {case_dir} ({exc})"
            ) from exc
    elif not source_vtu:
        source_vtu = "worker-cache"
    ensure_field_on_mesh(mesh, field)
    rho = case_density(case_dir)

    # The volume may be the worker's shared cache: scale only the extracted
    # surface (its own arrays), never the volume, so p is Pa exactly once.
    surf = mesh.extract_surface()
    if field == "p":
        scale_pressure(surf, rho)
    if field in surf.cell_data and field not in surf.point_data:
        surf = surf.cell_data_to_point_data(pass_cell_data=True)

    # W12: uniform foam at this time (e.g. 0/U = (0,0,0)) -> honest surface fill
    if foam_stats.get("uniform"):
        if field == "magU":
            fill = float(foam_stats["umin"])
        else:
            fill = float(foam_stats["pmin"]) * rho
        if field in surf.point_data:
            surf.point_data[field][:] = fill
        else:
            surf.point_data[field] = np.full(surf.n_points, fill, dtype=np.float64)
        if field in surf.cell_data:
            surf.cell_data[field][:] = fill

    if field == "magU":
        keep_point = [k for k in ("magU", "U") if k in surf.point_data]
        keep_cell = [k for k in ("magU",) if k in surf.cell_data]
    else:
        keep_point = [k for k in ("p",) if k in surf.point_data]
        keep_cell = [k for k in ("p",) if k in surf.cell_data]
    for k in list(surf.point_data.keys()):
        if k not in keep_point:
            del surf.point_data[k]
    for k in list(surf.cell_data.keys()):
        if k not in keep_cell:
            del surf.cell_data[k]

    out_dir.mkdir(parents=True, exist_ok=True)
    out_vtp = out_dir / f"{field}.vtp"
    out_meta = out_dir / f"{field}.meta.json"
    surf.save(str(out_vtp), binary=True)
    vtp_bytes = out_vtp.read_bytes()
    vtp_sha = hashlib.sha256(vtp_bytes).hexdigest()

    arr_pt = np.asarray(surf.point_data[field]) if field in surf.point_data else None
    surf_min = float(np.nanmin(arr_pt)) if arr_pt is not None else None
    surf_max = float(np.nanmax(arr_pt)) if arr_pt is not None else None

    meta = {
        "increment": "W12",
        "case_dir": str(case_dir),
        "time": time,
        "field": field,
        "fields_available": ["magU", "p"],
        "source_vtu": source_vtu,
        "convert_method": (
            "on-demand pyvista: read .cfddesk-prepared.vtu or OpenFOAMReader "
            "at the requested time -> extract_surface -> cell_data_to_point_data "
            "-> binary VTP; fingerprint from OpenFOAM "
            f"{time}/{'U' if field == 'magU' else 'p'} ascii; uniform foam times "
            "overwrite surface scalars (W12 animation live; not baked public/)"
        ),
        "proves_not_baked_only": True,
        "baked_public_fallback": "public/mtp1-fields.vtp (W5 cache only; viewport uses API)",
        "asset_bytes": len(vtp_bytes),
        "asset_sha256": vtp_sha,
        "n_points": int(surf.n_points),
        "n_cells": int(surf.n_cells),
        "bounds": list(map(float, surf.bounds)),
        "foam_proof": pressure_stats_in_pa(foam_stats, rho) if field == "p" else foam_stats,
        "surface_field": {
            "name": field,
            "min": surf_min,
            "max": surf_max,
            "n_samples": int(arr_pt.size) if arr_pt is not None else 0,
        },
        "u_from_case": foam_stats if field == "magU" else None,
        "no_fake_solve": True,
        "no_simscale_22_2": True,
        "uniform_foam": bool(foam_stats.get("uniform")),
        "field_unit": "Pa" if field == "p" else "m/s",
        "pressure_range_unit": "Pa",
        **pressure_meta(rho),
    }
    out_meta.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "vtp": str(out_vtp), "meta": str(out_meta), "bytes": len(vtp_bytes)}))
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", type=Path, required=True, help="OpenFOAM case directory")
    ap.add_argument("--time", default="50")
    ap.add_argument("--field", default="magU")
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--series-range", action="store_true")
    args = ap.parse_args()
    if args.series_range:
        print(json.dumps(series_field_range(args.case, args.field)))
        return
    out_dir = args.out_dir
    if out_dir is None:
        root = Path(__file__).resolve().parents[2]  # cfd-web/
        out_dir = root / ".cache" / "case-field-cli" / args.field
    export_field(args.case, args.time, args.field, out_dir)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
