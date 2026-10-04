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
import os
import sys
from pathlib import Path

# The one face numbering rule (host API 1.5): every visit, one index per solid that
# holds a shared face. It lives in magnusim_sdk.link, so a linking plugin numbers its
# faces with the same code; the face table, the viewport and the mesher call it here.
from magnusim_sdk.link import face_visits
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
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape

# Tighter than AIS interactive defaults so large circles stay round when zoomed.
# Still the official Prs3d knobs: coefficient * bbox size, angle in radians.
VIS_DEVIATION_COEFFICIENT = 0.0001  # AIS default is 0.001
VIS_DEVIATION_ANGLE_DEG = 5.0  # AIS default is 20 deg
# 8: the viewport's faceId/solidId follow face_visits. Before, a face two solids share
# got one viewport id, so every later viewport id named another face.
PREVIEW_VERSION = 8
# The display budget (LINK speed plan step 4, D14): a part with this many face visits
# or more is drawn with the AIS interactive defaults, BUDGET_DEFLECTION (0.001) x its
# diagonal and BUDGET_ANGLE_DEG (20 deg), not 8e-5 and 5 deg, and its box comes from a
# plain bounding box (then the triangles), not AddOptimal. On the 11,776-face part that
# is 564 k triangles, not 6.5 M (with 5 deg kept it stays 6.6 M: the angle sets the count
# there). Smaller parts are drawn exactly as before. cad_preview.json says so with
# display_budget: true; the mesh input (Body1.stl) of such a part is then built from the
# shape at CAD quality by the mesh job (prepare_input), never from this display mesh.
BUDGET_MIN_FACES = 5000
BUDGET_DEFLECTION = 0.001
BUDGET_ANGLE_DEG = 20.0


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


def plain_box(shape):
    """A quick box around the shape's geometry (``BRepBndLib.Add``), a little larger than
    the exact one: enough to size the display deflection of a large part. AddOptimal
    took 98 s on an 11,776-face part."""
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box, False)
    return box


def triangle_bounds(points) -> dict | None:
    """The box of the display triangles' nodes (they lie on the surface)."""
    import numpy as np

    pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    if not len(pts):
        return None
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    return {
        "xmin": float(lo[0]),
        "xmax": float(hi[0]),
        "ymin": float(lo[1]),
        "ymax": float(hi[1]),
        "zmin": float(lo[2]),
        "zmax": float(hi[2]),
    }


def box_from_bounds(bounds: dict):
    """A Bnd_Box with exactly these bounds (no gap)."""
    box = Bnd_Box()
    box.Update(
        float(bounds["xmin"]), float(bounds["ymin"]), float(bounds["zmin"]),
        float(bounds["xmax"]), float(bounds["ymax"]), float(bounds["zmax"]),
    )
    return box


def budget_applies(n_face_visits: int) -> bool:
    return int(n_face_visits) >= BUDGET_MIN_FACES


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


def face_properties(shape, *, bbrep: Path | None = None, processes: int | None = None, split=None):
    """Per-face area / centroid / outward normal / body, 1-based ids by ``face_visits``.

    Same numbering as the viewport faceId scalars and the cfddesk mesher, so
    ``face N@BodyB`` in the UI is ``faces[N-1]`` here, and that entry's ``body``
    is B (no ``body`` for a face outside every solid). A face two bodies share
    (``cad.shared_faces``) is inside the part: each of its entries has
    ``shared_with``, the id of the other one, and the BC panel refuses it.
    Lengths are in the STEP's own units (mm for the files we import).

    With ``bbrep`` (this shape as a binary BREP) a large part's table is split over up
    to 4 processes (``cad.face_table``); ``split`` is one already started. The rows are
    the serial ones in the same order; any failure computes them here instead.
    """
    from cfddesk.cad import face_table

    visits = face_visits(shape)
    rows = None
    if split is None and bbrep is not None:
        split = face_table.start(bbrep, len(visits), processes)
    if split is not None:
        rows = split.rows()
        if rows is not None and [r["id"] for r in rows] != [v[0] for v in visits]:
            rows = None
    if rows is None:
        rows = face_table.serial_rows(visits)
    return face_table.with_shared(rows, visits)


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


