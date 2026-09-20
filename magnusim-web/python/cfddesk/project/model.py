"""project.json model — nested hierarchy (Geometry / Simulation / Mesh / Run).

Canonical state lives in ``Project.geometries`` and ``Project.simulations``.
The flat v5 accessors (``step_path``, ``faces``, ``mesh``, ``boundary``,
``boundary_conditions``, ``solver``, ``mesh_fingerprint_at_last_mesh``) survive
as read-only properties onto the primary geometry / simulation so existing
callers keep working; every mutator rewrites the nested nodes.

v7: object-scoped ``field_units``, pressures stored in Pa, Geometry.volumes from
OCCT TopAbs_SOLID, Run snapshot density backfill for pre-v7 results.
v8: nested BC type/variant/subvariant (+ Periodic pairing); fingerprint uses
emitted patches; mesh fingerprint re-stamped on migrate only when the stored
hash still matches a pre-v8 formula (honest stale otherwise).
v9: ``location_in_mesh`` quantized to 1 nm before hashing (float noise / OCCT
micro-drift must not flip staleness); re-stamp when stored matches the
pre-quantize formula.
v10: fingerprint includes ``block_aabb=brep_geom`` (geometry AABB for
blockMesh). No re-stamp — meshes built under the triangulation-inflated
block must go stale rather than be laundered.
v11: ``BoundaryCondition.name_is_custom`` — type changes regenerate the
default display name / patch unless the user has edited Name.
v12: seed ``numerics`` / ``initial_conditions`` / ``simulation_control`` from
existing SolverSettings. Does **not** touch mesh fingerprints (staleness
must be unchanged across migrate).
v13: Phase 5 mesh schema (fineness, active_mesh_id, run.mesh_id, results_subdir).
v14: Geometry.bodies (role/region) replaces volumes; materials body_ids;
v15: web sibling JSON become derived mirrors; ingest if newer than project.
optional BC region. Mesh fingerprint unchanged for single-fluid projects.
"""

from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
import os
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from cfddesk.cad.step import FaceRecord, LoadedSolid
from cfddesk.case.bc_menu import registry_key_for_bc
from cfddesk.case.bc_registry import (
    BC_TYPES,
    default_settings,
    get_type,
    sanitize_patch_name,
)
from cfddesk.materials.library import RHO_AIR
from cfddesk.project.hierarchy import (
    Body,
    Geometry,
    MeshNode,
    RunNode,
    Simulation,
    _new_id,
    default_run_results_subdir,
    next_run_name,
)
from cfddesk.project.mesh_refinements import (
    BB_LAYER_TYPE,
    EXTRUSION_TYPE,
    FEATURE_REFINEMENT_TYPE,
    INFLATE_TYPE,
    REGION_REFINEMENT_TYPE,
    SURFACE_CUSTOM_SIZING_TYPE,
    SURFACE_REFINEMENT_TYPE,
    VOLUME_CUSTOM_SIZING_TYPE,
    MeshRefinementStub,
    bb_layer_fingerprint_payload,
    extrusion_fingerprint_payload,
    feature_refinement_fingerprint_payload,
    inflate_fingerprint_payload,
    label_for_type,
    next_refinement_display_name,
    region_refinement_fingerprint_payload,
    surface_custom_sizing_fingerprint_payload,
    surface_refinement_fingerprint_payload,
    volume_custom_sizing_fingerprint_payload,
)
from cfddesk.project.settings import (
    BoundarySettings,
    MeshSettings,
    PathsSettings,
    SolverSettings,
    quantize_location_m,
)
from cfddesk.registry.analysis import (
    DEFAULT_STEADY_KEY,
    resolve_analysis_key,
)
from cfddesk.results.color_scale import ColorScale
from cfddesk.results.filters import (
    FilterSpec,
    RecordSettings,
    ResultsDisplay,
    SavedView,
    ScreenshotSettings,
    default_filter_stack,
    filters_from_list,
    filters_to_list,
    records_from_list,
    records_to_list,
    screenshots_from_list,
    screenshots_to_list,
    views_from_list,
    views_to_list,
)
from cfddesk.results.window_geom import ResultsWindowGeom
from cfddesk.units.pressure import kinematic_to_pa

FaceRole = Literal["unassigned", "inlet", "outlet", "walls"]
ROLES: tuple[FaceRole, ...] = ("unassigned", "inlet", "outlet", "walls")

PROJECT_VERSION = 15

PRIMARY_SIM_NAME = "Incompressible"
# Registered AnalysisType key (land11). Legacy free-string "incompressible"
# remaps via resolve_analysis_key in _simulation_from_dict.
PRIMARY_SIM_ANALYSIS = DEFAULT_STEADY_KEY

# Fingerprint token for blockMesh sizing via ``shape_bbox`` /
# ``BRepBndLib.Add(useTriangulation=False)``. Changing this is a mesher break.
BLOCK_AABB_FINGERPRINT = "brep_geom"

# BC / IC settings keys stored as Pa (converted to kinematic only at case write).
_PRESSURE_SETTING_KEYS = (
    "gauge_pressure",
    "pressure",
)

# Absolute tolerances in model native length units (as delivered by OCCT).
DEFAULT_CENTROID_TOL = 1e-3
DEFAULT_AREA_TOL_ABS = 1e-2
DEFAULT_AREA_TOL_REL = 1e-6

_ROLE_TO_BC_TYPE: dict[FaceRole, str] = {
    "inlet": "velocity_inlet_fixed",
    "outlet": "pressure_outlet_gauge",
    "walls": "wall_noslip",
}
_ROLE_TO_DISPLAY: dict[FaceRole, str] = {
    "inlet": "Velocity inlet 1",
    "outlet": "Pressure outlet 1",
    "walls": "Wall no-slip 1",
}


@dataclass
class BoundaryCondition:
    id: str
    name: str
    patch_name: str
    type: str  # menu type key (v8); may still be flat registry key until migrate
    settings: dict[str, Any] = field(default_factory=dict)
    face_ids: list[int] = field(default_factory=list)
    refinement_level: int = 1
    variant: str = "default"
    subvariant: str | None = None
    paired_bc_id: str | None = None
    # True once the user edits Name; type changes then leave ``name`` alone.
    name_is_custom: bool = False
    # Optional region scope (None = all / fluid default).
    region: str | None = None

    def to_dict(self) -> dict:
        out: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "patch_name": self.patch_name,
            "type": self.type,
            "variant": self.variant,
            "settings": copy.deepcopy(self.settings),
            "face_ids": list(self.face_ids),
            "refinement_level": int(self.refinement_level),
            "name_is_custom": bool(self.name_is_custom),
        }
        if self.subvariant:
            out["subvariant"] = self.subvariant
        if self.paired_bc_id:
            out["paired_bc_id"] = self.paired_bc_id
        if self.region is not None:
            out["region"] = self.region
        return out

    @staticmethod
    def from_dict(data: dict) -> BoundaryCondition:
        from cfddesk.case.bc_menu import migrate_bc_dict

        migrated = migrate_bc_dict(dict(data))
        settings = migrated.get("settings") or {}
        if not isinstance(settings, dict):
            settings = {}
        paired = migrated.get("paired_bc_id")
        if paired is None and isinstance(settings, dict):
            paired = settings.get("paired_bc_id")
        sub = migrated.get("subvariant")
        region_raw = migrated.get("region")
        return BoundaryCondition(
            id=str(migrated["id"]),
            name=str(migrated["name"]),
            patch_name=str(migrated["patch_name"]),
            type=str(migrated["type"]),
            settings=copy.deepcopy(settings),
            face_ids=[int(x) for x in (migrated.get("face_ids") or [])],
            refinement_level=int(migrated.get("refinement_level", 1)),
            variant=str(migrated.get("variant") or "default"),
            subvariant=str(sub) if sub else None,
            paired_bc_id=str(paired) if paired else None,
            name_is_custom=bool(migrated.get("name_is_custom", False)),
            region=str(region_raw) if region_raw not in (None, "") else None,
        )


@dataclass(frozen=True)
class FaceFingerprint:
    face_id: int
    role: FaceRole
    centroid: tuple[float, float, float]
    area: float
    bc_id: str | None = None


@dataclass
class FingerprintMismatch:
    """Stored roles are not safe to apply — enumeration or geometry drifted."""

    reason: str
    details: list[str] = field(default_factory=list)


def _new_bc_id() -> str:
    return uuid.uuid4().hex[:12]


def _semantic_to_role(semantic: str) -> FaceRole:
    if semantic == "inlet":
        return "inlet"
    if semantic in ("outlet", "open"):
        return "outlet"
    if semantic == "wall":
        return "walls"
    return "unassigned"


def _role_semantic(role: FaceRole) -> str | None:
    if role == "inlet":
        return "inlet"
    if role == "outlet":
        return "outlet"
    if role == "walls":
        return "wall"
    return None


def _faces_from_list(items: list[dict]) -> list[FaceFingerprint]:
    """Parse face entries. ``role`` is only read from legacy (<v6) payloads."""
    return [
        FaceFingerprint(
            face_id=int(item["id"]),
            role=_parse_role(item.get("role", "unassigned")),
            centroid=(
                float(item["centroid"][0]),
                float(item["centroid"][1]),
                float(item["centroid"][2]),
            ),
            area=float(item["area"]),
            bc_id=(
                None if item.get("bc_id") in (None, "") else str(item.get("bc_id"))
            ),
        )
        for item in items
    ]


def _bodies_from_dict(items: list | None) -> list[Body]:
    out: list[Body] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        body = Body.from_dict(item)
        if not body.id:
            continue
        out.append(body)
    return out


def _geometry_from_dict(data: dict) -> Geometry:
    # Prefer bodies (v14+); fall back to legacy volumes dicts.
    raw_bodies = data.get("bodies")
    if raw_bodies is None:
        raw_bodies = data.get("volumes")
    return Geometry(
        id=str(data.get("id") or _new_id()),
        name=str(data.get("name") or "Geometry 1"),
        step_path=str(data.get("step_path") or ""),
        faces=_faces_from_list(data.get("faces") or []),
        bodies=_bodies_from_dict(raw_bodies),
    )


def _bodies_from_solid(solid: LoadedSolid) -> list[Body]:
    return [
        Body(
            id=v.volume_id,
            name=v.name,
            face_ids=tuple(v.face_ids),
            role="fluid",
            region="fluid",
        )
        for v in solid.volumes
    ]


def _material_body_ids(material: dict[str, Any]) -> list[str]:
    """Prefer body_ids; fall back to legacy volume_ids alias."""
    raw = material.get("body_ids")
    if raw is None:
        raw = material.get("volume_ids")
    return [str(x) for x in (raw or [])]


def _set_material_body_ids(material: dict[str, Any], body_ids: list[str]) -> None:
    """Write body_ids and keep volume_ids as a mirrored alias."""
    ids = [str(x) for x in body_ids]
    material["body_ids"] = ids
    material["volume_ids"] = list(ids)



def _normalize_materials_list(items: list | None) -> list[dict[str, Any]]:
    """Ensure each material has body_ids with volume_ids as mirrored alias."""
    out: list[dict[str, Any]] = []
    for m in items or []:
        if not isinstance(m, dict):
            continue
        m = copy.deepcopy(m)
        ids = _material_body_ids(m)
        _set_material_body_ids(m, ids)
        out.append(m)
    return out


