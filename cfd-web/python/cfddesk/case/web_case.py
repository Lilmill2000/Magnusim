"""Compatibility re-export — product writer is cfddesk.case.writer.write_solve_case."""
from __future__ import annotations

from cfddesk.case.writer import (
    faces_area,
    foam_header,
    hydraulic_diameter,
    inlet_speed_ms,
    js_plain_float,
    k_omega_from_scales,
    pressure_pa,
    resolve_speed_and_dhyd,
    write_foam_dict,
    write_solve_case,
    write_vol_field,
)
from cfddesk.case.writer import write_solve_case as write_web_solve_case

__all__ = [
    "faces_area",
    "foam_header",
    "hydraulic_diameter",
    "inlet_speed_ms",
    "js_plain_float",
    "k_omega_from_scales",
    "pressure_pa",
    "resolve_speed_and_dhyd",
    "write_foam_dict",
    "write_solve_case",
    "write_vol_field",
    "write_web_solve_case",
]