def mesh_for_display(shape, box, *, budget: bool = False):
    """AIS-equivalent tessellation with visualization-quality Prs3d settings.

    ``budget`` (a large part, see BUDGET_MIN_FACES): the deflection is BUDGET_DEFLECTION
    x the box's diagonal and the angle BUDGET_ANGLE_DEG, so the display mesh stays near
    half a million triangles.
    """
    BRepTools.Clean_s(shape)
    coefficient = BUDGET_DEFLECTION if budget else VIS_DEVIATION_COEFFICIENT
    angle_deg = BUDGET_ANGLE_DEG if budget else VIS_DEVIATION_ANGLE_DEG
    drawer = Prs3d_Drawer()
    drawer.SetDeviationCoefficient(coefficient)
    drawer.SetDeviationAngle(angle_deg * math.pi / 180.0)
    lin = float(Prs3d.GetDeflection_s(box, drawer.DeviationCoefficient(), drawer.MaximalChordialDeviation()))
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    diag = math.sqrt((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2) or 1.0
    if budget:
        lin = max(diag * BUDGET_DEFLECTION, 1e-4)
    else:
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
        "deviation_coefficient": coefficient,
        "deviation_angle_deg": angle_deg,
        "status": int(mesher.GetStatusFlags()),
    }


def extract_display_faces(shape):
    """Display triangles with per-triangle faceId / solidId from ``face_visits``.

    A face two solids share is drawn once per visit, each copy with its own id and
    body, as the face table and the mesher number it.

    Returns numpy arrays ``(points (n,3), normals (n,3), triangles (m,3), solid_ids,
    face_ids)``, read in bulk (``cad.tri_arrays``): the same values the per-node loop
    gave (``tests/unit/l4_loops.py``), about ten times faster.
    """
    import numpy as np

    from cfddesk.cad.tri_arrays import face_triangulations

    visits = face_visits(shape)
    per_face = face_triangulations([face for _i, _b, face in visits], normals=True)
    pts_parts, nrm_parts, tri_parts, sid_parts, fid_parts = [], [], [], [], []
    base = 0
    for (fid, body, _face), ft in zip(visits, per_face, strict=True):
        if ft is None:
            continue
        n = len(ft.nodes)
        pts_parts.append(ft.nodes)
        if ft.normals is not None:
            # Poly_Triangulation.Normal(i) is gp_Dir(stored float normal): normalised in
            # double; Reverse() negates; then the loop normalised once more.
            raw = ft.normals.astype(np.float64)
            x, y, z = raw[:, 0], raw[:, 1], raw[:, 2]
            d = np.sqrt(x * x + y * y + z * z)
            d = np.where(d > 0, d, 1.0)
            nx, ny, nz = x / d, y / d, z / d
            if ft.reversed:
                nx, ny, nz = -nx, -ny, -nz
            nlen = np.sqrt(nx * nx + ny * ny + nz * nz)
            nlen = np.where(nlen > 0, nlen, 1.0)
            nrm_parts.append(np.stack([nx / nlen, ny / nlen, nz / nlen], axis=1))
        else:
            nrm_parts.append(np.tile(np.array([0.0, 0.0, 1.0]), (n, 1)))
        tri = ft.triangles[:, [0, 2, 1]] if ft.reversed else ft.triangles
        tri_parts.append(tri + base)
        sid_parts.append(np.full(len(tri), body or 1, dtype=np.int32))
        fid_parts.append(np.full(len(tri), fid, dtype=np.int32))
        base += n
    if not pts_parts:
        empty3 = np.zeros((0, 3), dtype=np.float64)
        return empty3, empty3.copy(), np.zeros((0, 3), dtype=np.int64), np.zeros(0, np.int32), np.zeros(0, np.int32)
    return (
        np.concatenate(pts_parts),
        np.concatenate(nrm_parts),
        np.concatenate(tri_parts),
        np.concatenate(sid_parts),
        np.concatenate(fid_parts),
    )

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
    import numpy as np

    cell_scalars = {}
    if solid_ids is not None and len(solid_ids) and len(solid_ids) == len(tris):
        cell_scalars["solidId"] = solid_ids
    if face_ids is not None and len(face_ids) and len(face_ids) == len(tris):
        cell_scalars["faceId"] = face_ids
    if isinstance(tris, np.ndarray):
        # Triangles only: the same connectivity and offsets _flat makes, without the loop.
        m = len(tris)
        polys = (tris.reshape(-1).astype(np.int32), np.arange(3, 3 * m + 1, 3, dtype=np.int32))
    else:
        polys = _flat(tris)
    _write_binary_vtp(path, verts, polys=polys, normals=normals, cell_scalars=cell_scalars or None)
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


