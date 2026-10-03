"""The fluids a study can solve: the Newtonian incompressible material model.

The model publishes its presets (the Fluid picker's list), how a study's
material record stores the properties (``record_keys``, ``record_constants``)
and the property fields (kinematic viscosity, density). The core's Materials
panel and ``POST /api/materials`` read all of it from the registry, so these
presets are the one copy of each fluid's values.

Values are at 20 C, 1 atm. Air is Cengel, Fluid Mechanics, table A-15.

A saved record keeps its own numbers. ``LEGACY_AIR`` is what the app filled in
for an Air (or custom) record that has no numbers before the presets moved
here: it stays frozen so an older project solves exactly as it did.
"""

from __future__ import annotations

from typing import Any

from cfddesk.registry.material import MaterialModel
from cfddesk.registry.schema import SchemaField

MODEL_KEY = "newtonian_incompressible"

# Air at 20 C, 1 atm: what a new study's Air gets (SI: m^2/s, kg/m^3).
AIR: dict[str, float] = {"nu": 1.516e-5, "rho": 1.204}

# Frozen: never change. Read only for a saved record that lacks a number.
LEGACY_AIR: dict[str, float] = {"nu": 1.529e-5, "rho": 1.196}

CUSTOM_PRESET = "custom"


def _preset(
    key: str,
    name: str,
    nu: float,
    rho: float,
    library: str,
    *,
    codes: tuple[str, ...] = (),
    names: tuple[str, ...] | None = None,
    legacy: dict[str, float] | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "key": key,
        "name": name,
        "values": {"nu": nu, "rho": rho},
        "library": library,
        "codes": codes or (library,),
        "names": (name,) if names is None else names,
    }
    if legacy:
        row["legacy_values"] = dict(legacy)
    return row


# The Fluid picker's list, in order. A record names its preset by "preset"
# (key), else by "library" (one of codes), else by its name (one of names,
# any case). "legacy_values" are what a saved record of the preset that lacks
# a number reads (what older versions filled in); without them, "values".
PRESETS: tuple[dict[str, Any], ...] = (
    _preset("air", "Air", AIR["nu"], AIR["rho"], "AIR", codes=("AIR", "DEFAULT"), legacy=LEGACY_AIR),
    _preset("argon", "Argon", 1.34e-5, 1.661, "ARGON"),
    _preset("co2", "Carbon dioxide", 8.03e-6, 1.842, "CO2", names=("Carbon dioxide", "CO2")),
    _preset("hydrogen", "Hydrogen", 1.05e-4, 0.0838, "HYDROGEN"),
    _preset("nitrogen", "Nitrogen", 1.51e-5, 1.165, "NITROGEN"),
    _preset("water", "Water", 1.004e-6, 998.2, "WATER"),
    _preset(
        "seawater",
        "Seawater (3.5% saline)",
        1.05e-6,
        1025.0,
        "SEAWATER",
        names=("Seawater (3.5% saline)", "Seawater"),
    ),
    # A fluid of the user's own: it starts from Air's numbers and keeps the ones typed.
    _preset(CUSTOM_PRESET, "Custom fluid", AIR["nu"], AIR["rho"], "CUSTOM", names=(), legacy=LEGACY_AIR),
)

# How a study's material record stores each property: the record keys that may
# hold it, the first preferred. Every one of them is written.
RECORD_KEYS: dict[str, tuple[str, ...]] = {
    "nu": ("kinematic_viscosity", "nu"),
    "rho": ("density", "rho"),
}

# What every record of this model carries.
RECORD_CONSTANTS: dict[str, Any] = {
    "type": "Newtonian",
    "viscosity_model": "Newtonian",
    "kinematic_viscosity_unit": "m2/s",
    "density_unit": "kg/m3",
}


def preset(key: str) -> dict[str, Any]:
    """The preset row of ``key`` (KeyError if there is none)."""
    for row in PRESETS:
        if row["key"] == key:
            return row
    raise KeyError(key)


def _newtonian_properties_schema() -> tuple[SchemaField, ...]:
    return (
        SchemaField(
            "nu",
            "(ν) Kinematic viscosity",
            "float",
            default=AIR["nu"],
            min=0.0,
            unit="m^2/s",
            group="transport",
            quantity="kinematic_viscosity",
        ),
        SchemaField(
            "rho",
            "(ρ) Density",
            "float",
            default=AIR["rho"],
            min=0.0,
            unit="kg/m^3",
            group="transport",
            quantity="density",
        ),
    )


def build_newtonian_incompressible() -> MaterialModel:
    return MaterialModel(
        key=MODEL_KEY,
        label="Newtonian (incompressible)",
        properties_schema=_newtonian_properties_schema(),
        library=PRESETS,
        record_keys=RECORD_KEYS,
        record_constants=RECORD_CONSTANTS,
        custom_preset=CUSTOM_PRESET,
    )
