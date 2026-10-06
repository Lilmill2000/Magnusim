"""The OpenFOAM case writer of Incompressible Flow (write_solve_case).

``write_solve_case`` is the product path (js_steady / js_transient goldens).
"""

from __future__ import annotations

import dataclasses
import json
import math
import re
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Any

from magnusim_sdk.foam import dictionary_header as _foam_header
from magnusim_sdk.foam import (
    js_plain_float,
    write_foam_dict,
    write_vol_field,
)
from magnusim_sdk.foam import (
    write_decompose_par_dict as _write_decompose_par_dict_sdk,
)
from magnusim_sdk.foam import write_foam_text as _write_foam
from magnusim_sdk.units import UNITS as _UNITS

from .bc_kinds import (
    is_freestream,
    is_symmetry,
    is_total_pressure_inlet,
    wall_kind,
    wall_rotation,
    wall_velocity,
)
from .inlet_turbulence import sa_auto_nu_tilda
from .materials import LEGACY_AIR
from .physics import (
    DEFAULT_PHYSICS,
    KINEMATIC_FIELDS,
    SA_MODEL,
    StudyPhysics,
    TurbulenceModel,
    potential_flow_steps,
    turbulence_fields,
)

# Runtime imports stay lazy; static analysis sees the real exported types.
if TYPE_CHECKING:
    from .function_objects import js_to_precision, monitors_functions_text
    from .runspec import (
        FaceProps,
        RunSpec,
        WebBc,
        bc_faces,
        is_pressure_bc,
        is_velocity_inlet,
        is_velocity_outlet,
        is_wall_bc,
    )
    from .transient import TransientControl

_PRESSURE_KEYS = (
    "gauge_pressure",
    "pressure",
)


def write_fv_options_limit_u(path: Path, *, max_u: float) -> None:
    """Velocity cap FO (w27 limitU) — 10x expected speed, floor 50 m/s."""
    u = float(max_u)
    # Match JS Number.toPrecision(6) for the max value
    from .function_objects import js_to_precision

    max_s = js_to_precision(u, 6)
    _write_foam(
        path,
        _foam_header("fvOptions")
        + f"""
limitU
{{
    type            limitVelocity;
    active          yes;
    selectionMode   all;
    max             {max_s};
}}

// ************************************************************************* //
""",
    )


def write_fv_solution_pimple(
    path: Path,
    *,
    ctrl: TransientControl,
    turbulence: TurbulenceModel = "kOmegaSST",
    numerics: Any | None = None,
    potential_non_orth: int | None = None,
) -> None:
    """pimpleFoam fvSolution matching w30.transientFvSolution.

    ``potential_non_orth``: the study starts from potential flow; adds the Phi
    solver and the potentialFlow dict potentialFoam reads.
    """
    n_outer = max(1, int(round(ctrl.n_outer_correctors)))
    n_corr = max(1, int(round(ctrl.n_correctors)))
    n_non_orth = max(0, int(round(ctrl.n_non_orthogonal_correctors)))
    eq = _equation_regex(str(turbulence))
    if n_outer > 1:
        relax = f"""relaxationFactors
{{
    fields
    {{
        p               0.3;
        pFinal          1;
    }}
    equations
    {{
        {eq}   0.7;
        {_final_regex(eq)} 1;
    }}
}}"""
    else:
        relax = """relaxationFactors
{
    equations
    {
        ".*"            1;
    }
}"""
    # PIMPLE numerics come from the run panel (TransientControl), not the study panel.
    _ = numerics
    _write_foam(
        path,
        _foam_header("fvSolution")
        + f"""
solvers
{{
    p
    {{
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
        nCellsInCoarsestLevel 20;
        maxIter         200;
    }}
    pFinal
    {{
        $p;
        relTol          0;
    }}
{_potential_solver(potential_non_orth)}    {eq}
    {{
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
        maxIter         50;
    }}
    {_final_regex(eq)}
    {{
        $U;
        relTol          0;
    }}
}}
PIMPLE
{{
    momentumPredictor   yes;
    nOuterCorrectors    {n_outer};
    nCorrectors         {n_corr};
    nNonOrthogonalCorrectors {n_non_orth};
    turbOnFinalIterOnly yes;
    consistent          no;
}}
{_potential_flow_dict(potential_non_orth)}{relax}

// ************************************************************************* //
""",
    )


def _potential_solver(non_orth: int | None) -> str:
    """The Phi solver potentialFoam needs (the pressure solver's settings), or nothing."""
    if non_orth is None:
        return ""
    return "    Phi\n    {\n        $p;\n    }\n"


def _potential_flow_dict(non_orth: int | None) -> str:
    """potentialFoam's own dict, or nothing. The reference cells only matter in a
    closed domain (no fixed pressure anywhere)."""
    if non_orth is None:
        return ""
    return f"""potentialFlow
{{
    nNonOrthogonalCorrectors {int(non_orth)};
    PhiRefCell      0;
    PhiRefValue     0;
    pRefCell        0;
    pRefValue       0;
}}
"""


# potentialFoam -writep: the divergence of the flow-direction filtered div(phi,U).
_POTENTIAL_DIV = "    div(div(phi,U)) Gauss linear;\n"


def write_fv_schemes_transient(
    path: Path, *, ctrl: TransientControl, turbulence: str = "kOmegaSST", potential: bool = False
) -> None:
    """Compact transient fvSchemes matching w30.transientFvSchemes / js_transient golden.

    ``potential``: the study starts from potential flow (the scheme potentialFoam -writep reads).
    """
    ddt = "backward" if ctrl.time_scheme == "backward" else "Euler"
    grads = _grad_lines(turbulence)
    divs = _div_lines(turbulence, "Gauss limitedLinear 1") + (_POTENTIAL_DIV if potential else "")
    _write_foam(
        path,
        _foam_header("fvSchemes")
        + f"""
ddtSchemes {{ default {ddt}; }}
gradSchemes
{{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
{grads}}}
divSchemes
{{
    default         none;
    div(phi,U)      Gauss linearUpwind grad(U);
{divs}}}
laplacianSchemes {{ default Gauss linear limited corrected 0.5; }}
interpolationSchemes {{ default linear; }}
snGradSchemes {{ default limited corrected 0.5; }}
wallDist {{ method meshWave; }}

// ************************************************************************* //
""",
    )


def write_control_dict_transient(
    path: Path,
    *,
    ctrl: TransientControl,
    functions_text: str = "",
    restart: bool = False,
) -> None:
    """pimpleFoam controlDict matching w30.transientControlDict / js_transient golden.

    ``restart``: the run continues from its latest saved time (startFrom
    latestTime); frames are saved every write interval from there.
    """
    from .transient import foam_num

    adjust = ctrl.adjust_time_step
    body = f"""application     pimpleFoam;
startFrom       {"latestTime" if restart else "startTime"};
startTime       0;
stopAt          endTime;
endTime         {foam_num(ctrl.end_time)};
deltaT          {foam_num(ctrl.delta_t)};
writeControl    {"adjustableRunTime" if adjust else "runTime"};
writeInterval   {foam_num(ctrl.write_interval)};
purgeWrite      0;
writeFormat     binary;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   8;
runTimeModifiable true;

adjustTimeStep  {"yes" if adjust else "no"};
maxCo           {foam_num(ctrl.max_co)};
maxDeltaT       {foam_num(ctrl.max_delta_t)};

functions
{{
{functions_text or "    // no area-average probes"}
}}
"""
    _write_foam(path, _foam_header("controlDict") + "\n" + body)


# Safety-net endTime for end_condition="residual": the actual stop is meant
# to be residualControl (in fvSolution/SIMPLE), not this iteration count —
# it only guards against a run that never satisfies residualControl.


def _ensure_web_imports() -> None:
    """Load UI/prepare_run helpers without pulling OCCT on writer import."""
    g = globals()
    if g.get("_WEB_READY"):
        return
    from .function_objects import js_to_precision, monitors_functions_text
    from .runspec import (
        FaceProps,
        RunSpec,
        WebBc,
        bc_faces,
        is_pressure_bc,
        is_velocity_inlet,
        is_velocity_outlet,
        is_wall_bc,
        wall_treatment,
    )

    g.update(
        {
            "js_to_precision": js_to_precision,
            "monitors_functions_text": monitors_functions_text,
            "FaceProps": FaceProps,
            "RunSpec": RunSpec,
            "WebBc": WebBc,
            "bc_faces": bc_faces,
            "is_pressure_bc": is_pressure_bc,
            "is_velocity_inlet": is_velocity_inlet,
            "is_velocity_outlet": is_velocity_outlet,
            "is_wall_bc": is_wall_bc,
            "wall_treatment": wall_treatment,
            "_WEB_READY": True,
        }
    )


