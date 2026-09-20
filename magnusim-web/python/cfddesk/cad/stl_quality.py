"""STL chordal deflection vs snappy cell size — measurement and pre-mesh checks."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

import numpy as np
from OCP.BRep import BRep_Builder
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.gp import gp_Pnt
from OCP.TopoDS import TopoDS_Compound

from cfddesk.cad.step import LoadedSolid, shape_diagonal, tessellate_faces

if TYPE_CHECKING:
    from cfddesk.project.model import Project

FaceRoleName = Literal["unassigned", "inlet", "outlet", "walls"]

DEFAULT_STL_FACET_TO_CELL_RATIO = 1.0 / 3.0


@dataclass(frozen=True)
class RoleStlMetrics:
    role: FaceRoleName
    n_triangles: int
    # Diagnostics only (not the PASS/WARN gate):
    max_edge_m: float
    mean_edge_m: float
    # Gate inputs — chordal deflection requested of BRepMesh_IncrementalMesh:
    linear_deflection_m: float
    linear_deflection_native: float
    angular_deflection: float
    finest_cell_m: float
    refinement_level: int
    stl_facet_to_cell_ratio: float
    # deflection_m / finest_cell_m — PASS when ≤ 1 (and typically = configured ratio)
    ratio_deflection: float


@dataclass(frozen=True)
class StlMeshCheck:
    roles: list[RoleStlMetrics]
    ok: bool
    warn: bool
    message: str


@dataclass(frozen=True)
class ChordalSampleReport:
    role: FaceRoleName
    n_samples: int
    max_distance_m: float
    mean_distance_m: float
    linear_deflection_m: float
    within_deflection: bool
    note: str


def finest_cell_m(project: Project, role: FaceRoleName) -> tuple[float, int]:
    """``base_cell / 2^level`` for a CFD role (legacy MeshRefinement keys)."""
    ref = project.mesh.refinement
    level = int(getattr(ref, role, 0))
    cell = float(project.mesh.base_cell_m) / (2**level)
    return cell, level


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


def stl_deflection_for_role(
    solid: LoadedSolid,
    project: Project,
    role: FaceRoleName,
) -> tuple[float, float, float]:
    """Return ``(linear_native, angular_rad, linear_deflection_m)``.

    Linear deflection (metres) = ``finest_cell * stl_facet_to_cell_ratio``.
    That is the chordal budget BRepMesh_IncrementalMesh is asked to honour.
    Angular deflection is chosen so sagitta on a characteristic radius stays
    within the same budget.
    """
    cell_m, _level = finest_cell_m(project, role)
    return _deflection_from_cell(solid, project, cell_m)


def _triangle_edge_lengths_m(points_m: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    if len(triangles) == 0:
        return np.zeros(0, dtype=float)
    p0 = points_m[triangles[:, 0]]
    p1 = points_m[triangles[:, 1]]
    p2 = points_m[triangles[:, 2]]
    e01 = np.linalg.norm(p1 - p0, axis=1)
    e12 = np.linalg.norm(p2 - p1, axis=1)
    e20 = np.linalg.norm(p0 - p2, axis=1)
    return np.concatenate([e01, e12, e20])


def measure_role_tessellation(
    solid: LoadedSolid,
    project: Project,
    role: FaceRoleName,
    *,
    linear_deflection_native: float | None = None,
    angular_deflection: float | None = None,
) -> RoleStlMetrics:
    """Tessellate (as export would); report deflection gate + edge diagnostics."""
    cell_m, level = finest_cell_m(project, role)
    ratio = float(
        getattr(project.mesh, "stl_facet_to_cell_ratio", DEFAULT_STL_FACET_TO_CELL_RATIO)
    )
    scale = float(project.scale_to_metres)
    if linear_deflection_native is None or angular_deflection is None:
        lin, ang, defl_m = stl_deflection_for_role(solid, project, role)
    else:
        lin = float(linear_deflection_native)
        ang = float(angular_deflection)
        defl_m = lin * scale

    points, faces, face_ids = tessellate_faces(
        solid, linear_deflection=lin, angular_deflection=ang
    )
    points_m = np.asarray(points, dtype=float) * scale
    role_ids = {f.face_id for f in project.faces if f.role == role}
    mask = np.isin(face_ids, list(role_ids))
    tri = faces[mask]
    edges = _triangle_edge_lengths_m(points_m, tri)
    max_e = float(edges.max()) if edges.size else 0.0
    mean_e = float(edges.mean()) if edges.size else 0.0
    return RoleStlMetrics(
        role=role,
        n_triangles=int(len(tri)),
        max_edge_m=max_e,
        mean_edge_m=mean_e,
        linear_deflection_m=defl_m,
        linear_deflection_native=lin,
        angular_deflection=ang,
        finest_cell_m=cell_m,
        refinement_level=level,
        stl_facet_to_cell_ratio=ratio,
        ratio_deflection=defl_m / cell_m if cell_m > 0 else float("inf"),
    )


def measure_legacy_coarse_role(
    solid: LoadedSolid,
    project: Project,
    role: FaceRoleName,
) -> RoleStlMetrics:
    """Historical fixed deflection (1.0 native / 0.5 rad) for before/after reports."""
    return measure_role_tessellation(
        solid,
        project,
        role,
        linear_deflection_native=1.0,
        angular_deflection=0.5,
    )


def check_stl_vs_cells(
    solid: LoadedSolid,
    project: Project,
    *,
    roles: tuple[FaceRoleName, ...] = ("inlet", "outlet", "walls"),
    # Warn when requested chordal deflection exceeds the finest snap cell.
    warn_ratio: float = 1.0,
) -> StlMeshCheck:
    """Pre-mesh check: BRepMesh linear deflection vs finest cell per role.

    Gate metric is ``linear_deflection_m / finest_cell_m`` (equals the configured
    ``stl_facet_to_cell_ratio`` for mesh-tied export). Triangle counts and mean
    edge length are reported as diagnostics only.
    """
    metrics: list[RoleStlMetrics] = []
    for role in roles:
        if not any(f.role == role for f in project.faces):
            continue
        metrics.append(measure_role_tessellation(solid, project, role))

    if not metrics:
        return StlMeshCheck(
            roles=[],
            ok=False,
            warn=True,
            message="STL check: no inlet/outlet/walls roles to measure",
        )

    bad = [m for m in metrics if m.ratio_deflection > warn_ratio]
    lines = []
    for m in metrics:
        lines.append(
            f"{m.role}: defl={m.linear_deflection_m:.4g} m "
            f"cell={m.finest_cell_m:.4g} m (L{m.refinement_level}) "
            f"defl/cell={m.ratio_deflection:.3f} "
            f"tris={m.n_triangles} mean_edge={m.mean_edge_m:.4g} m"
        )
    if bad:
        msg = (
            "WARN STL chordal deflection coarser than snap cells — "
            "mesh will inherit faceting: " + "; ".join(lines)
        )
        return StlMeshCheck(roles=metrics, ok=True, warn=True, message=msg)

    msg = "PASS STL deflection vs cells: " + "; ".join(lines)
    return StlMeshCheck(roles=metrics, ok=True, warn=False, message=msg)


def verify_stl_chordal_deviation(
    solid: LoadedSolid,
    project: Project,
    role: FaceRoleName = "walls",
    *,
    n_samples: int = 400,
    rng_seed: int = 0,
) -> ChordalSampleReport:
    """Sample exported-role triangle centroids; distance to OCCT solid.

    Confirms BRepMesh linear deflection bounds actual chordal error. Once
    validated, production code trusts the deflection parameter.
    """
    m = measure_role_tessellation(solid, project, role)
    lin, ang, defl_m = (
        m.linear_deflection_native,
        m.angular_deflection,
        m.linear_deflection_m,
    )
    points, faces, face_ids = tessellate_faces(
        solid, linear_deflection=lin, angular_deflection=ang
    )
    role_ids = {f.face_id for f in project.faces if f.role == role}
    mask = np.isin(face_ids, list(role_ids))
    tri = faces[mask]
    if len(tri) == 0:
        return ChordalSampleReport(
            role=role,
            n_samples=0,
            max_distance_m=0.0,
            mean_distance_m=0.0,
            linear_deflection_m=defl_m,
            within_deflection=False,
            note="no triangles for role",
        )

    # Distance to the role face compound (not the solid volume — interior
    # points would report zero distance to a solid).
    face_ids_role = {f.face_id for f in project.faces if f.role == role}
    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    for rec in solid.faces:
        if rec.face_id in face_ids_role:
            builder.Add(compound, rec.face)

    centroids = (points[tri[:, 0]] + points[tri[:, 1]] + points[tri[:, 2]]) / 3.0
    rng = np.random.default_rng(rng_seed)
    n = min(int(n_samples), len(centroids))
    idx = rng.choice(len(centroids), size=n, replace=False)
    sample = centroids[idx]

    dists_native: list[float] = []
    for xyz in sample:
        vtx = BRepBuilderAPI_MakeVertex(
            gp_Pnt(float(xyz[0]), float(xyz[1]), float(xyz[2]))
        ).Vertex()
        dist = BRepExtrema_DistShapeShape(vtx, compound)
        dist.Perform()
        if dist.IsDone():
            dists_native.append(float(dist.Value()))

    scale = float(project.scale_to_metres)
    dists_m = np.asarray(dists_native, dtype=float) * scale
    max_d = float(dists_m.max()) if dists_m.size else 0.0
    mean_d = float(dists_m.mean()) if dists_m.size else 0.0
    # Allow tiny tolerance for numerical noise on the distance query.
    ok = max_d <= defl_m * 1.05 + 1e-9
    return ChordalSampleReport(
        role=role,
        n_samples=int(dists_m.size),
        max_distance_m=max_d,
        mean_distance_m=mean_d,
        linear_deflection_m=defl_m,
        within_deflection=ok,
        note=(
            "max STL→OCCT distance vs requested linear deflection "
            f"({'OK' if ok else 'EXCEEDS'} within 5% tol)"
        ),
    )
