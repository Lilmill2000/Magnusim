"""The pressure coefficient result field (Cp), from the study's reference values.

OpenFOAM's ``pressure`` function object in ``staticCoeff`` mode writes
Cp = (p - p∞) / (½ ρ∞ U∞²) into every saved frame. The case stores kinematic
pressure: ``rho rhoInf`` scales it by the fluid's density first, so p∞ is the
study's reference (gauge) pressure in Pa and ρ∞ the fluid's density.

A run writes it once the study has set any reference value, or when it has a
Forces monitor: both mean the reference values are in use. A study that never
opened them solves exactly as before (no new function object).
"""

from __future__ import annotations

from typing import Any

from cfddesk.registry.analysis import ResultField

from .force_objects import num, vec
from .reference import has_reference_values

CP_OBJECT = "pressureCoefficient"
CP_FIELD = "Cp"

# Listed after the analysis's own result fields: Results shows it when a frame has it.
CP_RESULT_FIELD = ResultField(CP_FIELD, "Pressure coefficient", "dimensionless", "scalar", unit="")


def writes_pressure_coefficient(spec: Any) -> bool:
    """True when the run's case gets the Cp function object."""
    return has_reference_values(getattr(spec, "reference", None)) or bool(getattr(spec, "forces_monitors", None))


def pressure_coefficient_block(*, rho: float, p_inf: float, speed: float, drag: Any) -> str:
    """The ``pressure`` function object that writes Cp at every write time."""
    u_inf = [float(speed) * float(c) for c in drag]
    return f"""    {CP_OBJECT}
    {{
        type            pressure;
        libs            (fieldFunctionObjects);
        writeControl    writeTime;
        mode            staticCoeff;
        result          {CP_FIELD};
        rho             rhoInf;
        rhoInf          {num(rho)};
        pInf            {num(p_inf)};
        UInf            {vec(u_inf)};
    }}"""


def pressure_coefficient_text(spec: Any, reference: Any) -> str:
    """The Cp block for this run, or "" when the run does not write Cp."""
    if not writes_pressure_coefficient(spec):
        return ""
    return pressure_coefficient_block(
        rho=reference.rho, p_inf=reference.pressure, speed=reference.speed, drag=reference.drag
    )