def ensure_step_sidecar(step: Path, shape, *, write: bool = True) -> tuple[Path | None, bool]:
    """The geometry's binary BREP beside its STEP (``source.bbrep``): ``(path, written now)``.

    An existing sidecar at least as new as the STEP is returned as is (mesh imports
    and IGES/BREP imports have one; ``io.read_step_shape`` reads it). Otherwise, with
    ``write``, it is written once (speed plan step 2): without triangles, to a temp
    name, given the STEP's own mtime, then renamed, so the geometry's age (the newer
    of the two) stays the same and no preview goes stale. Every later read (the next
    preview, a mesh, the face table's processes) then takes about a second instead of
    parsing the STEP.

    The preview writes it only for a part with the display budget: a BREP round trip
    renormalises axis directions (``gp_Dir``) in the last bit, so the shapes read from
    it are not bit-identical to the STEP's, and a plain import below the budget must
    mesh exactly as before (the meshing session's condition 1).
    """
    from OCP.BinTools import BinTools, BinTools_FormatVersion

    from cfddesk.cad.io import step_sidecar_path

    step = Path(step)
    side = step_sidecar_path(step)
    try:
        if not step.is_file():
            return (side if side.is_file() else None), False
        stamp = step.stat().st_mtime_ns
        if side.is_file() and side.stat().st_mtime_ns >= stamp:
            return side, False
        if not write:
            return None, False
        tmp = side.with_name(f"{side.stem}.{os.getpid()}.tmp.bbrep")
        try:
            BinTools.Write_s(shape, str(tmp), False, False, BinTools_FormatVersion.BinTools_FormatVersion_CURRENT)
            os.utime(tmp, ns=(stamp, stamp))
            os.replace(tmp, side)
        finally:
            tmp.unlink(missing_ok=True)
        return (side, True) if side.is_file() else (None, False)
    except Exception:
        return None, False


def read_bbrep(path: Path):
    from OCP.BinTools import BinTools
    from OCP.TopoDS import TopoDS_Shape

    shape = TopoDS_Shape()
    BinTools.Read_s(shape, str(path))
    if shape.IsNull():
        raise RuntimeError(f"empty shape: {path}")
    return shape


