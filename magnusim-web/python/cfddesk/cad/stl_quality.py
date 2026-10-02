"""STL chordal deflection vs snappy cell size — measurement and pre-mesh checks."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Literal

from cfddesk.cad.step import LoadedSolid, shape_diagonal

if TYPE_CHECKING:
    from cfddesk.project.model import Project

FaceRoleName = Literal["unassigned", "inlet", "outlet", "walls"]

DEFAULT_STL_FACET_TO_CELL_RATIO = 1.0 / 3.0


def finest_cell_m_for_level(project: Project, level: int) -> float:
    return float(project.mesh.base_cell_m) / (2 ** int(level))


def _deflection_from_cell(
    solid: LoadedSolid, project: Project, cell_m: float
) -> tuple[float, float, float]:
    ratio = float(
        getattr(project.mesh, "stl_facet_to_cell_ratio", DEFAULT_STL_FACET_TO_CELL_RATIO)
    )
    if ratio <= 0:
        ratio = DEFAULT_STL_FACET_TO_CELL_RATIO
    defl_m = cell_m * ratio
    scale = float(project.scale_to_metres)
    if scale <= 0:
        raise ValueError("scale_to_metres must be > 0")
    lin_native = max(defl_m / scale, 1e-6)
    diag_m = shape_diagonal(solid) * scale
    r_char = max(0.12 * diag_m, 8.0 * defl_m)
    half = min(0.999, defl_m / max(2.0 * r_char, 1e-12))
    ang = float(min(0.1, max(0.025, 2.0 * math.asin(half))))
    return lin_native, ang, defl_m


def stl_deflection_for_bc(
    solid: LoadedSolid,
    project: Project,
    bc,
) -> tuple[float, float, float]:
    """Return ``(linear_native, angular_rad, linear_deflection_m)`` for a BC.

    Uses ``MeshSettings.refinement`` role levels (same as snappy), not the
    possibly-stale per-BC ``refinement_level``.
    """
    level = _mesh_refinement_level_for_bc(project, bc)
    cell_m = finest_cell_m_for_level(project, level)
    return _deflection_from_cell(solid, project, cell_m)


def _mesh_refinement_level_for_bc(project: Project, bc) -> int:
    """Map a BC to MeshSettings.refinement inlet/outlet/walls."""
    levels = project.mesh.refinement
    semantic = None
    try:
        from cfddesk.case.bc_menu import registry_key_for_bc
        from cfddesk.case.bc_registry import get_type

        semantic = str(get_type(registry_key_for_bc(bc)).semantic).lower()
    except Exception:
        semantic = None
    pname = str(getattr(bc, "patch_name", "") or "").lower()
    if semantic == "inlet" or pname == "inlet":
        return int(levels.inlet)
    if semantic == "outlet" or pname == "outlet":
        return int(levels.outlet)
    if semantic == "wall" or pname in ("walls", "wall"):
        return int(levels.walls)
    return int(getattr(bc, "refinement_level", 1))
