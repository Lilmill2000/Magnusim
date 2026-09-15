"""MaterialModel registry spec (Phase 2 land5)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from cfddesk.registry.base import RegistryError
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


@dataclass(frozen=True)
class MaterialModel:
    """Registered material / constitutive model (e.g. newtonian incompressible)."""

    key: str
    label: str
    properties_schema: tuple[SchemaField, ...]
    # Soft-pass stub — transportProperties write stays in Phase 1 paths this land.
    write_files: Callable[..., None] | None = None
    library: tuple[dict[str, Any], ...] = ()


def validate_analysis_material_refs(hub: "RegistryHub") -> None:
    """Fail if any AnalysisType.material_models key is not registered."""
    mat_keys = set(hub.registry("material").keys())
    for spec in hub.registry("analysis").items():
        bag = tuple(getattr(spec, "material_models", ()) or ())
        unknown = [k for k in bag if k not in mat_keys]
        if unknown:
            key = getattr(spec, "key", "?")
            raise RegistryError(
                f"analysis {key!r}: unknown material key(s) {unknown}; "
                f"registered materials={sorted(mat_keys)}"
            )
