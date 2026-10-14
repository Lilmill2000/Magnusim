"""Heat Transfer's thermal fields on Incompressible Flow's boundary conditions.

The analyses add a "Thermal" group to the BC families they offer (host API 1.8
``bc_fields``): the BC editor draws it under the family's own settings, in
Heat Transfer studies only, and saves it in the same BC record. Temperatures
are stored in K (the editor shows °C or °F with a unit picker), heat flux in
W/m² and the heat transfer coefficient in W/(m²·K).

- velocity inlets and total-pressure inlets: the temperature of the fluid coming in;
- velocity outlets, pressure boundaries and freestreams: the temperature of any
  fluid that flows back in;
- walls: adiabatic, a fixed temperature, a heat flux (positive heats the
  fluid) or a heat transfer coefficient to an ambient temperature.

The walls no BC claims are adiabatic.

A field the record does not hold is solved at the value the BC editor shows for
it, the field's own default (an inlet at 20 °C, whatever the study's reference
temperature): what the editor shows and what is solved never differ.
"""

from __future__ import annotations

import math
from typing import Any

from cfddesk.registry.bc import BcFieldGroup
from cfddesk.registry.schema import SchemaField

from .physics import DEFAULT_REFERENCE_T

# The editor's default temperatures (20 °C): what a field the user never touched holds.
# Incompressible Flow's BC types and families this plugin's studies offer.
BC_TYPES: tuple[str, ...] = (
    "velocity_inlet_fixed",
    "velocity_inlet_volumetric",
    "velocity_inlet_mass",
    "velocity_outlet",
    "pressure_outlet_gauge",
    "wall_noslip",
    "wall_slip",
    "symmetry",
    "freestream",
    "total_pressure_inlet",
    "wall_moving",
    "wall_rotating",
)

# A new Wall in a Heat Transfer study starts no-slip (host API 1.8 bc_seeds): it is
# added for the heat through it, and a slip wall has no boundary layer (Start refuses
# a slip wall with heat through it). Incompressible Flow's own new Wall starts slip.
BC_SEEDS: dict[str, dict[str, Any]] = {"wall": {"wall_type": "No-slip"}}

INLET_FAMILIES: tuple[str, ...] = ("velocity_inlet", "total_pressure_inlet")
OPENING_FAMILIES: tuple[str, ...] = ("velocity_outlet", "pressure_outlet", "freestream")
WALL_FAMILIES: tuple[str, ...] = ("wall",)

ADIABATIC = "adiabatic"
FIXED_T = "temperature"
HEAT_FLUX = "heat_flux"
HTC = "heat_transfer_coefficient"
WALL_MODES: tuple[str, ...] = (ADIABATIC, FIXED_T, HEAT_FLUX, HTC)
WALL_MODE_LABELS: tuple[str, ...] = (
    "Adiabatic (no heat through it)",
    "Fixed temperature",
    "Heat flux",
    "Heat transfer coefficient",
)

INLET_T = SchemaField(
    "inlet_temperature",
    "Inlet temperature",
    "float",
    default=DEFAULT_REFERENCE_T,
    min=0.0,
    quantity="temperature",
    description="The temperature of the fluid coming in.",
)
BACKFLOW_T = SchemaField(
    "backflow_temperature",
    "Temperature of inflow",
    "float",
    default=DEFAULT_REFERENCE_T,
    min=0.0,
    quantity="temperature",
    description="The temperature of any fluid that flows in through this boundary (usually the surroundings').",
)
WALL_MODE = SchemaField(
    "thermal_condition",
    "Thermal",
    "choice",
    default=ADIABATIC,
    choices=WALL_MODES,
    choice_labels=WALL_MODE_LABELS,
    description=(
        "Adiabatic lets no heat through. A fixed temperature holds the wall at it. A heat flux "
        "puts that much heat per area into the fluid (negative takes it out). A heat transfer "
        "coefficient exchanges heat with an ambient temperature outside the wall."
    ),
)
WALL_T = SchemaField(
    "wall_temperature",
    "Wall temperature",
    "float",
    default=DEFAULT_REFERENCE_T,
    min=0.0,
    quantity="temperature",
    depends_on={"thermal_condition": FIXED_T},
)
WALL_Q = SchemaField(
    "wall_heat_flux",
    "Heat flux",
    "float",
    default=1000.0,
    quantity="heat_flux",
    depends_on={"thermal_condition": HEAT_FLUX},
    description="Heat per area into the fluid; negative cools it.",
)
WALL_H = SchemaField(
    "wall_htc",
    "Heat transfer coefficient",
    "float",
    default=10.0,
    min=0.0,
    quantity="heat_transfer_coefficient",
    depends_on={"thermal_condition": HTC},
)
AMBIENT_T = SchemaField(
    "ambient_temperature",
    "Ambient temperature",
    "float",
    default=DEFAULT_REFERENCE_T,
    min=0.0,
    quantity="temperature",
    depends_on={"thermal_condition": HTC},
)

