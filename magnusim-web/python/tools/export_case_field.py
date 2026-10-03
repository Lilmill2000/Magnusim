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
    PRESSURE_UNIT,
    case_density,
    field_scale,
    pressure_meta,
    pressure_stats_in_pa,
    scale_pressure,
)
from case_volume import load_volume  # noqa: E402
from result_names import (  # noqa: E402, F401  (foam_kind / FIELD_NAME / shown_fields: re-exported)
    FIELD_NAME,
    TENSOR_KINDS,
    case_result_fields,
    ensure_shown_field,
    foam_kind,
    foam_source,
    shown_fields,
)


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
        raise RuntimeError(f"{path.name} count mismatch {arr.size // width} != {n}")
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


_FOAM_TIME = re.compile(r"^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$")


def list_field_times(case_dir: Path, field: str) -> list[str]:
    names: list[str] = []
    field = str(field).strip()
    try:
        ents = list(Path(case_dir).iterdir())
    except OSError:
        return []
    for p in ents:
        if not p.is_dir() or not _FOAM_TIME.match(p.name):
            continue
        if foam_source(p, field) is not None:
            names.append(p.name)
    names.sort(key=lambda s: float(s))
    return names


def series_field_range(case_dir: Path, field: str) -> dict:
    """Overall foam min/max across every saved time. No VTK, no per-frame legend.

    Kinematic fields (the case's ``kinematic_fields``) are scaled by rho, as
    every surface shows them.
    """
    field = str(field).strip()
    if not FIELD_NAME.match(field):
        raise ValueError(f"unsupported field name {field!r}")
    case_dir = Path(case_dir).resolve()
    times = list_field_times(case_dir, field)
    frames = []
    lo = None
    hi = None
    scaled = False
    for t in times:
        src = foam_source(case_dir / t, field)
        if src is None:
            continue
        foam_name, kind = src
        path = case_dir / t / foam_name
        scale = field_scale(case_dir, foam_name)
        scaled = scaled or scale != 1.0
        stats = parse_foam_scalar_or_vector(path, kind)
        a = float(stats["umin"] if kind == "vector" else stats["pmin"]) * scale
        b = float(stats["umax"] if kind == "vector" else stats["pmax"]) * scale
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
        "scaled_by_density": scaled,
        **({"unit": PRESSURE_UNIT} if scaled else {}),
    }


def export_field(case_dir: Path, time: str, field: str, out_dir: Path, mesh=None, source_vtu=None):
    field = field.strip()
    if not FIELD_NAME.match(field):
        raise ValueError(f"unsupported field name {field!r}")
    case_dir = case_dir.resolve()
    time = str(time)
    time_dir = case_dir / time
    if not time_dir.is_dir():
        raise FileNotFoundError(f"time_not_found: missing time dir {time_dir}")

    src = foam_source(time_dir, field)
    if src is None:
        base = field[3:] if field.startswith("mag") and len(field) > 3 else field
        for name in dict.fromkeys((field, base)):
            found = foam_kind(time_dir / name) if (time_dir / name).is_file() else ""
            if found in TENSOR_KINDS:
                raise ValueError(f"{name} is a tensor field; it cannot be coloured as a scalar")
            if found == "face":
                raise ValueError(f"{name} is a face field; it cannot be coloured")
        raise FileNotFoundError(f"time_not_found: missing OpenFOAM {field}: {time_dir / field}")
    foam_name, kind = src
    foam_stats = parse_foam_scalar_or_vector(time_dir / foam_name, kind)

    if mesh is None:
        try:
            mesh, source_vtu = load_volume(case_dir, time)
        except Exception as exc:
            raise FileNotFoundError(
                f"missing prepared VTU and OpenFOAM read failed: {case_dir} ({exc})"
            ) from exc
    elif not source_vtu:
        source_vtu = "worker-cache"
    ensure_shown_field(mesh, field)
    rho = case_density(case_dir)
    scale = field_scale(case_dir, foam_name)

    # The volume may be the worker's shared cache: scale only the extracted
    # surface (its own arrays), never the volume, so a kinematic field is
    # scaled exactly once.
    surf = mesh.extract_surface()
    if scale != 1.0:
        scale_pressure(surf, rho, names=(field,))
    if field in surf.cell_data and field not in surf.point_data:
        surf = surf.cell_data_to_point_data(pass_cell_data=True)

    # W12: uniform foam at this time (e.g. 0/U = (0,0,0)) -> honest surface fill
    if foam_stats.get("uniform"):
        fill = float(foam_stats["umin"] if kind == "vector" else foam_stats["pmin"]) * scale
        if field in surf.point_data:
            surf.point_data[field][:] = fill
        else:
            surf.point_data[field] = np.full(surf.n_points, fill, dtype=np.float64)
        if field in surf.cell_data:
            surf.cell_data[field][:] = fill

    # A magnitude keeps its vector on the points too (glyphs, inspect).
    keep_point = [k for k in (field, foam_name if kind == "vector" else "") if k and k in surf.point_data]
    keep_cell = [k for k in (field,) if k in surf.cell_data]
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

    if kind == "vector":
        proof = dict(foam_stats)
        proof.update({"min": proof.get("umin"), "max": proof.get("umax"), "mean": proof.get("umean")})
    else:
        proof = pressure_stats_in_pa(foam_stats, rho) if scale != 1.0 else dict(foam_stats)
        proof.update({"min": proof.get("pmin"), "max": proof.get("pmax"), "mean": proof.get("pmean")})

    meta = {
        "increment": "W12",
        "case_dir": str(case_dir),
        "time": time,
        "field": field,
        "fields_available": shown_fields(time_dir),
        # The analysis's result fields from the case sidecar (labels, units); None without one.
        "result_fields": case_result_fields(case_dir),
        "source_vtu": source_vtu,
        "convert_method": (
            "on-demand pyvista: read .cfddesk-prepared.vtu or OpenFOAMReader "
            "at the requested time -> extract_surface -> cell_data_to_point_data "
            "-> binary VTP; fingerprint from OpenFOAM "
            f"{time}/{foam_name}; uniform foam times "
            "overwrite surface scalars (W12 animation live; not baked public/)"
        ),
        "proves_not_baked_only": True,
        "baked_public_fallback": "public/mtp1-fields.vtp (W5 cache only; viewport uses API)",
        "asset_bytes": len(vtp_bytes),
        "asset_sha256": vtp_sha,
        "n_points": int(surf.n_points),
        "n_cells": int(surf.n_cells),
        "bounds": list(map(float, surf.bounds)),
        "foam_proof": proof,
        "surface_field": {
            "name": field,
            "min": surf_min,
            "max": surf_max,
            "n_samples": int(arr_pt.size) if arr_pt is not None else 0,
        },
        "u_from_case": proof if kind == "vector" else None,
        "no_fake_solve": True,
        "no_simscale_22_2": True,
        "uniform_foam": bool(foam_stats.get("uniform")),
        "foam_kind": kind,
        # The range (min / max) is in what the surface shows (a kinematic field x rho).
        "range_scaled": True,
        "scaled_by_density": scale != 1.0,
        **({"pressure_range_unit": PRESSURE_UNIT, **pressure_meta(rho)} if scale != 1.0 else {}),
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
