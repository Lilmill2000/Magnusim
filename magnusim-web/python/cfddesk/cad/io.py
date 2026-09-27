"""Load STEP / IGES / BREP / STL / OBJ / PLY into an OCCT shape and write STEP."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from OCP.BinTools import BinTools
from OCP.BRep import BRep_Builder
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeShapeOnMesh,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
    BRepBuilderAPI_Transform,
)
from OCP.BRepLib import BRepLib
from OCP.BRepTools import BRepTools
from OCP.gp import gp_Trsf
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Controller, IGESControl_Reader
from OCP.Interface import Interface_Static
from OCP.RWStl import RWStl
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.STEPControl import (
    STEPControl_AsIs,
    STEPControl_Controller,
    STEPControl_Reader,
    STEPControl_Writer,
)
from OCP.StlAPI import StlAPI_Reader
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape, TopoDS_Shell
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

from cfddesk.cad.units import UNIT_TO_METRES, _normalize_unit_token

BREP_EXTS = {".step", ".stp", ".iges", ".igs", ".brep", ".brp"}
MESH_EXTS = {".stl", ".obj", ".ply"}
ALL_EXTS = BREP_EXTS | MESH_EXTS

# OCCT write.step.unit tokens
_STEP_UNITS = {
    "MM": "MM",
    "MILLIMETRE": "MM",
    "MILLIMETER": "MM",
    "CM": "CM",
    "CENTIMETRE": "CM",
    "CENTIMETER": "CM",
    "M": "M",
    "METRE": "M",
    "METER": "M",
    "INCH": "INCH",
    "IN": "INCH",
    "FT": "FT",
    "FOOT": "FT",
}

# Mesh coordinates have no unit. Scale into OCCT millimetres (cascade unit).
_MESH_TO_MM = {
    "MM": 1.0,
    "CM": 10.0,
    "M": 1000.0,
    "INCH": 25.4,
    "FT": 304.8,
}


def classify_cad(path: str | Path) -> str:
    ext = Path(path).suffix.lower()
    if ext in {".step", ".stp"}:
        return "step"
    if ext in {".iges", ".igs"}:
        return "iges"
    if ext in {".brep", ".brp"}:
        return "brep"
    if ext in MESH_EXTS:
        return "mesh"
    return "unknown"


def needs_length_unit(path: str | Path) -> bool:
    return classify_cad(path) == "mesh"


def normalize_length_unit(unit: str | None) -> str:
    if not unit:
        return "MM"
    key = _normalize_unit_token(str(unit))
    return _STEP_UNITS.get(key, "MM")


def count_sub(shape: TopoDS_Shape, kind) -> int:
    n = 0
    exp = TopExp_Explorer(shape, kind)
    while exp.More():
        n += 1
        exp.Next()
    return n


@dataclass
class LoadedCad:
    path: Path
    shape: TopoDS_Shape
    kind: str
    length_unit: str
    n_solids: int
    n_faces: int
    n_shells: int
    watertight: bool
    unified: bool = False
    # (points Nx3 mm, triangles Mx3) when face i of ``shape`` is exactly triangle i
    # (closed mesh, no coplanar merge): the preview is then built from these directly.
    triangles: tuple | None = None
    # Surface id per triangle (``face_groups``): the geometry's face ids for a closed mesh.
    groups: np.ndarray | None = None

    def summary(self) -> dict:
        return {
            "path": str(self.path),
            "kind": self.kind,
            "length_unit": self.length_unit,
            "n_solids": self.n_solids,
            "n_faces": self.n_faces,
            "n_shells": self.n_shells,
            "watertight": self.watertight,
            "unified": self.unified,
        }


def _load_step(path: Path) -> TopoDS_Shape:
    reader = STEPControl_Reader()
    status = reader.ReadFile(str(path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEP read failed ({status}): {path}")
    if reader.TransferRoots() == 0:
        raise RuntimeError(f"STEP transfer produced no shapes: {path}")
    return reader.OneShape()


def _load_iges(path: Path) -> TopoDS_Shape:
    try:
        IGESControl_Controller.Init_s()
    except Exception:
        pass
    reader = IGESControl_Reader()
    status = reader.ReadFile(str(path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"IGES read failed ({status}): {path}")
    if reader.TransferRoots() == 0:
        raise RuntimeError(f"IGES transfer produced no shapes: {path}")
    return reader.OneShape()


def _load_brep(path: Path) -> TopoDS_Shape:
    shape = TopoDS_Shape()
    ok = BRepTools.Read_s(shape, str(path), BRep_Builder())
    if not ok or shape.IsNull():
        raise RuntimeError(f"BREP read failed: {path}")
    return shape


def _triangles_from_meshio(path: Path) -> tuple[np.ndarray, np.ndarray]:
    import meshio

    mesh = meshio.read(str(path))
    pts = np.asarray(mesh.points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] < 3:
        raise RuntimeError(f"Mesh has no 3D points: {path}")
    chunks: list[np.ndarray] = []
    for block in mesh.cells:
        data = np.asarray(block.data, dtype=np.int64)
        if block.type == "triangle":
            chunks.append(data)
        elif block.type == "quad":
            chunks.append(data[:, [0, 1, 2]])
            chunks.append(data[:, [0, 2, 3]])
        elif block.type == "polygon":
            for poly in data:
                if len(poly) < 3:
                    continue
                origin = int(poly[0])
                for i in range(1, len(poly) - 1):
                    chunks.append(np.array([[origin, int(poly[i]), int(poly[i + 1])]], dtype=np.int64))
    if not chunks:
        raise RuntimeError(f"No triangle faces in {path}")
    return pts[:, :3], np.vstack(chunks)


def _load_stl(path: Path) -> TopoDS_Shape:
    shape = TopoDS_Shape()
    ok = StlAPI_Reader().Read(shape, str(path))
    if not ok or shape.IsNull():
        raise RuntimeError(f"STL read failed: {path}")
    return shape


def _has_degenerate_triangles(tri) -> bool:
    """True if any triangle repeats a node or has (near) zero area."""
    nodes = np.array(
        [(p.X(), p.Y(), p.Z()) for p in (tri.Node(i) for i in range(1, tri.NbNodes() + 1))],
        dtype=np.float64,
    )
    idx = np.array([tri.Triangle(i).Get() for i in range(1, tri.NbTriangles() + 1)], dtype=np.int64) - 1
    if np.any((idx[:, 0] == idx[:, 1]) | (idx[:, 1] == idx[:, 2]) | (idx[:, 0] == idx[:, 2])):
        return True
    a, b, c = nodes[idx[:, 0]], nodes[idx[:, 1]], nodes[idx[:, 2]]
    doubled_area = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    span = float(np.ptp(nodes, axis=0).max()) or 1.0
    return bool(np.any(doubled_area <= (span * 1e-9) ** 2))


def _closed_solid_from_stl(path: Path) -> TopoDS_Shape | None:
    """Watertight STL -> solid with shared edges, without sewing.

    RWStl merges coincident nodes and MakeShapeOnMesh gives adjacent triangles
    the same edge, so a closed surface is already connected: put the faces in
    one shell and make the solid. Sewing the same faces is O(minutes) on a
    100k-triangle STL. Returns None for an open or non-manifold surface (some
    edge not shared by exactly two faces) or one with degenerate triangles;
    the caller then sews with tolerance, which also drops zero-area faces the
    mesher could not match.
    """
    tri = RWStl.ReadFile_s(str(path))
    if tri is None or tri.NbTriangles() == 0:
        return None
    if _has_degenerate_triangles(tri):
        return None
    maker = BRepBuilderAPI_MakeShapeOnMesh(tri)
    maker.Build()
    faces = maker.Shape()
    if faces is None or faces.IsNull():
        return None
    builder = BRep_Builder()
    shell = TopoDS_Shell()
    builder.MakeShell(shell)
    exp = TopExp_Explorer(faces, TopAbs_FACE)
    while exp.More():
        builder.Add(shell, exp.Current())
        exp.Next()
    edge_faces = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shell, TopAbs_EDGE, TopAbs_FACE, edge_faces)
    for i in range(1, edge_faces.Extent() + 1):
        if edge_faces.FindFromIndex(i).Size() != 2:
            return None
    shell.Closed(True)
    made = BRepBuilderAPI_MakeSolid(shell)
    if not made.IsDone():
        return None
    solid = made.Solid()
    BRepLib.OrientClosedSolid_s(solid)
    return solid


def _with_stl(path: Path, use):
    """Call ``use(stl_path)`` on the mesh file, converting OBJ/PLY to a temp STL first."""
    if path.suffix.lower() == ".stl":
        return use(path)
    pts, tris = _triangles_from_meshio(path)
    fd, name = tempfile.mkstemp(prefix="cfd-mesh-", suffix=".stl")
    os.close(fd)
    tmp = Path(name)
    try:
        import meshio

        meshio.Mesh(pts, [("triangle", tris)]).write(str(tmp))
        return use(tmp)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _load_mesh(path: Path) -> tuple[TopoDS_Shape, tuple | None]:
    """Closed meshes become a solid directly; anything else is read as faces for sewing.

    Returns ``(shape, (points, triangles))`` on the direct path, where face i of the
    shape is triangle i; ``(shape, None)`` when the faces were read for sewing.
    """

    def read(stl: Path):
        solid = _closed_solid_from_stl(stl)
        if solid is None:
            return _load_stl(stl), None
        tri = RWStl.ReadFile_s(str(stl))
        nodes = np.array(
            [(q.X(), q.Y(), q.Z()) for q in (tri.Node(i) for i in range(1, tri.NbNodes() + 1))],
            dtype=np.float64,
        )
        idx = np.array([tri.Triangle(i).Get() for i in range(1, tri.NbTriangles() + 1)], dtype=np.int64) - 1
        return solid, (nodes, idx)

    return _with_stl(path, read)


def heal_to_solid(shape: TopoDS_Shape) -> tuple[TopoDS_Shape, bool]:
    """Sew faces and promote a closed shell to a solid when needed."""
    if count_sub(shape, TopAbs_SOLID) > 0:
        return shape, True
    sew = BRepBuilderAPI_Sewing(1.0e-6)
    sew.Add(shape)
    sew.Perform()
    sewn = sew.SewedShape()
    if sewn.IsNull():
        return shape, False
    if count_sub(sewn, TopAbs_SOLID) > 0:
        return sewn, True
    exp = TopExp_Explorer(sewn, TopAbs_SHELL)
    closed = False
    maker = BRepBuilderAPI_MakeSolid()
    added = 0
    while exp.More():
        shell = TopoDS.Shell_s(exp.Current())
        try:
            if shell.Closed():
                maker.Add(shell)
                added += 1
                closed = True
        except Exception:
            pass
        exp.Next()
    if added and maker.IsDone():
        return maker.Solid(), True
    return sewn, closed


def _scale_shape(shape: TopoDS_Shape, factor: float) -> TopoDS_Shape:
    if abs(factor - 1.0) < 1e-15:
        return shape
    trsf = gp_Trsf()
    trsf.SetScaleFactor(factor)
    return BRepBuilderAPI_Transform(shape, trsf, True).Shape()


def unify_planar_faces(shape: TopoDS_Shape) -> TopoDS_Shape:
    try:
        tool = ShapeUpgrade_UnifySameDomain(shape, True, True, False)
        tool.Build()
        out = tool.Shape()
        if out is None or out.IsNull():
            return shape
        return out
    except Exception:
        return shape


def load_cad(path: str | Path, *, length_unit: str | None = None) -> LoadedCad:
    path = Path(path).resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    kind = classify_cad(path)
    if kind == "unknown":
        raise RuntimeError(f"Unsupported CAD format: {path.suffix or path.name}")
    unit = normalize_length_unit(length_unit)
    if kind == "step":
        shape = _load_step(path)
    elif kind == "iges":
        shape = _load_iges(path)
    elif kind == "brep":
        shape = _load_brep(path)
    else:
        shape, triangles = _load_mesh(path)
        factor = _MESH_TO_MM.get(unit, 1.0)
        shape = _scale_shape(shape, factor)
        if triangles is not None:
            triangles = (triangles[0] * factor, triangles[1])
    unified = False
    groups = None
    shape, watertight = heal_to_solid(shape)
    if kind == "mesh":
        if triangles is not None:
            # Closed mesh: its faces are surfaces of triangles grouped by feature
            # angle (face_groups); the shape keeps one face per triangle.
            from cfddesk.cad.face_groups import group_triangles, orient_outward

            triangles = (triangles[0], orient_outward(triangles[0], triangles[1]))
            groups = group_triangles(*triangles)
        elif count_sub(shape, TopAbs_FACE) <= 8000:
            # Sewn (open or defective) mesh: coplanar merge, which dominates import
            # time on a large one.
            shape = unify_planar_faces(shape)
            unified = True
        watertight = count_sub(shape, TopAbs_SOLID) > 0
    if kind != "mesh" or unified:
        triangles = None
    n_solids = count_sub(shape, TopAbs_SOLID)
    n_faces = int(groups.max()) + 1 if groups is not None else count_sub(shape, TopAbs_FACE)
    n_shells = count_sub(shape, TopAbs_SHELL)
    if n_faces < 1:
        raise RuntimeError(f"No faces in {path}")
    return LoadedCad(
        path=path,
        shape=shape,
        kind=kind,
        length_unit=unit,
        n_solids=n_solids,
        n_faces=n_faces,
        n_shells=n_shells,
        watertight=watertight or n_solids > 0,
        unified=unified,
        triangles=triangles,
        groups=groups,
    )


def compound_shapes(shapes: list[TopoDS_Shape]) -> TopoDS_Shape:
    """One compound: solids (or the raw shape if a part has none) in given order."""
    builder = BRep_Builder()
    comp = TopoDS_Compound()
    builder.MakeCompound(comp)
    added = 0
    for shape in shapes:
        if shape is None or shape.IsNull():
            continue
        n_solids = 0
        exp = TopExp_Explorer(shape, TopAbs_SOLID)
        while exp.More():
            builder.Add(comp, exp.Current())
            n_solids += 1
            added += 1
            exp.Next()
        if n_solids == 0:
            builder.Add(comp, shape)
            added += 1
    if added == 0:
        raise RuntimeError("no shapes to compound")
    return comp


def compound_step_files(paths: list[str | Path]) -> LoadedCad:
    """Load each already-normalized STEP and compound them for the project assembly."""
    loaded: list[LoadedCad] = []
    for raw in paths:
        path = Path(raw).resolve()
        if not path.is_file():
            raise FileNotFoundError(path)
        loaded.append(load_cad(path))
    if not loaded:
        raise RuntimeError("no STEP parts to compound")
    if len(loaded) == 1:
        return loaded[0]
    shape = compound_shapes([item.shape for item in loaded])
    n_solids = count_sub(shape, TopAbs_SOLID)
    n_faces = count_sub(shape, TopAbs_FACE)
    n_shells = count_sub(shape, TopAbs_SHELL)
    return LoadedCad(
        path=loaded[0].path,
        shape=shape,
        kind="step",
        length_unit="MM",
        n_solids=n_solids,
        n_faces=n_faces,
        n_shells=n_shells,
        watertight=n_solids > 0,
        unified=False,
    )


def write_step(
    shape: TopoDS_Shape, dest: str | Path, *, length_unit: str = "MM", defer: bool = False
) -> Path:
    """Write ``dest`` (STEP) and its binary sidecar.

    ``defer=True`` writes only the sidecar now; ``write_deferred_step`` writes the
    STEP later (a faceted 100k-triangle STL takes ~20 s as STEP). Every reader in
    the app goes through ``read_step_shape`` / ``geometry_file_exists``, which work
    from the sidecar alone.
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if defer:
        normalize_length_unit(length_unit)
        if write_step_sidecar(shape, dest) is None:
            raise RuntimeError(f"geometry sidecar write failed: {step_sidecar_path(dest)}")
        return dest
    _write_step_file(shape, dest, length_unit=length_unit)
    write_step_sidecar(shape, dest)
    return dest