# ---------------------------------------------------------------------------
# Foam I/O (match JS foamHeader / writeVolField spacing — no C++ banner)
# ---------------------------------------------------------------------------


# foam_header, write_foam_dict, write_vol_field and js_plain_float are
# magnusim_sdk.foam's (imported above): one copy for the core and plugins.


# ---------------------------------------------------------------------------
# Turbulence scales (exact w27 kOmegaFromScales)
# ---------------------------------------------------------------------------


def k_omega_from_scales(speed: float, d_hyd: float | None) -> dict[str, float]:
    u = max(abs(float(speed) or 0.0), 0.1)
    intensity = 0.05
    k = 1.5 * (intensity * u) * (intensity * u)
    length = max(0.07 * (float(d_hyd) if d_hyd else 0.0), 1e-3)
    omega = math.sqrt(k) / ((0.09**0.25) * length)
    return {"k": k, "omega": omega, "I": intensity, "L": length}


# ---------------------------------------------------------------------------
# Face / BC helpers (web FaceProps.area_m2)
# ---------------------------------------------------------------------------


def _props_area(fp: FaceProps | None) -> float:
    if fp is None or fp.area_m2 is None:
        return 0.0
    a = float(fp.area_m2)
    return a if math.isfinite(a) else 0.0


def faces_area(faces: list[str], props: dict[str, FaceProps]) -> float:
    return sum(_props_area(props.get(f)) for f in faces or [])


def _bc_dict(bc: WebBc | dict) -> dict[str, Any]:
    _ensure_web_imports()
    if isinstance(bc, WebBc):
        return {
            "name": bc.name,
            "bc_type": bc.bc_type,
            "faces": list(bc.faces),
            "value": bc.value,
            "unit": bc.unit,
            "velocity_type": bc.velocity_type,
            "flow_rate_type": bc.flow_rate_type,
            "direction": bc.direction,
            "vector": bc.vector,
            "wall_type": bc.wall_type,
            **(bc.raw or {}),
        }
    return dict(bc)


def inlet_speed_ms(bc: dict) -> float:
    try:
        v = float(bc["value"]) if bc.get("value") is not None else float("nan")
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(v):
        return 1.0
    unit = str(bc.get("unit") or "").lower()
    if unit in ("m/s", "m s-1", ""):
        return v
    if unit == "ft/s":
        return v * 0.3048
    if unit in ("ft/min", "fpm"):
        return v * 0.3048 / 60.0
    if unit == "km/h":
        return v / 3.6
    if unit == "mph":
        return v * 0.44704
    return v


_PA = _UNITS["pressure"]
# The app's pressure units (magnusim_sdk.units), by every lower-case name a BC may carry.
PRESSURE_PA_FACTORS: dict[str, float] = {
    "kpa": _PA["kPa"],
    "bar": _PA["bar"],
    "psi": _PA["psi"],
    "inh2o": _PA["inH₂O"],
    "inh₂o": _PA["inH₂O"],
    "in h2o": _PA["inH₂O"],
    "inwc": _PA["inH₂O"],
    "mmh2o": _PA["mmH₂O"],
    "mmh₂o": _PA["mmH₂O"],
}


def pressure_pa(bc: dict) -> float:
    try:
        v = float(bc["value"]) if bc.get("value") is not None else float("nan")
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    unit = str(bc.get("unit") or "Pa").lower()
    return v * PRESSURE_PA_FACTORS.get(unit, 1.0)


def uses_flow_rate(bc: dict) -> bool:
    if re.search(r"flow\s*rate", str(bc.get("velocity_type") or ""), re.I):
        return True
    return bool(re.search(r"ft3/min|ft³/min|m3/s|m³/s|kg/s|lb/s", str(bc.get("unit") or ""), re.I))


def uses_vector(bc: dict) -> bool:
    return bool(re.search(r"vector", str(bc.get("direction") or ""), re.I)) and isinstance(
        bc.get("vector"), (list, tuple)
    )


def volumetric_m3s(bc: dict) -> float | None:
    try:
        v = float(bc["value"]) if bc.get("value") is not None else float("nan")
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    unit = str(bc.get("unit") or "").lower()
    if "ft" in unit and "min" in unit:
        return v * 0.00047194745
    if "l/min" in unit:
        return v / 60000.0
    if "l/s" in unit:
        return v / 1000.0
    if "m3" in unit or "m³" in unit or "m^3" in unit:
        return v
    return None


def mass_flow_kgs(bc: dict) -> float | None:
    try:
        v = float(bc["value"]) if bc.get("value") is not None else float("nan")
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    unit = str(bc.get("unit") or "").lower()
    if unit == "kg/s":
        return v
    if unit == "lb/s":
        return v * 0.45359237
    if unit == "kg/h":
        return v / 3600.0
    return None


def is_mass_flow(bc: dict) -> bool:
    if re.search(r"mass", str(bc.get("flow_rate_type") or ""), re.I):
        return True
    return mass_flow_kgs(bc) is not None and volumetric_m3s(bc) is None


def inlet_direction(bc: dict) -> list[float] | None:
    if not uses_vector(bc):
        return None
    v = [float(x) or 0.0 for x in (bc.get("vector") or [])[:3]]
    while len(v) < 3:
        v.append(0.0)
    m = math.hypot(v[0], v[1], v[2])
    if not (m > 0):
        return None
    return [x / m for x in v]


def vector_inlet_velocity(bc: dict, face_props: dict[str, FaceProps]) -> dict[str, Any] | None:
    spd = abs(inlet_speed_ms(bc))
    direction = inlet_direction(bc)
    if direction is None:
        return None
    return {
        "U": [d * spd for d in direction],
        "magnitude": spd,
    }


def inlet_ref_speed(bc: dict, face_area: float, rho: float) -> float:
    if uses_flow_rate(bc):
        q = (
            (mass_flow_kgs(bc) or 0.0) / (rho or 1.2)
            if is_mass_flow(bc)
            else (volumetric_m3s(bc) or 0.0)
        )
        n = max(1, len(bc_faces(bc)))
        if face_area > 0:
            return abs(q) * n / face_area
        return max(1.0, abs(q) * 1000.0)
    return abs(inlet_speed_ms(bc))


def spec_is_transient(spec: Any) -> bool:
    """The run solves in time (its transient control is resolved, or about to be)."""
    return getattr(spec, "transient", None) is not None or getattr(spec, "time_dependency", "") == "transient"


def inlet_quantity(bc: dict) -> str:
    """What a velocity inlet's value is: velocity, volumetric_flow or mass_flow."""
    if uses_flow_rate(bc):
        return "mass_flow" if is_mass_flow(bc) else "volumetric_flow"
    return "velocity"


def with_table_peak(bc: dict, transient: bool) -> dict:
    """A velocity inlet whose "Varies with time" table is in effect, read as a
    fixed one at the table's largest value: its reference speed (turbulence at
    the inlet, the velocity cap, the time-step estimate)."""
    from magnusim_sdk.units import SI_DEFAULT

    from . import time_table as _tt

    if not _tt.in_effect(bc, transient):
        return bc
    q = inlet_quantity(bc)
    peak = _tt.peak_si(bc, q)
    return bc if peak is None else {**bc, "value": peak, "unit": SI_DEFAULT[q]}  # type: ignore[index]


def pressure_values_pa(bc: dict, transient: bool) -> list[float]:
    """A pressure boundary's gauge pressure in Pa; with a table in effect, its lowest and highest."""
    from . import time_table as _tt

    span = _tt.span_si(bc, "pressure") if _tt.in_effect(bc, transient) else None
    return list(span) if span else [pressure_pa(bc)]


_FREE_OUTFLOW = {"type": "inletOutlet", "inletValue": "uniform (0 0 0)", "value": "uniform (0 0 0)"}


def outlet_value_given(bc: dict) -> bool:
    """True when a velocity outlet record holds a number (older records may hold none)."""
    try:
        return math.isfinite(float(bc["value"]))
    except (KeyError, TypeError, ValueError):
        return False


