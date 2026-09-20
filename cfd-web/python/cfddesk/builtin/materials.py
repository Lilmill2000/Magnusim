"""Built-in MaterialModel specs (Phase 2 land5)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from cfddesk.materials.library import LIBRARY
from cfddesk.registry.material import MaterialModel
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def _library_presets() -> tuple[dict[str, Any], ...]:
    """Presets from materials/library.py (Air, Water, ...) — no rewrite of library."""
    return tuple(
        {
            "key": m.key,
            "name": m.name,
            "viscosity_model": m.viscosity_model,
            "nu": m.nu,
            "rho": m.rho,
        }
        for m in LIBRARY
    )


def _newtonian_properties_schema() -> tuple[SchemaField, ...]:
    return (
        SchemaField(
            "nu",
            "Kinematic viscosity",
            "float",
            default=1.5e-5,
            min=0.0,
            unit="m^2/s",
            group="transport",
        ),
        SchemaField(
            "rho",
            "Density",
            "float",
            default=1.204,
            min=0.0,
            unit="kg/m^3",
            group="transport",
        ),
    )


def build_newtonian_incompressible() -> MaterialModel:
    return MaterialModel(
        key="newtonian_incompressible",
        label="Newtonian (incompressible)",
        properties_schema=_newtonian_properties_schema(),
        write_files=None,  # NOT_yet_done: transportProperties still Phase 1
        library=_library_presets(),
    )


def register_materials(hub: RegistryHub) -> None:
    """Register newtonian_incompressible (idempotent same-plugin)."""
    reg = hub.registry("material")
    reg.register(build_newtonian_incompressible(), plugin="builtin")