def _sha256(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class _Stages:
    """Seconds per stage of a preview (the rows of the speed plan's table)."""

    def __init__(self, timings: dict | None, on_stage=None):
        self.timings = timings
        self.on_stage = on_stage

    def __call__(self, name: str, fn):
        import time

        t0 = time.perf_counter()
        out = fn()
        seconds = round(time.perf_counter() - t0, 3)
        if self.timings is not None:
            self.timings[name] = seconds
        if self.on_stage is not None:
            self.on_stage(name, seconds)
        return out


def export_preview(
    step: Path,
    edges: Path,
    faces: Path,
    meta: Path | None = None,
    shape=None,
    *,
    com: bool = True,
    bbrep: Path | None = None,
    timings: dict | None = None,
    on_stage=None,
    shape_is_bbrep: bool = True,
) -> dict:
    """Write edges/faces VTP + cad_preview.json. ``shape`` may be a cached OCCT shape.

    ``com=False`` leaves the centre of mass out (a link job writes it afterwards).
    ``bbrep`` is the shape as a binary BREP (a link job's ``source.bbrep``); for a STEP
    it is the sidecar ``ensure_step_sidecar`` writes. A large part's face table is
    computed from it in other processes while this one meshes (``cad.face_table``).
    A part of BUDGET_MIN_FACES face visits or more gets the display budget.
    ``timings`` (a dict) gets the seconds of each stage; ``on_stage(name, seconds)``
    is called after each. ``shape_is_bbrep=False`` says ``shape`` was not read from
    ``bbrep``'s bytes (a text BREP): the face table's processes read ``bbrep``, so this
    process then reads it too, and every table row is the one the processes compute.
    """
    from cfddesk.cad import face_table
    from cfddesk.cad.io import read_triangle_sidecar

    stage = _Stages(timings, on_stage)
    triangles = read_triangle_sidecar(step)
    if triangles is not None:
        return export_preview_from_triangles(step, edges, faces, meta, *triangles)
    if shape is None:
        shape = stage("read_shape", lambda: load_step(step))
    n_faces = count_sub(shape, TopAbs_FACE)
    budget = budget_applies(n_faces)
    if bbrep is None:
        bbrep, written = stage("write_bbrep", lambda: ensure_step_sidecar(step, shape, write=budget))
        shape_is_bbrep = not written
    # Started before the display mesh, read after the edges. Every way out of here
    # (a failure, a stage that raises, the face table read or not) stops its processes
    # and removes their rows folder; a killed process leaves that to the processes
    # themselves (they exit with it) and to the folder's own clean-up (cad.face_table).
    split = face_table.start(bbrep, n_faces)
    try:
        if split is not None and not shape_is_bbrep:
            shape = stage("read_bbrep", lambda: read_bbrep(bbrep))
        if budget:
            box = stage("bbox_plain", lambda: plain_box(shape))
            bounds = None
        else:
            bounds, box = stage("bbox", lambda: shape_bounds(shape))
        mesh_info = stage("display_mesh", lambda: mesh_for_display(shape, box, budget=budget))
        n_solids = count_sub(shape, TopAbs_SOLID)
        n_edges = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(shape, TopAbs_EDGE, n_edges)
        verts, normals, tris, solid_ids, face_ids = stage("triangles", lambda: extract_display_faces(shape))
        if budget:
            bounds = stage("bbox_exact", lambda: triangle_bounds(verts)) or dict(
                zip(("xmin", "ymin", "zmin", "xmax", "ymax", "zmax"), (float(v) for v in box.Get()), strict=True)
            )
        n_tris = stage("faces_vtp", lambda: save_faces_vtp(faces, verts, normals, tris, solid_ids, face_ids))
        n_body = max(n_solids, 1)
        bodies = [f"Body{i}" for i in range(1, n_body + 1)]
        polylines = stage("edges", lambda: extract_display_edges(shape))
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
        if budget:
            out["display_budget"] = True
            if bbrep is not None and Path(bbrep).is_file():
                # The mesh input's freshness test for a plain import (Body1.json, prepare_input).
                out["shape_sha256"] = _sha256(Path(bbrep))
        if com:
            centre, centre_kind = stage("center_of_mass", lambda: shape_center_of_mass(shape))
            if centre:
                out["center_of_mass"] = centre
                out["center_of_mass_kind"] = centre_kind
        try:
            out["faces"] = stage("face_table", lambda: face_properties(shape, split=split))
            out["faces_length_unit"] = "mm"
        except Exception:
            pass
    finally:
        if split is not None:
            split.close()
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