def _write_step_file(shape: TopoDS_Shape, dest: Path, *, length_unit: str = "MM") -> Path:
    normalize_length_unit(length_unit)
    try:
        STEPControl_Controller.Init_s()
    except Exception:
        pass
    # Mesh imports are already scaled to millimetres; keep STEP in cascade units.
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    writer = STEPControl_Writer()
    status = writer.Transfer(shape, STEPControl_AsIs)
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEP transfer failed ({status})")
    status = writer.Write(str(dest))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEP write failed ({status}): {dest}")
    if not dest.is_file() or dest.stat().st_size < 32:
        raise RuntimeError(f"STEP missing after write: {dest}")
    return dest


def write_deferred_step(step: str | Path) -> Path:
    """Write the STEP for a sidecar-only geometry (see ``write_step(defer=True)``).

    The STEP gets the sidecar's mtime so the sidecar stays the file readers use and
    previews built from it stay fresh. Written to a temp name, then replaced.
    """
    step = Path(step)
    side = step_sidecar_path(step)
    if not side.is_file():
        raise FileNotFoundError(side)
    shape = TopoDS_Shape()
    BinTools.Read_s(shape, str(side))
    if shape.IsNull():
        raise RuntimeError(f"empty geometry sidecar: {side}")
    tmp = step.with_name(f"{step.stem}.{os.getpid()}.tmp.step")
    try:
        _write_step_file(shape, tmp)
        stamp = side.stat().st_mtime_ns
        os.utime(tmp, ns=(stamp, stamp))
        os.replace(tmp, step)
    finally:
        tmp.unlink(missing_ok=True)
    return step