def _simulation_from_dict(data: dict, *, geometry_id: str) -> Simulation:
    meshes = [MeshNode.from_dict(m) for m in (data.get("meshes") or [])]
    if not meshes:
        meshes = [MeshNode(id=_new_id(), name="Mesh 1", settings=MeshSettings())]
    active_mesh_id = str(data.get("active_mesh_id") or "")
    if not active_mesh_id or not any(m.id == active_mesh_id for m in meshes):
        active_mesh_id = meshes[0].id
    runs = [RunNode.from_dict(r) for r in (data.get("runs") or [])]
    active_run_id = str(data.get("active_run_id") or "")
    if active_run_id and not any(r.id == active_run_id for r in runs):
        active_run_id = ""
    solver = SolverSettings.from_dict(data.get("solver"))
    simulation_control = copy.deepcopy(data.get("simulation_control") or {})
    analysis_type = resolve_analysis_key(
        data.get("analysis_type"),
        solver_mode=solver.mode,
        simulation_control=simulation_control
        if isinstance(simulation_control, dict)
        else None,
    )
    return Simulation(
        id=str(data.get("id") or _new_id()),
        name=str(data.get("name") or PRIMARY_SIM_NAME),
        analysis_type=analysis_type,
        geometry_id=str(data.get("geometry_id") or geometry_id),
        boundary_conditions=[
            BoundaryCondition.from_dict(b)
            for b in (data.get("boundary_conditions") or [])
        ],
        meshes=meshes,
        runs=runs,
        solver=solver,
        boundary=BoundarySettings.from_dict(data.get("boundary")),
        materials=_normalize_materials_list(data.get("materials") or []),
        initial_conditions=copy.deepcopy(data.get("initial_conditions") or {}),
        advanced_concepts=copy.deepcopy(data.get("advanced_concepts") or {}),
        numerics=copy.deepcopy(data.get("numerics") or {}),
        simulation_control=simulation_control,
        result_control=copy.deepcopy(data.get("result_control") or {}),
        active_mesh_id=active_mesh_id,
        active_run_id=active_run_id,
    )


def _results_look_loadable(root: Path) -> bool:
    """Cheap check that ``root`` holds something the results viewer can open."""
    try:
        if (root / "constant" / "polyMesh").is_dir():
            return True
        if (root / "case.foam").exists():
            return True
        for child in root.iterdir():
            if not child.is_dir():
                continue
            try:
                float(child.name)
            except ValueError:
                continue
            return True
    except OSError:
        return False
    return False


