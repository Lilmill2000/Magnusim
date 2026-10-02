"""Frozen values the old project.json migrations read.

These are copies of what old files were written with, kept here so a
migration means today what it meant when the file was saved. They must never
follow the fluids library, the BC registry or a plugin's defaults: when those
change, these stay.

- ``V7_ASSUMED_DENSITY_KG_M3``: the density pre-v7 files are assumed to use
  (dry air at 20 °C, 1 atm) when their kinematic pressures become Pa and when a
  recovered run's snapshot gets a density.
- ``V4_BOUNDARY_DEFAULTS``: the v4 ``boundary`` values the BC conversion
  reads, for a key the file does not have.
- ``V4_BC_SETTINGS``: the settings of the three BC types a v4 file's face
  roles become, as the BC registry gave them.
- ``v4_bcs_from_roles``: the v4 → BC conversion.
"""

from __future__ import annotations

import copy
from collections.abc import Iterable, Mapping
from typing import Any

V7_ASSUMED_DENSITY_KG_M3 = 1.204

V4_BOUNDARY_DEFAULTS: dict[str, Any] = {
    "inlet_speed_m_s": 0.5,
    "inlet_direction_mode": "normal",
    "inlet_vector": [-1.0, 0.0, 0.0],
    "outlet_p": 0.0,
}

V4_BC_SETTINGS: dict[str, dict[str, Any]] = {
    "velocity_inlet_fixed": {
        "direction_mode": "normal",
        "speed_m_s": 20.0,
        "velocity": [0.0, 0.0, 0.0],
        "temperature_K": 293.15,
    },
    "pressure_outlet_gauge": {
        "gauge_pressure": 0.0,
    },
    "wall_noslip": {
        "thermal_mode": "adiabatic",
        "temperature_K": 293.15,
        "heat_flux_W_m2": 0.0,
        "htc_W_m2K": 10.0,
        "ambient_T_K": 293.15,
    },
}


def _v4_boundary(boundary: Mapping[str, Any] | None) -> dict[str, Any]:
    """The v4 ``boundary`` block with missing keys filled and values typed."""
    raw = dict(boundary or {})
    mode = raw.get("inlet_direction_mode", V4_BOUNDARY_DEFAULTS["inlet_direction_mode"])
    if mode not in ("normal", "vector"):
        mode = "normal"
    vec = raw.get("inlet_vector", V4_BOUNDARY_DEFAULTS["inlet_vector"])
    return {
        "inlet_speed_m_s": float(
            raw.get("inlet_speed_m_s", V4_BOUNDARY_DEFAULTS["inlet_speed_m_s"])
        ),
        "inlet_direction_mode": mode,
        "inlet_vector": [float(vec[0]), float(vec[1]), float(vec[2])],
        "outlet_p": float(raw.get("outlet_p", V4_BOUNDARY_DEFAULTS["outlet_p"])),
    }


def v4_bcs_from_roles(
    face_roles: Iterable[tuple[int, str]],
    boundary: Mapping[str, Any] | None,
    refinement: Mapping[str, int],
) -> list[dict[str, Any]]:
    """BCs for a v4 file: one each for its inlet, outlet and walls faces.

    ``face_roles`` is (face id, role) per face, ``boundary`` the file's
    ``boundary`` block (pressures still kinematic; the v7 migration converts
    them) and ``refinement`` the mesh refinement level per role. Returns the BC
    fields without ids, inlet first; a role no face has gets no BC.
    """
    by_role: dict[str, list[int]] = {"inlet": [], "outlet": [], "walls": []}
    for face_id, role in face_roles:
        if role in by_role:
            by_role[role].append(int(face_id))
    b = _v4_boundary(boundary)

    bcs: list[dict[str, Any]] = []
    if by_role["inlet"]:
        settings = copy.deepcopy(V4_BC_SETTINGS["velocity_inlet_fixed"])
        settings["speed_m_s"] = b["inlet_speed_m_s"]
        settings["direction_mode"] = b["inlet_direction_mode"]
        settings["velocity"] = list(b["inlet_vector"])
        bcs.append(
            {
                "name": "Velocity inlet 1",
                "patch_name": "inlet",
                "type": "velocity_inlet_fixed",
                "settings": settings,
                "face_ids": sorted(by_role["inlet"]),
                "refinement_level": int(refinement["inlet"]),
            }
        )
    if by_role["outlet"]:
        settings = copy.deepcopy(V4_BC_SETTINGS["pressure_outlet_gauge"])
        settings["gauge_pressure"] = b["outlet_p"]
        bcs.append(
            {
                "name": "Pressure outlet 1",
                "patch_name": "outlet",
                "type": "pressure_outlet_gauge",
                "settings": settings,
                "face_ids": sorted(by_role["outlet"]),
                "refinement_level": int(refinement["outlet"]),
            }
        )
    if by_role["walls"]:
        bcs.append(
            {
                "name": "Wall no-slip 1",
                "patch_name": "walls",
                "type": "wall_noslip",
                "settings": copy.deepcopy(V4_BC_SETTINGS["wall_noslip"]),
                "face_ids": sorted(by_role["walls"]),
                "refinement_level": int(refinement["walls"]),
            }
        )
    return bcs