def triangle_sidecar_path(step: str | Path) -> Path:
    return Path(step).with_suffix(".tris.npz")


def write_geometry(loaded: LoadedCad, dest: str | Path) -> bool:
    """Store an imported shape at ``dest`` (source.step). Returns True when the STEP is deferred.

    Mesh files write the binary sidecar now and the STEP later; when face i is
    triangle i the triangles are kept too, so the preview needs no re-meshing.
    """
    dest = Path(dest)
    defer = loaded.kind == "mesh"
    write_step(loaded.shape, dest, length_unit=loaded.length_unit, defer=defer)
    tris = triangle_sidecar_path(dest)
    if loaded.triangles is not None:
        points, faces = loaded.triangles
        pts = np.asarray(points, dtype=np.float64)
        tri = np.asarray(faces, dtype=np.int32)
        # Written after the sidecar, so it is at least as new as the geometry.
        with tris.open("wb") as fh:
            if loaded.groups is not None:
                np.savez(fh, points=pts, triangles=tri, groups=np.asarray(loaded.groups, dtype=np.int32))
            else:
                np.savez(fh, points=pts, triangles=tri)
    else:
        tris.unlink(missing_ok=True)
    return defer


def read_triangle_sidecar(step: str | Path):
    """(points, triangles, groups) for ``step`` when its triangle sidecar is current, else None.

    ``groups`` (surface id per triangle) is None for a sidecar written before
    surfaces were grouped; face i is then triangle i.
    """
    tris = triangle_sidecar_path(step)
    try:
        if not tris.is_file() or tris.stat().st_mtime_ns < geometry_mtime_ns(step):
            return None
        with np.load(tris) as data:
            groups = np.array(data["groups"]) if "groups" in data.files else None
            return np.array(data["points"]), np.array(data["triangles"]), groups
    except Exception:
        return None


