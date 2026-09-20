"""STEP load, face enumeration, geometric fingerprints, tessellation."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
from OCP.GeomAbs import (
    GeomAbs_BSplineSurface,
    GeomAbs_Cone,
    GeomAbs_Cylinder,
    GeomAbs_Plane,
    GeomAbs_Sphere,
    GeomAbs_Torus,
)
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Face, TopoDS_Shape
from OCP.TopTools import TopTools_IndexedMapOfShape

from cfddesk.cad.units import UnitResolution, resolve_units, shape_bbox

_SURF_NAMES = {
    GeomAbs_Plane: "Plane",
    GeomAbs_Cylinder: "Cylinder",
    GeomAbs_Cone: "Cone",
    GeomAbs_Sphere: "Sphere",
    GeomAbs_Torus: "Torus",
    GeomAbs_BSplineSurface: "BSpline",
}


@dataclass(frozen=True)
class FaceRecord:
    """One boundary face with a stable-while-enumeration-stable geometric fingerprint."""

    face_id: int
    area: float
    centroid: tuple[float, float, float]
    surface_type: str
    face: TopoDS_Face


@dataclass(frozen=True)
class VolumeRecord:
    """One TopAbs_SOLID with the face_ids that belong to it (global face enumeration)."""

    volume_id: str
    name: str
    face_ids: tuple[int, ...]


@dataclass
class LoadedSolid:
    path: Path
    shape: TopoDS_Shape
    faces: list[FaceRecord]
    units: UnitResolution
    volumes: list[VolumeRecord] = field(default_factory=list)

    @property
    def n_faces(self) -> int:
        return len(self.faces)

    def faces_for_volume(self, volume_id: str) -> list[int]:
        for v in self.volumes:
            if v.volume_id == volume_id:
                return list(v.face_ids)
        return []

    def volume_for_face(self, face_id: int) -> str | None:
        """Invert volume→faces map; first containing volume wins."""
        fid = int(face_id)
        for v in self.volumes:
            if fid in v.face_ids:
                return v.volume_id
        return None


def _surface_type_name(face: TopoDS_Face) -> str:
    adapt = BRepAdaptor_Surface(face)
    return _SURF_NAMES.get(adapt.GetType(), str(adapt.GetType()))


def _face_props(face: TopoDS_Face) -> tuple[float, tuple[float, float, float]]:
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, props)
    c = props.CentreOfMass()
    return float(props.Mass()), (float(c.X()), float(c.Y()), float(c.Z()))


def load_step(path: str | Path) -> LoadedSolid:
    """Read a STEP file and enumerate faces in OCCT explorer order."""
    path = Path(path).resolve()
    if not path.is_file():
        raise FileNotFoundError(path)

    reader = STEPControl_Reader()
    status = reader.ReadFile(str(path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEP read failed ({status}): {path}")
    if reader.TransferRoots() == 0:
        raise RuntimeError(f"STEP transfer produced no shapes: {path}")

    shape = reader.OneShape()
    faces: list[FaceRecord] = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    idx = 0
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        area, centroid = _face_props(face)
        faces.append(
            FaceRecord(
                face_id=idx,
                area=area,
                centroid=centroid,
                surface_type=_surface_type_name(face),
                face=face,
            )
        )
        idx += 1
        explorer.Next()

    if not faces:
        raise RuntimeError(f"No faces found in STEP: {path}")

    units = resolve_units(path, shape)
    volumes = enumerate_volumes(shape, faces)
    return LoadedSolid(path=path, shape=shape, faces=faces, units=units, volumes=volumes)


def enumerate_volumes(
    shape: TopoDS_Shape, faces: list[FaceRecord]
) -> list[VolumeRecord]:
    """Map each TopAbs_SOLID to global face_ids (same indices as ``faces``)."""
    face_list = [(fr.face_id, fr.face) for fr in faces]

    def _face_id_of(face: TopoDS_Face) -> int | None:
        for fid, f in face_list:
            if f.IsSame(face):
                return fid
        return None

    volumes: list[VolumeRecord] = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    vi = 0
    while explorer.More():
        solid = explorer.Current()
        fids: list[int] = []
        fexp = TopExp_Explorer(solid, TopAbs_FACE)
        while fexp.More():
            face = TopoDS.Face_s(fexp.Current())
            fid = _face_id_of(face)
            if fid is not None and fid not in fids:
                fids.append(fid)
            fexp.Next()
        fids.sort()
        volumes.append(
            VolumeRecord(
                volume_id=f"solid-{vi}",
                name=f"Solid {vi + 1}",
                face_ids=tuple(fids),
            )
        )
        vi += 1
        explorer.Next()

    if not volumes:
        # Degenerate: no solid — one synthetic volume owning all faces.
        volumes.append(
            VolumeRecord(
                volume_id="solid-0",
                name="Solid 1",
                face_ids=tuple(fr.face_id for fr in faces),
            )
        )
    return volumes


def volumes_from_shape(shape: TopoDS_Shape) -> list[VolumeRecord]:
    """Enumerate volumes for an in-memory shape (e.g. synthetic two-box gate)."""
    faces: list[FaceRecord] = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    idx = 0
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        area, centroid = _face_props(face)
        faces.append(
            FaceRecord(
                face_id=idx,
                area=area,
                centroid=centroid,
                surface_type=_surface_type_name(face),
                face=face,
            )
        )
        idx += 1
        explorer.Next()
    return enumerate_volumes(shape, faces)


def shape_diagonal(solid: LoadedSolid) -> float:
    """BBox diagonal in native OCCT units."""
    bb = shape_bbox(solid.shape, unit="native")
    e = bb.extents
    return float((e[0] * e[0] + e[1] * e[1] + e[2] * e[2]) ** 0.5)


def mesh_deflection(
    solid: LoadedSolid,
    *,
    relative_linear: float = 0.00025,
    angular_deflection: float = 0.08,
) -> tuple[float, float]:
    """Linear (model units) + angular (rad) deflection for Fusion-class smoothness.

    ``relative_linear`` is a fraction of the bbox diagonal (default 0.025%).
    Angular ~0.08 rad (~4.5°) keeps curved silhouettes smooth under shading.
    Viewport ``step_solid`` only — STL export passes its own coarse values.
    """
    diag = max(shape_diagonal(solid), 1e-9)
    # Floor is relative to the native diagonal — never an absolute mm/m length.
    # (Old absolute ``1e-4`` meant 0.1 µm in MM native vs 0.1 mm in metre native.)
    linear = max(relative_linear * diag, 1e-9 * diag)
    return float(linear), float(angular_deflection)


def tessellate_faces(
    solid: LoadedSolid,
    *,
    linear_deflection: float | None = None,
    angular_deflection: float | None = None,
    relative_linear: float = 0.00025,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Tessellate all faces; bake ``face_id`` into per-triangle cell data.

    Defaults are relative to model size (viewport ``step_solid``). STL export
    must pass explicit coarse ``linear_deflection`` / ``angular_deflection``.

    Returns
    -------
    points : (N, 3) float64
    faces : (M, 3) int64 — triangle vertex indices (0-based)
    face_ids : (M,) int32 — CAD face index for each triangle
    """
    lin_auto, ang_auto = mesh_deflection(
        solid, relative_linear=relative_linear, angular_deflection=0.08
    )
    lin = float(linear_deflection) if linear_deflection is not None else lin_auto
    ang = float(angular_deflection) if angular_deflection is not None else ang_auto
    # Drop any prior triangulation so IncrementalMesh rebuilds at new deflection.
    BRepTools.Clean_s(solid.shape)
    BRepMesh_IncrementalMesh(solid.shape, lin, False, ang, True)

    points: list[list[float]] = []
    triangles: list[list[int]] = []
    face_ids: list[int] = []
    offset = 0

    for record in solid.faces:
        face = record.face
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue

        trsf = loc.Transformation()
        n_nodes = tri.NbNodes()
        for i in range(1, n_nodes + 1):
            p = tri.Node(i)
            p.Transform(trsf)
            points.append([p.X(), p.Y(), p.Z()])

        reversed_orient = face.Orientation() == TopAbs_REVERSED
        n_tris = tri.NbTriangles()
        for i in range(1, n_tris + 1):
            t = tri.Triangle(i)
            n1, n2, n3 = t.Value(1), t.Value(2), t.Value(3)
            if reversed_orient:
                n1, n2, n3 = n1, n3, n2
            triangles.append([offset + n1 - 1, offset + n2 - 1, offset + n3 - 1])
            face_ids.append(record.face_id)

        offset += n_nodes

    if not triangles:
        raise RuntimeError("Tessellation produced no triangles")

    return (
        np.asarray(points, dtype=np.float64),
        np.asarray(triangles, dtype=np.int64),
        np.asarray(face_ids, dtype=np.int32),
    )


