"""v7 nested project hierarchy: Geometry, Simulation, Mesh, Run."""

from __future__ import annotations

import copy
import dataclasses
import uuid
from dataclasses import dataclass, field
from typing import Any

from cfddesk.project.settings import (
    BoundarySettings,
    MeshSettings,
    SolverSettings,
)
from cfddesk.project.mesh_refinements import (
    MeshRefinementStub,
    parse_refinement_stubs,
)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def default_results_subdir(mesh_id: str, *, legacy_primary: bool = False) -> str:
    """Windows-local results tree for a mesh node.

    Migrated primary meshes keep ``results`` so existing copy-backs still resolve.
    New meshes use ``results/mesh-<id>``.
    """
    if legacy_primary:
        return "results"
    return f"results/mesh-{mesh_id}"


def default_run_results_subdir(mesh_id: str, run_id: str) -> str:
    """Windows-local results tree for one solve run (isolated from siblings).

    Mesh polyMesh stays at ``results/mesh-<id>``. Each Run copy-back goes to
    ``results/mesh-<id>/run-<id>`` so a later turbulence model cannot wipe
    the previous field.
    """
    return f"results/mesh-{mesh_id}/run-{run_id}"


def next_run_name(runs: list[RunNode], turbulence: str) -> str:
    """Return the next free ``<turbulence> N`` label (e.g. ``kOmegaSST 1``)."""
    label = (turbulence or "Run").strip() or "Run"
    existing = {r.name for r in runs}
    n = 1
    while f"{label} {n}" in existing:
        n += 1
    return f"{label} {n}"


@dataclass
class Geometry:
    id: str
    name: str
    step_path: str
    # Face geometry only — no role in serialization (BC membership is source of truth)
    faces: list  # list[FaceFingerprint] — typed loosely to avoid cycle
    # TopAbs_SOLID enumeration: [{id, name, face_ids}]
    volumes: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "step_path": self.step_path,
            "faces": [
                {
                    "id": f.face_id,
                    "centroid": list(f.centroid),
                    "area": f.area,
                    **({"bc_id": f.bc_id} if f.bc_id else {}),
                }
                for f in self.faces
            ],
            "volumes": copy.deepcopy(self.volumes),
        }


@dataclass
class MeshNode:
    id: str
    name: str
    settings: MeshSettings
    last_mesh_fingerprint: str | None = None
    results_subdir: str = ""
    n_cells: int | None = None
    n_points: int | None = None
    # Inc 7a/7b: named Refinements children (inflate payload for parametric only).
    refinements: list[MeshRefinementStub] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.results_subdir:
            self.results_subdir = default_results_subdir(self.id)

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "settings": self.settings.to_dict(),
            "results_subdir": self.results_subdir,
            "refinements": [r.to_dict() for r in self.refinements],
        }
        if self.last_mesh_fingerprint is not None:
            d["last_mesh_fingerprint"] = self.last_mesh_fingerprint
        if self.n_cells is not None:
            d["n_cells"] = int(self.n_cells)
        if self.n_points is not None:
            d["n_points"] = int(self.n_points)
        return d

    @staticmethod
    def from_dict(data: dict) -> MeshNode:
        mid = str(data.get("id") or _new_id())
        settings = MeshSettings.from_dict(data.get("settings") or data)
        results_subdir = data.get("results_subdir")
        if not results_subdir:
            # Pre-v13 nodes: preserve classic single-tree path until upgrade
            # rewrites explicitly; default still valid if upgrade is skipped.
            results_subdir = "results"
        n_cells = data.get("n_cells")
        n_points = data.get("n_points")
        return MeshNode(
            id=mid,
            name=str(data.get("name") or "Mesh 1"),
            settings=settings,
            last_mesh_fingerprint=data.get("last_mesh_fingerprint"),
            results_subdir=str(results_subdir),
            n_cells=int(n_cells) if n_cells is not None else None,
            n_points=int(n_points) if n_points is not None else None,
            refinements=parse_refinement_stubs(data.get("refinements")),
        )


def next_mesh_name(meshes: list[MeshNode]) -> str:
    """Return the next free ``Mesh N`` label."""
    existing = {m.name for m in meshes}
    n = 1
    while f"Mesh {n}" in existing:
        n += 1
    return f"Mesh {n}"