BC_FIELDS: tuple[BcFieldGroup, ...] = (
    BcFieldGroup("ht_inlet_thermal", "Thermal", (INLET_T,), families=INLET_FAMILIES),
    BcFieldGroup(
        "ht_opening_thermal",
        "Thermal",
        (BACKFLOW_T,),
        families=OPENING_FAMILIES,
        description="Fluid leaving takes its own temperature; fluid coming back in has this one.",
    ),
    BcFieldGroup(
        "ht_wall_thermal",
        "Thermal",
        (WALL_MODE, WALL_T, WALL_Q, WALL_H, AMBIENT_T),
        families=WALL_FAMILIES,
        description="Heat through the wall.",
    ),
)


def _num(value: Any, default: float) -> float:
    if isinstance(value, bool) or value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def wall_mode(rec: dict[str, Any] | None) -> str:
    raw = str((rec or {}).get("thermal_condition") or "").strip().lower()
    return raw if raw in WALL_MODES else ADIABATIC


def _field(rec: dict[str, Any] | None, f: SchemaField) -> float:
    """The record's value of ``f``, else (missing or not a number) the field's default."""
    return _num((rec or {}).get(f.key), float(f.default))


def inlet_temperature(rec: dict[str, Any] | None) -> float:
    """The inlet temperature in K (the editor's default when the record holds none)."""
    return _field(rec, INLET_T)


def backflow_temperature(rec: dict[str, Any] | None) -> float:
    """The temperature of fluid flowing back in, in K (the editor's default when the record holds none)."""
    return _field(rec, BACKFLOW_T)


def wall_thermal(rec: dict[str, Any] | None) -> dict[str, Any]:
    """A wall's thermal condition: ``{mode, T?, q?, h?, Ta?}`` (K, W/m², W/(m²·K)); a value
    the record does not hold is its field's default, as the BC editor shows it."""
    d = rec or {}
    mode = wall_mode(d)
    if mode == FIXED_T:
        return {"mode": mode, "T": _field(d, WALL_T)}
    if mode == HEAT_FLUX:
        return {"mode": mode, "q": _field(d, WALL_Q)}
    if mode == HTC:
        return {"mode": mode, "h": _field(d, WALL_H), "Ta": _field(d, AMBIENT_T)}
    return {"mode": ADIABATIC}


def thermal_problem(rec: dict[str, Any], kind: str) -> str | None:
    """What is wrong with a BC's thermal fields, in the user's words, else None."""
    d = rec or {}
    if kind == "inlet" or kind == "total_pressure":
        if inlet_temperature(d) <= 0:
            return "its inlet temperature must be above absolute zero"
    elif kind in ("pressure", "velocity_outlet", "freestream"):
        if backflow_temperature(d) <= 0:
            return "its temperature of inflow must be above absolute zero"
    elif kind == "wall":
        w = wall_thermal(d)
        if w["mode"] == FIXED_T and w["T"] <= 0:
            return "its wall temperature must be above absolute zero"
        if w["mode"] == HTC:
            if w["h"] <= 0:
                return "its heat transfer coefficient must be above 0"
            if w["Ta"] <= 0:
                return "its ambient temperature must be above absolute zero"
    return None
