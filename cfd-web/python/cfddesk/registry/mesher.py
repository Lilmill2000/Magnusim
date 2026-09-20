"""MeshBackend registry spec (Phase 2 land4)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

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


def analysis_has_mesh_bags(hub: RegistryHub) -> bool:
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


def geometry_region_count(project: Any) -> int:
    """Number of distinct body regions on the primary geometry (0 if none)."""
    geom = getattr(project, "primary_geometry", lambda: None)()
    if geom is None:
        return 0
    bodies = getattr(geom, "bodies", None) or []
    if not bodies:
        return 0
    return len({getattr(b, "region", "fluid") for b in bodies})


def validate_multi_region_meshing(
    project: Any,
    mesher: MeshBackend | None,
) -> list[str]:
    """Reject multi-region geometry when the mesher does not support it.

    Built-ins all have ``multi_region=False`` this phase; Phase 6 CHT provides
    a multi-region backend. Soft-pass: do not enable multi-region meshing.
    """
    errors: list[str] = []
    n_regions = geometry_region_count(project)
    if n_regions <= 1:
        return errors
    if mesher is None or not bool(getattr(mesher, "multi_region", False)):
        key = getattr(mesher, "key", None) if mesher is not None else None
        label = f" mesher={key!r}" if key else ""
        errors.append(
            f"multi-region geometry ({n_regions} regions) requires a "
            f"MeshBackend with multi_region=True{label}"
        )
    return errors

