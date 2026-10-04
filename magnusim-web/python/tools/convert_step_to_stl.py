"""Convert a STEP file to a binary STL via OCP (OCCT).

Used by the geometry import API: --step <in.step> --out <out.stl> [--meta <meta.json>].
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
from pathlib import Path

# Run by the server as a plain script: cfddesk lives one level up.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

LINEAR_DEFLECTION = 0.5
ANGULAR_DEFLECTION = 0.5
# Match the viewport CAD preview (OCCT Prs3d), not the old coarse 0.5 mm grid.
CAD_DEVIATION_COEFFICIENT = 0.0001
CAD_DEVIATION_ANGLE_DEG = 5.0


def load_step(path: Path):
    from cfddesk.cad.io import read_step_shape

    return read_step_shape(path)


def tessellate_cad_quality(shape, bounds: dict | None = None):
    """Same Prs3d deflection the viewport uses, so snappy snaps to the CAD you see.

    ``bounds`` (the preview's ``bounds``, which a linked geometry's link/state.json
    also holds): the box the deflection is sized from. Without, the exact box
    (``AddOptimal``, as before; it took 98 s on an 11,776-face part).
    """
    import math

    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepTools import BRepTools
    from OCP.IMeshTools import IMeshTools_Parameters
    from OCP.Precision import Precision
    from OCP.Prs3d import Prs3d, Prs3d_Drawer

    BRepTools.Clean_s(shape)
    if bounds is not None:
        from cfddesk.cad.preview import box_from_bounds

        box = box_from_bounds(bounds)
    else:
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(shape, box)
    drawer = Prs3d_Drawer()
    drawer.SetDeviationCoefficient(CAD_DEVIATION_COEFFICIENT)
    drawer.SetDeviationAngle(CAD_DEVIATION_ANGLE_DEG * math.pi / 180.0)
    lin = float(Prs3d.GetDeflection_s(box, drawer.DeviationCoefficient(), drawer.MaximalChordialDeviation()))
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    diag = math.sqrt((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2) or 1.0
    lin = min(lin, max(diag * 8e-5, 1e-4))
    params = IMeshTools_Parameters()
    params.Deflection = lin
    params.Angle = drawer.DeviationAngle()
    params.Relative = False
    params.InParallel = True
    params.MinSize = Precision.Confusion_s()
    params.InternalVerticesMode = True
    params.ControlSurfaceDeflection = True
    BRepMesh_IncrementalMesh(shape, params)
    return lin, float(drawer.DeviationAngle())


def has_triangulation(shape) -> bool:
    """Any face of ``shape`` carries a stored triangulation (a BREP written from a meshed
    shape, which the link contract accepts). ``AddOptimal`` then measures that
    triangulation, not the geometry, until the shape is cleaned."""
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location

    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        if BRep_Tool.Triangulation_s(TopoDS.Face_s(exp.Current()), TopLoc_Location()) is not None:
            return True
        exp.Next()
    return False


def collect_mesh(shape):
    """Every face visit's triangles: points (n, 3) and 0-based triangles (m, 3), numpy.

    Read in bulk (``cfddesk.cad.tri_arrays``); the same values, in the same order, as
    the per-node loop it replaced (``tests/unit/l4_loops.py``).
    """
    import numpy as np

    from cfddesk.cad.tri_arrays import face_triangulations

    faces = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        faces.append(TopoDS.Face_s(exp.Current()))
        exp.Next()
    pts, tris = [], []
    base = 0
    for ft in face_triangulations(faces):
        if ft is None:
            continue
        pts.append(ft.nodes)
        tris.append((ft.triangles[:, [0, 2, 1]] if ft.reversed else ft.triangles) + base)
        base += len(ft.nodes)
    if not pts:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int64)
    return np.concatenate(pts), np.concatenate(tris)


def mesh_bounds(verts) -> dict:
    import numpy as np

    v = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
    lo, hi = v.min(axis=0), v.max(axis=0)
    return {
        "xmin": float(lo[0]),
        "xmax": float(hi[0]),
        "ymin": float(lo[1]),
        "ymax": float(hi[1]),
        "zmin": float(lo[2]),
        "zmax": float(hi[2]),
        "nx": len(v),
    }


def tessellate(shape, lin: float, ang: float):
    BRepMesh_IncrementalMesh(shape, lin, False, ang, True)
    return collect_mesh(shape)


def write_stl_from_vtp(vtp_path: Path, out: Path, meta_path: Path) -> int:
    if not vtp_path.is_file():
        print("MISSING VTP", vtp_path, file=sys.stderr)
        return 2
    import pyvista as pv

    mesh = pv.read(str(vtp_path))
    try:
        mesh = mesh.triangulate()
    except Exception:
        pass
    # A closed surface needs 4 triangles; a box has 12 (a floor of 100 refused every boxy part).
    if mesh is None or mesh.n_points < 4 or mesh.n_cells < 4:
        print("FAIL: CAD VTP too small", vtp_path, file=sys.stderr)
        return 3
    faces = mesh.faces.reshape(-1, 4)
    verts = [tuple(map(float, p)) for p in mesh.points]
    tris = [(int(a), int(b), int(c)) for _, a, b, c in faces]
    print("VTP", vtp_path, "vertices", len(verts), "triangles", len(tris))
    xs = [v[0] for v in verts]
    ys = [v[1] for v in verts]
    zs = [v[2] for v in verts]
    bounds = {
        "xmin": min(xs),
        "xmax": max(xs),
        "ymin": min(ys),
        "ymax": max(ys),
        "zmin": min(zs),
        "zmax": max(zs),
        "nx": len(verts),
        "ntri": len(tris),
    }
    header = f"W27 Body1 from {vtp_path.name} CAD preview".encode("ascii", "replace")
    write_binary_stl(out, verts, tris, header=header)
    print("Wrote", out, "bytes", out.stat().st_size)
    meta = {
        "step_path": None,
        "from_vtp": str(vtp_path),
        "out_stl": str(out),
        "convert_tool": "CAD faces VTP -> STL (viewport tessellation)",
        "linear_deflection": None,
        "angular_deflection": None,
        "cad_quality": True,
        "bounds": bounds,
        "header": header.decode("ascii", "replace"),
        "bodies": ["Body1"],
        "increment": "W27",
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print("Wrote", meta_path)
    return 0


_STL_RECORD = [("n", "<f4", 3), ("p0", "<f4", 3), ("p1", "<f4", 3), ("p2", "<f4", 3), ("attr", "<u2")]


def write_binary_stl(path: Path, verts, tris, header: bytes = b"mtp1 from Vortex CFD Test.step via OCP"):
    """Binary STL, numpy: byte for byte what the per-triangle loop wrote.

    The facet normal is the cross product in double, divided by its length, then stored
    as float32, as before. The length is ``x ** 0.5`` (C ``pow``), as the loop took it:
    ``sqrt`` differs from it in the last bit for about 1 value in 2000, which can change
    a float32.
    """
    from itertools import repeat

    import numpy as np

    v = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
    t = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
    p0, p1, p2 = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    ux, uy, uz = p1[:, 0] - p0[:, 0], p1[:, 1] - p0[:, 1], p1[:, 2] - p0[:, 2]
    vx, vy, vz = p2[:, 0] - p0[:, 0], p2[:, 1] - p0[:, 1], p2[:, 2] - p0[:, 2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    sq = nx * nx + ny * ny + nz * nz
    nlen = np.fromiter(map(float.__pow__, sq.tolist(), repeat(0.5)), dtype=np.float64, count=len(sq))
    keep = nlen > 0
    safe = np.where(keep, nlen, 1.0)
    rec = np.zeros(len(t), dtype=_STL_RECORD)
    rec["n"] = np.stack([np.where(keep, nx / safe, 0.0), np.where(keep, ny / safe, 0.0), np.where(keep, nz / safe, 0.0)], axis=1)
    rec["p0"], rec["p1"], rec["p2"] = p0, p1, p2
    hdr = header[:80].ljust(80, b"\0")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        fh.write(hdr)
        fh.write(struct.pack("<I", len(t)))
        fh.write(rec.tobytes())


def build_mesh_input(
    step: Path,
    out: Path,
    *,
    bounds: dict | None = None,
    shape_sha256: str | None = None,
    display_budget: bool = False,
) -> dict:
    """The Hex-dominant mesh input of a linked or display-budgeted geometry (prepare_input).

    ``Body1.stl`` from the shape (``step``: the geometry's source.step, read through its
    binary sidecar) at CAD quality, never from the display mesh. ``bounds`` sizes the
    deflection (the preview's bounds, so no AddOptimal; see ``tessellate_cad_quality``).
    With ``display_budget`` they are the display triangles' box, taken after the preview
    cleaned and meshed the shape. Otherwise they are the box ``AddOptimal`` took before
    the preview cleaned it, which for a shape that carries a stored triangulation is that
    triangulation's box: then they are not used, and the box is taken from the cleaned
    shape, as the CLI's ``--cad-quality`` does (the same bytes).
    Written to a temp name and renamed, then ``Body1.json`` the same way, recording
    ``shape_sha256`` and ``cad_quality: true``: a crash in between leaves a json that
    does not match, and the next Generate builds again. Returns the meta, with the
    seconds of each step in ``timings``.
    """
    import hashlib
    import time

    timings: dict[str, float] = {}

    def timed(name: str, fn):
        t = time.perf_counter()
        r = fn()
        timings[name] = round(time.perf_counter() - t, 3)
        return r

    t0 = time.perf_counter()
    shape = timed("read_shape", lambda: load_step(step))
    if bounds is not None and not display_budget and has_triangulation(shape):
        bounds = None
    lin, ang = timed("tessellate", lambda: tessellate_cad_quality(shape, bounds))
    verts, tris = timed("collect", lambda: collect_mesh(shape))
    if len(tris) < 4:
        raise RuntimeError(f"the shape gave {len(tris)} triangles")
    header = f"W16 Body1 from {Path(step).name} via OCP".encode("ascii", "replace")
    tmp = out.with_name(f"{out.stem}.{os.getpid()}.tmp.stl")
    try:
        timed("write_stl", lambda: write_binary_stl(tmp, verts, tris, header=header))
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)
    meta = {
        "step_path": str(step),
        "out_stl": str(out),
        "convert_tool": "OCP/OCCT BRepMesh_IncrementalMesh at CAD quality (mesh job prepare_input)",
        "linear_deflection": lin,
        "angular_deflection": ang,
        "cad_quality": True,
        "bounds": {**mesh_bounds(verts), "ntri": len(tris)},
        "header": header.decode("ascii", "replace"),
        "bodies": ["Body1"],
        "increment": "W27",
        "shape_sha256": shape_sha256,
        "stl_sha256": digest,
        "prepared_by": "prepare_input",
        "seconds": round(time.perf_counter() - t0, 3),
        "timings": timings,
    }
    meta_path = out.with_suffix(".json")
    tmp_meta = meta_path.with_name(f"{meta_path.stem}.{os.getpid()}.tmp.json")
    tmp_meta.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    os.replace(tmp_meta, meta_path)
    return meta


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Convert STEP to binary STL via OCP")
    ap.add_argument("--step", type=Path, default=None, help="Input STEP path (not needed with --from-vtp)")
    ap.add_argument("--out", type=Path, required=True, help="Output STL path")
    ap.add_argument("--meta", type=Path, default=None, help="Optional meta JSON path (default: out with .json)")
    ap.add_argument("--lin", type=float, default=LINEAR_DEFLECTION)
    ap.add_argument("--ang", type=float, default=ANGULAR_DEFLECTION)
    ap.add_argument("--cad-quality", action="store_true", help="Use viewport Prs3d deflection (CAD-faithful)")
    ap.add_argument("--from-vtp", type=Path, default=None, help="Write STL from an existing CAD faces VTP")
    args = ap.parse_args(argv)

    step: Path = args.step
    out: Path = args.out
    meta_path: Path = args.meta if args.meta is not None else out.with_suffix(".json")

    if args.from_vtp is not None:
        return write_stl_from_vtp(args.from_vtp, out, meta_path)
    if step is None:
        ap.error("--step is required unless --from-vtp is given")

    from cfddesk.cad.io import geometry_file_exists

    if not geometry_file_exists(step):
        print("MISSING STEP", step, file=sys.stderr)
        return 2
    print("Loading", step)
    shape = load_step(step)
    if args.cad_quality:
        lin, ang = tessellate_cad_quality(shape)
        print("Tessellating CAD-quality lin=", lin, "ang=", ang)
        verts, tris = collect_mesh(shape)
        args.lin, args.ang = lin, ang
    else:
        print("Tessellating lin=", args.lin, "ang=", args.ang)
        verts, tris = tessellate(shape, args.lin, args.ang)
    print("vertices", len(verts), "triangles", len(tris))
    if len(tris) < 4:
        print("FAIL: too few triangles", file=sys.stderr)
        return 3
    bounds = {**mesh_bounds(verts), "ntri": len(tris)}
    print("bounds", bounds)
    header = f"W16 Body1 from {step.name} via OCP".encode("ascii", "replace")
    write_binary_stl(out, verts, tris, header=header)
    print("Wrote", out, "bytes", out.stat().st_size)
    meta = {
        "step_path": str(step),
        "out_stl": str(out),
        "convert_tool": "OCP/OCCT STEPControl_Reader + BRepMesh_IncrementalMesh (cfddesk .venv)",
        "linear_deflection": args.lin,
        "angular_deflection": args.ang,
        "cad_quality": bool(args.cad_quality),
        "bounds": bounds,
        "header": header.decode("ascii", "replace"),
        "bodies": ["Body1"],
        "increment": "W27",
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print("Wrote", meta_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
