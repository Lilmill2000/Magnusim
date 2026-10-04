"""The per-node Python loops L4 replaced with numpy, kept word for word as references.

``gate:l4-equal`` (``test_l4_equal.py``) checks that the numpy versions give exactly
what these gave: ``preview.extract_display_faces`` and ``preview.face_properties``
(before L4, at 2817aab..91ecc84) and ``convert_step_to_stl.collect_mesh`` /
``write_binary_stl``.
"""

from __future__ import annotations

import math
import struct
from pathlib import Path


def face_properties(shape):
    """``preview.face_properties`` at 91ecc84, word for word (the face table before L4)."""
    from magnusim_sdk.link import face_visits
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp, BRepGProp_Face
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.GProp import GProp_GProps

    from cfddesk.cad import shared_faces

    out = []
    keys: list[tuple[int, int | None, float, tuple[float, float, float], object]] = []
    for idx, body, face in face_visits(shape):
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        area = float(props.Mass())
        c = props.CentreOfMass()
        centroid = [float(c.X()), float(c.Y()), float(c.Z())]
        keys.append((idx, body, area, (centroid[0], centroid[1], centroid[2]), face))
        normal = None
        try:
            adapt = BRepAdaptor_Surface(face)
            umin, umax, vmin, vmax = BRepTools.UVBounds_s(face)
            u = 0.5 * (umin + umax)
            v = 0.5 * (vmin + vmax)
            pnt = gp_Pnt()
            vec = gp_Vec()
            BRepGProp_Face(face).Normal(u, v, pnt, vec)
            if vec.Magnitude() > 0:
                vec.Normalize()
                normal = [float(vec.X()), float(vec.Y()), float(vec.Z())]
            stype = str(adapt.GetType()).split("_")[-1]
        except Exception:
            stype = "unknown"
        entry = {
            "id": idx,
            "area": area,
            "centroid": centroid,
            "normal": normal,
            "surface_type": stype,
        }
        if body is not None:
            entry["body"] = body
        out.append(entry)
    shared = shared_faces.pairs(keys)
    for e in out:
        if e["id"] in shared:
            e["shared_with"] = shared[e["id"]]
    return out


def extract_display_faces(shape):
    from magnusim_sdk.link import face_visits
    from OCP.BRep import BRep_Tool
    from OCP.StdPrs import StdPrs_ToolTriangulatedShape
    from OCP.TopAbs import TopAbs_REVERSED
    from OCP.TopLoc import TopLoc_Location

    verts: list[tuple[float, float, float]] = []
    normals = []
    tris = []
    solid_ids = []
    face_ids = []
    for fid, body, face in face_visits(shape):
        sid = body or 1
        loc = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, loc)
        if triangulation is None:
            continue
        try:
            StdPrs_ToolTriangulatedShape.ComputeNormals_s(face, triangulation)
        except Exception:
            pass
        trsf = loc.Transformation()
        rev = face.Orientation() == TopAbs_REVERSED
        base = len(verts)
        has_n = False
        try:
            has_n = bool(triangulation.HasNormals())
        except Exception:
            has_n = False
        for i in range(1, triangulation.NbNodes() + 1):
            pt = triangulation.Node(i)
            pt.Transform(trsf)
            verts.append((float(pt.X()), float(pt.Y()), float(pt.Z())))
            if has_n:
                nrm = triangulation.Normal(i)
                if rev:
                    nrm.Reverse()
                nx, ny, nz = float(nrm.X()), float(nrm.Y()), float(nrm.Z())
                nlen = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                normals.append((nx / nlen, ny / nlen, nz / nlen))
            else:
                normals.append((0.0, 0.0, 1.0))
        for i in range(1, triangulation.NbTriangles() + 1):
            t = triangulation.Triangle(i)
            n1, n2, n3 = t.Get()
            if rev:
                n1, n2, n3 = n1, n3, n2
            tris.append((base + n1 - 1, base + n2 - 1, base + n3 - 1))
            solid_ids.append(sid)
            face_ids.append(fid)
    return verts, normals, tris, solid_ids, face_ids


def collect_mesh(shape):
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

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
