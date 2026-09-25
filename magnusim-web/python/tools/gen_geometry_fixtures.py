#!/usr/bin/env python3
"""Write one geometry file per import extension the app lists, from one STEP.

The Add geometry picker accepts .step .stp .iges .igs .brep .brp .stl .obj .ply.
This writes each of them from a source STEP so every advertised format can be
tested end to end (python/tests/unit/test_geometry_formats.py and the e2e suite).

    python tools/gen_geometry_fixtures.py SOURCE.step OUT_DIR [--deflection MM] [--stem NAME]

A smaller --deflection gives a denser mesh (STL/OBJ/PLY); use it to build a
large STL for import timing.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _tessellate(shape, deflection: float):
    """Triangle soup (points Nx3, triangles Mx3) from a meshed OCC shape."""
    import numpy as np
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    BRepMesh_IncrementalMesh(shape, deflection, False, 0.3, True).Perform()
    points: list[tuple[float, float, float]] = []
    tris: list[tuple[int, int, int]] = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is not None:
            trsf = loc.Transformation()
            base = len(points)
            for i in range(1, tri.NbNodes() + 1):
                p = tri.Node(i).Transformed(trsf)
                points.append((p.X(), p.Y(), p.Z()))
            flip = face.Orientation() == TopAbs_REVERSED
            for i in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(i).Get()
                if flip:
                    b, c = c, b
                tris.append((base + a - 1, base + b - 1, base + c - 1))
        exp.Next()
    return np.asarray(points, dtype=float), np.asarray(tris, dtype=np.int32)


def generate(source: Path, out: Path, *, deflection: float = 0.5, stem: str | None = None) -> dict[str, Path]:
    import meshio
    from OCP.BRepTools import BRepTools
    from OCP.IGESControl import IGESControl_Controller, IGESControl_Writer

    from cfddesk.cad.io import _load_step

    out.mkdir(parents=True, exist_ok=True)
    name = stem or source.stem
    shape = _load_step(source)
    written: dict[str, Path] = {}

    for ext in (".step", ".stp"):
        dest = out / f"{name}{ext}"
        shutil.copyfile(source, dest)
        written[ext] = dest

    try:
        IGESControl_Controller.Init_s()
    except Exception:
        pass
    for ext in (".iges", ".igs"):
        writer = IGESControl_Writer("MM", 1)
        writer.AddShape(shape)
        writer.ComputeModel()
        dest = out / f"{name}{ext}"
        if not writer.Write(str(dest)):
            raise RuntimeError(f"IGES write failed: {dest}")
        written[ext] = dest

    for ext in (".brep", ".brp"):
        dest = out / f"{name}{ext}"
        if not BRepTools.Write_s(shape, str(dest)):
            raise RuntimeError(f"BREP write failed: {dest}")
        written[ext] = dest

    pts, tris = _tessellate(shape, deflection)
    if not len(tris):
        raise RuntimeError("tessellation produced no triangles")
    mesh = meshio.Mesh(pts, [("triangle", tris)])
    for ext, fmt in ((".stl", "stl"), (".obj", "obj"), (".ply", "ply")):
        dest = out / f"{name}{ext}"
        kwargs = {"binary": True} if fmt in ("stl", "ply") else {}
        meshio.write(str(dest), mesh, file_format=fmt, **kwargs)
        written[ext] = dest
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--deflection", type=float, default=0.5, help="Tessellation chord error in model units (mm)")
    ap.add_argument("--stem", default=None)
    args = ap.parse_args(argv)
    for ext, path in generate(args.source, args.out_dir, deflection=args.deflection, stem=args.stem).items():
        print(f"{ext:6} {path.stat().st_size:>10,d}  {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