def velocity_outlet_U(bc: dict, rho: float) -> dict[str, str]:
    """A velocity outlet's 0/U entry: the outflow its panel asks for.

    A speed normal to the face is surfaceNormalFixedValue with a positive
    (outward) refValue; a speed along a vector is fixedValue; a volumetric or
    mass flow is flowRateOutletVelocity, the rate once per assigned face (as an
    inlet's). A record with no value keeps the free outflow (inletOutlet, no
    backflow) older versions wrote for every velocity outlet.
    """
    _ensure_web_imports()
    if not outlet_value_given(bc):
        return dict(_FREE_OUTFLOW)
    n_faces = max(1, len(bc_faces(bc)))
    if uses_flow_rate(bc):
        if is_mass_flow(bc) and mass_flow_kgs(bc) is not None:
            return {
                "type": "flowRateOutletVelocity",
                "massFlowRate": f"constant {js_to_precision(abs(mass_flow_kgs(bc) or 0.0) * n_faces, 8)}",
                "rhoOutlet": f"{rho}",
                "value": "uniform (0 0 0)",
            }
        if volumetric_m3s(bc) is not None:
            return {
                "type": "flowRateOutletVelocity",
                "volumetricFlowRate": f"constant {js_to_precision(abs(volumetric_m3s(bc) or 0.0) * n_faces, 8)}",
                "value": "uniform (0 0 0)",
            }
        return dict(_FREE_OUTFLOW)
    vec = vector_inlet_velocity(bc, {}) if uses_vector(bc) else None
    if vec:
        comps = [js_to_precision(c, 8) for c in vec["U"]]
        return {"type": "fixedValue", "value": f"uniform ({' '.join(comps)})"}
    return {
        "type": "surfaceNormalFixedValue",
        "refValue": f"uniform {js_plain_float(abs(inlet_speed_ms(bc)))}",
        "value": "uniform (0 0 0)",
    }


def outlet_outflow(bc: dict) -> float | None:
    """A velocity outlet's outflow as asked (speed, volumetric or mass flow; any unit), None without a value."""
    if not outlet_value_given(bc):
        return None
    if uses_flow_rate(bc):
        q = mass_flow_kgs(bc) if is_mass_flow(bc) else volumetric_m3s(bc)
        return abs(q) if q is not None else None
    return abs(inlet_speed_ms(bc))


