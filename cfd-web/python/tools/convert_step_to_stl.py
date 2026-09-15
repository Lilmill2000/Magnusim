"""Convert a STEP file to a binary STL via OCP (OCCT).

Used by the geometry import API: --step <in.step> --out <out.stl> [--meta <meta.json>].
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS

LINEAR_DEFLECTION = 0.5
ANGULAR_DEFLECTION = 0.5
# Match the viewport CAD preview (OCCT Prs3d), not the old coarse 0.5 mm grid.
CAD_DEVIATION_COEFFICIENT = 0.0001
CAD_DEVIATION_ANGLE_DEG = 5.0


def load_step(path: Path):
    reader = STEPControl_Reader()
    status = reader.ReadFile(str(path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEP read failed status={status} path={path}")
    reader.TransferRoots()
    return reader.OneShape()


def tessellate_cad_quality(shape):
    """Same Prs3d deflection the viewport uses, so snappy snaps to the CAD you see."""
    import math

    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepTools import BRepTools
    from OCP.IMeshTools import IMeshTools_Parameters
    from OCP.Precision import Precision
    from OCP.Prs3d import Prs3d, Prs3d_Drawer

    BRepTools.Clean_s(shape)
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


def collect_mesh(shape):
    verts = []
    tris = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        loc = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, loc)
        if triangulation is None:
            exp.Next()
            continue
        trsf = loc.Transformation()
        base = len(verts)
        for i in range(1, triangulation.NbNodes() + 1):
            pt = triangulation.Node(i)
            pt.Transform(trsf)
            verts.append((pt.X(), pt.Y(), pt.Z()))
        rev = face.Orientation() == TopAbs_REVERSED
        for i in range(1, triangulation.NbTriangles() + 1):
            t = triangulation.Triangle(i)
            n1, n2, n3 = t.Get()
            if rev:
                n1, n2, n3 = n1, n3, n2
            tris.append((base + n1 - 1, base + n2 - 1, base + n3 - 1))
        exp.Next()
    return verts, tris


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
    if mesh is None or mesh.n_points < 3 or mesh.n_cells < 100:
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


def write_binary_stl(path: Path, verts, tris, header: bytes = b"mtp1 from Vortex CFD Test.step via OCP"):
    hdr = header[:80].ljust(80, b"\0")
    buf = bytearray()
    buf.extend(hdr)
    buf.extend(struct.pack("<I", len(tris)))
    for i0, i1, i2 in tris:
        p0, p1, p2 = verts[i0], verts[i1], verts[i2]
        ux, uy, uz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
        vx, vy, vz = p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        nlen = (nx * nx + ny * ny + nz * nz) ** 0.5
        if nlen > 0:
            nx, ny, nz = nx / nlen, ny / nlen, nz / nlen
        else:
            nx = ny = nz = 0.0
        buf.extend(
            struct.pack(
                "<12fH",
                nx, ny, nz,
                p0[0], p0[1], p0[2],
                p1[0], p1[1], p1[2],
                p2[0], p2[1], p2[2],
                0,
            )
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Convert STEP to binary STL via OCP")
    ap.add_argument("--step", type=Path, required=True, help="Input STEP path")
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

    if not step.is_file():
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
    if len(tris) < 100:
        print("FAIL: too few triangles", file=sys.stderr)
        return 3
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