def tessellate_single_face(
    face: TopoDS_Face,
    *,
    linear_deflection: float,
    angular_deflection: float = 0.35,
    relative_deflection: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    """Triangulate one BREP face in native OCCT units.

    Used when gmsh cannot mesh closed periodic surfaces (cylinders/tori).
    """
    lin = max(float(linear_deflection), 1e-15)
    ang = max(float(angular_deflection), 1e-3)
    rel = bool(relative_deflection)
    BRepTools.Clean_s(face)
    BRepMesh_IncrementalMesh(face, lin, rel, ang, True)

    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face, loc)
    if tri is None or tri.NbTriangles() < 1:
        raise RuntimeError("OCCT face tessellation produced no triangles")

    trsf = loc.Transformation()
    points: list[list[float]] = []
    for i in range(1, tri.NbNodes() + 1):
        p = tri.Node(i)
        p.Transform(trsf)
        points.append([p.X(), p.Y(), p.Z()])

    reversed_orient = face.Orientation() == TopAbs_REVERSED
    triangles: list[list[int]] = []
    for i in range(1, tri.NbTriangles() + 1):
        t = tri.Triangle(i)
        n1, n2, n3 = t.Value(1), t.Value(2), t.Value(3)
        if reversed_orient:
            n1, n2, n3 = n1, n3, n2
        triangles.append([n1 - 1, n2 - 1, n3 - 1])

    return np.asarray(points, dtype=np.float64), np.asarray(triangles, dtype=np.int64)