def freestream_speed(bc: dict) -> float:
    """A freestream's speed in m/s (its value and unit; 0 without a value)."""
    try:
        v = float(bc["value"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    return abs(inlet_speed_ms(bc)) if math.isfinite(v) else 0.0


def freestream_velocity(bc: dict) -> list[float]:
    """A freestream's velocity vector in m/s: its speed along its direction (+x when it has none)."""
    raw = bc.get("vector")
    v = [0.0, 0.0, 0.0]
    if isinstance(raw, (list, tuple)):
        for i, x in enumerate(list(raw)[:3]):
            try:
                v[i] = float(x)
            except (TypeError, ValueError):
                v[i] = 0.0
    if not all(math.isfinite(x) for x in v):
        v = [0.0, 0.0, 0.0]
    m = math.hypot(*v)
    direction = [x / m for x in v] if m > 0 else [1.0, 0.0, 0.0]
    spd = freestream_speed(bc)
    return [spd * d for d in direction]


def freestream_pressure_pa(bc: dict) -> float:
    """A freestream's gauge pressure in Pa (stored in Pa; 0 when it has none)."""
    try:
        p = float(bc.get("freestream_pressure") or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return p if math.isfinite(p) else 0.0


def resolve_speed_and_dhyd(spec: RunSpec) -> tuple[float, float]:
    """Port of writeSolveCase speedRef / dHyd selection."""
    _ensure_web_imports()
    rho = float(spec.rho) or LEGACY_AIR["rho"]
    props = spec.face_props or {}
    transient = spec_is_transient(spec)
    speed_ref = 1.0
    d_hyd: float | None = None
    inlets = [(m.get("bc"), m.get("patch")) for m in (spec.mapped or []) if is_velocity_inlet(m.get("bc"))]
    if inlets:
        best = 0.0
        best_area = 0.0
        for bc_raw, _patch in inlets:
            bc = with_table_peak(_bc_dict(bc_raw), transient)  # type: ignore[arg-type]
            faces = bc_faces(bc)
            area = faces_area(faces, props)
            s = inlet_ref_speed(bc, area / max(1, len(faces)), rho)
            if s > best:
                best = s
            if area > best_area:
                best_area = area
        speed_ref = max(best, 0.1)
        d_hyd = 2.0 * math.sqrt(best_area / math.pi) if best_area > 0 else None
    else:
        # Static pressures and total-pressure inlets: the pressure difference drives the flow.
        pm = [
            m.get("bc")
            for m in (spec.mapped or [])
            if is_pressure_bc(m.get("bc")) or is_total_pressure_inlet(m.get("bc"))
        ]
        pvals = [v for b in pm if b for v in pressure_values_pa(_bc_dict(b), transient)]
        if len(pvals) >= 2:
            dp = max(pvals) - min(pvals)
            speed_ref = max(1.0, math.sqrt((2.0 * abs(dp)) / rho))
        min_area = float("inf")
        for b in pm:
            if not b:
                continue
            a = faces_area(bc_faces(_bc_dict(b)), props)
            if a > 0 and a < min_area:
                min_area = a
        d_hyd = 2.0 * math.sqrt(min_area / math.pi) if math.isfinite(min_area) else None
        # No inlet: a velocity outlet's outflow is the case's speed when it is faster.
        for m in spec.mapped or []:
            if not is_velocity_outlet(m.get("bc")):
                continue
            ob = _bc_dict(m.get("bc"))  # type: ignore[arg-type]
            if not outlet_value_given(ob):
                continue
            faces = bc_faces(ob)
            area = faces_area(faces, props)
            speed_ref = max(speed_ref, inlet_ref_speed(ob, area / max(1, len(faces)), rho))
        # No inlet: a freestream's speed is the case's speed when it is faster.
        for m in spec.mapped or []:
            if is_freestream(m.get("bc")):
                speed_ref = max(speed_ref, freestream_speed(_bc_dict(m.get("bc"))))  # type: ignore[arg-type]
    if not d_hyd or not (d_hyd > 0):
        d_hyd = 0.05
    return float(speed_ref), float(d_hyd)


def inlet_flow_direction(bc: dict, face_props: dict[str, FaceProps]) -> list[float] | None:
    """The unit direction a velocity inlet's flow comes in along.

    Its vector when it has one, else against its faces' area-weighted outward
    normal (the CAD face table's), None when neither gives a direction.
    """
    direction = inlet_direction(bc) if uses_vector(bc) else None
    if direction is not None:
        return direction
    total = [0.0, 0.0, 0.0]
    for face in bc_faces(bc):
        fp = face_props.get(face)
        if fp is None or fp.normal is None:
            continue
        area = _props_area(fp) or 1.0
        for i in range(3):
            total[i] -= float(fp.normal[i]) * area
    m = math.hypot(*total)
    if not (m > 0) or not math.isfinite(m):
        return None
    return [c / m for c in total]


def initial_velocity(spec: RunSpec, speed_ref: float) -> tuple[list[float], str]:
    """The starting velocity (0/U's internal field) in m/s and where it came from.

    ``still``: 0. ``custom``: the study's components. ``inlet``: the case's
    reference speed (the fastest velocity inlet's, as the turbulence values use)
    along the largest velocity inlet's direction; with no velocity inlet the
    first freestream's velocity; with neither 0 (from ``none``).
    """
    _ensure_web_imports()
    physics: StudyPhysics = getattr(spec, "physics", None) or DEFAULT_PHYSICS
    if physics.initial_flow == "custom":
        return [float(c) for c in physics.initial_u], "custom"
    if physics.initial_flow != "inlet":
        return [0.0, 0.0, 0.0], "still"
    props = spec.face_props or {}
    best: dict[str, Any] | None = None
    best_area = -1.0
    for m in spec.mapped or []:
        if not is_velocity_inlet(m.get("bc")):
            continue
        bc = _bc_dict(m.get("bc"))  # type: ignore[arg-type]
        area = faces_area(bc_faces(bc), props)
        if area > best_area:
            best, best_area = bc, area
    if best is not None:
        direction = inlet_flow_direction(best, props)
        if direction is None:
            return [0.0, 0.0, 0.0], "none"
        return [float(speed_ref) * c for c in direction], "inlet"
    for m in spec.mapped or []:
        if is_freestream(m.get("bc")):
            return freestream_velocity(_bc_dict(m.get("bc"))), "freestream"  # type: ignore[arg-type]
    return [0.0, 0.0, 0.0], "none"


def _uniform_vector(v: list[float]) -> str:
    """``uniform (x y z)``: (0 0 0) exactly as before for a still start."""
    from .function_objects import js_to_precision as _prec

    if not any(v):
        return "uniform (0 0 0)"
    return "uniform (" + " ".join(_prec(c, 8) if c else "0" for c in v) + ")"


# ---------------------------------------------------------------------------
# Patch role map + field dicts
# ---------------------------------------------------------------------------


def _patch_names(spec: RunSpec, poly_dst: Path | None) -> list[str]:
    """Prefer polyMesh boundary order; else walls + mapped BC order (w27)."""
    names: list[str] = []
    if poly_dst and (poly_dst / "boundary").is_file():
        from magnusim_sdk.foam import boundary_patch_names as _parse_boundary_patches

        names = _parse_boundary_patches(poly_dst / "boundary")
    if not names:
        # Invent: walls first (unclaimed mesh default), then mapped patch order
        names = ["walls"]
        for m in spec.mapped or []:
            patch = str(m.get("patch") or "")
            if patch and patch not in names:
                names.append(patch)
        for b in spec.bcs:
            patch = b.patch or b.name
            if patch and patch not in names:
                names.append(patch)
        for n in spec.patches or []:
            if n and n not in names:
                names.append(n)
    elif "walls" not in names:
        names = ["walls"] + names
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def turb_value_strings(k: float, omega: float, nu_tilda: float | None = None) -> dict[str, str]:
    """The value strings of k, omega, epsilon (Cmu k omega) and R (isotropic, 2/3 k I),
    and Spalart-Allmaras's nuTilda when given."""
    from .function_objects import js_to_precision as _prec

    r_diag = _prec(2.0 * k / 3.0, 6)
    out = {
        "k": _prec(k, 6),
        "omega": _prec(omega, 6),
        "epsilon": _prec(0.09 * k * omega, 6),
        "R": f"({r_diag} 0 0 {r_diag} 0 {r_diag})",
    }
    if nu_tilda is not None:
        out["nuTilda"] = _prec(nu_tilda, 6)
    return out


def carries_inlet_turbulence(bc: dict) -> bool:
    """A boundary flow can come in through, with a "Turbulence at the inlet" setting."""
    _ensure_web_imports()
    return is_velocity_inlet(bc) or is_pressure_bc(bc) or is_total_pressure_inlet(bc) or is_freestream(bc)


def patch_turbulence(spec: RunSpec, speed_ref: float) -> dict[str, dict[str, Any]]:
    """{patch: scales} of each boundary whose "Turbulence at the inlet" is not Auto.

    A velocity inlet's intensity is of its own speed; a pressure boundary's or
    a total-pressure inlet's of the case's reference speed (it has no speed of
    its own). A freestream always
    has its own: on Auto, 5 % intensity of its speed and a turbulent viscosity
    10 x the fluid's (the length-scale rule would size eddies by the far
    field's size).

    Under Spalart-Allmaras each one also carries ``nu_tilda``, from its
    turbulent viscosity (k / omega); a freestream on Auto then has none of its
    own (the case-wide Auto rule, nuTilda = 3 x nu, holds there too).
    """
    from .inlet_turbulence import (
        DEFAULT_INTENSITY_PCT,
        DEFAULT_RATIO,
        RATIO,
        nu_tilda_from_nut,
        patch_scales,
        turbulence_spec,
    )

    _ensure_web_imports()
    sa = getattr(getattr(spec, "physics", None), "turbulence_model", "") == SA_MODEL
    rho = float(spec.rho) or LEGACY_AIR["rho"]
    props = spec.face_props or {}
    out: dict[str, dict[str, Any]] = {}
    for m in spec.mapped or []:
        patch = str(m.get("patch") or "")
        if not patch or not m.get("bc"):
            continue
        bc = _bc_dict(m["bc"])
        if not carries_inlet_turbulence(bc):
            continue
        speed = speed_ref
        if is_velocity_inlet(bc):
            faces = bc_faces(bc)
            speed = inlet_ref_speed(
                with_table_peak(bc, spec_is_transient(spec)), faces_area(faces, props) / max(1, len(faces)), rho
            )
        elif is_freestream(bc):
            speed = freestream_speed(bc)
            if turbulence_spec(bc) == "Auto" and not sa:
                bc = {
                    "turbulence_spec": RATIO,
                    "turbulence_intensity": DEFAULT_INTENSITY_PCT,
                    "turbulence_viscosity_ratio": DEFAULT_RATIO,
                }
        scales = patch_scales(bc, speed=speed, nu=float(spec.nu))
        if scales is not None:
            if sa:
                scales["nu_tilda"] = nu_tilda_from_nut(scales["k"] / scales["omega"], float(spec.nu))
            out[patch] = scales
    return out


def _build_field_patches(
    spec: RunSpec,
    patch_names: list[str],
    *,
    turb_values: dict[str, str],
    patch_turb: dict[str, dict[str, str]] | None = None,
) -> tuple[dict, dict, dict[str, dict]]:
    """U, p and one patch dict per turbulence field the study's model reads.

    ``turb_values`` holds the case-wide value string for k, omega, epsilon and
    R (inlets on Auto, walls, the internal field); ``patch_turb`` a patch's own
    values when its "Turbulence at the inlet" sets them.
    """
    _ensure_web_imports()
    model = getattr(getattr(spec, "physics", None), "turbulence_model", "kOmegaSST")
    names = turbulence_fields(model)
    turb: dict[str, dict[str, dict[str, str]]] = {name: {} for name in names}

    def set_turb(patch: str, make) -> None:
        values = (patch_turb or {}).get(patch) or turb_values
        for name in names:
            turb[name][patch] = make(name, values)

    def fixed(name: str, values: dict[str, str]) -> dict[str, str]:
        if name == "nut":
            return {"type": "calculated", "value": "uniform 0"}
        return {"type": "fixedValue", "value": f"uniform {values[name]}"}

    def inlet_outlet(name: str, values: dict[str, str]) -> dict[str, str]:
        if name == "nut":
            return {"type": "calculated", "value": "uniform 0"}
        v = values[name]
        return {"type": "inletOutlet", "inletValue": f"uniform {v}", "value": f"uniform {v}"}

    def slip(name: str, _values: dict[str, str]) -> dict[str, str]:
        if name == "nut":
            return {"type": "calculated", "value": "uniform 0"}
        return {"type": "zeroGradient"}

    def symmetry(_name: str, _values: dict[str, str]) -> dict[str, str]:
        return {"type": "symmetry"}

    def freestream(name: str, values: dict[str, str]) -> dict[str, str]:
        if name == "nut":
            return {"type": "calculated", "value": "uniform 0"}
        return {"type": "freestream", "freestreamValue": f"uniform {values[name]}"}

    wall_fn = {
        "k": "kqRWallFunction",
        "R": "kqRWallFunction",
        "omega": "omegaWallFunction",
        "epsilon": "epsilonWallFunction",
        # Spalart-Allmaras: Spalding's law covers the wall layer at any y+.
        "nut": "nutUSpaldingWallFunction" if model == SA_MODEL else "nutkWallFunction",
    }

    def no_slip(name: str, _values: dict[str, str]) -> dict[str, str]:
        if name == "nuTilda":
            # nuTilda is 0 at a wall (the model is integrated down to it).
            return {"type": "fixedValue", "value": "uniform 0"}
        value = "0" if name == "nut" else turb_values[name]
        return {"type": wall_fn[name], "value": f"uniform {value}"}

    from . import time_table as _tt

    rho = float(spec.rho) or LEGACY_AIR["rho"]
    wall_default = spec.wall_default or "No-slip"
    props = spec.face_props or {}
    # "Varies with time" tables replace fixed values in transient runs only.
    transient = spec_is_transient(spec)
    role: dict[str, dict[str, Any]] = {}
    for m in spec.mapped or []:
        bc = m.get("bc")
        patch = str(m.get("patch") or "")
        if not bc or not patch:
            continue
        b = _bc_dict(bc)
        if is_velocity_inlet(b):
            role[patch] = {"kind": "inlet", "bc": b}
        elif is_pressure_bc(b):
            role[patch] = {"kind": "pressure", "bc": b}
        elif is_velocity_outlet(b):
            role[patch] = {"kind": "velOutlet", "bc": b}
        elif is_wall_bc(b):
            role[patch] = {"kind": "wall", "bc": b, "treatment": wall_kind(b)}
        elif is_symmetry(b):
            role[patch] = {"kind": "symmetry", "bc": b}
        elif is_freestream(b):
            role[patch] = {"kind": "freestream", "bc": b}
        elif is_total_pressure_inlet(b):
            role[patch] = {"kind": "totalPressure", "bc": b}

    U: dict[str, dict[str, str]] = {}
    p: dict[str, dict[str, str]] = {}

    for name in patch_names:
        r = role.get(name)
        kind = r["kind"] if r else "wall"
        if kind == "inlet":
            bc = r["bc"]  # type: ignore[index]
            n_faces = max(1, len(bc_faces(bc)))
            varying = (
                _tt.inlet_velocity(
                    bc,
                    quantity=inlet_quantity(bc),
                    n_faces=n_faces,
                    rho=rho,
                    direction=inlet_direction(bc) if uses_vector(bc) else None,
                )
                if _tt.in_effect(bc, transient)
                else None
            )
            if varying:
                U[name] = varying
            elif uses_flow_rate(bc) and is_mass_flow(bc) and mass_flow_kgs(bc) is not None:
                rate = (mass_flow_kgs(bc) or 0.0) * n_faces
                U[name] = {
                    "type": "flowRateInletVelocity",
                    "massFlowRate": f"constant {js_to_precision(rate, 8)}",
                    "rhoInlet": f"{rho}",
                    "extrapolateProfile": "false",
                    "value": "uniform (0 0 0)",
                }
            elif uses_flow_rate(bc) and volumetric_m3s(bc) is not None:
                rate = (volumetric_m3s(bc) or 0.0) * n_faces
                U[name] = {
                    "type": "flowRateInletVelocity",
                    "volumetricFlowRate": f"constant {js_to_precision(rate, 8)}",
                    "extrapolateProfile": "false",
                    "value": "uniform (0 0 0)",
                }
            else:
                spd = abs(inlet_speed_ms(bc))
                vec = vector_inlet_velocity(bc, props) if uses_vector(bc) else None
                if vec:
                    comps = [js_to_precision(c, 8) for c in vec["U"]]
                    U[name] = {
                        "type": "fixedValue",
                        "value": f"uniform ({' '.join(comps)})",
                    }
                else:
                    U[name] = {
                        "type": "surfaceNormalFixedValue",
                        "refValue": f"uniform {js_plain_float(-spd)}",
                        "value": "uniform (0 0 0)",
                    }
            p[name] = {"type": "zeroGradient"}
            set_turb(name, fixed)
        elif kind == "pressure":
            p_kin = pressure_pa(r["bc"]) / rho  # type: ignore[index]
            U[name] = {"type": "pressureInletOutletVelocity", "value": "uniform (0 0 0)"}
            varying_p = _tt.pressure_p(r["bc"], rho) if _tt.in_effect(r["bc"], transient) else None  # type: ignore[index]
            p[name] = varying_p or {"type": "fixedValue", "value": f"uniform {js_to_precision(p_kin, 8)}"}
            set_turb(name, inlet_outlet)
        elif kind == "velOutlet":
            U[name] = velocity_outlet_U(r["bc"], rho)  # type: ignore[index]
            p[name] = {"type": "zeroGradient"}
            set_turb(name, inlet_outlet)
        elif kind == "totalPressure":
            # Inflow at p = p0 - |U|^2/2 (kinematic); outflow holds p0 as a static pressure.
            p0_kin = js_to_precision(pressure_pa(r["bc"]) / rho, 8)  # type: ignore[index]
            U[name] = {"type": "pressureInletOutletVelocity", "value": "uniform (0 0 0)"}
            varying_p0 = _tt.pressure_p(r["bc"], rho, total=True) if _tt.in_effect(r["bc"], transient) else None  # type: ignore[index]
            p[name] = varying_p0 or {"type": "totalPressure", "p0": f"uniform {p0_kin}", "value": f"uniform {p0_kin}"}
            set_turb(name, inlet_outlet)
        elif kind == "freestream":
            # The far field: the freestream comes in where the flow enters, the
            # rest leaves freely (freestreamVelocity / freestreamPressure switch
            # on the flux direction).
            fb = r["bc"]  # type: ignore[index]
            fs_u = " ".join(js_to_precision(c, 8) for c in freestream_velocity(fb))
            U[name] = {"type": "freestreamVelocity", "freestreamValue": f"uniform ({fs_u})"}
            p_kin = freestream_pressure_pa(fb) / rho
            p[name] = {"type": "freestreamPressure", "freestreamValue": f"uniform {js_to_precision(p_kin, 8)}"}
            set_turb(name, freestream)
        elif kind == "symmetry":
            # Every field mirrored; the patch is made type symmetry (write_solve_case).
            U[name] = {"type": "symmetry"}
            p[name] = {"type": "symmetry"}
            set_turb(name, symmetry)
        else:
            treatment = r["treatment"] if r and r.get("kind") == "wall" else wall_default
            if treatment == "Slip":
                U[name] = {"type": "slip"}
                p[name] = {"type": "zeroGradient"}
                set_turb(name, slip)
            elif treatment == "Moving":
                # Slides along itself: the fluid sticks to it (fixedValue on a fixed mesh).
                vel = " ".join(js_to_precision(c, 8) for c in wall_velocity(r["bc"]))  # type: ignore[index]
                U[name] = {"type": "fixedValue", "value": f"uniform ({vel})"}
                p[name] = {"type": "zeroGradient"}
                set_turb(name, no_slip)
            elif treatment == "Rotating":
                origin, axis, omega = wall_rotation(r["bc"])  # type: ignore[index]
                U[name] = {
                    "type": "rotatingWallVelocity",
                    "origin": "(" + " ".join(js_plain_float(c) for c in origin) + ")",
                    "axis": "(" + " ".join(js_plain_float(c) for c in axis) + ")",
                    "omega": js_to_precision(omega, 8),
                    "value": "uniform (0 0 0)",
                }
                p[name] = {"type": "zeroGradient"}
                set_turb(name, no_slip)
            else:
                U[name] = {"type": "noSlip"}
                p[name] = {"type": "zeroGradient"}
                set_turb(name, no_slip)
    return U, p, turb


def _steady_control_dict_body(
    end_time: float, write_interval: float, functions_text: str, *, restart_from: float | None = None
) -> str:
    # A run shorter than its write interval would write no result at all (the solve
    # "fails" with nothing to reconstruct): the last iteration is always written.
    # A run continued from its latest saved iteration (restart_from) counts its
    # iterations, and its writes, from there (writeControl runTime: every write
    # interval after the start, so the new end is written when the extra
    # iterations are a whole number of intervals).
    span = float(end_time) - float(restart_from or 0)
    if span > 0:
        write_interval = min(float(write_interval), span)
    restart = restart_from is not None
    return f"""application     simpleFoam;
startFrom       {"latestTime" if restart else "startTime"};
startTime       0;
stopAt          endTime;
endTime         {js_plain_float(float(end_time))};
deltaT          1;
writeControl    {"runTime" if restart else "timeStep"};
writeInterval   {js_plain_float(float(write_interval))};
purgeWrite      0;
writeFormat     binary;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{{
{functions_text}
}}"""


def _equation_regex(model: str) -> str:
    """fvSolution key for U plus the turbulence equations the model solves."""
    from .physics import solved_turbulence_fields

    extra = solved_turbulence_fields(model)
    return '"(' + "|".join(("U", *extra)) + ')"' if extra else "U"


def _final_regex(eq: str) -> str:
    return eq[:-1] + 'Final"' if eq.endswith('"') else eq + "Final"


def _grad_lines(model: str, limited: str = "cellLimited Gauss linear 1") -> str:
    from .physics import solved_turbulence_fields

    out = ""
    for name in solved_turbulence_fields(model):
        if name == "R":
            continue
        out += f"    {'grad(' + name + ')':<15} {limited};\n"
    return out


def _div_lines(model: str, turb_scheme: str) -> str:
    """div(phi,<field>) for each solved turbulence field plus the momentum stress terms."""
    from .physics import RSM_MODELS, solved_turbulence_fields

    out = ""
    for name in solved_turbulence_fields(model):
        out += f"    {'div(phi,' + name + ')':<15} {turb_scheme};\n"
    if model in RSM_MODELS:
        # Reynolds-stress momentum source: div(R) plus the laminar deviatoric part.
        out += "    div(R)          Gauss linear;\n"
        out += "    div((nu*dev2(T(grad(U))))) Gauss linear;\n"
    out += "    div((nuEff*dev2(T(grad(U))))) Gauss linear;\n"
    return out


def _foam_float(x: float) -> str:
    """1e-4 -> '1e-4', 0.7 -> '0.7' (matches the committed js goldens)."""
    x = float(x)
    if x != 0 and abs(x) < 1e-3:
        mant, exp = f"{x:.6e}".split("e")
        mant = mant.rstrip("0").rstrip(".")
        return f"{mant}e{int(exp)}"
    return f"{x:g}"


# The steady schemes of each Numerics preset (physics.NUMERICS_PRESETS):
# gradient limiter, the turbulence equations' convection scheme and the
# non-orthogonal correction. Robust is what every study solved with before the
# preset existed (the motorBike-tutorial style, safe on poor meshes). Accurate
# follows the pitzDaily-tutorial style: limitedLinear (second order, bounded)
# for the turbulence equations, multi-directional gradient limiting at half
# strength, and full non-orthogonal correction. Momentum is second order
# (linearUpwind) in both.
_STEADY_SCHEMES: dict[str, dict[str, str]] = {
    "robust": {
        "grad": "cellLimited Gauss linear 1",
        "turb_div": "bounded Gauss upwind",
        "laplacian": "Gauss linear limited corrected 0.5",
        "sn_grad": "limited corrected 0.5",
    },
    "accurate": {
        "grad": "cellMDLimited Gauss linear 0.5",
        "turb_div": "bounded Gauss limitedLinear 1",
        "laplacian": "Gauss linear corrected",
        "sn_grad": "corrected",
    },
}


def _steady_fv_schemes_body(physics: StudyPhysics | None = None) -> str:
    ph = physics or DEFAULT_PHYSICS
    model = ph.turbulence_model
    s = _STEADY_SCHEMES.get(ph.numerics) or _STEADY_SCHEMES["robust"]
    return f"""ddtSchemes {{ default steadyState; }}
gradSchemes
{{
    default         Gauss linear;
    grad(U)         {s["grad"]};
{_grad_lines(model, s["grad"])}}}
divSchemes
{{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
{_div_lines(model, s["turb_div"])}{_POTENTIAL_DIV if ph.uses_potential_flow() else ""}}}
laplacianSchemes {{ default {s["laplacian"]}; }}
interpolationSchemes {{ default linear; }}
snGradSchemes {{ default {s["sn_grad"]}; }}
wallDist {{ method meshWave; }}"""


def _steady_fv_solution_body(physics: StudyPhysics | None = None) -> str:
    from .physics import solved_turbulence_fields

    ph = physics or DEFAULT_PHYSICS
    turb = solved_turbulence_fields(ph.turbulence_model)
    ru = _foam_float(ph.residual_u)
    residual = f"p {_foam_float(ph.residual_p)}; U {ru};"
    if turb:
        residual += ' "(' + "|".join(turb) + f')" {ru};'
    # SIMPLEC replaces the study's relaxation with its own (physics.solve_relax_*).
    relax_u = _foam_float(ph.solve_relax_u())
    equations = f"        U               {relax_u};\n"
    for name in turb:
        equations += f"        {name:<15} {relax_u};\n"
    non_orth = ph.potential_flow_non_orth() if ph.uses_potential_flow() else None
    return f"""solvers
{{
    p
    {{
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
        nCellsInCoarsestLevel 20;
        maxIter         200;
    }}
{_potential_solver(non_orth)}    {_equation_regex(ph.turbulence_model)}
    {{
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
        maxIter         50;
    }}
}}
SIMPLE
{{
    nNonOrthogonalCorrectors {int(ph.n_non_orthogonal)};
    consistent      {"yes" if ph.simplec else "no"};
    residualControl {{ {residual} }}
}}
{_potential_flow_dict(non_orth)}relaxationFactors
{{
    fields
    {{
        p               {_foam_float(ph.solve_relax_p())};
    }}
    equations
    {{
{equations}    }}
}}"""


def write_custom_monitor_surfaces(out: Path, spec: Any, services: Any = None) -> list[dict[str, Any]]:
    """One constant/triSurface/rc_<name>.stl (metres) per custom monitor.

    Cut from the study's CAD faces by the core (``services.faces_to_stl``) with
    the scale the mesher uses, so the sampled surface lies on the mesh boundary.
    Monitors whose faces are not on this geometry are skipped (nothing to sample).
    """
    mons = list(getattr(spec, "custom_monitors", None) or [])
    if not mons or services is None:
        return []
    from .function_objects import custom_monitor_key

    tri_dir = Path(out) / "constant" / "triSurface"
    taken: set[str] = set()
    written: list[dict[str, Any]] = []
    for m in mons:
        key = custom_monitor_key(str(m.get("name") or "monitor"), taken)
        fname = key + ".stl"
        area = services.faces_to_stl(
            list(m.get("faces") or []), tri_dir / fname, f"Magnusim monitor {m.get('name') or key}"
        )
        if area is None:
            taken.discard(key)
            continue
        written.append(
            {
                "id": m.get("id"),
                "name": str(m.get("name") or key),
                "key": key,
                "surface": fname,
                "faces": list(m.get("faces") or []),
                "area_m2": area,
            }
        )
    return written


def _copy_polymesh(src_case: Path, out_dir: Path) -> Path | None:
    """Copy constant/polyMesh from mesh case. Returns poly dst or None if absent."""
    candidates = [
        src_case / "constant" / "polyMesh",
        src_case if (src_case / "owner").is_file() else None,
    ]
    poly_src = next((p for p in candidates if p and p.is_dir() and (p / "owner").is_file()), None)
    const = out_dir / "constant"
    const.mkdir(parents=True, exist_ok=True)
    poly_dst = const / "polyMesh"
    if poly_src is None:
        return None
    if poly_dst.exists():
        shutil.rmtree(poly_dst)
    shutil.copytree(poly_src, poly_dst)
    return poly_dst


_TIME_NAME = re.compile(r"^\d+(\.\d+)?(?:[eE][+-]?\d+)?$")
# The parts of a continued run's solver log (solve.sh keeps log.<app>.1, .2, ...).
_LOG_PART = re.compile(r"^log\.(simpleFoam|pimpleFoam)\.\d+$")


def latest_saved_time(out_dir: Path) -> float | None:
    """The latest saved time (> 0) of a run's case whose frame has U and p, or None."""
    best: float | None = None
    if not out_dir.is_dir():
        return None
    for child in out_dir.iterdir():
        if not (child.is_dir() and _TIME_NAME.match(child.name)):
            continue
        t = float(child.name)
        if t > 0 and (child / "U").is_file() and (child / "p").is_file() and (best is None or t > best):
            best = t
    return best


def restart_write_interval(span: float, every: float) -> float:
    """A continued transient run's write interval: at most ``every``, and a whole
    number of them over ``span`` (the new end minus the time it continues from).

    adjustableRunTime counts its writes from the start time and OpenFOAM writes
    nothing at the end time itself, so a run continued from a time off its write
    grid (a Stop saves the current step) would otherwise never save its new end.
    """
    if not (span > 0 and every > 0):
        return every
    n = max(1, math.ceil(span / every - 1e-9))
    return float(f"{span / n:.12g}")


def _clean_prior_run(out_dir: Path, *, keep_times: bool = False) -> None:
    """Remove what an earlier solve of this case left: its result times, postProcessing
    and logs. ``keep_times`` (a run continued from its latest saved time) removes only
    the half-copied frames."""
    if not out_dir.is_dir():
        return
    for child in list(out_dir.iterdir()):
        name = child.name
        is_time = child.is_dir() and _TIME_NAME.match(name) and float(name) > 0
        # .frame-<t>.part: a result frame solve.sh was still copying in.
        is_tmp = child.is_dir() and (name.startswith(".sync_") or name.startswith(".frame-"))
        if is_tmp or (is_time and not keep_times):
            shutil.rmtree(child, ignore_errors=True)
        elif not keep_times and child.is_file() and _LOG_PART.match(name):
            child.unlink(missing_ok=True)
    if keep_times:
        return
    for stale in (
        "postProcessing",
        "log.simpleFoam",
        "log.pimpleFoam",
        "log.decomposePar",
        "log.reconstructPar",
        "log.reconstructPar.live",
        "log.livesync",
    ):
        p = out_dir / stale
        if p.exists():
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)
    # A potential-flow start's step log (foam_pre.sh: log.<tool>.<step>).
    for old in out_dir.glob("log.potentialFoam*"):
        old.unlink(missing_ok=True)


def _join_functions(text: str, extra: str) -> str:
    """controlDict function blocks plus ``extra`` (which replaces the no-monitor comment)."""
    if not extra:
        return text
    if not text.strip() or text.strip().startswith("//"):
        return extra
    return text + "\n" + extra


def _reference_monitors(spec: Any, poly_dst: Path | None, functions_text: str) -> tuple[str, dict[str, Any]]:
    """The function objects of Forces monitors (which measure against the study's
    reference values) and Point probes, and what the sidecar records about them."""
    from .force_objects import (
        forces_functions_text,
        plan_forces_monitors,
        plan_probe_monitors,
        probes_functions_text,
    )
    from .reference import resolve_reference

    reference = resolve_reference(spec)
    mesh_patches: set[str] | None = None
    if poly_dst and (poly_dst / "boundary").is_file():
        from magnusim_sdk.foam import boundary_patch_names as _parse_boundary_patches

        mesh_patches = set(_parse_boundary_patches(poly_dst / "boundary"))
    forces = plan_forces_monitors(spec, mesh_patches, reference)
    text = _join_functions(functions_text, forces_functions_text(forces, reference, transient=spec.transient))
    probes = plan_probe_monitors(spec)
    text = _join_functions(text, probes_functions_text(probes, transient=spec.transient))
    from .pressure_coefficient import pressure_coefficient_text

    cp = pressure_coefficient_text(spec, reference)
    text = _join_functions(text, cp)
    return text, {
        "reference": reference.to_json(),
        "forces_monitors": forces,
        "probe_monitors": probes,
        "pressure_coefficient": bool(cp),
    }


def write_solve_case(spec: RunSpec, out_dir: Path | str, services: Any = None) -> dict[str, Any]:
    """Write a complete run case matching the UI prepare_run contract (steady or transient).

    Product API.
    """
    _ensure_web_imports()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "0").mkdir(exist_ok=True)
    (out / "constant").mkdir(exist_ok=True)
    (out / "system").mkdir(exist_ok=True)
    restart = getattr(spec, "restart", None)
    restart_from: float | None = None
    if restart:
        # Continued from the latest saved time: the case keeps its times (and its
        # mesh, which those fields are on); only the new end is written.
        restart_from = latest_saved_time(out)
        if restart_from is None:
            return {"ok": False, "error": "This run has no saved result to continue from."}
        if float(spec.end_time) <= restart_from:
            end_text = js_plain_float(float(spec.end_time))
            return {
                "ok": False,
                "error": f"The new end ({end_text}) must be after the last saved time ({js_plain_float(restart_from)}).",
            }
        if spec.transient is not None:
            every = restart_write_interval(float(spec.end_time) - restart_from, float(spec.transient.write_interval))
            spec = dataclasses.replace(
                spec, transient=dataclasses.replace(spec.transient, write_interval=every), write_interval=every
            )
    _clean_prior_run(out, keep_times=restart_from is not None)

    kept_mesh = out / "constant" / "polyMesh"
    poly_dst: Path | None
    if restart_from is not None and (kept_mesh / "owner").is_file():
        poly_dst = kept_mesh
    else:
        poly_dst = _copy_polymesh(Path(spec.mesh_case_dir), out)
    patch_names = _patch_names(spec, poly_dst)

    speed_ref, d_hyd = resolve_speed_and_dhyd(spec)
    # Prefer RunSpec.speed_for_k when caller already resolved it (> default)
    if spec.speed_for_k and spec.speed_for_k != 1.0:
        speed_ref = float(spec.speed_for_k)
    physics: StudyPhysics = getattr(spec, "physics", None) or DEFAULT_PHYSICS
    model = physics.turbulence_model
    turb = k_omega_from_scales(speed_ref, d_hyd)
    # epsilon = Cmu * k * omega; isotropic Reynolds stress R = (2/3) k I.
    epsilon = 0.09 * turb["k"] * turb["omega"]
    # Spalart-Allmaras's Auto: nuTilda = 3 x nu at the inlets and inside.
    nu_tilda = sa_auto_nu_tilda(float(spec.nu)) if model == SA_MODEL else None
    turb_values = turb_value_strings(turb["k"], turb["omega"], nu_tilda)
    # Boundaries whose "Turbulence at the inlet" sets their own values.
    own_turb = patch_turbulence(spec, speed_ref) if model != "laminar" else {}
    patch_turb = {
        patch: turb_value_strings(sc["k"], sc["omega"], sc.get("nu_tilda")) for patch, sc in own_turb.items()
    }

    U, p, turb_patches = _build_field_patches(spec, patch_names, turb_values=turb_values, patch_turb=patch_turb)
    # The study's starting flow (Still: 0, as before the setting existed).
    u0, u0_from = initial_velocity(spec, speed_ref)
    write_vol_field(
        out / "0" / "U",
        object_name="U",
        cls="volVectorField",
        dims="[0 1 -1 0 0 0 0]",
        internal=_uniform_vector(u0),
        patches=U,
    )
    # A flux a potential-flow start left here: the solver would start from it.
    for stale in ("phi", "Phi"):
        (out / "0" / stale).unlink(missing_ok=True)
    write_vol_field(
        out / "0" / "p",
        object_name="p",
        cls="volScalarField",
        dims="[0 2 -2 0 0 0 0]",
        internal="uniform 0",
        patches=p,
    )
    # Drop turbulence fields left by a previous model in this run folder.
    for stale in ("k", "omega", "epsilon", "R", "nut", "nuTilda"):
        (out / "0" / stale).unlink(missing_ok=True)
    field_meta = {
        "k": ("volScalarField", "[0 2 -2 0 0 0 0]"),
        "omega": ("volScalarField", "[0 0 -1 0 0 0 0]"),
        "epsilon": ("volScalarField", "[0 2 -3 0 0 0 0]"),
        "R": ("volSymmTensorField", "[0 2 -2 0 0 0 0]"),
        "nut": ("volScalarField", "[0 2 -1 0 0 0 0]"),
        "nuTilda": ("volScalarField", "[0 2 -1 0 0 0 0]"),
    }
    for name, patches in turb_patches.items():
        cls, dims = field_meta[name]
        internal = "uniform 0" if name == "nut" else f"uniform {turb_values[name]}"
        write_vol_field(
            out / "0" / name,
            object_name=name,
            cls=cls,
            dims=dims,
            internal=internal,
            patches=patches,
        )

    # Wall functions require polyMesh type wall. gmshToFoam leftover
    # defaultFaces (prism end-caps) stay type patch unless we rewrite them.
    # A Symmetry BC's patch is made type symmetry here (it is meshed as a plain
    # patch), and a patch left symmetry by an earlier solve opens again when its
    # BC is no longer one, so a BC's type can change without a new mesh.
    if poly_dst and (poly_dst / "boundary").is_file():
        from magnusim_sdk.foam import parse_boundary_patch_types
        from magnusim_sdk.gmsh_helpers import apply_boundary_patch_types

        wall_names = {
            n
            for n, spec in turb_patches.get("nut", {}).items()
            if "WallFunction" in str((spec or {}).get("type") or "")
        }
        wall_names.update(
            n
            for n, spec in U.items()
            if str((spec or {}).get("type") or "") == "noSlip"
        )
        # Moving and rotating walls are walls with any turbulence model (laminar too).
        wall_names.update(
            str(m.get("patch") or "")
            for m in spec.mapped or []
            if is_wall_bc(_bc_dict(m.get("bc") or {})) and wall_kind(_bc_dict(m.get("bc") or {})) in ("Moving", "Rotating")
        )
        wall_names.discard("")
        patch_types = {n: "wall" for n in wall_names}
        patch_types.update({n: "symmetry" for n, e in U.items() if str((e or {}).get("type") or "") == "symmetry"})
        for pname, ptype in parse_boundary_patch_types(poly_dst / "boundary").items():
            if ptype == "symmetry" and pname not in patch_types:
                patch_types[pname] = "patch"
        if patch_types:
            apply_boundary_patch_types(poly_dst / "boundary", patch_types)

    write_foam_dict(
        out / "constant" / "transportProperties",
        "dictionary",
        "transportProperties",
        f"transportModel  Newtonian;\nnu              [0 2 -1 0 0 0 0] {js_plain_float(float(spec.nu))};",
    )
    write_foam_dict(
        out / "constant" / "turbulenceProperties",
        "dictionary",
        "turbulenceProperties",
        "simulationType  laminar;"
        if model == "laminar"
        else f"""simulationType  RAS;
RAS
{{
    RASModel        {model};
    turbulence      on;
    printCoeffs     on;
}}""",
    )

    mon_patches = list(spec.monitor_patches or [])
    functions_text = monitors_functions_text(mon_patches, transient=spec.transient)
    custom_meta = write_custom_monitor_surfaces(out, spec, services)
    if custom_meta:
        from .function_objects import custom_monitors_functions_text

        extra = custom_monitors_functions_text(custom_meta, transient=spec.transient)
        functions_text = extra if not mon_patches else functions_text + "\n" + extra
    from .function_objects import result_fields_functions_text

    # Extra result fields at every saved time (y+, wall shear stress, total
    # pressure, vorticity, Q; time averages for a transient run).
    functions_text += "\n" + result_fields_functions_text(
        turbulent=model != "laminar", rho=float(spec.rho), transient=spec.transient
    )
    functions_text, monitor_meta = _reference_monitors(spec, poly_dst, functions_text)
    # "Stop when a monitor settles": a runTimeControl after the monitors it reads.
    from .settle import plan_settle, settle_functions_text

    settle_plan = plan_settle(
        spec,
        custom_meta=custom_meta,
        forces_plans=monitor_meta["forces_monitors"],
        probe_plans=monitor_meta["probe_monitors"],
    )
    functions_text = _join_functions(functions_text, settle_functions_text(settle_plan))
    is_transient = spec.transient is not None

    if is_transient:
        write_control_dict_transient(
            out / "system" / "controlDict",
            ctrl=spec.transient,  # type: ignore[arg-type]
            functions_text=functions_text,
            restart=restart_from is not None,
        )
        write_fv_schemes_transient(
            out / "system" / "fvSchemes",
            ctrl=spec.transient,  # type: ignore[arg-type]
            turbulence=model,
            potential=physics.uses_potential_flow(),
        )
        write_fv_solution_pimple(
            out / "system" / "fvSolution",
            ctrl=spec.transient,  # type: ignore[arg-type]
            turbulence=model,  # type: ignore[arg-type]
            potential_non_orth=physics.potential_flow_non_orth() if physics.uses_potential_flow() else None,
        )
    else:
        write_foam_dict(
            out / "system" / "controlDict",
            "dictionary",
            "controlDict",
            _steady_control_dict_body(spec.end_time, spec.write_interval, functions_text, restart_from=restart_from),
        )
        write_foam_dict(
            out / "system" / "fvSchemes",
            "dictionary",
            "fvSchemes",
            _steady_fv_schemes_body(physics),
        )
        write_foam_dict(
            out / "system" / "fvSolution",
            "dictionary",
            "fvSolution",
            _steady_fv_solution_body(physics),
        )

    u_max = max(50.0, 10.0 * abs(speed_ref))
    write_fv_options_limit_u(out / "system" / "fvOptions", max_u=u_max)

    if int(spec.n_procs) > 1:
        _write_decompose_par_dict_sdk(out / "system" / "decomposeParDict", int(spec.n_procs))

    (out / "case.foam").write_text("", encoding="ascii")

    mapped_meta = []
    for m in spec.mapped or []:
        bc = _bc_dict(m.get("bc") or {})
        faces = bc_faces(bc)
        entry: dict[str, Any] = {
            "name": bc.get("name"),
            "bc_type": bc.get("bc_type"),
            "patch": m.get("patch"),
            "faces": faces,
            "value": bc.get("value"),
            "unit": bc.get("unit") or None,
            "face_area_m2": faces_area(faces, spec.face_props) or None,
        }
        if is_wall_bc(bc):
            entry["wall_type"] = wall_kind(bc)
        mapped_meta.append(entry)

    sidecar: dict[str, Any] = {
        "endTime": spec.end_time,
        "writeInterval": spec.write_interval,
        "nProcs": int(spec.n_procs),
        "solver": "pimpleFoam" if is_transient else "simpleFoam",
        "time_dependency": "Transient" if is_transient else "Steady-state",
        "nu": float(spec.nu),
        "rho": float(spec.rho),
        # Fields stored divided by rho: the results viewer shows them times rho (Pa).
        "kinematic_fields": list(KINEMATIC_FIELDS),
        "patches": patch_names,
        "wall_default": spec.wall_default,
        "mapped": mapped_meta,
        "monitors": mon_patches,
        "custom_monitors": custom_meta,
        **monitor_meta,
        "turbulence": {
            "model": model,
            "intensity": turb["I"],
            "length_scale_m": turb["L"],
            "hydraulic_diameter_m": d_hyd,
            "speed_ref_m_s": speed_ref,
            "k": turb["k"],
            "omega": turb["omega"],
            "epsilon": epsilon,
            # Patches whose "Turbulence at the inlet" is not Auto: their own scales.
            "patches": own_turb,
        },
        "numerics": {
            "residual_u": physics.residual_u,
            "residual_p": physics.residual_p,
            # The relaxation the steady solve uses (SIMPLEC's own while it is on).
            "relax_u": physics.solve_relax_u(),
            "relax_p": physics.solve_relax_p(),
            "n_non_orthogonal": physics.n_non_orthogonal,
            "preset": physics.numerics,
            "simplec": physics.simplec,
        },
        # The starting flow: 0/U's internal velocity (m/s), where it came from
        # (still, custom, inlet, freestream, or none: "From the inlet" with no
        # inlet or freestream to take it from), and the potential-flow start.
        "initial": {
            "flow": physics.initial_flow,
            "velocity_m_s": u0,
            "from": u0_from,
            "potential_flow": physics.uses_potential_flow(),
        },
        "n_cells": spec.n_cells,
        "mesh_id": spec.mesh_id,
        "run_id": spec.run_id,
    }
    if nu_tilda is not None:
        # Spalart-Allmaras: the Auto nuTilda (inlets on Auto and the starting field).
        sidecar["turbulence"]["nu_tilda"] = nu_tilda
    if physics.uses_potential_flow():
        # WSL steps the runner runs on the written case before the solver (each
        # checked against its step table): potentialFoam writes the start into 0/.
        sidecar["pre_steps"] = potential_flow_steps()
    if settle_plan is not None:
        # What the settle stop watches as written, or why it is not written.
        sidecar["settle"] = settle_plan
    if restart_from is not None:
        sidecar["restart"] = {"from_time": restart_from, "end_time": float(spec.end_time)}
    if is_transient and spec.transient is not None:
        t = spec.transient
        sidecar["transient"] = {
            "end_time": t.end_time,
            "delta_t": t.delta_t,
            "write_interval": t.write_interval,
            "adjust_time_step": t.adjust_time_step,
            "max_co": t.max_co,
            "max_delta_t": t.max_delta_t,
            "time_scheme": t.time_scheme,
            "n_outer_correctors": t.n_outer_correctors,
            "n_correctors": t.n_correctors,
            "n_non_orthogonal_correctors": t.n_non_orthogonal_correctors,
            "average_from": t.average_from,
        }
    report: dict[str, Any] = {
        "ok": True,
        "case_dir": str(out),
        "solver": sidecar["solver"],
        "n_procs": int(spec.n_procs),
        "patches": patch_names,
        "turbulence": sidecar["turbulence"],
        "polyMesh_copied": poly_dst is not None,
    }
    if restart_from is not None:
        report["restart"] = dict(sidecar["restart"])
        # The steps a run takes before its solver (pre_steps, e.g. potentialFoam's
        # starting field) belong to a run written from the start: a continued run
        # starts from its saved fields, so it never has any.
        sidecar.pop("pre_steps", None)
        report.pop("pre_steps", None)
    (out / "w27-case.json").write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
    return report
