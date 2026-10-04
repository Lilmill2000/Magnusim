"""Face triangulations as numpy arrays, read in one C++ call (LINK speed plan, steps 4-5).

OCP hands out a triangulation one node at a time (``Poly_Triangulation.Node(i)``):
on a 6.5 M-triangle part the Python loop over the nodes took 53 s. Here
``BinTools_ShapeSet.WriteTriangulation`` writes every face's triangulation into one
buffer in C++, and numpy reads the nodes, triangles and normals straight out of it.
The values are the ones ``Node(i)``, ``Triangle(i)`` and the stored normals hold, bit
for bit (doubles, int32 and float32, little-endian, as BinTools writes them).

The face's location is applied as ``gp_Pnt.Transform`` applies it: nothing for an
identity, an exact add for a translation. Any other location falls back to the
per-node loop for that face, so the result is always exactly the loop's.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass
class FaceTris:
    """One face visit's triangulation, in model coordinates.

    ``nodes`` (n, 3) float64 after the face's location; ``triangles`` (m, 3) int64,
    0-based into ``nodes``, in the triangulation's own order (not reversed for a
    reversed face); ``normals`` (n, 3) float32 as stored, or None; ``reversed``
    whether the face is reversed.
    """

    nodes: np.ndarray
    triangles: np.ndarray
    normals: np.ndarray | None
    reversed: bool


def _loop_nodes(triangulation: Any, trsf: Any) -> np.ndarray:
    n = triangulation.NbNodes()
    out = np.empty((n, 3), dtype=np.float64)
    for i in range(1, n + 1):
        p = triangulation.Node(i)
        p.Transform(trsf)
        out[i - 1] = (p.X(), p.Y(), p.Z())
    return out


def _parse(data: bytes, count: int) -> list[tuple[np.ndarray, np.ndarray, np.ndarray | None]]:
    """``BinTools_ShapeSet::WriteTriangulation`` (format 4): per triangulation, int32 nodes,
    int32 triangles, bool has-UV, bool has-normals, double deflection, the nodes (3
    doubles each), the UVs (2 doubles each), the triangles (3 int32, 1-based), the
    normals (3 float32 each)."""
    nl = data.index(b"\n")
    head = data[:nl].split()
    if len(head) != 2 or head[0] != b"Triangulations" or int(head[1]) != count:
        raise ValueError("unexpected triangulation header")
    pos = nl + 1
    out = []
    for _ in range(count):
        nn, nt = (int(v) for v in np.frombuffer(data, "<i4", 2, pos))
        pos += 8
        has_uv, has_n = data[pos], data[pos + 1]
        pos += 2 + 8
        nodes = np.frombuffer(data, "<f8", nn * 3, pos).reshape(nn, 3)
        pos += nn * 24
        if has_uv:
            pos += nn * 16
        tris = np.frombuffer(data, "<i4", nt * 3, pos).reshape(nt, 3)
        pos += nt * 12
        normals = None
        if has_n:
            normals = np.frombuffer(data, "<f4", nn * 3, pos).reshape(nn, 3)
            pos += nn * 12
        out.append((nodes, tris, normals))
    if pos != len(data):
        raise ValueError("triangulation buffer not fully read")
    return out


def face_triangulations(faces: list[Any], *, normals: bool = False) -> list[FaceTris | None]:
    """The triangulation of each face (None for a face without one), in ``faces`` order.

    ``normals=True`` first computes missing normals (``StdPrs_ToolTriangulatedShape.
    ComputeNormals``, as the display extraction does) and returns them. A face listed
    twice (a face two solids share) reuses one read.
    """
    from OCP.BinTools import BinTools_ShapeSet
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.gp import gp_TrsfForm
    from OCP.TopAbs import TopAbs_REVERSED
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS_Compound, TopoDS_Face
    from OCP.TopTools import TopTools_IndexedMapOfShape

    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    seen = TopTools_IndexedMapOfShape()
    plan: list[tuple[int, Any, Any, bool] | None] = []
    uniq: list[Any] = []
    for face in faces:
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            plan.append(None)
            continue
        key = face.Located(TopLoc_Location())
        before = seen.Extent()
        slot = seen.Add(key) - 1
        if seen.Extent() > before:
            if normals:
                try:
                    from OCP.StdPrs import StdPrs_ToolTriangulatedShape

                    StdPrs_ToolTriangulatedShape.ComputeNormals_s(face, tri)
                except Exception:
                    pass
            # A face that holds only the triangulation: the set then writes exactly
            # one triangulation per such face, in the order they were added.
            only = TopoDS_Face()
            builder.MakeFace(only, tri)
            builder.Add(compound, only)
            uniq.append(tri)
        plan.append((slot, loc.Transformation(), tri, face.Orientation() == TopAbs_REVERSED))
    parsed: list[tuple[np.ndarray, np.ndarray, np.ndarray | None]] = []
    if uniq:
        sset = BinTools_ShapeSet()
        sset.SetWithTriangles(True)
        sset.SetWithNormals(bool(normals))
        sset.Add(compound)
        buf = io.BytesIO()
        sset.WriteTriangulation(buf)
        parsed = _parse(buf.getvalue(), len(uniq))
        for (nodes, tris, _n), tri in zip(parsed, uniq, strict=True):
            if len(nodes) != tri.NbNodes() or len(tris) != tri.NbTriangles():
                raise ValueError("triangulation counts differ from the shape")
    out: list[FaceTris | None] = []
    for item in plan:
        if item is None:
            out.append(None)
            continue
        slot, trsf, tri, rev = item
        nodes, tris, nrm = parsed[slot]
        form = trsf.Form()
        if form == gp_TrsfForm.gp_Identity:
            pts = np.array(nodes, dtype=np.float64)
        elif form == gp_TrsfForm.gp_Translation:
            t = trsf.TranslationPart()
            pts = nodes + np.array([t.X(), t.Y(), t.Z()], dtype=np.float64)
        else:
            pts = _loop_nodes(tri, trsf)
        has_n = bool(normals) and nrm is not None and bool(tri.HasNormals())
        out.append(FaceTris(pts, tris.astype(np.int64) - 1, np.array(nrm) if has_n else None, rev))
    return out
