"""MeshBackend registry spec (Phase 2 land4)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


# The refinement records the host stores (scripts/w26-mesh-refinements.js).
HOST_REFINEMENT_TYPES = ("surface_custom_sizing", "inflate_boundary_layer")


@dataclass(frozen=True)
class MeshBackend:
    """Registered mesher backend (Standard / cfMesh / hex-dominant snappy).

    Named MeshBackend (not MeshAlgorithm / HexcoreBackend) so it does not
    collide with the project.settings Literals.
    """

    key: str
    label: str
    settings_schema: tuple[SchemaField, ...]
    # Mesh refinement types this mesher's run applies (from HOST_REFINEMENT_TYPES).
    # The Mesh panel offers exactly these, and the refinements API refuses others
    # on this mesher's meshes.
    refinement_types: tuple[str, ...]
    tool: str
    # Accepted for API 1.0 plugins and not read by the host: fingerprint_payload,
    # generate, supports_hex_core, frozen and multi_region (the schema says what
    # a mesher takes; a mesh run starts from its engine).
    fingerprint_payload: Callable[..., dict[str, Any]] | None = None
    generate: Callable[..., str] | None = None
    supports_hex_core: bool = False
    requires: tuple[Requirement, ...] = ()
    frozen: bool = False
    multi_region: bool = False
    # Which host mesh run path executes this backend: "standard", "cfmesh" or
    # "snappy_hexdominant". A plugin that clones a builtin (dataclasses.replace)
    # inherits it, so its mesher runs through that path with its own key and
    # defaults. Empty = the key itself.
    engine: str = ""
    # What the Mesh panel shows while it runs: (stage, label) for each progress
    # stage its generator reports, and (stage, regex, label) to name one
    # stage's detail lines. A stage with no label shows "Working".
    stage_labels: tuple[tuple[str, str], ...] = ()
    stage_details: tuple[tuple[str, str, str], ...] = ()
    # The finished mesh's summary after the cell counts: (result_key, text, otherwise).
    # A true value shows text, a false one otherwise (empty: nothing); a number
    # shows text with "{length}" as a length in the project's units.
    report: tuple[tuple[str, str, str], ...] = ()


def validate_mesher(spec: Any) -> None:
    """Refuse a mesher whose refinement types, stage labels or report are malformed."""
    import re

    from cfddesk.registry.base import RegistryError

    key = getattr(spec, "key", "?")
    for t in getattr(spec, "refinement_types", ()) or ():
        if t not in HOST_REFINEMENT_TYPES:
            known = ", ".join(HOST_REFINEMENT_TYPES)
            raise RegistryError(f"mesher {key!r}: refinement type {t!r} is not one the host stores ({known})")

    def _strings(rows: Any, n: int, what: str) -> None:
        for row in rows or ():
            if not (isinstance(row, tuple) and len(row) == n and all(isinstance(x, str) for x in row)):
                raise RegistryError(f"mesher {key!r}: each {what} entry is a tuple of {n} strings, got {row!r}")

    _strings(getattr(spec, "stage_labels", ()), 2, "stage_labels")
    _strings(getattr(spec, "stage_details", ()), 3, "stage_details")
    _strings(getattr(spec, "report", ()), 3, "report")
    for _stage, pattern, _label in getattr(spec, "stage_details", ()) or ():
        try:
            re.compile(pattern)
        except re.error as exc:
            raise RegistryError(f"mesher {key!r}: stage_details pattern {pattern!r}: {exc}") from exc


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