@dataclass
class Project:
    version: int
    # Explicit scale: multiply native OCCT coordinates by this to get metres.
    # Applied at STL export so constant/triSurface is always metres.
    scale_to_metres: float
    native_unit: str
    # Geometric context unit from STEP header (may differ from cascade).
    declared_unit: str | None
    units_confirmed: bool
    units_ambiguous: bool
    units_notes: list[str] = field(default_factory=list)
    color_scale: ColorScale = field(default_factory=ColorScale)
    results_window: ResultsWindowGeom = field(default_factory=ResultsWindowGeom)
    results_display: ResultsDisplay = field(default_factory=ResultsDisplay)
    results_filters: list = field(default_factory=default_filter_stack)
    results_views: list = field(default_factory=list)
    results_screenshots: list = field(default_factory=list)
    results_records: list = field(default_factory=list)
    paths: PathsSettings = field(default_factory=PathsSettings)
    geometries: list[Geometry] = field(default_factory=list)
    simulations: list[Simulation] = field(default_factory=list)
    # Object-scoped display units, e.g. "bc:<id>.gauge_pressure" → "psi"
    field_units: dict[str, str] = field(default_factory=dict)
    # Soft-pass land8 / v15: sibling mirror bookkeeping
    updated_at: str | None = None
    persistence: dict[str, Any] = field(default_factory=dict)

    # ---- primary node access -------------------------------------------------

    def primary_geometry(self) -> Geometry | None:
        return self.geometries[0] if self.geometries else None

    def primary_simulation(self) -> Simulation | None:
        return self.simulations[0] if self.simulations else None

    # ---- flat v5 read shims --------------------------------------------------

    @property
    def step_path(self) -> str:
        geom = self.primary_geometry()
        return geom.step_path if geom is not None else ""

    @property
    def faces(self) -> list[FaceFingerprint]:
        geom = self.primary_geometry()
        return geom.faces if geom is not None else []

    @property
    def mesh(self) -> MeshSettings:
        """Active mesh settings (compat alias — not always meshes[0])."""
        sim = self.primary_simulation()
        return sim.active_mesh().settings if sim is not None else MeshSettings()

    @property
    def boundary(self) -> BoundarySettings:
        sim = self.primary_simulation()
        return sim.boundary if sim is not None else BoundarySettings()

    @property
    def boundary_conditions(self) -> list[BoundaryCondition]:
        sim = self.primary_simulation()
        return sim.boundary_conditions if sim is not None else []

    @property
    def solver(self) -> SolverSettings:
        sim = self.primary_simulation()
        return sim.solver if sim is not None else SolverSettings()

    @property
    def mesh_fingerprint_at_last_mesh(self) -> str | None:
        sim = self.primary_simulation()
        return sim.active_mesh().last_mesh_fingerprint if sim is not None else None

    # ---- nested update helpers ----------------------------------------------

    def _ensure_geometry(self) -> Geometry:
        geom = self.primary_geometry()
        if geom is not None:
            return geom
        return Geometry(id=_new_id(), name="Geometry 1", step_path="", faces=[])

    def _replace_primary_sim(self, **changes: Any) -> Project:
        sims = list(self.simulations)
        if not sims:
            geoms = list(self.geometries)
            if not geoms:
                geoms = [self._ensure_geometry()]
            sims = [_default_simulation(geoms[0].id)]
            return dataclasses.replace(
                self,
                geometries=geoms,
                simulations=[dataclasses.replace(sims[0], **changes)],
            )
        sims[0] = dataclasses.replace(sims[0], **changes)
        return dataclasses.replace(self, simulations=sims)

    def _replace_active_mesh_node(self, **changes: Any) -> Project:
        sim = self.primary_simulation()
        meshes = list(sim.meshes) if sim is not None else []
        if not meshes:
            mid = _new_id()
            meshes = [MeshNode(id=mid, name="Mesh 1", settings=MeshSettings())]
            active_id = mid
        else:
            active_id = (sim.active_mesh_id if sim is not None else "") or meshes[0].id
        replaced = False
        for i, m in enumerate(meshes):
            if m.id == active_id:
                meshes[i] = dataclasses.replace(m, **changes)
                replaced = True
                break
        if not replaced:
            meshes[0] = dataclasses.replace(meshes[0], **changes)
            active_id = meshes[0].id
        return self._replace_primary_sim(meshes=meshes, active_mesh_id=active_id)

    def _replace_primary_mesh_node(self, **changes: Any) -> Project:
        """Deprecated name — routes to the active mesh."""
        return self._replace_active_mesh_node(**changes)

    # ---- BC queries ----------------------------------------------------------

    def bc_for_face(self, face_id: int) -> BoundaryCondition | None:
        for bc in self.boundary_conditions:
            if face_id in bc.face_ids:
                return bc
        return None

    def bc_by_id(self, bc_id: str) -> BoundaryCondition | None:
        for bc in self.boundary_conditions:
            if bc.id == bc_id:
                return bc
        return None

    def role_of(self, face_id: int) -> FaceRole:
        bc = self.bc_for_face(face_id)
        if bc is None:
            return "unassigned"
        try:
            return _semantic_to_role(get_type(registry_key_for_bc(bc)).semantic)
        except KeyError:
            return "unassigned"

    def unassigned_face_ids(self) -> list[int]:
        assigned = {fid for bc in self.boundary_conditions for fid in bc.face_ids}
        return sorted(f.face_id for f in self.faces if f.face_id not in assigned)

    def _sync_faces_from_bcs(self) -> Project:
        """Recompute FaceFingerprint.role / bc_id from boundary_conditions."""
        face_bc: dict[int, BoundaryCondition] = {}
        for bc in self.boundary_conditions:
            for fid in bc.face_ids:
                face_bc[fid] = bc
        geometries = [
            dataclasses.replace(
                g,
                faces=[
                    FaceFingerprint(
                        face_id=f.face_id,
                        role=(
                            _semantic_to_role(
                                get_type(
                                    registry_key_for_bc(face_bc[f.face_id])
                                ).semantic
                            )
                            if f.face_id in face_bc
                            else "unassigned"
                        ),
                        centroid=f.centroid,
                        area=f.area,
                        bc_id=face_bc[f.face_id].id if f.face_id in face_bc else None,
                    )
                    for f in g.faces
                ],
            )
            for g in self.geometries
        ]
        return dataclasses.replace(self, geometries=geometries)

    def _replace_bcs(self, bcs: list[BoundaryCondition]) -> Project:
        proj = self._replace_primary_sim(boundary_conditions=list(bcs))
        proj = dataclasses.replace(proj, version=PROJECT_VERSION)
        return proj._sync_faces_from_bcs()

    def assign_faces(self, bc_id: str, face_ids: list[int]) -> Project:
        wanted = {int(f) for f in face_ids}
        if not wanted:
            return self
        bcs: list[BoundaryCondition] = []
        found = False
        for bc in self.boundary_conditions:
            remaining = [f for f in bc.face_ids if f not in wanted]
            if bc.id == bc_id:
                found = True
                merged = sorted(set(remaining) | wanted)
                bcs.append(dataclasses.replace(bc, face_ids=merged))
            else:
                bcs.append(dataclasses.replace(bc, face_ids=remaining))
        if not found:
            raise KeyError(f"Unknown BC id {bc_id!r}")
        return self._replace_bcs(bcs)

    def unassign_faces(self, face_ids: list[int]) -> Project:
        wanted = {int(f) for f in face_ids}
        if not wanted:
            return self
        bcs = [
            dataclasses.replace(
                bc, face_ids=[f for f in bc.face_ids if f not in wanted]
            )
            for bc in self.boundary_conditions
        ]
        return self._replace_bcs(bcs)

    def materials_assigned(self) -> bool:
        """GREEN Materials rule: at least one material has non-empty body_ids."""
        sim = self.primary_simulation()
        if sim is None:
            return False
        return any(bool(_material_body_ids(m)) for m in sim.materials)

    def assigned_material(self) -> dict[str, Any] | None:
        """First material with a body assignment (case-write source of ν/ρ)."""
        sim = self.primary_simulation()
        if sim is None:
            return None
        for m in sim.materials:
            if _material_body_ids(m):
                return m
        return None

    def assign_volumes(self, material_id: str, volume_ids: list[str]) -> Project:
        """Legacy alias for assign_bodies (volume_ids == body_ids)."""
        return self.assign_bodies(material_id, volume_ids)

    def assign_bodies(self, material_id: str, body_ids: list[str]) -> Project:
        wanted = {str(v) for v in body_ids}
        if not wanted:
            return self
        sim = self.primary_simulation()
        if sim is None:
            raise KeyError("No simulation")
        materials: list[dict[str, Any]] = []
        found = False
        for m in sim.materials:
            m = copy.deepcopy(m)
            remaining = [v for v in _material_body_ids(m) if v not in wanted]
            if str(m.get("id")) == material_id:
                found = True
                merged = sorted(set(remaining) | wanted)
                _set_material_body_ids(m, merged)
            else:
                _set_material_body_ids(m, remaining)
            materials.append(m)
        if not found:
            raise KeyError(f"Unknown material id {material_id!r}")
        return self._replace_primary_sim(materials=materials)

    def unassign_volumes(self, volume_ids: list[str]) -> Project:
        """Legacy alias for unassign_bodies."""
        return self.unassign_bodies(volume_ids)

    def unassign_bodies(self, body_ids: list[str]) -> Project:
        wanted = {str(v) for v in body_ids}
        if not wanted:
            return self
        sim = self.primary_simulation()
        if sim is None:
            return self
        materials = []
        for m in sim.materials:
            m = copy.deepcopy(m)
            _set_material_body_ids(
                m, [v for v in _material_body_ids(m) if v not in wanted]
            )
            materials.append(m)
        return self._replace_primary_sim(materials=materials)

    def upsert_material(self, material: dict[str, Any]) -> Project:
        """Insert or replace a material dict by id."""
        sim = self.primary_simulation()
        if sim is None:
            raise KeyError("No simulation")
        mid = str(material.get("id") or "")
        if not mid:
            raise ValueError("material requires id")
        materials = copy.deepcopy(sim.materials)
        for i, m in enumerate(materials):
            if str(m.get("id")) == mid:
                materials[i] = copy.deepcopy(material)
                break
        else:
            materials.append(copy.deepcopy(material))
        return self._replace_primary_sim(materials=materials)

    def material_by_id(self, material_id: str) -> dict[str, Any] | None:
        sim = self.primary_simulation()
        if sim is None:
            return None
        for m in sim.materials:
            if str(m.get("id")) == material_id:
                return m
        return None

    def set_field_unit(self, key: str, unit: str) -> Project:
        fu = dict(self.field_units)
        fu[key] = unit
        return dataclasses.replace(self, field_units=fu, version=PROJECT_VERSION)

    def field_unit(self, key: str, default: str) -> str:
        return self.field_units.get(key, default)

    def faces_for_volumes(self, volume_ids: list[str]) -> list[int]:
        """Resolve volume/body ids → face ids via Geometry.bodies (OCCT map)."""
        return self.faces_for_bodies(volume_ids)

    def faces_for_bodies(self, body_ids: list[str]) -> list[int]:
        """Resolve body ids → face ids via Geometry.bodies."""
        geom = self.primary_geometry()
        if geom is None:
            return []
        wanted = {str(v) for v in body_ids}
        fids: list[int] = []
        for body in geom.bodies:
            if body.id in wanted:
                for fid in body.face_ids:
                    if int(fid) not in fids:
                        fids.append(int(fid))
        return fids

    def next_bc_display_name(
        self, base_label: str, *, exclude_id: str | None = None
    ) -> str:
        """``Velocity inlet``, then ``Velocity inlet 2``, … among other BCs."""
        existing = {
            bc.name
            for bc in self.boundary_conditions
            if exclude_id is None or bc.id != exclude_id
        }
        if base_label not in existing:
            return base_label
        n = 2
        while f"{base_label} {n}" in existing:
            n += 1
        return f"{base_label} {n}"

    def allocate_patch_name(
        self, display_name: str, *, exclude_id: str | None = None
    ) -> str:
        """Slugify ``display_name``; append ``_2``, ``_3``, … on collision."""
        existing = {
            bc.patch_name
            for bc in self.boundary_conditions
            if exclude_id is None or bc.id != exclude_id
        }
        return sanitize_patch_name(display_name, existing)

    def add_bc(
        self,
        *,
        name: str,
        bc_type: str,
        settings: dict[str, Any] | None = None,
        face_ids: list[int] | None = None,
        refinement_level: int = 1,
        patch_name: str | None = None,
        bc_id: str | None = None,
        name_is_custom: bool = False,
    ) -> tuple[Project, BoundaryCondition]:
        if patch_name is None:
            patch = self.allocate_patch_name(name, exclude_id=bc_id)
        else:
            existing = {
                bc.patch_name
                for bc in self.boundary_conditions
                if bc.id != (bc_id or "")
            }
            patch = patch_name
            if patch in existing:
                raise ValueError(f"patch_name {patch!r} already in use")
        from cfddesk.case.bc_menu import nested_from_legacy

        # Accept flat registry keys (gates / role helpers) or already-nested menu keys.
        if bc_type in BC_TYPES:
            reg_key = bc_type
            menu_type, variant, subvariant = nested_from_legacy(bc_type)
        else:
            menu_type, variant, subvariant = bc_type, "default", None
            from cfddesk.case.bc_menu import legacy_from_nested

            reg_key = legacy_from_nested(menu_type, variant, subvariant)
        spec = get_type(reg_key)
        merged = default_settings(reg_key)
        if settings:
            merged.update(settings)
        bc = BoundaryCondition(
            id=bc_id or _new_bc_id(),
            name=name,
            patch_name=patch,
            type=menu_type,
            variant=variant,
            subvariant=subvariant,
            settings=merged,
            face_ids=sorted({int(f) for f in (face_ids or [])}),
            refinement_level=int(refinement_level),
            paired_bc_id=(
                str(merged.get("paired_bc_id")) if merged.get("paired_bc_id") else None
            ),
            name_is_custom=bool(name_is_custom),
        )
        _ = spec
        proj = self._replace_bcs([*self.boundary_conditions, bc])
        if bc.face_ids:
            proj = proj.assign_faces(bc.id, bc.face_ids)
            # re-fetch bc after assign (face lists may have been moved)
            refreshed = proj.bc_by_id(bc.id)
            assert refreshed is not None
            return proj, refreshed
        return proj, bc

    def rename_bc(self, bc_id: str, name: str, *, sync_patch: bool = True) -> Project:
        """Rename display label; marks ``name_is_custom``.

        When ``sync_patch`` is True (default), ``patch_name`` is re-slugified from
        the new display name (unique among siblings). That changes the mesh
        fingerprint — expected after a rename of an already-meshed project.
        """
        if not any(bc.id == bc_id for bc in self.boundary_conditions):
            raise KeyError(f"Unknown BC id {bc_id!r}")
        bcs = []
        for bc in self.boundary_conditions:
            if bc.id != bc_id:
                bcs.append(bc)
                continue
            patch = (
                self.allocate_patch_name(name, exclude_id=bc_id)
                if sync_patch
                else bc.patch_name
            )
            bcs.append(
                dataclasses.replace(
                    bc, name=name, patch_name=patch, name_is_custom=True
                )
            )
        return self._replace_primary_sim(boundary_conditions=bcs)

    def rename_patch(self, bc_id: str, patch_name: str) -> Project:
        """Explicit OpenFOAM patch rename — changes mesh_input_fingerprint."""
        existing = {
            bc.patch_name for bc in self.boundary_conditions if bc.id != bc_id
        }
        if patch_name in existing:
            raise ValueError(f"patch_name {patch_name!r} already in use")
        bcs = []
        found = False
        for bc in self.boundary_conditions:
            if bc.id == bc_id:
                found = True
                bcs.append(dataclasses.replace(bc, patch_name=patch_name))
            else:
                bcs.append(bc)
        if not found:
            raise KeyError(f"Unknown BC id {bc_id!r}")
        return self._replace_primary_sim(boundary_conditions=bcs)

    def delete_bc(self, bc_id: str) -> Project:
        if not any(bc.id == bc_id for bc in self.boundary_conditions):
            raise KeyError(f"Unknown BC id {bc_id!r}")
        bcs = [bc for bc in self.boundary_conditions if bc.id != bc_id]
        return self._replace_bcs(bcs)

    def with_role(self, face_id: int, role: FaceRole) -> Project:
        """Assign face to a matching semantic BC (create if needed)."""
        if role == "unassigned":
            return self.unassign_faces([face_id])
        semantic = _role_semantic(role)
        assert semantic is not None
        matching = [
            bc
            for bc in self.boundary_conditions
            if get_type(registry_key_for_bc(bc)).semantic == semantic
        ]
        if matching:
            return self.assign_faces(matching[0].id, [face_id])
        # Create classic-named BC so gate_a2 / migrated meshes keep inlet|outlet|walls.
        bc_type = _ROLE_TO_BC_TYPE[role]
        display = _ROLE_TO_DISPLAY[role]
        existing_patches = {bc.patch_name for bc in self.boundary_conditions}
        # Prefer stable role patch names when free; else sanitize.
        preferred = role if role in ("inlet", "outlet", "walls") else None
        if preferred is not None and preferred not in existing_patches:
            patch: str = preferred
        else:
            patch = sanitize_patch_name(display, existing_patches)
        level = 1
        if role == "inlet":
            level = self.mesh.refinement.inlet
        elif role == "outlet":
            level = self.mesh.refinement.outlet
        elif role == "walls":
            level = self.mesh.refinement.walls
        settings = default_settings(bc_type)
        if role == "inlet":
            settings["speed_m_s"] = self.boundary.inlet_speed_m_s
            settings["direction_mode"] = self.boundary.inlet_direction_mode
            settings["velocity"] = list(self.boundary.inlet_vector)
        elif role == "outlet":
            settings["gauge_pressure"] = self.boundary.outlet_p
        proj, bc = self.add_bc(
            name=display,
            bc_type=bc_type,
            settings=settings,
            face_ids=[face_id],
            refinement_level=level,
            patch_name=patch,
        )
        return proj

    # ---- mutators ------------------------------------------------------------

    def with_units(
        self,
        *,
        scale_to_metres: float,
        native_unit: str,
        declared_unit: str | None,
        units_confirmed: bool,
        units_ambiguous: bool,
        units_notes: list[str] | None = None,
    ) -> Project:
        return dataclasses.replace(
            self,
            scale_to_metres=scale_to_metres,
            native_unit=native_unit,
            declared_unit=declared_unit,
            units_confirmed=units_confirmed,
            units_ambiguous=units_ambiguous,
            units_notes=list(units_notes if units_notes is not None else self.units_notes),
        )

    def with_color_scale(self, scale: ColorScale) -> Project:
        return dataclasses.replace(self, color_scale=scale)

    def with_results_window(self, geom: ResultsWindowGeom) -> Project:
        return dataclasses.replace(self, results_window=geom)

    def with_results_display(self, display: ResultsDisplay) -> Project:
        return dataclasses.replace(self, results_display=display)

    def with_results_filters(self, filters: list[FilterSpec]) -> Project:
        return dataclasses.replace(self, results_filters=list(filters))

    def with_results_views(self, views: list[SavedView]) -> Project:
        return dataclasses.replace(self, results_views=list(views))

    def with_results_screenshots(self, shots: list[ScreenshotSettings]) -> Project:
        return dataclasses.replace(self, results_screenshots=list(shots))

    def with_results_records(self, records: list[RecordSettings]) -> Project:
        return dataclasses.replace(self, results_records=list(records))

    def with_mesh(self, mesh: MeshSettings) -> Project:
        """Replace settings on the **active** mesh (compat alias)."""
        return self._replace_active_mesh_node(settings=mesh)

    def with_active_mesh_id(self, mesh_id: str) -> Project:
        """Select which mesh the panel / Generate / ``project.mesh`` address."""
        sim = self.primary_simulation()
        if sim is None:
            return self
        if not any(m.id == mesh_id for m in sim.meshes):
            raise ValueError(f"unknown mesh id {mesh_id!r}")
        return self._replace_primary_sim(active_mesh_id=str(mesh_id))

    def with_active_run_id(self, run_id: str) -> Project:
        """Select which run View Results / the viewport prefer."""
        sim = self.primary_simulation()
        if sim is None:
            return self
        if not any(r.id == run_id for r in sim.runs):
            raise ValueError(f"unknown run id {run_id!r}")
        return self._replace_primary_sim(active_run_id=str(run_id))

    def add_solve_run(self) -> Project:
        """Append a new named run bound to the active mesh, and make it active.

        Each run gets its own ``results/mesh-<id>/run-<id>`` tree so a later
        solve cannot overwrite a sibling turbulence model's copy-back.
        """
        sim = self.primary_simulation()
        if sim is None:
            return self
        mesh = sim.active_mesh()
        rid = _new_id()
        name = next_run_name(sim.runs, self.solver.turbulence)
        results_path = default_run_results_subdir(mesh.id, rid)
        snap = dict(self.solver.to_dict())
        mat = self.assigned_material()
        if mat is not None:
            snap["density_kg_m3"] = float(mat["rho"])
            snap["nu"] = float(mat["nu"])
            snap["material_id"] = str(mat.get("id", ""))
            snap["material_name"] = str(mat.get("name", ""))
        run = RunNode(
            id=rid,
            name=name,
            results_path=results_path,
            settings_snapshot=snap,
            mesh_id=mesh.id,
        )
        return self._replace_primary_sim(
            runs=list(sim.runs) + [run],
            active_run_id=rid,
        )


    def reconcile_runs_from_disk(self, project_dir: str | Path) -> Project:
        """Bind orphan ``results/mesh-*/run-*`` trees into the run list.

        Older / interrupted sessions can leave AmgX copy-back on disk without a
        matching RunNode or ``active_run_id``. View Results uses those fields,
        so reopen must heal the tree without inventing Simulation control UI.

        - Adds a RunNode for each ``run-<id>`` folder not already in ``runs``.
        - If ``active_run_id`` is empty, selects the run with the highest
          numeric time directory that contains field files (U/p/phi preferred).
        - Does not rename or delete existing legacy runs (``results_path``
          ``results`` stays as-is).
        """
        root = Path(project_dir)
        sim = self.primary_simulation()
        if sim is None:
            return self

        runs = list(sim.runs)
        known = {r.id for r in runs}
        added = False

        def _max_solution_time(run_dir: Path) -> float:
            best = -1.0
            if not run_dir.is_dir():
                return best
            for child in run_dir.iterdir():
                if not child.is_dir():
                    continue
                try:
                    t = float(child.name)
                except ValueError:
                    continue
                field_names = {"U", "p", "phi", "T", "k", "omega", "nut"}
                has_field = any((child / name).is_file() for name in field_names)
                if not has_field and t > 0:
                    has_field = any(p.is_file() for p in child.iterdir())
                if has_field and t > best:
                    best = t
            return best

        for mesh in sim.meshes:
            mesh_root = root / "results" / f"mesh-{mesh.id}"
            if not mesh_root.is_dir():
                continue
            for child in sorted(mesh_root.iterdir(), key=lambda p: p.name):
                if not child.is_dir() or not child.name.startswith("run-"):
                    continue
                rid = child.name[len("run-") :]
                if not rid or rid in known:
                    continue
                has_mesh = (child / "constant" / "polyMesh").is_dir()
                has_times = _max_solution_time(child) >= 0.0
                if not has_mesh and not has_times:
                    continue
                results_path = default_run_results_subdir(mesh.id, rid)
                turb = str(getattr(self.solver, "turbulence", "") or "")
                name = next_run_name(runs, turb or "Run")
                runs.append(
                    RunNode(
                        id=rid,
                        name=name,
                        results_path=results_path,
                        settings_snapshot={},
                        mesh_id=mesh.id,
                    )
                )
                known.add(rid)
                added = True

        active_id = str(sim.active_run_id or "")
        if active_id and any(r.id == active_id for r in runs):
            if added:
                return self._replace_primary_sim(runs=runs)
            return self

        active_mesh = sim.active_mesh()
        candidates: list[tuple[float, str]] = []
        for run in runs:
            run_dir = root / (run.results_path or "")
            score = _max_solution_time(run_dir)
            if score < 0:
                continue
            boost = 0.1 if run.mesh_id == active_mesh.id else 0.0
            candidates.append((score + boost, run.id))
        if not candidates:
            if added:
                return self._replace_primary_sim(runs=runs)
            return self
        candidates.sort(key=lambda x: x[0], reverse=True)
        best_id = candidates[0][1]
        return self._replace_primary_sim(runs=runs, active_run_id=best_id)


    def add_mesh(
        self,
        *,
        name: str | None = None,
        copy_settings_from_active: bool = True,
    ) -> Project:
        """Create a new named mesh, make it active, and isolate its results_subdir."""
        sim = self.primary_simulation()
        if sim is None:
            return self
        new_sim, _node = sim.add_mesh_node(
            name=name,
            copy_settings_from_active=copy_settings_from_active,
        )
        return self._replace_primary_sim(
            meshes=new_sim.meshes,
            active_mesh_id=new_sim.active_mesh_id,
        )

    def remove_mesh(self, mesh_id: str) -> Project:
        """Remove a mesh node. Refuses to delete the last mesh."""
        sim = self.primary_simulation()
        if sim is None:
            return self
        if len(sim.meshes) <= 1:
            raise ValueError("cannot remove the last mesh")
        if not any(m.id == mesh_id for m in sim.meshes):
            raise ValueError(f"unknown mesh id {mesh_id!r}")
        meshes = [m for m in sim.meshes if m.id != mesh_id]
        active = sim.active_mesh_id
        if active == mesh_id:
            active = meshes[0].id
        return self._replace_primary_sim(meshes=meshes, active_mesh_id=active)

    def with_boundary(self, boundary: BoundarySettings) -> Project:
        return self._replace_primary_sim(boundary=boundary)

    def with_boundary_conditions(self, bcs: list[BoundaryCondition]) -> Project:
        return self._replace_bcs(bcs)

    def with_solver(self, solver: SolverSettings) -> Project:
        return self._replace_primary_sim(solver=solver)

    def numerics_settings(self) -> Any:
        from cfddesk.project.numerics import NumericsSettings

        sim = self.primary_simulation()
        raw = sim.numerics if sim is not None else {}
        n = NumericsSettings.from_dict(raw if raw else None)
        # backend authoritative for AmgX display / write path sync
        if self.solver.backend == "amgx":
            n.p_solver = "amgx"
            n.residual_u = self.solver.residual_u
        else:
            if n.p_solver == "amgx":
                n.p_solver = "GAMG"
            n.residual_u = self.solver.residual_u
            n.residual_p = self.solver.residual_p
        return n

    def simulation_control_settings(self) -> Any:
        from cfddesk.project.numerics import SimulationControlSettings

        sim = self.primary_simulation()
        raw = sim.simulation_control if sim is not None else {}
        return SimulationControlSettings.from_dict(raw if raw else None)

    def with_numerics(self, numerics: Any) -> Project:
        from cfddesk.project.numerics import NumericsSettings

        n = numerics if isinstance(numerics, NumericsSettings) else NumericsSettings.from_dict(numerics)
        # Form Apply: p_solver updates authoritative backend.
        sol = self.solver
        backend = "amgx" if n.p_solver == "amgx" else "cpu"
        from dataclasses import replace as dc_replace

        sol = dc_replace(
            sol,
            backend=backend,  # type: ignore[arg-type]
            residual_u=n.residual_u,
            residual_p=n.residual_p,
        )
        return self._replace_primary_sim(numerics=n.to_dict(), solver=sol)

    def with_simulation_control(self, ctrl: Any) -> Project:
        from cfddesk.project.numerics import SimulationControlSettings

        c = (
            ctrl
            if isinstance(ctrl, SimulationControlSettings)
            else SimulationControlSettings.from_dict(ctrl)
        )
        return self._replace_primary_sim(simulation_control=c.to_dict())

    def with_initial_conditions(self, ic: dict[str, Any]) -> Project:
        return self._replace_primary_sim(initial_conditions=dict(ic))

    def with_paths(self, paths: PathsSettings) -> Project:
        return dataclasses.replace(self, paths=paths)

    def with_runs(self, runs: list[RunNode]) -> Project:
        return self._replace_primary_sim(runs=list(runs))

    def snapshot_run_material(
        self, run_id: str, *, material: dict[str, Any] | None = None
    ) -> Project:
        """Write density/nu into a Run's settings_snapshot (legend source of truth)."""
        mat = material if material is not None else self.assigned_material()
        if mat is None:
            raise RuntimeError("No assigned material to snapshot onto Run")
        runs: list[RunNode] = []
        found = False
        primary = self.primary_simulation()
        for run in primary.runs if primary else []:
            if run.id == run_id:
                found = True
                snap = copy.deepcopy(run.settings_snapshot)
                snap["density_kg_m3"] = float(mat["rho"])
                snap["nu"] = float(mat["nu"])
                snap["material_id"] = str(mat.get("id", ""))
                snap["material_name"] = str(mat.get("name", ""))
                snap.pop("density_backfill", None)
                runs.append(dataclasses.replace(run, settings_snapshot=snap))
            else:
                runs.append(run)
        if not found:
            raise KeyError(f"Unknown run id {run_id!r}")
        return self.with_runs(runs)

    def with_mesh_fingerprint(
        self,
        fingerprint: str | None,
        *,
        n_cells: int | None = None,
        n_points: int | None = None,
        mesh_id: str | None = None,
    ) -> Project:
        """Record the mesh input fingerprint at the end of a successful mesh run.

        When ``mesh_id`` is set, update that node (not necessarily the active one).
        """
        changes: dict[str, Any] = {"last_mesh_fingerprint": fingerprint}
        if n_cells is not None:
            changes["n_cells"] = int(n_cells)
        if n_points is not None:
            changes["n_points"] = int(n_points)
        if mesh_id:
            return self.with_mesh_node(str(mesh_id), **changes)
        return self._replace_active_mesh_node(**changes)

    def with_mesh_node(self, mesh_id: str, **changes: Any) -> Project:
        """Replace fields on a mesh node by id (active mesh unchanged)."""
        sim = self.primary_simulation()
        if sim is None:
            raise ValueError("No simulation")
        meshes = list(sim.meshes)
        found = False
        for i, m in enumerate(meshes):
            if m.id == mesh_id:
                meshes[i] = dataclasses.replace(m, **changes)
                found = True
                break
        if not found:
            raise ValueError(f"Unknown mesh id {mesh_id!r}")
        return self._replace_primary_sim(
            meshes=meshes,
            active_mesh_id=sim.active_mesh_id or meshes[0].id,
        )


    def next_refinement_display_name(
        self,
        base_label: str,
        *,
        mesh_id: str | None = None,
        exclude_id: str | None = None,
    ) -> str:
        """``Surface refinement``, then ``Surface refinement 2``, … on active mesh."""
        sim = self.primary_simulation()
        if sim is None:
            return base_label
        node = sim.mesh_by_id(mesh_id) if mesh_id else sim.active_mesh()
        if node is None:
            node = sim.active_mesh()
        existing = {
            r.name
            for r in node.refinements
            if exclude_id is None or r.id != exclude_id
        }
        return next_refinement_display_name(existing, base_label)

    def add_mesh_refinement(
        self,
        *,
        type_key: str,
        name: str | None = None,
        mesh_id: str | None = None,
    ) -> tuple[Project, MeshRefinementStub]:
        """Append a named Refinements stub on a mesh (type+name only; Inc 7a)."""
        sim = self.primary_simulation()
        if sim is None:
            raise ValueError("No simulation")
        mid = mesh_id or sim.active_mesh_id or sim.active_mesh().id
        node = sim.mesh_by_id(mid)
        if node is None:
            raise ValueError(f"Unknown mesh id {mid!r}")
        label = label_for_type(type_key)
        display = name or self.next_refinement_display_name(label, mesh_id=mid)
        if str(type_key) == INFLATE_TYPE:
            from cfddesk.project.mesh_refinements import make_inflate_stub

            algo = str(getattr(self.mesh, "algorithm", "") or "")
            stub = make_inflate_stub(name=display, algorithm=algo, stub_id=_new_id())
        elif str(type_key) == SURFACE_REFINEMENT_TYPE:
            from cfddesk.project.mesh_refinements import make_surface_refinement_stub

            stub = make_surface_refinement_stub(name=display, stub_id=_new_id())
        elif str(type_key) == FEATURE_REFINEMENT_TYPE:
            from cfddesk.project.mesh_refinements import make_feature_refinement_stub

            stub = make_feature_refinement_stub(name=display, stub_id=_new_id())
        elif str(type_key) == SURFACE_CUSTOM_SIZING_TYPE:
            from cfddesk.project.mesh_refinements import make_surface_custom_sizing_stub

            stub = make_surface_custom_sizing_stub(name=display, stub_id=_new_id())
        elif str(type_key) == VOLUME_CUSTOM_SIZING_TYPE:
            from cfddesk.project.mesh_refinements import make_volume_custom_sizing_stub

            stub = make_volume_custom_sizing_stub(name=display, stub_id=_new_id())
        elif str(type_key) == REGION_REFINEMENT_TYPE:
            from cfddesk.project.mesh_refinements import make_region_refinement_stub

            stub = make_region_refinement_stub(name=display, stub_id=_new_id())
        elif str(type_key) == BB_LAYER_TYPE:
            from cfddesk.project.mesh_refinements import make_bb_layer_stub

            stub = make_bb_layer_stub(name=display, stub_id=_new_id())
        elif str(type_key) == EXTRUSION_TYPE:
            from cfddesk.project.mesh_refinements import make_extrusion_stub

            stub = make_extrusion_stub(name=display, stub_id=_new_id())
        else:
            stub = MeshRefinementStub(id=_new_id(), type=str(type_key), name=display)
        refinements = list(node.refinements) + [stub]
        proj = self.with_mesh_node(mid, refinements=refinements)
        return proj, stub

    def mesh_refinement_by_id(
        self, refinement_id: str, *, mesh_id: str | None = None
    ) -> MeshRefinementStub | None:
        sim = self.primary_simulation()
        if sim is None:
            return None
        nodes = sim.meshes
        if mesh_id:
            node = sim.mesh_by_id(mesh_id)
            nodes = [node] if node is not None else []
        for node in nodes:
            for r in node.refinements:
                if r.id == refinement_id:
                    return r
        return None

    def update_mesh_refinement(
        self,
        refinement_id: str,
        *,
        mesh_id: str | None = None,
        **changes: Any,
    ) -> Project:
        """Replace fields on a refinement stub (Inc 7b inflate payload)."""
        sim = self.primary_simulation()
        if sim is None:
            raise ValueError("No simulation")
        mid = mesh_id or sim.active_mesh_id or sim.active_mesh().id
        node = sim.mesh_by_id(mid)
        if node is None:
            raise ValueError(f"Unknown mesh id {mid!r}")
        found = False
        refinements: list[MeshRefinementStub] = []
        for r in node.refinements:
            if r.id == refinement_id:
                refinements.append(dataclasses.replace(r, **changes))
                found = True
            else:
                refinements.append(r)
        if not found:
            raise KeyError(f"Unknown refinement id {refinement_id!r}")
        return self.with_mesh_node(mid, refinements=refinements)

    # ---- fingerprints --------------------------------------------------------

    def mesh_input_fingerprint(self, mesh_id: str | None = None) -> str:
        """Stable hash of mesh settings + emitted patches / BC topology.

        When ``mesh_id`` is set, hash that mesh's settings (not necessarily active).
        """
        return _hash_mesh_fingerprint_payload(
            _mesh_fingerprint_payload(self, mesh_id=mesh_id)
        )

    def is_mesh_stale(self, mesh_id: str | None = None) -> bool:
        """True if a mesh exists but settings no longer match that mesh run.

        No prior mesh (``last_mesh_fingerprint is None``) is *not*
        stale — that is \"no mesh yet\".
        """
        sim = self.primary_simulation()
        if sim is None:
            return False
        node = (
            sim.mesh_by_id(mesh_id)
            if mesh_id
            else sim.active_mesh()
        )
        if node is None or node.last_mesh_fingerprint is None:
            return False
        return node.last_mesh_fingerprint != self.mesh_input_fingerprint(
            mesh_id=node.id
        )

    def has_mesh(self, mesh_id: str | None = None) -> bool:
        sim = self.primary_simulation()
        if sim is None:
            return False
        node = sim.mesh_by_id(mesh_id) if mesh_id else sim.active_mesh()
        return node is not None and node.last_mesh_fingerprint is not None

    # ---- persistence ---------------------------------------------------------

    def to_dict(self) -> dict:
        d = {
            "version": self.version,
            "units": {
                "native_unit": self.native_unit,
                "declared_unit": self.declared_unit,
                "scale_to_metres": self.scale_to_metres,
                "confirmed": self.units_confirmed,
                "ambiguous": self.units_ambiguous,
                "notes": list(self.units_notes),
            },
            "results": {
                "color_scale": self.color_scale.to_dict(),
                "window": self.results_window.to_dict(),
                "display": self.results_display.to_dict(),
                "filters": filters_to_list(self.results_filters),
                "views": views_to_list(self.results_views),
                "screenshots": screenshots_to_list(self.results_screenshots),
                "records": records_to_list(self.results_records),
            },
            "paths": self.paths.to_dict(),
            "geometries": [g.to_dict() for g in self.geometries],
            "simulations": [s.to_dict() for s in self.simulations],
            "field_units": dict(self.field_units),
        }
        if self.updated_at:
            d["updated_at"] = self.updated_at
        if self.persistence:
            d["persistence"] = dict(self.persistence)
        return d

    def save(self, path: str | Path) -> None:
        """Atomic write; snapshots the pre-upgrade file once on schema bump."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        old_version = _read_version(path)
        if old_version is not None and old_version < PROJECT_VERSION:
            backup = path.with_name(f"{path.name}.v{old_version}.bak")
            if not backup.exists():
                shutil.copy2(path, backup)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)

    @staticmethod
    def from_dict(data: dict, project_dir: str | Path | None = None) -> Project:
        version = int(data.get("version", PROJECT_VERSION))
        units = data.get("units") or {}
        scale = units.get("scale_to_metres", data.get("scale_to_metres"))
        if scale is None:
            raise ValueError(
                "project.json missing units.scale_to_metres — refuse silent default"
            )
        results = data.get("results") or {}
        paths = PathsSettings.from_dict(data.get("paths"))

        if version >= 6:
            geometries = [_geometry_from_dict(g) for g in (data.get("geometries") or [])]
            if not geometries:
                geometries = [
                    Geometry(id=_new_id(), name="Geometry 1", step_path="", faces=[])
                ]
            sims_raw = data.get("simulations") or []
            simulations = [
                _simulation_from_dict(s, geometry_id=geometries[0].id)
                for s in sims_raw
            ]
            if not simulations:
                simulations = [_default_simulation(geometries[0].id)]
        else:
            geometries, simulations = _migrate_flat_to_hierarchy(
                data, version=version, paths=paths, project_dir=project_dir
            )

        field_units = data.get("field_units") or {}
        if not isinstance(field_units, dict):
            field_units = {}

        project = Project(
            version=PROJECT_VERSION if version < PROJECT_VERSION else version,
            scale_to_metres=float(scale),
            native_unit=str(units.get("native_unit", data.get("native_unit", "UNKNOWN"))),
            declared_unit=(
                None
                if units.get("declared_unit", data.get("declared_unit")) in (None, "")
                else str(units.get("declared_unit", data.get("declared_unit")))
            ),
            units_confirmed=bool(units.get("confirmed", data.get("units_confirmed", False))),
            units_ambiguous=bool(units.get("ambiguous", data.get("units_ambiguous", True))),
            units_notes=list(units.get("notes", data.get("units_notes", []))),
            color_scale=ColorScale.from_dict(results.get("color_scale")),
            results_window=ResultsWindowGeom.from_dict(results.get("window")),
            results_display=ResultsDisplay.from_dict(results.get("display")),
            results_filters=filters_from_list(results.get("filters")),
            results_views=views_from_list(results.get("views")),
            results_screenshots=screenshots_from_list(results.get("screenshots")),
            results_records=records_from_list(results.get("records")),
            paths=paths,
            geometries=geometries,
            simulations=simulations,
            field_units={str(k): str(v) for k, v in field_units.items()},
            updated_at=(str(data["updated_at"]) if data.get("updated_at") else None),
            persistence=(
                dict(data["persistence"])
                if isinstance(data.get("persistence"), dict)
                else (
                    {"legacy": data["persistence"]}
                    if data.get("persistence")
                    else {}
                )
            ),
        )
        project = project._sync_faces_from_bcs()
        if version < 6:
            project = _maybe_upgrade_legacy_mesh_fingerprint(project, data)
        if version < 7:
            project = _upgrade_to_v7(project, project_dir=project_dir)
        if version < 8:
            project = _upgrade_to_v8(project)
        if version < 9:
            project = _upgrade_to_v9(project)
        if version < 10:
            project = _upgrade_to_v10(project)
        if version < 11:
            project = _upgrade_to_v11(project)
        if version < 12:
            project = _upgrade_to_v12(project)
        if version < 13:
            project = _upgrade_to_v13(project, project_dir=project_dir)
        if version < 14:
            project = _upgrade_to_v14(project)
        if version < 15:
            project = _upgrade_to_v15(project, project_dir=project_dir)
        elif project_dir is not None:
            # Already v15+: still ingest siblings that are newer than project.json
            from cfddesk.project.web_mirrors import ingest_web_siblings_if_newer

            project = ingest_web_siblings_if_newer(project, project_dir)
        return project

    @staticmethod
    def load(path: str | Path) -> Project:
        path = Path(path)
        data = json.loads(path.read_text(encoding="utf-8"))
        return Project.from_dict(data, project_dir=path.parent)

    @staticmethod
    def from_solid(
        solid: LoadedSolid,
        roles: dict[int, FaceRole] | None = None,
        *,
        scale_to_metres: float | None = None,
        units_confirmed: bool = False,
        preserve: Project | None = None,
    ) -> Project:
        roles = roles or {}
        faces = [
            FaceFingerprint(
                face_id=rec.face_id,
                role="unassigned",
                centroid=rec.centroid,
                area=rec.area,
                bc_id=None,
            )
            for rec in solid.faces
        ]
        u = solid.units
        prev_geom = preserve.primary_geometry() if preserve is not None else None
        prev_sim = preserve.primary_simulation() if preserve is not None else None
        if preserve is not None:
            scale = preserve.scale_to_metres
            confirmed = preserve.units_confirmed
            native = preserve.native_unit
            declared = preserve.declared_unit
            ambiguous = preserve.units_ambiguous
            notes = list(preserve.units_notes)
            color = preserve.color_scale
            results_window = preserve.results_window
            results_display = preserve.results_display
            results_filters = list(preserve.results_filters)
            results_views = list(preserve.results_views)
            results_screenshots = list(preserve.results_screenshots)
            results_records = list(preserve.results_records)
            mesh = preserve.mesh
            boundary = preserve.boundary
            solver = preserve.solver
            paths = preserve.paths
            mesh_fp = preserve.mesh_fingerprint_at_last_mesh
            runs = list(prev_sim.runs) if prev_sim is not None else []
            materials = (
                copy.deepcopy(prev_sim.materials) if prev_sim is not None else []
            )
            field_units = dict(preserve.field_units)
            # Preserve BC definitions; keep face assignments that still exist.
            live_ids = {rec.face_id for rec in solid.faces}
            bcs = [
                dataclasses.replace(
                    bc, face_ids=[f for f in bc.face_ids if f in live_ids]
                )
                for bc in preserve.boundary_conditions
            ]
        else:
            if scale_to_metres is not None:
                scale = scale_to_metres
            elif u.proposed_scale_to_metres is not None:
                scale = u.proposed_scale_to_metres
            else:
                raise ValueError(
                    "Cannot create project without scale_to_metres — units unresolved"
                )
            confirmed = units_confirmed
            native = u.cascade_unit
            declared = u.geometric_context_unit
            ambiguous = u.ambiguous
            notes = list(u.ambiguity_notes)
            color = ColorScale()
            results_window = ResultsWindowGeom()
            results_display = ResultsDisplay()
            results_filters = default_filter_stack()
            results_views = []
            results_screenshots = []
            results_records = []
            mesh = MeshSettings()
            boundary = BoundarySettings()
            solver = SolverSettings()
            paths = PathsSettings()
            mesh_fp = None
            runs = []
            materials = []
            bcs = []
            field_units = {}

        geometry = Geometry(
            id=prev_geom.id if prev_geom is not None else _new_id(),
            name=prev_geom.name if prev_geom is not None else "Geometry 1",
            step_path=str(solid.path),
            faces=faces,
            bodies=_bodies_from_solid(solid),
        )
        mesh_node = MeshNode(
            id=(
                prev_sim.primary_mesh().id
                if prev_sim is not None and prev_sim.meshes
                else _new_id()
            ),
            name=(
                prev_sim.primary_mesh().name
                if prev_sim is not None and prev_sim.meshes
                else "Mesh 1"
            ),
            settings=mesh,
            last_mesh_fingerprint=mesh_fp,
            results_subdir=(
                prev_sim.active_mesh().results_subdir
                if prev_sim is not None and prev_sim.meshes
                else "results"
            ),
            n_cells=(
                prev_sim.active_mesh().n_cells
                if prev_sim is not None and prev_sim.meshes
                else None
            ),
            n_points=(
                prev_sim.active_mesh().n_points
                if prev_sim is not None and prev_sim.meshes
                else None
            ),
        )
        simulation = Simulation(
            id=prev_sim.id if prev_sim is not None else _new_id(),
            name=prev_sim.name if prev_sim is not None else PRIMARY_SIM_NAME,
            analysis_type=(
                prev_sim.analysis_type if prev_sim is not None else PRIMARY_SIM_ANALYSIS
            ),
            geometry_id=geometry.id,
            boundary_conditions=bcs,
            meshes=[mesh_node],
            runs=runs,
            solver=solver,
            boundary=boundary,
            materials=materials,
            active_mesh_id=mesh_node.id,
        )

        project = Project(
            version=PROJECT_VERSION,
            scale_to_metres=scale,
            native_unit=native,
            declared_unit=declared,
            units_confirmed=confirmed,
            units_ambiguous=ambiguous,
            units_notes=notes,
            color_scale=color,
            results_window=results_window,
            results_display=results_display,
            results_filters=results_filters,
            results_views=results_views,
            results_screenshots=results_screenshots,
            results_records=results_records,
            paths=paths,
            geometries=[geometry],
            simulations=[simulation],
            field_units=field_units,
        )._sync_faces_from_bcs()

        # Apply explicit role map (creates classic BCs as needed).
        for fid, role in roles.items():
            if role != "unassigned":
                project = project.with_role(fid, role)
        return project


def _kin_pressure_to_pa(settings: dict[str, Any], rho: float) -> dict[str, Any]:
    out = copy.deepcopy(settings)
    for key in _PRESSURE_SETTING_KEYS:
        if key in out and out[key] is not None:
            out[key] = kinematic_to_pa(float(out[key]), rho)
    return out


def _ensure_geometry_volumes(
    geom: Geometry, *, project_dir: str | Path | None
) -> tuple[Geometry, str]:
    """Populate bodies from STEP when missing. Returns (geom, source_note)."""
    if geom.bodies:
        return geom, "present"
    step = Path(geom.step_path) if geom.step_path else None
    if step is not None and not step.is_file() and project_dir is not None:
        cand = Path(project_dir) / geom.step_path
        if cand.is_file():
            step = cand
    if step is not None and step.is_file():
        try:
            from cfddesk.cad.step import load_step

            solid = load_step(step)
            return (
                dataclasses.replace(geom, bodies=_bodies_from_solid(solid)),
                "occt_step",
            )
        except Exception:
            pass
    # Last resort — one synthetic fluid body owning all faces.
    return (
        dataclasses.replace(
            geom,
            bodies=[
                Body(
                    id="solid-0",
                    name="Solid 1",
                    face_ids=tuple(f.face_id for f in geom.faces),
                    role="fluid",
                    region="fluid",
                )
            ],
        ),
        "synthetic_fallback",
    )


def _upgrade_to_v7(
    project: Project, *, project_dir: str | Path | None = None
) -> Project:
    """Kinematic→Pa, volume enumeration, Run ρ backfill, materials shape."""
    rho0 = RHO_AIR
    geometries: list[Geometry] = []
    for g in project.geometries:
        g2, _note = _ensure_geometry_volumes(g, project_dir=project_dir)
        geometries.append(g2)

    simulations: list[Simulation] = []
    for sim in project.simulations:
        bcs = [
            dataclasses.replace(bc, settings=_kin_pressure_to_pa(bc.settings, rho0))
            for bc in sim.boundary_conditions
        ]
        boundary = dataclasses.replace(
            sim.boundary,
            outlet_p=kinematic_to_pa(float(sim.boundary.outlet_p), rho0),
        )
        materials = []
        for m in sim.materials:
            m = copy.deepcopy(m)
            ids = _material_body_ids(m)
            _set_material_body_ids(m, ids)
            if "id" not in m or not m["id"]:
                m["id"] = _new_id()
            materials.append(m)
        ic = copy.deepcopy(sim.initial_conditions)
        if isinstance(ic, dict):
            for key in _PRESSURE_SETTING_KEYS:
                if key in ic and ic[key] is not None:
                    ic[key] = kinematic_to_pa(float(ic[key]), rho0)
            # Nested IC blob used by Phase 2 form
            gp = ic.get("gauge_pressure")
            if gp is None and isinstance(ic.get("p"), (int, float)):
                ic["gauge_pressure"] = kinematic_to_pa(float(ic["p"]), rho0)

        runs: list[RunNode] = []
        for run in sim.runs:
            snap = copy.deepcopy(run.settings_snapshot)
            if "density_kg_m3" not in snap:
                snap["density_kg_m3"] = rho0
                snap["density_backfill"] = "RHO_AIR_assumed"
            runs.append(dataclasses.replace(run, settings_snapshot=snap))

        simulations.append(
            dataclasses.replace(
                sim,
                boundary_conditions=bcs,
                boundary=boundary,
                materials=materials,
                initial_conditions=ic,
                runs=runs,
            )
        )

    return dataclasses.replace(
        project,
        version=7,
        geometries=geometries,
        simulations=simulations,
    )._sync_faces_from_bcs()


_TRANSFORM_FINGERPRINT_KEYS = (
    "transform",
    "separationVector",
    "rotationAxis",
    "rotationCentre",
)


def _hash_mesh_fingerprint_payload(payload: dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _mesh_settings_fingerprint_payload(
    project: Project,
    *,
    mesh_settings: MeshSettings | None = None,
    quantize_location: bool = True,
    include_block_aabb: bool = True,
) -> dict[str, Any]:
    mesh = mesh_settings if mesh_settings is not None else project.mesh
    loc = mesh.location_in_mesh
    if quantize_location:
        loc_payload = quantize_location_m(loc)
    else:
        loc_payload = list(loc) if loc is not None else None
    payload: dict[str, Any] = {
        "base_cell_m": mesh.base_cell_m,
        "refinement": mesh.refinement.to_dict(),
        "location_in_mesh": loc_payload,
        "stl_facet_to_cell_ratio": mesh.stl_facet_to_cell_ratio,
    }
    algo = str(getattr(mesh, "algorithm", "standard") or "standard")
    if algo == "standard":
        payload["algorithm"] = "standard"
        payload["hex_element_core"] = bool(
            getattr(mesh, "hex_element_core", True)
        )
        if payload["hex_element_core"]:
            # Gap-aware cfMesh recipe, or body-fit v1 when that backend is on.
            # Marks pre-fix hexcore meshes stale so the UI asks for a remesh.
            payload["hexcore_recipe"] = mesh.hexcore_recipe_token()
    elif algo == "hex-dominant-parametric":
        payload["algorithm"] = "hex-dominant-parametric"
        # Inc 14a.2-ship: Level-0 from geometry-derived Hex helper, not UI seeds.
        payload["bbox_resolution"] = "geometry_derived_hex_helper"
        payload["castellated"] = {
            "max_local_cells": int(getattr(mesh, "max_local_cells", 40_000_000)),
            "max_global_cells": int(getattr(mesh, "max_global_cells", 100_000_000)),
            "min_refinement_cells": int(getattr(mesh, "min_refinement_cells", 1)),
            "max_load_unbalance": float(getattr(mesh, "max_load_unbalance", 0.2)),
            "cells_between_levels": int(getattr(mesh, "cells_between_levels", 3)),
            "resolve_feature_angle": float(
                getattr(mesh, "resolve_feature_angle", 30.0)
            ),
            "allow_free_standing_zone_faces": bool(
                getattr(mesh, "allow_free_standing_zone_faces", False)
            ),
        }
        from cfddesk.mesh.snappy_policy import snappy_geometry_fingerprint_payload

        payload.update(
            snappy_geometry_fingerprint_payload(
                walls_level=int(mesh.refinement.walls),
                fineness=int(getattr(mesh, "fineness", 5) or 5),
                has_features=True,
            )
        )
    else:
        # Feature-level + snap strength scale with fineness / walls (snappy_policy).
        from cfddesk.mesh.snappy_policy import snappy_geometry_fingerprint_payload

        payload.update(
            snappy_geometry_fingerprint_payload(
                walls_level=int(mesh.refinement.walls),
                fineness=int(getattr(mesh, "fineness", 5) or 5),
                has_features=True,
            )
        )
    # Only when layers are on — keeps migrated add_layers=False fingerprints stable.
    # Standard v1 ignores layers.
    if mesh.add_layers and algo != "standard":
        payload["add_layers"] = True
    if include_block_aabb:
        payload["block_aabb"] = BLOCK_AABB_FINGERPRINT
    return payload


def _emitted_patches_fingerprint_payload(project: Project) -> list[dict[str, Any]]:
    from cfddesk.mesh.patches import emit_all_patches

    return [
        {
            "name": ep.name,
            "patch_type": ep.patch_type,
            "face_ids": list(ep.face_ids),
            "refinement_level": int(ep.refinement_level),
        }
        for ep in emit_all_patches(project)
    ]


def _bc_fingerprint_entry(bc: BoundaryCondition) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "type": bc.type,
        "variant": bc.variant,
        "registry_key": registry_key_for_bc(bc),
    }
    if bc.subvariant:
        entry["subvariant"] = bc.subvariant
    paired = bc.paired_bc_id
    if paired is None and isinstance(bc.settings, dict):
        paired = bc.settings.get("paired_bc_id")
    if paired is not None:
        entry["paired_bc_id"] = paired
    settings = bc.settings if isinstance(bc.settings, dict) else {}
    for key in _TRANSFORM_FINGERPRINT_KEYS:
        if key in settings:
            entry[key] = settings[key]
    return entry


def _mesh_fingerprint_payload(
    project: Project, *, mesh_id: str | None = None
) -> dict[str, Any]:
    mesh_settings: MeshSettings | None = None
    if mesh_id:
        sim = project.primary_simulation()
        node = sim.mesh_by_id(mesh_id) if sim is not None else None
        if node is not None:
            mesh_settings = node.settings
    refinements: list[MeshRefinementStub] = []
    sim = project.primary_simulation()
    if sim is not None:
        node = sim.mesh_by_id(mesh_id) if mesh_id else sim.active_mesh()
        if node is not None:
            refinements = list(node.refinements)
    payload: dict[str, Any] = {
        "mesh": _mesh_settings_fingerprint_payload(
            project, mesh_settings=mesh_settings
        ),
        "emitted_patches": _emitted_patches_fingerprint_payload(project),
        "boundary_conditions": [
            _bc_fingerprint_entry(bc)
            for bc in sorted(project.boundary_conditions, key=lambda b: b.patch_name)
        ],
    }
    inflate = inflate_fingerprint_payload(refinements)
    if inflate:
        payload["inflate_boundary_layers"] = inflate
    surface = surface_refinement_fingerprint_payload(refinements)
    if surface:
        payload["surface_refinements"] = surface
    feature = feature_refinement_fingerprint_payload(refinements)
    if feature:
        payload["feature_refinements"] = feature
    scs = surface_custom_sizing_fingerprint_payload(refinements)
    if scs:
        payload["surface_custom_sizing"] = scs
    vcs = volume_custom_sizing_fingerprint_payload(refinements)
    if vcs:
        payload["volume_custom_sizing"] = vcs
    region = region_refinement_fingerprint_payload(refinements)
    if region:
        payload["region_refinements"] = region
    bb_layer = bb_layer_fingerprint_payload(refinements)
    if bb_layer:
        payload["bounding_box_layer_additions"] = bb_layer
    extrusion = extrusion_fingerprint_payload(refinements)
    if extrusion:
        payload["extrusion_mesh_refinements"] = extrusion
    # v14: bodies only when non-trivial (role != fluid or >1 region).
    # Single-fluid projects must keep the pre-v14 fingerprint hash.
    geom = project.primary_geometry()
    if geom is not None and geom.bodies:
        roles_non_fluid = any(b.role != "fluid" for b in geom.bodies)
        region_names = {b.region for b in geom.bodies}
        if roles_non_fluid or len(region_names) > 1:
            payload["bodies"] = [
                {
                    "id": b.id,
                    "role": b.role,
                    "region": b.region,
                    "face_ids": list(b.face_ids),
                }
                for b in sorted(geom.bodies, key=lambda x: x.id)
            ]
    return payload


def _mesh_input_fingerprint_pre_v8(project: Project) -> str:
    """Pre-nested BC identity formula used before v8 type/variant rewrite.

    Same mesh + emitted patches + transform keys as the current formula, but BC
    ``type`` is the flat registry key and ``variant`` is ``default`` — the shape
    stamped by v5–v7 mesh runs and by legacy re-stamp before nested migrate.
    Uses unquantized location (pre-v9) so migrate chains stay honest.
    """
    bcs_payload: list[dict[str, Any]] = []
    for bc in sorted(project.boundary_conditions, key=lambda b: b.patch_name):
        reg = registry_key_for_bc(bc)
        entry: dict[str, Any] = {
            "type": reg,
            "variant": "default",
            "registry_key": reg,
        }
        paired = bc.paired_bc_id
        if paired is None and isinstance(bc.settings, dict):
            paired = bc.settings.get("paired_bc_id")
        if paired is not None:
            entry["paired_bc_id"] = paired
        settings = bc.settings if isinstance(bc.settings, dict) else {}
        for key in _TRANSFORM_FINGERPRINT_KEYS:
            if key in settings:
                entry[key] = settings[key]
        bcs_payload.append(entry)
    return _hash_mesh_fingerprint_payload(
        {
            "mesh": _mesh_settings_fingerprint_payload(
                project, quantize_location=False, include_block_aabb=False
            ),
            "emitted_patches": _emitted_patches_fingerprint_payload(project),
            "boundary_conditions": bcs_payload,
        }
    )


def _mesh_input_fingerprint_unquantized_location(project: Project) -> str:
    """Pre-v9 formula: raw float64 ``location_in_mesh``, no ``block_aabb``."""
    return _hash_mesh_fingerprint_payload(
        {
            "mesh": _mesh_settings_fingerprint_payload(
                project, quantize_location=False, include_block_aabb=False
            ),
            "emitted_patches": _emitted_patches_fingerprint_payload(project),
            "boundary_conditions": [
                _bc_fingerprint_entry(bc)
                for bc in sorted(
                    project.boundary_conditions, key=lambda b: b.patch_name
                )
            ],
        }
    )


def _mesh_input_fingerprint_v9_quantize(project: Project) -> str:
    """v9 formula: quantized location, no ``block_aabb`` (pre-v10)."""
    return _hash_mesh_fingerprint_payload(
        {
            "mesh": _mesh_settings_fingerprint_payload(
                project, quantize_location=True, include_block_aabb=False
            ),
            "emitted_patches": _emitted_patches_fingerprint_payload(project),
            "boundary_conditions": [
                _bc_fingerprint_entry(bc)
                for bc in sorted(
                    project.boundary_conditions, key=lambda b: b.patch_name
                )
            ],
        }
    )


def _upgrade_to_v8(project: Project) -> Project:
    """Nested BC keys + conditional fingerprint re-stamp for formula-only change."""
    stored = project.mesh_fingerprint_at_last_mesh
    reconcilable: set[str] = set()
    if stored is not None:
        # Pre-reparse state (v4→v7 keeps flat registry keys on BC.type).
        # Use unquantized mesh payload so v8 migrate stays independent of v9.
        reconcilable.add(_mesh_input_fingerprint_unquantized_location(project))
        # Already-nested load path: reconstruct the flat-type stamp.
        reconcilable.add(_mesh_input_fingerprint_pre_v8(project))
        # Very legacy MeshSettings-only stamp (also handled earlier for version < 6).
        reconcilable.add(project.mesh.fingerprint(quantize_location=False))

    simulations: list[Simulation] = []
    for sim in project.simulations:
        bcs = [BoundaryCondition.from_dict(bc.to_dict()) for bc in sim.boundary_conditions]
        simulations.append(dataclasses.replace(sim, boundary_conditions=bcs))
    project = dataclasses.replace(
        project, version=8, simulations=simulations
    )._sync_faces_from_bcs()

    # Re-stamp only when stored matches an old/current formula for *this* topology.
    # Face/settings drift leaves the project honestly stale.
    # Stamp with unquantized formula so v9 can detect the pre-quantize hash.
    if stored is not None:
        new_fp = _mesh_input_fingerprint_unquantized_location(project)
        if stored == new_fp or stored in reconcilable:
            project = project.with_mesh_fingerprint(new_fp)
    return project


def _upgrade_to_v9(project: Project) -> Project:
    """Quantize locationInMesh in the mesh fingerprint; conditional re-stamp.

    Stamps the v9 formula (quantized location, **no** ``block_aabb``) so v10
    can introduce the block AABB token as a hard break without laundering.
    """
    stored = project.mesh_fingerprint_at_last_mesh
    reconcilable: set[str] = set()
    if stored is not None:
        reconcilable.add(_mesh_input_fingerprint_unquantized_location(project))
        reconcilable.add(_mesh_input_fingerprint_v9_quantize(project))
        reconcilable.add(project.mesh.fingerprint(quantize_location=False))
        reconcilable.add(project.mesh.fingerprint(quantize_location=True))

    project = dataclasses.replace(project, version=9)

    if stored is not None:
        new_fp = _mesh_input_fingerprint_v9_quantize(project)
        if stored == new_fp or stored in reconcilable:
            project = project.with_mesh_fingerprint(new_fp)
    return project


def _upgrade_to_v10(project: Project) -> Project:
    """Record geometry block AABB in the fingerprint. No re-stamp.

    Pre-v10 meshes were sized from a triangulation-inflated AABB after STL
    export. Re-stamping here would mark those meshes fresh while snappy would
    rebuild to a different cell count (Manual: 69770 → 68292).
    """
    return dataclasses.replace(project, version=10)


def _upgrade_to_v11(project: Project) -> Project:
    """v11 is BC ``name_is_custom`` (handled in BoundaryCondition.from_dict)."""
    return dataclasses.replace(project, version=11)


def _upgrade_to_v12(project: Project) -> Project:
    """Seed numerics / IC / sim-control. Never touch mesh fingerprints."""
    from cfddesk.project.initial_conditions import rebuild_initial_conditions
    from cfddesk.project.numerics import NumericsSettings, SimulationControlSettings

    sim = project.primary_simulation()
    if sim is None:
        return dataclasses.replace(project, version=12)

    sol = sim.solver
    numerics = NumericsSettings.from_dict(sim.numerics if sim.numerics else None)
    if not sim.numerics:
        numerics = NumericsSettings.from_backend(sol.backend)
        numerics.residual_u = sol.residual_u
        numerics.residual_p = sol.residual_p
    else:
        # Keep backend authoritative: sync p_solver display from backend.
        if sol.backend == "amgx":
            numerics.p_solver = "amgx"
        elif numerics.p_solver == "amgx":
            numerics.p_solver = "GAMG"

    sim_ctrl = SimulationControlSettings.from_dict(
        sim.simulation_control if sim.simulation_control else None
    )
    ic = sim.initial_conditions if isinstance(sim.initial_conditions, dict) else {}
    if not ic or "p" not in ic:
        ic = rebuild_initial_conditions(project)

    project = project._replace_primary_sim(
        numerics=numerics.to_dict(),
        simulation_control=sim_ctrl.to_dict(),
        initial_conditions=ic,
    )
    return dataclasses.replace(project, version=12)


def _bbox_diagonal_m_for_project(project: Project) -> float | None:
    """Native STEP bbox diagonal in metres, or None if geometry unavailable."""
    geom = project.primary_geometry()
    if geom is None or not geom.step_path:
        return None
    path = Path(geom.step_path)
    if not path.is_file():
        return None
    try:
        from cfddesk.cad.step import load_step
        from cfddesk.cad.units import shape_bbox

        solid = load_step(path)
        bb = shape_bbox(solid.shape, unit="native")
        s = float(project.scale_to_metres) or 1.0
        dx = (bb.xmax - bb.xmin) * s
        dy = (bb.ymax - bb.ymin) * s
        dz = (bb.zmax - bb.zmin) * s
        diag = (dx * dx + dy * dy + dz * dz) ** 0.5
        return float(diag) if diag > 0 else None
    except Exception:
        return None


def _upgrade_mesh_settings_v13(
    settings: MeshSettings, *, bbox_diagonal_m: float | None
) -> MeshSettings:
    """Preserve absolute sizes; mark sizing manual; fill Phase-5 fields."""
    from cfddesk.project.mesh_sizing import FINENESS_DEFAULT, fineness_from_base_cell

    if bbox_diagonal_m is not None:
        fineness = fineness_from_base_cell(bbox_diagonal_m, settings.base_cell_m)
    else:
        fineness = FINENESS_DEFAULT
    # Physics-based default True; keep whatever refinement was already stored.
    return dataclasses.replace(
        settings,
        fineness=fineness,
        sizing_mode="manual",
        physics_based=True,
        add_layers=False,
        max_meshing_runtime_s=float(
            getattr(settings, "max_meshing_runtime_s", 18_000.0) or 18_000.0
        ),
    )


def _upgrade_to_v13(
    project: Project, *, project_dir: str | Path | None = None
) -> Project:
    """Phase 5 mesh schema: fineness fields, active_mesh_id, run.mesh_id, results_subdir.

    Does **not** re-stamp mesh fingerprints when ``add_layers`` stays False (default).
    """
    _ = project_dir  # reserved for future path-relative STEP resolve
    bbox_L = _bbox_diagonal_m_for_project(project)
    legacy_results = project.paths.local_results or "results"

    simulations: list[Simulation] = []
    for sim in project.simulations:
        meshes_in = list(sim.meshes) if sim.meshes else []
        if not meshes_in:
            mid = _new_id()
            meshes_in = [
                MeshNode(
                    id=mid,
                    name="Mesh 1",
                    settings=MeshSettings(),
                    results_subdir=legacy_results,
                )
            ]
        meshes_out: list[MeshNode] = []
        for i, mesh_node in enumerate(meshes_in):
            new_settings = _upgrade_mesh_settings_v13(
                mesh_node.settings, bbox_diagonal_m=bbox_L
            )
            # Primary / first mesh keeps the classic results tree.
            subdir = mesh_node.results_subdir
            if not subdir or subdir.startswith("results/mesh-"):
                # from_dict may have invented results/mesh-<id>; migrate primary → results.
                if i == 0:
                    subdir = legacy_results
            meshes_out.append(
                dataclasses.replace(
                    mesh_node,
                    settings=new_settings,
                    results_subdir=subdir or legacy_results,
                )
            )
        primary_id = meshes_out[0].id
        active_id = sim.active_mesh_id if getattr(sim, "active_mesh_id", "") else ""
        if not active_id or not any(m.id == active_id for m in meshes_out):
            active_id = primary_id

        runs_out: list[RunNode] = []
        for run in sim.runs:
            mid = run.mesh_id if getattr(run, "mesh_id", "") else ""
            if not mid or not any(m.id == mid for m in meshes_out):
                mid = primary_id
            runs_out.append(dataclasses.replace(run, mesh_id=mid))

        simulations.append(
            dataclasses.replace(
                sim,
                meshes=meshes_out,
                runs=runs_out,
                active_mesh_id=active_id,
            )
        )

    return dataclasses.replace(project, version=13, simulations=simulations)



def _upgrade_to_v14(project: Project) -> Project:
    """volumes → bodies(role=fluid, region=fluid); materials volume_ids → body_ids.

    Does **not** re-stamp mesh fingerprints. Single-fluid projects keep the
    same ``mesh_input_fingerprint`` (bodies omitted from the payload unless
    any body is non-fluid or more than one region exists).
    """
    geometries: list[Geometry] = []
    for g in project.geometries:
        if g.bodies:
            bodies = list(g.bodies)
        else:
            # Defensive: volumes property may be empty too; keep empty list.
            bodies = [
                Body(
                    id=str(vol.get("id") or ""),
                    name=str(vol.get("name") or vol.get("id") or ""),
                    face_ids=tuple(int(x) for x in (vol.get("face_ids") or [])),
                    role="fluid",
                    region="fluid",
                )
                for vol in g.volumes
                if str(vol.get("id") or "")
            ]
        # Normalize role/region defaults for any pre-v14 body dicts already loaded
        bodies = [
            Body(
                id=b.id,
                name=b.name,
                face_ids=tuple(b.face_ids),
                role=b.role if b.role in ("fluid", "solid", "void") else "fluid",
                region=b.region or "fluid",
            )
            for b in bodies
        ]
        geometries.append(dataclasses.replace(g, bodies=bodies))

    simulations: list[Simulation] = []
    for sim in project.simulations:
        materials = []
        for m in sim.materials:
            m = copy.deepcopy(m)
            _set_material_body_ids(m, _material_body_ids(m))
            materials.append(m)
        simulations.append(dataclasses.replace(sim, materials=materials))

    return dataclasses.replace(
        project, version=14, geometries=geometries, simulations=simulations
    )



def _upgrade_to_v15(project: Project, project_dir: str | Path | None = None) -> Project:
    """Mark web siblings as derived mirrors; ingest if sibling files are newer.

    Compares sibling `updated_at` (else mtime) to project `updated_at`.
    Does not change mesh fingerprints.
    """
    from cfddesk.project.web_mirrors import ingest_web_siblings_if_newer, mark_web_mirrors_derived

    if project_dir is not None:
        return ingest_web_siblings_if_newer(project, project_dir)
    return mark_web_mirrors_derived(project)



def _default_simulation(geometry_id: str) -> Simulation:
    mid = _new_id()
    return Simulation(
        id=_new_id(),
        name=PRIMARY_SIM_NAME,
        analysis_type=PRIMARY_SIM_ANALYSIS,
        geometry_id=geometry_id,
        boundary_conditions=[],
        meshes=[
            MeshNode(
                id=mid,
                name="Mesh 1",
                settings=MeshSettings(),
                results_subdir="results",
            )
        ],
        runs=[],
        active_mesh_id=mid,
    )


def _read_version(path: Path) -> int | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        return int(data.get("version"))
    except (AttributeError, TypeError, ValueError):
        return None


def _recover_runs(
    data: dict,
    *,
    paths: PathsSettings,
    project_dir: str | Path | None,
) -> list[RunNode]:
    """Adopt an existing v4/v5 ``results/`` tree as Run 1 of the migrated sim."""
    if project_dir is None:
        return []
    results_root = Path(project_dir) / paths.local_results
    if not results_root.is_dir() or not _results_look_loadable(results_root):
        return []
    solver = SolverSettings.from_dict(data.get("solver"))
    full = solver.to_dict()
    raw = data.get("solver")
    if isinstance(raw, dict) and raw:
        snapshot = dict(full)
        unrecoverable: list[str] = []
    else:
        snapshot = {}
        unrecoverable = sorted(full)
    return [
        RunNode(
            id=_new_id(),
            name=paths.wsl_case_id or "Run 1",
            results_path=paths.local_results,
            settings_snapshot=snapshot,
            unrecoverable=unrecoverable,
        )
    ]


def _maybe_upgrade_legacy_mesh_fingerprint(project: Project, data: dict) -> Project:
    """Re-stamp when stored hash is the pre-BC-aware ``MeshSettings.fingerprint()``.

    Stamps the v9 quantized formula (**without** ``block_aabb``) so the v10
    block AABB hard-break still marks inflated-block meshes stale. If the stored
    value matches neither legacy nor a known formula, leave it (honest stale).
    """
    mesh_data = data.get("mesh") or {}
    stored = None
    if isinstance(mesh_data, dict):
        stored = mesh_data.get("last_mesh_fingerprint")
    if not stored:
        return project
    if stored == project.mesh_input_fingerprint():
        return project
    if stored == _mesh_input_fingerprint_v9_quantize(project):
        return project
    if stored == project.mesh.fingerprint(quantize_location=False) or stored == (
        project.mesh.fingerprint(quantize_location=True)
    ):
        return project.with_mesh_fingerprint(
            _mesh_input_fingerprint_v9_quantize(project)
        )
    return project


def _migrate_flat_to_hierarchy(
    data: dict,
    *,
    version: int,
    paths: PathsSettings,
    project_dir: str | Path | None,
) -> tuple[list[Geometry], list[Simulation]]:
    """Wrap a flat v4/v5 payload into one Geometry + one Simulation."""
    faces = _faces_from_list(data["faces"])
    mesh_data = data.get("mesh") or {}
    mesh = MeshSettings.from_dict(mesh_data)
    boundary = BoundarySettings.from_dict(data.get("boundary"))
    bcs_data = data.get("boundary_conditions")
    if bcs_data is not None:
        bcs = [BoundaryCondition.from_dict(item) for item in bcs_data]
    elif version < 5:
        bcs = _migrate_v4_bcs(faces, boundary, mesh)
    else:
        bcs = []

    geometry = Geometry(
        id=_new_id(),
        name="Geometry 1",
        step_path=str(data["step_path"]),
        faces=faces,
    )
    mesh_node = MeshNode(
        id=_new_id(),
        name="Mesh 1",
        settings=mesh,
        last_mesh_fingerprint=mesh_data.get("last_mesh_fingerprint"),
        results_subdir="results",
    )
    runs = _recover_runs(data, paths=paths, project_dir=project_dir)
    runs = [dataclasses.replace(r, mesh_id=r.mesh_id or mesh_node.id) for r in runs]
    simulation = Simulation(
        id=_new_id(),
        name=PRIMARY_SIM_NAME,
        analysis_type=PRIMARY_SIM_ANALYSIS,
        geometry_id=geometry.id,
        boundary_conditions=bcs,
        meshes=[mesh_node],
        runs=runs,
        solver=SolverSettings.from_dict(data.get("solver")),
        boundary=boundary,
        materials=[],
        active_mesh_id=mesh_node.id,
    )
    return [geometry], [simulation]


def _migrate_v4_bcs(
    faces: list[FaceFingerprint],
    boundary: BoundarySettings,
    mesh: MeshSettings,
) -> list[BoundaryCondition]:
    """Build v5 BCs from v4 face roles + BoundarySettings; keep inlet/outlet/walls."""
    by_role: dict[FaceRole, list[int]] = {
        "inlet": [],
        "outlet": [],
        "walls": [],
        "unassigned": [],
    }
    for f in faces:
        by_role.setdefault(f.role, []).append(f.face_id)

    bcs: list[BoundaryCondition] = []
    if by_role["inlet"]:
        settings = default_settings("velocity_inlet_fixed")
        settings["speed_m_s"] = boundary.inlet_speed_m_s
        settings["direction_mode"] = boundary.inlet_direction_mode
        settings["velocity"] = list(boundary.inlet_vector)
        bcs.append(
            BoundaryCondition(
                id=_new_bc_id(),
                name="Velocity inlet 1",
                patch_name="inlet",
                type="velocity_inlet_fixed",
                settings=settings,
                face_ids=sorted(by_role["inlet"]),
                refinement_level=mesh.refinement.inlet,
            )
        )
    if by_role["outlet"]:
        settings = default_settings("pressure_outlet_gauge")
        settings["gauge_pressure"] = boundary.outlet_p
        bcs.append(
            BoundaryCondition(
                id=_new_bc_id(),
                name="Pressure outlet 1",
                patch_name="outlet",
                type="pressure_outlet_gauge",
                settings=settings,
                face_ids=sorted(by_role["outlet"]),
                refinement_level=mesh.refinement.outlet,
            )
        )
    if by_role["walls"]:
        bcs.append(
            BoundaryCondition(
                id=_new_bc_id(),
                name="Wall no-slip 1",
                patch_name="walls",
                type="wall_noslip",
                settings=default_settings("wall_noslip"),
                face_ids=sorted(by_role["walls"]),
                refinement_level=mesh.refinement.walls,
            )
        )
    return bcs


@dataclass
class ProjectLoadResult:
    project: Project
    mismatch: FingerprintMismatch | None

    @property
    def roles_trusted(self) -> bool:
        return self.mismatch is None


def _parse_role(value: object) -> FaceRole:
    s = str(value)
    if s in ROLES:
        return s
    return "unassigned"


def fingerprints_match(
    stored: list[FaceFingerprint],
    live: list[FaceRecord],
    *,
    centroid_tol: float = DEFAULT_CENTROID_TOL,
    area_tol_abs: float = DEFAULT_AREA_TOL_ABS,
    area_tol_rel: float = DEFAULT_AREA_TOL_REL,
) -> FingerprintMismatch | None:
    """Compare stored fingerprints to freshly derived STEP faces."""
    details: list[str] = []
    if len(stored) != len(live):
        return FingerprintMismatch(
            reason="face_count",
            details=[f"stored={len(stored)} live={len(live)}"],
        )

    by_id = {f.face_id: f for f in stored}
    for rec in live:
        fp = by_id.get(rec.face_id)
        if fp is None:
            details.append(f"face {rec.face_id}: missing from project.json")
            continue
        dx = abs(fp.centroid[0] - rec.centroid[0])
        dy = abs(fp.centroid[1] - rec.centroid[1])
        dz = abs(fp.centroid[2] - rec.centroid[2])
        if max(dx, dy, dz) > centroid_tol:
            details.append(
                f"face {rec.face_id}: centroid drift "
                f"stored={fp.centroid} live={rec.centroid}"
            )
        area_tol = max(area_tol_abs, area_tol_rel * max(abs(fp.area), abs(rec.area), 1.0))
        if abs(fp.area - rec.area) > area_tol:
            details.append(
                f"face {rec.face_id}: area drift stored={fp.area} live={rec.area}"
            )

    if details:
        return FingerprintMismatch(reason="geometry", details=details)
    return None


def load_project_against_solid(
    path: str | Path, solid: LoadedSolid
) -> ProjectLoadResult:
    """Load project.json and validate fingerprints against ``solid``."""
    project = Project.load(path)
    mismatch = fingerprints_match(project.faces, solid.faces)
    if mismatch is not None:
        cleared = Project.from_solid(solid, roles=None, preserve=project)
        # Strip face assignments on mismatch but keep BC definitions.
        cleared_bcs = [
            dataclasses.replace(bc, face_ids=[]) for bc in cleared.boundary_conditions
        ]
        cleared = cleared.with_boundary_conditions(cleared_bcs)
        return ProjectLoadResult(project=cleared, mismatch=mismatch)
    trusted = Project.from_solid(solid, roles=None, preserve=project)
    return ProjectLoadResult(project=trusted, mismatch=None)
