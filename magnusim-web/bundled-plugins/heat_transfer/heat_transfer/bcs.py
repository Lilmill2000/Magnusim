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

A solid body's outer faces take a "Solid wall" (this plugin's own BC family,
offered in Heat Transfer studies): adiabatic, a fixed temperature, a heat flux
into the solid or a heat transfer coefficient to an ambient temperature. A Wall
on a solid's face is read the same way (its Thermal fields; it has no flow).

A field the record does not hold is solved at the value the BC editor shows for
it, the field's own default (an inlet at 20 °C, whatever the study's reference
temperature): what the editor shows and what is solved never differ.
"""

from __future__ import annotations

import math
from typing import Any

from cfddesk.registry.bc import BcFamily, BcFieldGroup, BcTypeSpec
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
    # This plugin's own: a solid body's outer face.
    "ht_solid_wall",
)

SOLID_WALL_FAMILY = "solid_wall"
SOLID_WALL_TYPE = "ht_solid_wall"
SOLID_WALL_RECORD = "Solid wall"

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

SOLID_WALL_FIELDS: tuple[SchemaField, ...] = (
    SchemaField(
        WALL_MODE.key,
        WALL_MODE.label,
        "choice",
        default=ADIABATIC,
        choices=WALL_MODES,
        choice_labels=WALL_MODE_LABELS,
        description=(
            "Adiabatic lets no heat through. A fixed temperature holds the face at it. A heat flux puts "
            "that much heat per area into the solid (negative takes it out). A heat transfer coefficient "
            "exchanges heat with an ambient temperature outside the face."
        ),
    ),
    WALL_T,
    SchemaField(
        WALL_Q.key,
        WALL_Q.label,
        "float",
        default=1000.0,
        quantity="heat_flux",
        depends_on={"thermal_condition": HEAT_FLUX},
        description="Heat per area into the solid; negative cools it.",
    ),
    WALL_H,
    AMBIENT_T,
)


def _resolve_solid_wall(_rec: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    return SOLID_WALL_TYPE, {}


SOLID_WALL_BC_TYPE = BcTypeSpec(
    SOLID_WALL_TYPE,
    "Solid wall",
    "wall",
    "wall",
    SOLID_WALL_FIELDS,
    family=SOLID_WALL_FAMILY,
)

SOLID_WALL_BC_FAMILY = BcFamily(
    key=SOLID_WALL_FAMILY,
    label="Solid wall",
    record_type=SOLID_WALL_RECORD,
    color="wall",
    hint="A solid body's outer face: adiabatic, a temperature, a heat flux or a heat transfer coefficient",
    variants=(SOLID_WALL_TYPE,),
    defaults={"metric": {"thermal_condition": ADIABATIC}, "imperial": {"thermal_condition": ADIABATIC}},
    fields=SOLID_WALL_FIELDS,
    resolve=_resolve_solid_wall,
)


def is_solid_wall(rec: dict[str, Any] | None) -> bool:
    raw = str((rec or {}).get("bc_type") or "").strip().lower().replace("_", " ")
    return raw == SOLID_WALL_RECORD.lower()


def record_kind(rec: dict[str, Any] | None) -> str | None:
    """What a BC record is: one of Incompressible Flow's kinds, ``solid_wall``, or None."""
    from incompressible_flow.flow_bcs import boundary_kind

    if is_solid_wall(rec):
        return "solid_wall"
    return boundary_kind(rec)


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
    elif kind in ("wall", "solid_wall"):
        w = wall_thermal(d)
        if w["mode"] == FIXED_T and w["T"] <= 0:
            return "its wall temperature must be above absolute zero"
        if w["mode"] == HTC:
            if w["h"] <= 0:
                return "its heat transfer coefficient must be above 0"
            if w["Ta"] <= 0:
                return "its ambient temperature must be above absolute zero"
    return None