def geometry_file_exists(step: str | Path) -> bool:
    """True when the geometry at ``step`` can be read: the STEP or its sidecar."""
    step = Path(step)
    return step.is_file() or step_sidecar_path(step).is_file()


def geometry_mtime_ns(step: str | Path) -> int:
    """Newest of the STEP and its sidecar (0 when neither exists)."""
    step = Path(step)
    out = 0
    for path in (step, step_sidecar_path(step)):
        try:
            out = max(out, path.stat().st_mtime_ns)
        except OSError:
            pass
    return out


def step_sidecar_path(step: str | Path) -> Path:
    return Path(step).with_suffix(".bbrep")


def write_step_sidecar(shape: TopoDS_Shape, step: str | Path) -> Path | None:
    """Binary BREP copy of the shape next to ``step`` (written after it, so it is newer).

    Reading a STEP of a faceted STL (100k+ faces) takes ~40 s; this reads in
    under a second with the same faces in the same order.
    """
    dest = step_sidecar_path(step)
    try:
        if BinTools.Write_s(shape, str(dest)):
            return dest
    except Exception:
        pass
    try:
        dest.unlink(missing_ok=True)
    except OSError:
        pass
    return None


def read_step_shape(step: str | Path) -> TopoDS_Shape:
    """Shape of ``step``: its binary sidecar when that is at least as new, else the STEP.

    Anything that rewrites the STEP later makes it newer than the sidecar, so a
    stale sidecar is never used.
    """
    step = Path(step)
    side = step_sidecar_path(step)
    try:
        step_ns = step.stat().st_mtime_ns if step.is_file() else -1
        if side.is_file() and side.stat().st_mtime_ns >= step_ns:
            shape = TopoDS_Shape()
            BinTools.Read_s(shape, str(side))
            if not shape.IsNull():
                return shape
    except Exception:
        pass
    return _load_step(step)


def unit_scale_to_metres(unit: str) -> float | None:
    return UNIT_TO_METRES.get(_normalize_unit_token(normalize_length_unit(unit)))
