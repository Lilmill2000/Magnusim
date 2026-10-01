"""Built-in MaterialModel specs (Phase 2 land5)."""

from __future__ import annotations

from typing import Any

from cfddesk.registry.material import MaterialModel
from cfddesk.registry.schema import SchemaField
from magnusim_sdk.fluids import LIBRARY


def _library_presets() -> tuple[dict[str, Any], ...]:
    """Presets from the SDK fluid library (magnusim_sdk.fluids: Air, Water, ...)."""
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
        library=_library_presets(),
    )
