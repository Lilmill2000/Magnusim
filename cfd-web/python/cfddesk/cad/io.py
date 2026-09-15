"""Load STEP / IGES / BREP / STL / OBJ / PLY into an OCCT shape and write STEP."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import tempfile

import numpy as np

from OCP.BRep import BRep_Builder
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
    BRepBuilderAPI_Transform,
)
from OCP.BRepTools import BRepTools
from OCP.gp import gp_Trsf
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Controller, IGESControl_Reader
from OCP.Interface import Interface_Static
from OCP.STEPControl import (
    STEPControl_AsIs,
    STEPControl_Controller,
    STEPControl_Reader,
    STEPControl_Writer,
)
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.StlAPI import StlAPI_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape

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


def _load_mesh(path: Path) -> TopoDS_Shape:
    ext = path.suffix.lower()
    if ext == ".stl":
        return _load_stl(path)
    pts, tris = _triangles_from_meshio(path)
    fd, name = tempfile.mkstemp(prefix="cfd-mesh-", suffix=".stl")
    os.close(fd)
    tmp = Path(name)
    try:
        import meshio

        meshio.Mesh(pts, [("triangle", tris)]).write(str(tmp))
        return _load_stl(tmp)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


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
        shape = _load_mesh(path)
        shape = _scale_shape(shape, _MESH_TO_MM.get(unit, 1.0))
    unified = False
    shape, watertight = heal_to_solid(shape)
    if kind == "mesh":
        shape = unify_planar_faces(shape)
        unified = True
        watertight = count_sub(shape, TopAbs_SOLID) > 0
    n_solids = count_sub(shape, TopAbs_SOLID)
    n_faces = count_sub(shape, TopAbs_FACE)
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


def write_step(shape: TopoDS_Shape, dest: str | Path, *, length_unit: str = "MM") -> Path:
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
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


def unit_scale_to_metres(unit: str) -> float | None:
    return UNIT_TO_METRES.get(_normalize_unit_token(normalize_length_unit(unit)))
