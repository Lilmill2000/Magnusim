"""Volume cutting-plane slice for Results.

pyvista DataSet.slice on the OpenFOAM volume (or prepared VTU) at the
requested origin/normal. That is a filled 2-D mesh with field scalars —
not a surface-skin polyline.

The slice carries only the coloured field (a scalar by its own name, a vector
X as magX with X kept), the case's velocity vector and its magnitude (for
glyphs), and the extra fields the caller asks for. A caller that names no
extra fields at all (extra=None: today's page) gets every scalar the frame
wrote, which the page colours vector glyphs and inspect picks from; extra=[]
carries none. '' colours by the case's default shown field.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
import pyvista as pv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from case_units import case_density, pressure_meta, scale_kinematic  # noqa: E402
from case_volume import load_volume  # noqa: E402
from result_names import (  # noqa: E402
    dataset_shown_fields,
    dataset_vector,
    default_shown_field,
    ensure_shown_field,
    has_shown_field,
    mag_base,
    resolve_shown_field,
    shown_fields,
)


def read_volume_at_time(case_dir: Path, time: str):
    return load_volume(case_dir, time)


FIELD_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


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
    field: str = "",
    vector: str = "",
    extra=None,
    mesh=None,
    source: str | None = None,
) -> dict:
    case_dir = Path(case_dir).resolve()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    field = str(field or "").strip()
    if field and not FIELD_NAME.match(field):
        raise ValueError(f"unsupported field name {field!r}")
    if isinstance(extra, str):
        extra = extra.replace(";", ",").split(",")
    every_scalar = extra is None
    extras: list[str] = []
    for raw in extra or ():
        name = str(raw or "").strip()
        if not name:
            continue
        if not FIELD_NAME.match(name):
            raise ValueError(f"unsupported field name {name!r}")
        if name not in extras:
            extras.append(name)

    if mesh is None:
        mesh, source = read_volume_at_time(case_dir, str(time))
    elif not source:
        source = "worker-cache"
    if mesh is None or int(getattr(mesh, "n_cells", 0) or 0) < 1:
        raise RuntimeError(f"volume read failed: {case_dir}")
    asked = field
    field = resolve_shown_field(mesh, asked, "" if asked else default_shown_field(case_dir, str(time)))
    if not field:
        raise RuntimeError(f"mesh missing {asked}" if asked else "this result has no field to colour by")
    ensure_shown_field(mesh, field)
    vec = dataset_vector(case_dir, str(time), mesh, vector)
    if every_scalar:
        # No extra named: every scalar the frame wrote (the volume's own when
        # there is no time folder), as the page reads them from the slice.
        frame = shown_fields(case_dir / str(time)) or dataset_shown_fields(mesh)
        extras = [n for n in frame if not (vec and n == "mag" + vec)]
    # Extra fields ride along when the volume has them (a missing one is left out).
    extras = [n for n in extras if has_shown_field(mesh, n)]
    for name in extras:
        ensure_shown_field(mesh, name)

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

    ensure_shown_field(sliced, field)
    for name in ("mag" + vec if vec else "", *extras):
        if name:
            try:
                ensure_shown_field(sliced, name)
            except RuntimeError:
                pass
    rho = case_density(case_dir)
    # Kinematic fields (the case's kinematic_fields) show in Pa; the slice owns
    # its arrays, so the shared volume stays as read.
    try:
        scale_kinematic(sliced, case_dir)
    except Exception:
        pass
    keep = {field, mag_base(field), vec, ("mag" + vec) if vec else "", *extras} - {""}
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
        "vector_field": vec or None,
        "extra": extras,
        "extra_requested": not every_scalar,
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
    ap.add_argument("--field", default="", help="shown field to colour by ('' = the case's default)")
    ap.add_argument("--vector", default="", help="vector to carry for glyphs ('' = the case's velocity)")
    ap.add_argument(
        "--extra", default=None, help="comma-separated shown fields to carry too (left out: every scalar)"
    )
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
            vector=args.vector,
            extra=args.extra,
        )
    except Exception as exc:
        print(f"export_cut_plane failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
