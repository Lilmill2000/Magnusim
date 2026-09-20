"""SI ↔ display conversion. Temperature uses affine transforms (°C / °F)."""

from __future__ import annotations

from cfddesk.units.quantities import UNITS, Quantity


def to_si(quantity: Quantity, value: float, unit: str) -> float:
    if quantity == "temperature":
        if unit == "K":
            return float(value)
        if unit == "°C":
            return float(value) + 273.15
        if unit == "°F":
            return (float(value) - 32.0) * 5.0 / 9.0 + 273.15
        raise ValueError(f"unknown temperature unit {unit!r}")
    table = UNITS[quantity]
    if unit not in table:
        raise ValueError(f"unknown {quantity} unit {unit!r}")
    return float(value) * table[unit]


def from_si(quantity: Quantity, value_si: float, unit: str) -> float:
    if quantity == "temperature":
        if unit == "K":
            return float(value_si)
        if unit == "°C":
            return float(value_si) - 273.15
        if unit == "°F":
            return (float(value_si) - 273.15) * 9.0 / 5.0 + 32.0
        raise ValueError(f"unknown temperature unit {unit!r}")
    table = UNITS[quantity]
    if unit not in table:
        raise ValueError(f"unknown {quantity} unit {unit!r}")
    return float(value_si) / table[unit]
