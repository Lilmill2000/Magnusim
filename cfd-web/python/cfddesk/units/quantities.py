"""Quantity unit tables (SI storage; display conversion via convert.py)."""

from __future__ import annotations

from typing import Literal

Quantity = Literal[
    "velocity",
    "pressure",
    "volumetric_flow",
    "mass_flow",
    "length",
    "temperature",
    "time",
    "angular_velocity",
    "density",
    "kinematic_viscosity",
]

# Multiplicative factors: value_si = value_display * factor  (temperature is affine — see convert.py)
UNITS: dict[Quantity, dict[str, float]] = {
    "velocity": {"m/s": 1.0, "km/h": 1.0 / 3.6, "mph": 0.44704, "ft/s": 0.3048},
    "pressure": {
        "Pa": 1.0,
        "kPa": 1e3,
        "bar": 1e5,
        "psi": 6894.757293168,
        "inH₂O": 249.08891,
        "mmH₂O": 9.80665,
    },
    "volumetric_flow": {
        "m³/s": 1.0,
        "L/s": 1e-3,
        "CFM": 0.00047194745,
        "ft3/min": 0.00047194745,
        "ft³/min": 0.00047194745,
        "m³/h": 1.0 / 3600.0,
    },
    "mass_flow": {"kg/s": 1.0, "kg/h": 1.0 / 3600.0, "lb/s": 0.45359237},
    "length": {"m": 1.0, "mm": 1e-3, "cm": 1e-2, "in": 0.0254, "ft": 0.3048},
    "temperature": {"K": 1.0, "°C": 1.0, "°F": 1.0},  # affine handled in convert
    "time": {"s": 1.0, "min": 60.0, "h": 3600.0},
    "angular_velocity": {"rad/s": 1.0, "rpm": 2.0 * 3.141592653589793 / 60.0},
    "density": {"kg/m³": 1.0, "lb/ft³": 16.01846337},
    "kinematic_viscosity": {
        "m²/s": 1.0,
        "cSt": 1e-6,
        "ft²/s": 0.09290304,
    },
}

SI_DEFAULT: dict[Quantity, str] = {
    "velocity": "m/s",
    "pressure": "Pa",
    "volumetric_flow": "m³/s",
    "mass_flow": "kg/s",
    "length": "m",
    "temperature": "K",
    "time": "s",
    "angular_velocity": "rad/s",
    "density": "kg/m³",
    "kinematic_viscosity": "m²/s",
}


def unit_labels(quantity: Quantity) -> list[str]:
    return list(UNITS[quantity].keys())