def tessellate_single_face_robust(
    face: TopoDS_Face,
    *,
    linear_deflection: float,
    face_area_native: float,
    angular_deflection: float = 0.35,
) -> tuple[np.ndarray, np.ndarray]:
    """Try several OCCT deflections — tiny spheres need relative meshing."""
    import math

    lin0 = max(float(linear_deflection), 1e-15)
    area = max(float(face_area_native), 1e-30)
    edge_est = math.sqrt(area)
    attempts: list[tuple[float, bool]] = [
        (lin0, False),
        (min(lin0, edge_est * 0.5), False),
        (min(lin0, edge_est * 0.15), False),
        (max(edge_est * 0.08, 1e-6), False),
        (0.01, True),
        (0.001, True),
        (0.0001, True),
    ]
    last_err: RuntimeError | None = None
    for lin, rel in attempts:
        try:
            return tessellate_single_face(
                face,
                linear_deflection=lin,
                angular_deflection=angular_deflection,
                relative_deflection=rel,
            )
        except RuntimeError as exc:
            last_err = exc
            continue
    raise RuntimeError(
        f"OCCT face tessellation failed after {len(attempts)} attempts: {last_err}"
    )


def extract_cad_edges(
    solid: LoadedSolid,
    *,
    deflection: float | None = None,
    scale: float = 1.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Discretise unique topological edges (Fusion-style true CAD edges).

    Returns
    -------
    points : (N, 3) float64 — scaled by ``scale`` (use ``scale_to_metres`` for CFD)
    lines : int64 ravelled VTK line connectivity ``[n, i0, i1, …]``
    """
    if deflection is None:
        deflection, _ = mesh_deflection(solid)
        # Match face-mesh deflection so circles (vortex finder, rims) stay round.
        deflection = max(deflection, 1e-4)

    edge_map = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid.shape, TopAbs_EDGE, edge_map)

    points: list[list[float]] = []
    lines: list[int] = []
    offset = 0

    for i in range(1, edge_map.Size() + 1):
        edge = TopoDS.Edge_s(edge_map.FindKey(i))
        if BRep_Tool.Degenerated_s(edge):
            continue
        try:
            curve = BRepAdaptor_Curve(edge)
            u0 = float(curve.FirstParameter())
            u1 = float(curve.LastParameter())
        except Exception:
            continue
        if abs(u1 - u0) < 1e-15:
            continue
        try:
            sampler = GCPnts_QuasiUniformDeflection(curve, float(deflection), u0, u1)
        except Exception:
            continue
        if not sampler.IsDone() or sampler.NbPoints() < 2:
            continue
        n = int(sampler.NbPoints())
        for j in range(1, n + 1):
            p = sampler.Value(j)
            points.append([p.X() * scale, p.Y() * scale, p.Z() * scale])
        lines.append(n)
        lines.extend(range(offset, offset + n))
        offset += n

    if not points:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0,), dtype=np.int64)
    return (
        np.asarray(points, dtype=np.float64),
        np.asarray(lines, dtype=np.int64),
    )
