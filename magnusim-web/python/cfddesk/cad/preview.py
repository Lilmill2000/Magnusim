"""OCCT visualization-mesher CAD preview (library). CLI wraps this module.

This is the AIS / Prs3d shaded-display path, not a UV-grid guess and not Body1.stl.

Docs:
  https://dev.opencascade.org/doc/occt-7.9.0/overview/html/occt_user_guides__mesh.html
  Prs3d_Drawer: DeviationCoefficient default 0.001, DeviationAngle default 20 deg
  Prs3d.GetDeflection: SizeOfObject * DeviationCoefficient
  BRepMesh_IncrementalMesh + IMeshTools_Parameters
  StdPrs_ToolTriangulatedShape.ComputeNormals
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.GProp import GProp_GProps
from OCP.IMeshTools import IMeshTools_Parameters
from OCP.Precision import Precision
from OCP.Prs3d import Prs3d, Prs3d_Drawer
from OCP.StdPrs import StdPrs_ToolTriangulatedShape
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape

# Tighter than AIS interactive defaults so large circles stay round when zoomed.
# Still the official Prs3d knobs: coefficient * bbox size, angle in radians.
VIS_DEVIATION_COEFFICIENT = 0.0001  # AIS default is 0.001
VIS_DEVIATION_ANGLE_DEG = 5.0  # AIS default is 20 deg
PREVIEW_VERSION = 7


def load_step(path: Path):
    from cfddesk.cad.io import read_step_shape

    return read_step_shape(path)


def count_sub(shape, kind) -> int:
    n = 0
    exp = TopExp_Explorer(shape, kind)
    while exp.More():
        n += 1
        exp.Next()
    return n


def shape_bounds(shape):
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return {
        "xmin": float(xmin),
        "xmax": float(xmax),
        "ymin": float(ymin),
        "ymax": float(ymax),
        "zmin": float(zmin),
        "zmax": float(zmax),
    }, box


def shape_center_of_mass(shape):
    """Volume COM in the STEP own axes. Does not rebase world XYZ."""
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    kind = "volume"
    if float(props.Mass()) <= 0:
        BRepGProp.SurfaceProperties_s(shape, props)
        kind = "surface"
    if float(props.Mass()) <= 0:
        return None, kind
    c = props.CentreOfMass()
    return [float(c.X()), float(c.Y()), float(c.Z())], kind


def face_properties(shape):
    """Per-face area / centroid / outward normal, 1-based ids in explorer order.

    Same TopExp_Explorer(FACE) order as the viewport faceId scalars and the
    cfddesk mesher, so ``face N@Body1`` in the UI is ``faces[N-1]`` here.
    Lengths are in the STEP's own units (mm for the files we import).
    """
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.gp import gp_Pnt, gp_Vec

    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    idx = 0
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        idx += 1
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        area = float(props.Mass())
        c = props.CentreOfMass()
        centroid = [float(c.X()), float(c.Y()), float(c.Z())]
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
        out.append(
            {
                "id": idx,
                "area": area,
                "centroid": centroid,
                "normal": normal,
                "surface_type": stype,
            }
        )
        exp.Next()
    return out


def write_faces_into_meta(step: Path, meta_path: Path) -> dict:
    from cfddesk.cad.io import read_triangle_sidecar

    triangles = read_triangle_sidecar(step)
    meta = {}
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            meta = {}
    if triangles is not None and triangles[2] is not None:
        meta["faces"] = _grouped_face_entries(*triangles)
    else:
        meta["faces"] = face_properties(load_step(step))
    meta["faces_length_unit"] = "mm"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def mesh_for_display(shape, box):
    """AIS-equivalent tessellation with visualization-quality Prs3d settings."""
    BRepTools.Clean_s(shape)
    drawer = Prs3d_Drawer()
    drawer.SetDeviationCoefficient(VIS_DEVIATION_COEFFICIENT)
    drawer.SetDeviationAngle(VIS_DEVIATION_ANGLE_DEG * math.pi / 180.0)
    lin = float(Prs3d.GetDeflection_s(box, drawer.DeviationCoefficient(), drawer.MaximalChordialDeviation()))
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    diag = math.sqrt((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2) or 1.0
    # Keep circles round on typical part sizes (OCCT default 0.001 is ~20-gon on this model).
    lin = min(lin, max(diag * 8e-5, 1e-4))
    params = IMeshTools_Parameters()
    params.Deflection = lin
    params.Angle = drawer.DeviationAngle()
    params.Relative = False
    params.InParallel = True
    params.MinSize = Precision.Confusion_s()
    params.InternalVerticesMode = True
    params.ControlSurfaceDeflection = True
    mesher = BRepMesh_IncrementalMesh(shape, params)
    return {
        "linear_deflection": lin,
        "angular_deflection": float(drawer.DeviationAngle()),
        "deviation_coefficient": VIS_DEVIATION_COEFFICIENT,
        "deviation_angle_deg": VIS_DEVIATION_ANGLE_DEG,
        "status": int(mesher.GetStatusFlags()),
    }


def map_face_to_solid_id(shape):
    solids = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_SOLID, solids)
    ancestors = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_FACE, TopAbs_SOLID, ancestors)

    def lookup(face):
        if solids.Extent() < 1:
            return 1
        try:
            if not ancestors.Contains(face):
                return 1
            lst = ancestors.FindFromKey(face)
            if lst.IsEmpty():
                return 1
            idx = solids.FindIndex(lst.First())
            return int(idx) if idx else 1
        except Exception:
            return 1

    return lookup, int(solids.Extent())


def extract_display_faces(shape):
    verts: list[tuple[float, float, float]] = []
    normals = []
    tris = []
    solid_ids = []
    face_ids = []
    solid_of, _n_solids = map_face_to_solid_id(shape)
    faces_map = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_FACE, faces_map)
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        sid = solid_of(face)
        try:
            fid = int(faces_map.FindIndex(face)) or 1
        except Exception:
            fid = 1
        loc = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, loc)
        if triangulation is None:
            exp.Next()
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
        exp.Next()
    return verts, normals, tris, solid_ids, face_ids


def extract_display_edges(shape):
    """Feature edges from the same visualization mesh (PolygonOnTriangulation)."""
    edge_to_faces = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, edge_to_faces)
    polylines = []
    seen = TopTools_IndexedMapOfShape()
    for i in range(1, edge_to_faces.Extent() + 1):
        edge = TopoDS.Edge_s(edge_to_faces.FindKey(i))
        if seen.Contains(edge):
            continue
        seen.Add(edge)
        try:
            if BRep_Tool.Degenerated_s(edge):
                continue
        except Exception:
            pass
        loc3 = TopLoc_Location()
        poly3 = None
        try:
            poly3 = BRep_Tool.Polygon3D_s(edge, loc3)
        except Exception:
            poly3 = None
        if poly3 is not None and poly3.NbNodes() >= 2:
            trsf = loc3.Transformation()
            pts = []
            for j in range(1, poly3.NbNodes() + 1):
                p = poly3.Nodes().Value(j)
                p.Transform(trsf)
                pts.append((float(p.X()), float(p.Y()), float(p.Z())))
            if len(pts) >= 2:
                polylines.append(pts)
            continue
        faces = edge_to_faces.FindFromIndex(i)
        if faces.IsEmpty():
            continue
        face = TopoDS.Face_s(faces.First())
        loc = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, loc)
        poly = None
        if triangulation is not None:
            try:
                poly = BRep_Tool.PolygonOnTriangulation_s(edge, triangulation, loc)
            except Exception:
                poly = None
        if poly is None or poly.NbNodes() < 2:
            continue
        trsf = loc.Transformation()
        pts = []
        nodes = poly.Nodes()
        for k in range(nodes.Lower(), nodes.Upper() + 1):
            p = triangulation.Node(nodes.Value(k))
            p.Transform(trsf)
            pts.append((float(p.X()), float(p.Y()), float(p.Z())))
        if len(pts) >= 2:
            polylines.append(pts)
    return polylines


def _write_binary_vtp(
    path: Path,
    points,
    *,
    lines=None,
    polys=None,
    normals=None,
    cell_scalars: dict | None = None,
) -> None:
    """VTK XML PolyData with appended raw binary arrays (UInt32 byte-count headers).

    vtk.js and pyvista/VTK read it; it is ~3x smaller than ASCII and written with
    numpy instead of a Python loop per point. ``lines`` / ``polys`` are
    ``(connectivity, offsets)`` arrays.
    """
    import struct

    import numpy as np

    pts = np.ascontiguousarray(np.asarray(points, dtype=np.float32).reshape(-1, 3))
    empty = (np.zeros(0, dtype=np.int32), np.zeros(0, dtype=np.int32))
    line_conn, line_off = (np.asarray(a, dtype=np.int32) for a in (lines or empty))
    poly_conn, poly_off = (np.asarray(a, dtype=np.int32) for a in (polys or empty))
    blocks: list[bytes] = []
    offset = 0

    def array_xml(data, vtk_type: str, name: str | None = None, ncomp: int = 1) -> str:
        nonlocal offset
        raw = np.ascontiguousarray(data).tobytes()
        attrs = f'type="{vtk_type}"' + (f' Name="{name}"' if name else "")
        if ncomp != 1:
            attrs += f' NumberOfComponents="{ncomp}"'
        xml = f'<DataArray {attrs} format="appended" offset="{offset}"/>'
        blocks.append(struct.pack("<I", len(raw)) + raw)
        offset += 4 + len(raw)
        return xml

    head = [
        '<?xml version="1.0"?>',
        '<VTKFile type="PolyData" version="1.0" byte_order="LittleEndian" header_type="UInt32">',
        "  <PolyData>",
        f'    <Piece NumberOfPoints="{len(pts)}" NumberOfVerts="0" NumberOfLines="{len(line_off)}" '
        f'NumberOfStrips="0" NumberOfPolys="{len(poly_off)}">',
    ]
    if normals is not None and len(normals) == len(pts):
        nrm = np.asarray(normals, dtype=np.float32).reshape(-1, 3)
        head += ['      <PointData Normals="Normals">', "        " + array_xml(nrm, "Float32", "Normals", 3), "      </PointData>"]
    if cell_scalars:
        head.append("      <CellData>")
        for name, values in cell_scalars.items():
            head.append("        " + array_xml(np.asarray(values, dtype=np.int32), "Int32", name))
        head.append("      </CellData>")
    head += ["      <Points>", "        " + array_xml(pts, "Float32", None, 3), "      </Points>"]
    head += [
        "      <Lines>",
        "        " + array_xml(line_conn, "Int32", "connectivity"),
        "        " + array_xml(line_off, "Int32", "offsets"),
        "      </Lines>",
        "      <Polys>",
        "        " + array_xml(poly_conn, "Int32", "connectivity"),
        "        " + array_xml(poly_off, "Int32", "offsets"),
        "      </Polys>",
        "    </Piece>",
        "  </PolyData>",
        '  <AppendedData encoding="raw">',
        "   _",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write("\n".join(head).encode("ascii"))
        for block in blocks:
            f.write(block)
        f.write(b"\n  </AppendedData>\n</VTKFile>\n")


def _flat(rows) -> tuple:
    """Ragged index lists -> (connectivity, offsets)."""
    import numpy as np

    lengths = np.fromiter((len(r) for r in rows), dtype=np.int64, count=len(rows))
    conn = np.fromiter((i for r in rows for i in r), dtype=np.int32, count=int(lengths.sum()))
    return conn, np.cumsum(lengths).astype(np.int32)


def save_edges_vtp(path: Path, polylines):
    points: list[tuple[float, float, float]] = []
    lines = []
    for pl in polylines:
        start = len(points)
        points.extend(pl)
        lines.append(range(start, start + len(pl)))
    _write_binary_vtp(path, points, lines=_flat(lines))
    return len(points)


def save_faces_vtp(path: Path, verts, normals, tris, solid_ids=None, face_ids=None):
    cell_scalars = {}
    if solid_ids and len(solid_ids) == len(tris):
        cell_scalars["solidId"] = solid_ids
    if face_ids and len(face_ids) == len(tris):
        cell_scalars["faceId"] = face_ids
    _write_binary_vtp(path, verts, polys=_flat(tris), normals=normals, cell_scalars=cell_scalars or None)
    return len(tris)


FEATURE_ANGLE_DEG = 30.0


def _grouped_face_entries(points, tris, groups) -> list[dict]:
    """``faces[]`` for a grouped mesh import: one entry per surface (face id = group + 1)."""
    from cfddesk.cad.face_groups import group_properties

    return [
        {
            "id": g + 1,
            "area": round(p["area"], 9),
            "centroid": [round(v, 6) for v in p["centroid"]],
            "normal": [round(v, 6) for v in p["normal"]],
            "surface_type": "Plane" if p["planar"] else "Mesh",
        }
        for g, p in enumerate(group_properties(points, tris, groups))
    ]


def export_preview_from_triangles(
    step: Path, edges: Path, faces: Path, meta: Path | None, points, tris, groups=None
) -> dict:
    """Preview for a mesh import from its triangles (see ``io.read_triangle_sidecar``).

    Same outputs as ``export_preview`` without re-meshing the triangles: flat
    triangles, per-face area/centroid/normal, and the volume centroid. With
    ``groups`` (surface id per triangle) a face is a surface of triangles and the
    edges are the surface boundaries; without, face i is triangle i and the edges
    are folds over 30° and open borders.
    """
    import numpy as np

    pts = np.asarray(points, dtype=np.float64)
    tri = np.asarray(tris, dtype=np.int64)
    m = len(tri)
    corners = pts[tri]  # (m, 3, 3)
    cross = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    twice_area = np.linalg.norm(cross, axis=1)
    normal = cross / np.where(twice_area > 0, twice_area, 1.0)[:, None]
    centroid = corners.mean(axis=1)

    _write_binary_vtp(
        faces,
        corners.reshape(-1, 3),
        polys=(np.arange(3 * m, dtype=np.int32), np.arange(3, 3 * m + 1, 3, dtype=np.int32)),
        normals=np.repeat(normal, 3, axis=0),
        cell_scalars={
            "solidId": np.ones(m, dtype=np.int32),
            "faceId": (np.asarray(groups, dtype=np.int32) + 1) if groups is not None else np.arange(1, m + 1, dtype=np.int32),
        },
    )

    # Feature edges: sort each triangle edge, pair the two faces that share it.
    ends = np.sort(tri[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    owner = np.repeat(np.arange(m), 3)
    order = np.lexsort((ends[:, 1], ends[:, 0]))
    ends, owner = ends[order], owner[order]
    same = np.all(ends[1:] == ends[:-1], axis=1)
    starts = np.concatenate(([True], ~same))
    n_unique = int(starts.sum())
    counts = np.diff(np.concatenate((np.nonzero(starts)[0], [len(ends)])))
    first = np.nonzero(starts)[0]
    border = first[counts == 1]
    pair = first[counts == 2]
    cos_fold = np.einsum("ij,ij->i", normal[owner[pair]], normal[owner[pair + 1]])
    if groups is not None:
        g = np.asarray(groups)
        fold = pair[g[owner[pair]] != g[owner[pair + 1]]]
    else:
        fold = pair[cos_fold < np.cos(np.radians(FEATURE_ANGLE_DEG))]
    feature = ends[np.concatenate((border, fold))]
    k = len(feature)
    _write_binary_vtp(
        edges,
        pts[feature].reshape(-1, 3),
        lines=(np.arange(2 * k, dtype=np.int32), np.arange(2, 2 * k + 1, 2, dtype=np.int32)),
    )

    signed = np.einsum("ij,ij->i", corners[:, 0], np.cross(corners[:, 1], corners[:, 2])) / 6.0
    total = float(signed.sum())
    com = (signed[:, None] * corners.sum(axis=1) / 4.0).sum(axis=0) / total if abs(total) > 0 else centroid.mean(axis=0)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    out = {
        "preview_version": PREVIEW_VERSION,
        "step_path": str(step),
        "edges_vtp": str(edges),
        "faces_vtp": str(faces),
        "representation": "step",
        "display": "mesh-triangles",
        "tessellated": False,
        "n_solids": 1,
        "bodies": ["Body1"],
        "n_faces": int(np.max(groups)) + 1 if groups is not None else m,
        "n_edges": n_unique,
        "n_edge_polylines": k,
        "n_edge_points": 2 * k,
        "n_display_tris": m,
        "bounds": {
            "xmin": float(lo[0]), "xmax": float(hi[0]),
            "ymin": float(lo[1]), "ymax": float(hi[1]),
            "zmin": float(lo[2]), "zmax": float(hi[2]),
        },
        "linear_deflection": 0.0,
        "angular_deflection": 0.0,
        "deviation_coefficient": VIS_DEVIATION_COEFFICIENT,
        "deviation_angle_deg": VIS_DEVIATION_ANGLE_DEG,
        "status": 0,
        "center_of_mass": [float(v) for v in com],
        "center_of_mass_kind": "volume",
        "faces": _grouped_face_entries(pts, tri, groups) if groups is not None else [
            {
                "id": i + 1,
                "area": round(float(twice_area[i] / 2.0), 9),
                "centroid": [round(float(v), 6) for v in centroid[i]],
                "normal": [round(float(v), 6) for v in normal[i]],
                "surface_type": "Plane",
            }
            for i in range(m)
        ],
        "faces_length_unit": "mm",
    }
    meta_path = meta if meta is not None else edges.with_name("cad_preview.json")
    meta_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    return out


def export_preview(step: Path, edges: Path, faces: Path, meta: Path | None = None, shape=None) -> dict:
    """Write edges/faces VTP + cad_preview.json. ``shape`` may be a cached OCCT shape."""
    from cfddesk.cad.io import read_triangle_sidecar

    triangles = read_triangle_sidecar(step)
    if triangles is not None:
        return export_preview_from_triangles(step, edges, faces, meta, *triangles)
    if shape is None:
        shape = load_step(step)
    bounds, box = shape_bounds(shape)
    mesh_info = mesh_for_display(shape, box)
    n_solids = count_sub(shape, TopAbs_SOLID)
    n_faces = count_sub(shape, TopAbs_FACE)
    n_edges = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_EDGE, n_edges)
    verts, normals, tris, solid_ids, face_ids = extract_display_faces(shape)
    n_tris = save_faces_vtp(faces, verts, normals, tris, solid_ids, face_ids)
    n_body = max(n_solids, 1)
    bodies = [f"Body{i}" for i in range(1, n_body + 1)]
    polylines = extract_display_edges(shape)
    n_edge_pts = save_edges_vtp(edges, polylines)
    out = {
        "preview_version": PREVIEW_VERSION,
        "step_path": str(step),
        "edges_vtp": str(edges),
        "faces_vtp": str(faces),
        "representation": "step",
        "display": "occt-prs3d",
        "tessellated": False,
        "n_solids": n_solids,
        "bodies": bodies,
        "n_faces": n_faces,
        "n_edges": int(n_edges.Extent()),
        "n_edge_polylines": len(polylines),
        "n_edge_points": n_edge_pts,
        "n_display_tris": n_tris,
        "bounds": bounds,
        **mesh_info,
    }
    com, com_kind = shape_center_of_mass(shape)
    if com:
        out["center_of_mass"] = com
        out["center_of_mass_kind"] = com_kind
    try:
        out["faces"] = face_properties(shape)
        out["faces_length_unit"] = "mm"
    except Exception:
        pass
    meta_path = meta if meta is not None else edges.with_name("cad_preview.json")
    compact = len(out.get("faces") or []) > 2000
    meta_path.write_text(
        json.dumps(out, separators=(",", ":")) if compact else json.dumps(out, indent=2), encoding="utf-8"
    )
    return out


def write_com_into_meta(step: Path, meta_path: Path) -> dict:
    shape = load_step(step)
    com, com_kind = shape_center_of_mass(shape)
    meta = {}
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            meta = {}
    if com:
        meta["center_of_mass"] = com
        meta["center_of_mass_kind"] = com_kind
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export STEP with OCCT visualization mesher (Prs3d)")
    ap.add_argument("--step", type=Path, required=True)
    ap.add_argument("--edges", type=Path, required=False)
    ap.add_argument("--faces", type=Path, required=False)
    ap.add_argument("--meta", type=Path, default=None)
    ap.add_argument("--com-only", action="store_true", help="Write centre of mass into existing cad_preview.json")
    ap.add_argument("--faces-only", action="store_true", help="Write per-face area/centroid/normal into existing cad_preview.json")
    args = ap.parse_args(argv)

    from cfddesk.cad.io import geometry_file_exists

    if not geometry_file_exists(args.step):
        print("MISSING STEP", args.step, file=sys.stderr)
        return 2

    if args.faces_only:
        meta_path = args.meta if args.meta is not None else (
            args.edges.with_name("cad_preview.json") if args.edges is not None else args.step.with_name("cad_preview.json")
        )
        meta = write_faces_into_meta(args.step, meta_path)
        print("CAD_FACES_OK", json.dumps({"n_faces": len(meta.get("faces") or [])}))
        return 0 if meta.get("faces") else 4

    if args.com_only:
        meta_path = args.meta if args.meta is not None else (
            args.edges.with_name("cad_preview.json") if args.edges is not None else args.step.with_name("cad_preview.json")
        )
        meta = write_com_into_meta(args.step, meta_path)
        print("CAD_COM_OK", json.dumps({"center_of_mass": meta.get("center_of_mass"), "kind": meta.get("center_of_mass_kind")}))
        return 0 if meta.get("center_of_mass") else 4

    if args.edges is None or args.faces is None:
        print("MISSING --edges/--faces (or use --com-only)", file=sys.stderr)
        return 2

    shape = load_step(args.step)
    bounds, box = shape_bounds(shape)
    mesh_info = mesh_for_display(shape, box)

    n_solids = count_sub(shape, TopAbs_SOLID)
    n_faces = count_sub(shape, TopAbs_FACE)
    n_edges = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_EDGE, n_edges)

    verts, normals, tris, solid_ids, face_ids = extract_display_faces(shape)
    n_tris = save_faces_vtp(args.faces, verts, normals, tris, solid_ids, face_ids)
    n_body = max(n_solids, 1)
    bodies = [f"Body{i}" for i in range(1, n_body + 1)]
    polylines = extract_display_edges(shape)
    n_edge_pts = save_edges_vtp(args.edges, polylines)

    meta = {
        "preview_version": PREVIEW_VERSION,
        "step_path": str(args.step),
        "edges_vtp": str(args.edges),
        "faces_vtp": str(args.faces),
        "representation": "step",
        "display": "occt-prs3d",
        "tessellated": False,
        "n_solids": n_solids,
        "bodies": bodies,
        "n_faces": n_faces,
        "n_edges": int(n_edges.Extent()),
        "n_edge_polylines": len(polylines),
        "n_edge_points": n_edge_pts,
        "n_display_tris": n_tris,
        "bounds": bounds,
        **mesh_info,
    }
    com, com_kind = shape_center_of_mass(shape)
    if com:
        meta["center_of_mass"] = com
        meta["center_of_mass_kind"] = com_kind
    try:
        meta["faces"] = face_properties(shape)
        meta["faces_length_unit"] = "mm"
    except Exception as exc:  # pragma: no cover - preview must still succeed
        print("CAD_FACES_WARN", str(exc)[:200], file=sys.stderr)
    meta_path = args.meta if args.meta is not None else args.edges.with_name("cad_preview.json")
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(
        "CAD_PREVIEW_OK",
        json.dumps({k: meta[k] for k in ("preview_version", "linear_deflection", "angular_deflection", "n_display_tris")}),
    )
    if n_faces < 1 and len(polylines) < 1:
        print("FAIL: empty STEP shape", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main() or 0)
