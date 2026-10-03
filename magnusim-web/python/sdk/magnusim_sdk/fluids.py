"""Fluid presets (Air, Water, ...) and reference constants at 20 °C, 1 atm.

RHO_AIR and NU_AIR are dry air at 20 °C, 1 atm (Cengel, Fluid Mechanics,
table A-15: ρ 1.204 kg/m³, ν 1.516e-5 m²/s). The Incompressible Flow
plugin's material presets are the values the app uses; LIBRARY agrees with them
(the plugin's tests pin it).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Used by the library Air entry — import these; do not re-type. Old project
# migrations keep their own frozen copy (cfddesk.project.legacy_sim), not these.
RHO_AIR = 1.204  # kg/m³, dry air at 20 °C, 1 atm
NU_AIR = 1.516e-5  # m²/s, dry air at 20 °C, 1 atm


@dataclass(frozen=True)
class LibraryMaterial:
    key: str
    name: str
    viscosity_model: str
    nu: float  # m²/s
    rho: float  # kg/m³


# Values at 20 °C, 1 atm.
LIBRARY: list[LibraryMaterial] = [
    LibraryMaterial("air", "Air", "Newtonian", NU_AIR, RHO_AIR),
    LibraryMaterial("argon", "Argon", "Newtonian", 1.34e-5, 1.661),
    LibraryMaterial("co2", "Carbon dioxide", "Newtonian", 8.03e-6, 1.842),
    LibraryMaterial("hydrogen", "Hydrogen", "Newtonian", 1.05e-4, 0.0838),
    LibraryMaterial("nitrogen", "Nitrogen", "Newtonian", 1.51e-5, 1.165),
    LibraryMaterial("water", "Water", "Newtonian", 1.004e-6, 998.2),
    LibraryMaterial("seawater", "Seawater (3.5% saline)", "Newtonian", 1.05e-6, 1025.0),
    LibraryMaterial("custom", "Custom fluid", "Newtonian", NU_AIR, RHO_AIR),
]


def by_key(key: str) -> LibraryMaterial:
    for m in LIBRARY:
        if m.key == key:
            return m
    raise KeyError(key)


def default_air_dict(
    *,
    material_id: str,
    volume_ids: list[str] | None = None,
    body_ids: list[str] | None = None,
) -> dict[str, Any]:
    air = by_key("air")
    ids = list(body_ids if body_ids is not None else (volume_ids or []))
    return {
        "id": material_id,
        "name": air.name,
        "library_key": air.key,
        "viscosity_model": air.viscosity_model,
        "nu": air.nu,
        "rho": air.rho,
        "body_ids": ids,
        "volume_ids": list(ids),  # legacy alias
    }


def search(query: str) -> list[LibraryMaterial]:
    q = query.strip().lower()
    if not q:
        return list(LIBRARY)
    return [m for m in LIBRARY if q in m.name.lower() or q in m.key.lower()]