@dataclass
class RunNode:
    id: str
    name: str
    results_path: str
    settings_snapshot: dict[str, Any] = field(default_factory=dict)
    unrecoverable: list[str] = field(default_factory=list)
    mesh_id: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "results_path": self.results_path,
            "settings_snapshot": copy.deepcopy(self.settings_snapshot),
            "unrecoverable": list(self.unrecoverable),
            "mesh_id": self.mesh_id,
        }

    @staticmethod
    def from_dict(data: dict) -> RunNode:
        return RunNode(
            id=str(data.get("id") or _new_id()),
            name=str(data.get("name") or "Run 1"),
            results_path=str(data.get("results_path") or "results"),
            settings_snapshot=copy.deepcopy(data.get("settings_snapshot") or {}),
            unrecoverable=list(data.get("unrecoverable") or []),
            mesh_id=str(data.get("mesh_id") or ""),
        )


@dataclass
class Simulation:
    id: str
    name: str
    analysis_type: str
    geometry_id: str
    boundary_conditions: list  # list[BoundaryCondition]
    meshes: list[MeshNode]
    runs: list[RunNode]
    solver: SolverSettings = field(default_factory=SolverSettings)
    boundary: BoundarySettings = field(default_factory=BoundarySettings)
    materials: list[dict[str, Any]] = field(default_factory=list)
    # Stubs for tree nodes
    initial_conditions: dict[str, Any] = field(default_factory=dict)
    advanced_concepts: dict[str, Any] = field(default_factory=dict)
    numerics: dict[str, Any] = field(default_factory=dict)
    simulation_control: dict[str, Any] = field(default_factory=dict)
    result_control: dict[str, Any] = field(default_factory=dict)
    active_mesh_id: str = ""
    active_run_id: str = ""

    def primary_mesh(self) -> MeshNode:
        if not self.meshes:
            mid = _new_id()
            self.meshes = [
                MeshNode(
                    id=mid,
                    name="Mesh 1",
                    settings=MeshSettings(),
                    results_subdir=default_results_subdir(mid, legacy_primary=True),
                )
            ]
        return self.meshes[0]

    def active_mesh(self) -> MeshNode:
        """Mesh selected for the panel / Generate (falls back to primary)."""
        primary = self.primary_mesh()
        if self.active_mesh_id:
            for m in self.meshes:
                if m.id == self.active_mesh_id:
                    return m
        return primary

    def mesh_by_id(self, mesh_id: str) -> MeshNode | None:
        for m in self.meshes:
            if m.id == mesh_id:
                return m
        return None

    def run_by_id(self, run_id: str) -> RunNode | None:
        for r in self.runs:
            if r.id == run_id:
                return r
        return None

    def active_run(self) -> RunNode | None:
        """Selected run for results view. No silent fallback to runs[0]."""
        if self.active_run_id:
            return self.run_by_id(self.active_run_id)
        return None

    def add_mesh_node(
        self,
        *,
        name: str | None = None,
        settings: MeshSettings | None = None,
        copy_settings_from_active: bool = True,
    ) -> tuple[Simulation, MeshNode]:
        """Append a new mesh; returns (updated simulation, new node).

        Does not mutate ``self`` — returns a replaced ``Simulation``.
        """
        mid = _new_id()
        if settings is not None:
            mesh_settings = copy.deepcopy(settings)
        elif copy_settings_from_active:
            mesh_settings = copy.deepcopy(self.active_mesh().settings)
        else:
            mesh_settings = MeshSettings()
        node = MeshNode(
            id=mid,
            name=name or next_mesh_name(self.meshes),
            settings=mesh_settings,
            results_subdir=default_results_subdir(mid),
            last_mesh_fingerprint=None,
            n_cells=None,
            n_points=None,
        )
        meshes = list(self.meshes) + [node]
        sim = dataclasses.replace(self, meshes=meshes, active_mesh_id=mid)
        return sim, node

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "analysis_type": self.analysis_type,
            "geometry_id": self.geometry_id,
            "materials": copy.deepcopy(self.materials),
            "initial_conditions": copy.deepcopy(self.initial_conditions),
            "boundary_conditions": [bc.to_dict() for bc in self.boundary_conditions],
            "advanced_concepts": copy.deepcopy(self.advanced_concepts),
            "numerics": copy.deepcopy(self.numerics),
            "simulation_control": copy.deepcopy(self.simulation_control),
            "result_control": copy.deepcopy(self.result_control),
            "solver": self.solver.to_dict(),
            "boundary": self.boundary.to_dict(),
            "meshes": [m.to_dict() for m in self.meshes],
            "runs": [r.to_dict() for r in self.runs],
            "active_mesh_id": self.active_mesh_id or self.primary_mesh().id,
            "active_run_id": self.active_run_id,
        }
