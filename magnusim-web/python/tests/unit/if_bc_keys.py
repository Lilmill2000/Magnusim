"""Incompressible Flow's BC type and family keys, as the core's tests expect them.

The core's tests may not import the plugin; the keys are listed here once. The
first seven are the keys projects have always stored.
"""

from __future__ import annotations

STORED_BC_KEYS: tuple[str, ...] = (
    "velocity_inlet_fixed",
    "velocity_inlet_volumetric",
    "velocity_inlet_mass",
    "velocity_outlet",
    "pressure_outlet_gauge",
    "wall_noslip",
    "wall_slip",
)
IF_BC_KEYS: tuple[str, ...] = (
    *STORED_BC_KEYS,
    "symmetry",
    "freestream",
    "wall_moving",
    "wall_rotating",
    "total_pressure_inlet",
)
IF_BC_FAMILIES: tuple[str, ...] = (
    "velocity_inlet",
    "velocity_outlet",
    "pressure_outlet",
    "total_pressure_inlet",
    "freestream",
    "wall",
    "symmetry",
)
