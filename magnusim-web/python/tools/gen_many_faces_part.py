#!/usr/bin/env python3
"""Write a part with thousands of faces: a long bar with square teeth on both sides.

The viewport has to stay quick on big parts (hiding a face once froze the page for
most of a minute on a part with 6,500 faces and 23,000 edges). The e2e test that
checks it builds its part with this at test time.

    python tools/gen_many_faces_part.py OUT.brep [--teeth N]

One solid: the outline of a bar with N teeth on each long side (8 N + 4 sides) pushed
out sideways, so 8 N + 6 flat faces and 24 N + 12 edges (N = 750: 6,006 faces, 18,012
edges), each face with one outline and no holes, which keeps the import quick.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def build(teeth: int):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
    from OCP.gp import gp_Pnt, gp_Vec

    pitch = 4.0  # mm per tooth
    base = 10.0
    tooth = 10.0
    length = pitch * teeth
    # Teeth on both long sides, so the two end faces mesh into well-shaped triangles.
    outline = []
    for i in range(teeth):
        x0 = i * pitch
        outline += [(x0 + 0.25 * pitch, 0.0), (x0 + 0.25 * pitch, -tooth), (x0 + 0.75 * pitch, -tooth), (x0 + 0.75 * pitch, 0.0)]
    outline += [(length, 0.0), (length, base)]
    for i in reversed(range(teeth)):
        x0 = i * pitch
        outline += [(x0 + 0.75 * pitch, base), (x0 + 0.75 * pitch, base + tooth), (x0 + 0.25 * pitch, base + tooth), (x0 + 0.25 * pitch, base)]
    outline += [(0.0, base), (0.0, 0.0)]
    poly = BRepBuilderAPI_MakePolygon()
    for x, z in outline:
        poly.Add(gp_Pnt(x, 0.0, z))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()
    return BRepPrimAPI_MakePrism(face, gp_Vec(0.0, 20.0, 0.0)).Shape()


def write(shape, out: Path) -> None:
    """A .brep (OCC's own format: quick to read back), or a .step."""
    if out.suffix.lower() in (".brep", ".brp"):
        from OCP.BRepTools import BRepTools

        if not BRepTools.Write_s(shape, str(out)):
            raise RuntimeError(f"could not write {out}")
        return
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    if writer.Write(str(out)) != IFSelect_RetDone:
        raise RuntimeError(f"could not write {out}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("out", type=Path)
    ap.add_argument("--teeth", type=int, default=750)
    a = ap.parse_args(argv)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    write(build(a.teeth), a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
