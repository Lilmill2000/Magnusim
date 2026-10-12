"""MaterialModel registry spec (Phase 2 land5)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

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
    # Accepted, not read: the analysis's write_case writes the model's files.
    write_files: Callable[..., None] | None = None
    # Presets, in picker order: {"key", "name", "values": {property: SI value},
    # "library": the code a record saves, "codes": codes a saved record may carry
    # for it (e.g. ("AIR", "DEFAULT"); DEFAULT marks a new material's preset),
    # "names": record names read as it (any case), and optionally
    # "legacy_values": what a saved record of it that lacks a number reads}.
    library: tuple[dict[str, Any], ...] = ()
    # API 1.4: how a study's material record stores this model's properties.
    # record_keys: property -> the record keys that may hold it, first preferred,
    # e.g. {"nu": ("kinematic_viscosity", "nu"), "rho": ("density", "rho")}.
    record_keys: dict[str, tuple[str, ...]] = field(default_factory=dict)
    # Values every record of this model carries, e.g. {"type": "Newtonian"}.
    record_constants: dict[str, Any] = field(default_factory=dict)
    # The preset name a record has once its values are edited by hand.
    custom_preset: str = "custom"
    # API 1.8: what a body with this material is, "fluid" or "solid". An analysis
    # that lists more than one model lets a study hold several material records,
    # one per group of bodies; a solid record makes its bodies a solid region.
    role: str = "fluid"


MATERIAL_ROLES: tuple[str, ...] = ("fluid", "solid")


def validate_analysis_material_refs(hub: RegistryHub) -> None:
    """Fail if any AnalysisType.material_models key is not registered."""
    materials = hub.registry("material")
    mat_keys = set(materials.keys())
    for model in materials.items():
        role = str(getattr(model, "role", "fluid") or "fluid")
        if role not in MATERIAL_ROLES:
            for spec in hub.registry("analysis").items():
                if getattr(model, "key", None) in tuple(getattr(spec, "material_models", ()) or ()):
                    raise RegistryError(
                        f"analysis {getattr(spec, 'key', '?')!r}: material {model.key!r} has role {role!r}; "
                        f"a role is one of {list(MATERIAL_ROLES)}"
                    )
    for spec in hub.registry("analysis").items():
        bag = tuple(getattr(spec, "material_models", ()) or ())
        unknown = [k for k in bag if k not in mat_keys]
        if unknown:
            key = getattr(spec, "key", "?")
            raise RegistryError(
                f"analysis {key!r}: unknown material key(s) {unknown}; "
                f"registered materials={sorted(mat_keys)}"
            )
