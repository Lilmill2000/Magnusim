"""Minimum flow-passage sizing and mesh cell-count assertion."""

from __future__ import annotations

import math
from dataclasses import dataclass

from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Plane

from cfddesk.cad.step import FaceRecord, LoadedSolid
from cfddesk.project.defaults import (
    MESH_BASE_CELL_M,
    MESH_MIN_CELLS_ACROSS_PASSAGE,
    MESH_REFINEMENT_LEVEL_INOUT,
)
from cfddesk.project.model import FaceRole, Project


@dataclass(frozen=True)
class PassageMeasure:
    face_id: int
    role: FaceRole
    diameter_m: float
    area_m2: float
    method: str


@dataclass(frozen=True)
class PassageMeshCheck:
    passages: list[PassageMeasure]
    min_passage_m: float
    base_cell_m: float
    refinement_level: int
    refined_cell_m: float
    cells_across_min: float
    min_required: float
    ok: bool
    message: str


def plane_equivalent_diameter_m(rec: FaceRecord, scale_to_metres: float) -> PassageMeasure:
    """For a planar opening, diameter from area (circular equivalent)."""
    area_m2 = rec.area * scale_to_metres * scale_to_metres
    if area_m2 <= 0:
        raise ValueError(f"face {rec.face_id}: non-positive area")
    diameter_m = 2.0 * math.sqrt(area_m2 / math.pi)
    return PassageMeasure(
        face_id=rec.face_id,
        role="unassigned",
        diameter_m=diameter_m,
        area_m2=area_m2,
        method="2*sqrt(area/pi) planar disk",
    )


def measure_role_passages(
    solid: LoadedSolid,
    project: Project,
    roles: tuple[FaceRole, ...] = ("inlet", "outlet"),
) -> list[PassageMeasure]:
    """Measure passage diameters for CFD opening roles from CAD."""
    by_id = {f.face_id: f for f in solid.faces}
    out: list[PassageMeasure] = []
    for fp in project.faces:
        if fp.role not in roles:
            continue
        rec = by_id[fp.face_id]
        adapt = BRepAdaptor_Surface(rec.face)
        if adapt.GetType() != GeomAbs_Plane:
            raise RuntimeError(
                f"role {fp.role} face {fp.face_id} is not planar — "
                "passage diameter method expects a planar opening"
            )
        m = plane_equivalent_diameter_m(rec, project.scale_to_metres)
        out.append(
            PassageMeasure(
                face_id=m.face_id,
                role=fp.role,
                diameter_m=m.diameter_m,
                area_m2=m.area_m2,
                method=m.method,
            )
        )
    if not out:
        raise RuntimeError("no inlet/outlet faces to measure")
    return out


def check_passage_cells(
    passages: list[PassageMeasure],
    *,
    base_cell_m: float = MESH_BASE_CELL_M,
    refinement_level: int = MESH_REFINEMENT_LEVEL_INOUT,
    min_cells: float = MESH_MIN_CELLS_ACROSS_PASSAGE,
) -> PassageMeshCheck:
    """Assert refined cell size gives ≥ min_cells across the smallest passage."""
    min_passage = min(p.diameter_m for p in passages)
    refined = base_cell_m / (2**refinement_level)
    cells_across = min_passage / refined
    ok = cells_across >= min_cells
    msg = (
        f"min passage={min_passage:.6g} m; base={base_cell_m:.6g} m; "
        f"level={refinement_level}; refined_cell={refined:.6g} m; "
        f"cells_across={cells_across:.3f} (need ≥ {min_cells:g})"
    )
    if not ok:
        msg = "BLOCK meshing: " + msg
    return PassageMeshCheck(
        passages=passages,
        min_passage_m=min_passage,
        base_cell_m=base_cell_m,
        refinement_level=refinement_level,
        refined_cell_m=refined,
        cells_across_min=cells_across,
        min_required=min_cells,
        ok=ok,
        message=msg,
    )
