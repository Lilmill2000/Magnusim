"""MeshBackend registry spec (Phase 2 land4)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


@dataclass(frozen=True)
class MeshBackend:
    """Registered mesher backend (Standard / cfMesh / hex-dominant snappy).

    Named MeshBackend (not MeshAlgorithm / HexcoreBackend) so it does not
    collide with project.settings Literals — same lesson as SolverApp vs
    settings.SolverBackend (cpu|amgx).
    """

    key: str
    label: str
    settings_schema: tuple[SchemaField, ...]
    refinement_types: tuple[str, ...]
    tool: str
    # Soft-pass stubs — fingerprint / generate wiring stays in Phase 1 paths.
    fingerprint_payload: Callable[..., dict[str, Any]] | None = None
    supports_hex_core: bool = False
    requires: tuple[Requirement, ...] = ()
    frozen: bool = False  # cfmesh: True (hexcore-cfmesh-backup rule)
    multi_region: bool = False


def analysis_has_mesh_bags(hub: "RegistryHub") -> bool:
    """True if any AnalysisType exposes mesh_backends / mesh_backend string bags.

    land4 soft-pass: AnalysisType currently has none — do not invent a bag.
    Kept as a probe so a later land can wire validation when bags appear.
    """
    for spec in hub.registry("analysis").items():
        if hasattr(spec, "mesh_backends") or hasattr(spec, "mesh_backend"):
            return True
        if hasattr(spec, "default_mesher") or hasattr(spec, "meshers"):
            return True
    return False
