"""Incompressible Flow's boundary conditions: the BC types (variants) and families.

The families the Boundary Conditions panel offers (Velocity inlet, Velocity
outlet, Pressure, Wall, Symmetry, ...) and their BC types. The seven keys
projects have always stored (``analyses.bc_types``, project.json v8 records and
``hub.bc.extend`` name them) keep their meaning, so nothing saved changes. Flow
rate and slip / no-slip are settings of a family, not families of their own.

``resolve_record`` turns a saved web record into its BC type key and SI settings
(each family's ``resolve``).
"""

from __future__ import annotations

import math
import re
from typing import Any

from cfddesk.registry.bc import BcFamily, BcTypeSpec
from cfddesk.registry.schema import SchemaField
from magnusim_sdk.study import (
    is_pressure_bc,
    is_velocity_inlet,
    is_velocity_outlet,
    is_wall_bc,
)
from magnusim_sdk.units.convert import to_si

from . import inlet_turbulence as _turb
from .bc_kinds import (
    is_freestream,
    is_symmetry,
    is_total_pressure_inlet,
    wall_kind,
    wall_rotation,
    wall_velocity,
)

SettingField = SchemaField

# The family every BC type of this plugin belongs to.
VELOCITY_INLET = "velocity_inlet"
VELOCITY_OUTLET = "velocity_outlet"
PRESSURE = "pressure_outlet"
WALL = "wall"
SYMMETRY = "symmetry"
FREESTREAM = "freestream"
TOTAL_PRESSURE = "total_pressure_inlet"

# The editor slot component (ui/) that draws every family's settings.
BC_UI = "incompressible_flow.bc"


# --- OpenFOAM boundaryField entries -------------------------------------------


def _entry(body: str) -> str:
    return body.rstrip() + "\n"


def _fixed_vector(name: str, settings: dict, _ctx: dict) -> str:
    v = settings.get("velocity", (0.0, 0.0, 0.0))
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        vx, vy, vz = float(v[0]), float(v[1]), float(v[2])
    else:
        vx = vy = vz = 0.0
    return _entry(
        f"""    {name}
    {{
        type            fixedValue;
        value           uniform ({vx:g} {vy:g} {vz:g});
    }}"""
    )


def _velocity_inlet_fixed_U(name: str, settings: dict, ctx: dict) -> str:
    mode = str(settings.get("direction_mode", "normal"))
    if mode == "vector":
        return _fixed_vector(name, settings, ctx)
    # magnitude + inward (-outward normal) from context
    speed = float(settings.get("speed_m_s", 0.0))
    n = ctx.get("inward_normal")
    if n is None:
        n = (-1.0, 0.0, 0.0)
    u = (n[0] * speed, n[1] * speed, n[2] * speed)
    return _entry(
        f"""    {name}
    {{
        type            fixedValue;
        value           uniform ({u[0]:g} {u[1]:g} {u[2]:g});
    }}"""
    )


def _zero_grad(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            zeroGradient;
    }}"""
    )


def _no_slip(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            noSlip;
    }}"""
    )


def _slip(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            slip;
    }}"""
    )


def _flow_rate_inlet_U(name: str, settings: dict, _ctx: dict) -> str:
    # volumetric m3/s or mass kg/s via rho
    kind = str(settings.get("flow_kind", "volumetric"))
    if kind == "mass":
        rate = float(settings.get("mass_flow_kg_s", 0.0))
        rho = float(settings.get("rho", 1.0))
        return _entry(
            f"""    {name}
    {{
        type            flowRateInletVelocity;
        massFlowRate    constant {rate:g};
        rho             {rho:g};
        value           uniform (0 0 0);
    }}"""
        )
    rate = float(settings.get("volumetric_flow_m3_s", 0.0))
    return _entry(
        f"""    {name}
    {{
        type            flowRateInletVelocity;
        volumetricFlowRate constant {rate:g};
        value           uniform (0 0 0);
    }}"""
    )


def _inlet_outlet_U(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            inletOutlet;
        inletValue      uniform (0 0 0);
        value           uniform (0 0 0);
    }}"""
    )


def _symmetry(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            symmetry;
    }}"""
    )


def _vec3(v: Any, default: tuple[float, float, float] = (0.0, 0.0, 0.0)) -> tuple[float, float, float]:
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        try:
            out = (float(v[0]), float(v[1]), float(v[2]))
        except (TypeError, ValueError):
            return default
        if all(math.isfinite(x) for x in out):
            return out
    return default


def _freestream_U(name: str, settings: dict, _ctx: dict) -> str:
    u = _vec3(settings.get("velocity"))
    return _entry(
        f"""    {name}
    {{
        type            freestreamVelocity;
        freestreamValue uniform ({u[0]:g} {u[1]:g} {u[2]:g});
    }}"""
    )


def _freestream_p(name: str, settings: dict, _ctx: dict) -> str:
    p = float(settings.get("pressure", 0.0))
    return _entry(
        f"""    {name}
    {{
        type            freestreamPressure;
        freestreamValue uniform {p:g};
    }}"""
    )


def _rotating_wall_U(name: str, settings: dict, _ctx: dict) -> str:
    o = _vec3(settings.get("origin"))
    a = _vec3(settings.get("axis"), (0.0, 0.0, 1.0))
    w = float(settings.get("omega", 0.0))
    return _entry(
        f"""    {name}
    {{
        type            rotatingWallVelocity;
        origin          ({o[0]:g} {o[1]:g} {o[2]:g});
        axis            ({a[0]:g} {a[1]:g} {a[2]:g});
        omega           {w:g};
        value           uniform (0 0 0);
    }}"""
    )


def _pressure_inlet_outlet_U(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            pressureInletOutletVelocity;
        value           uniform (0 0 0);
    }}"""
    )


def _total_p(name: str, settings: dict, _ctx: dict) -> str:
    p0 = float(settings.get("total_pressure", 0.0))
    return _entry(
        f"""    {name}
    {{
        type            totalPressure;
        p0              uniform {p0:g};
        value           uniform {p0:g};
    }}"""
    )


def _fixed_p(name: str, settings: dict, _ctx: dict) -> str:
    p = float(settings.get("gauge_pressure", settings.get("pressure", 0.0)))
    return _entry(
        f"""    {name}
    {{
        type            fixedValue;
        value           uniform {p:g};
    }}"""
    )


def _T_fixed(name: str, settings: dict, _ctx: dict) -> str:
    t = float(settings.get("temperature_K", 293.15))
    return _entry(
        f"""    {name}
    {{
        type            fixedValue;
        value           uniform {t:g};
    }}"""
    )


def _T_zero_grad(name: str, _s: dict, _c: dict) -> str:
    return _zero_grad(name, _s, _c)


def _T_heat_flux(name: str, settings: dict, _ctx: dict) -> str:
    q = float(settings.get("heat_flux_W_m2", 0.0))
    return _entry(
        f"""    {name}
    {{
        type            externalWallHeatFluxTemperature;
        mode            flux;
        q               uniform {q:g};
        value           uniform 293.15;
    }}"""
    )


def _T_external_htc(name: str, settings: dict, _ctx: dict) -> str:
    h = float(settings.get("htc_W_m2K", 10.0))
    ta = float(settings.get("ambient_T_K", 293.15))
    return _entry(
        f"""    {name}
    {{
        type            externalWallHeatFluxTemperature;
        mode            coefficient;
        h               uniform {h:g};
        Ta              uniform {ta:g};
        value           uniform {ta:g};
    }}"""
    )


def _wall_T(name: str, settings: dict, ctx: dict) -> str:
    mode = str(settings.get("thermal_mode", "adiabatic"))
    if mode == "fixed_temperature":
        return _T_fixed(name, settings, ctx)
    if mode == "fixed_heat_flux":
        return _T_heat_flux(name, settings, ctx)
    if mode == "external_heat_transfer":
        return _T_external_htc(name, settings, ctx)
    return _T_zero_grad(name, settings, ctx)


# --- BC types ------------------------------------------------------------------

_THERMAL_WALL_FIELDS = (
    SettingField(
        "thermal_mode",
        "Thermal",
        "choice",
        default="adiabatic",
        choices=(
            "adiabatic",
            "fixed_temperature",
            "fixed_heat_flux",
            "external_heat_transfer",
        ),
        energy_only=True,
    ),
    SettingField(
        "temperature_K",
        "Temperature",
        "float",
        default=293.15,
        unit="K",
        energy_only=True,
        rate_kind="intensive",
    ),
    SettingField(
        "heat_flux_W_m2",
        "Heat flux",
        "float",
        default=0.0,
        unit="W/m²",
        energy_only=True,
        rate_kind="extensive",
    ),
    SettingField(
        "htc_W_m2K", "HTC", "float", default=10.0, unit="W/m²K", energy_only=True
    ),
    SettingField(
        "ambient_T_K", "Ambient T", "float", default=293.15, unit="K", energy_only=True
    ),
)

_INLET_T = (
    SettingField(
        "temperature_K",
        "Inlet temperature",
        "float",
        default=293.15,
        unit="K",
        energy_only=True,
        rate_kind="intensive",
    ),
)


BC_TYPES: tuple[BcTypeSpec, ...] = (
    BcTypeSpec(
        "velocity_inlet_fixed",
        "Velocity inlet",
        "inlet",
        "patch",
        (
            SettingField(
                "direction_mode",
                "Direction",
                "choice",
                default="normal",
                choices=("normal", "vector"),
            ),
            SettingField(
                "speed_m_s",
                "Speed",
                "float",
                default=20.0,
                unit="m/s",
                rate_kind="intensive",
            ),
            SettingField(
                "velocity",
                "Velocity vector",
                "vector3",
                default=(0.0, 0.0, 0.0),
                unit="m/s",
                rate_kind="intensive",
            ),
            *_INLET_T,
        ),
        write_U=_velocity_inlet_fixed_U,
        write_p=_zero_grad,
        write_T=_T_fixed,
        family=VELOCITY_INLET,
        match=(("velocity_type", "Fixed"),),
    ),
    BcTypeSpec(
        "velocity_inlet_volumetric",
        "Velocity inlet",
        "inlet",
        "patch",
        (
            SettingField(
                "volumetric_flow_m3_s",
                "Volumetric flow",
                "float",
                default=0.0,
                unit="m³/s",
                rate_kind="extensive",
            ),
            SettingField("flow_kind", "Kind", "choice", default="volumetric", choices=("volumetric",)),
            *_INLET_T,
        ),
        write_U=_flow_rate_inlet_U,
        write_p=_zero_grad,
        write_T=_T_fixed,
        family=VELOCITY_INLET,
        match=(("velocity_type", "Flow rate"), ("flow_rate_type", "Volumetric flow")),
    ),
    BcTypeSpec(
        "velocity_inlet_mass",
        "Velocity inlet",
        "inlet",
        "patch",
        (
            SettingField(
                "mass_flow_kg_s",
                "Mass flow",
                "float",
                default=0.0,
                unit="kg/s",
                rate_kind="extensive",
            ),
            SettingField("rho", "Density", "float", default=1.0, unit="kg/m³"),
            SettingField("flow_kind", "Kind", "choice", default="mass", choices=("mass",)),
            *_INLET_T,
        ),
        write_U=_flow_rate_inlet_U,
        write_p=_zero_grad,
        write_T=_T_fixed,
        family=VELOCITY_INLET,
        match=(("velocity_type", "Flow rate"), ("flow_rate_type", "Mass flow")),
    ),
    BcTypeSpec(
        "velocity_outlet",
        "Velocity outlet",
        "outlet",
        "patch",
        (
            SettingField(
                "velocity",
                "Velocity vector",
                "vector3",
                default=(0.0, 0.0, 0.0),
                unit="m/s",
                rate_kind="intensive",
            ),
        ),
        write_U=_fixed_vector,
        write_p=_zero_grad,
        family=VELOCITY_OUTLET,
    ),
    BcTypeSpec(
        "pressure_outlet_gauge",
        "Pressure",
        "outlet",
        "patch",
        (
            SettingField(
                "gauge_pressure",
                "Gauge pressure",
                "float",
                default=0.0,
                unit="Pa",
                rate_kind="intensive",
            ),
        ),
        write_U=_inlet_outlet_U,
        write_p=_fixed_p,
        family=PRESSURE,
    ),
    BcTypeSpec(
        "wall_noslip",
        "Wall",
        "wall",
        "wall",
        _THERMAL_WALL_FIELDS,
        write_U=_no_slip,
        write_p=_zero_grad,
        write_T=_wall_T,
        family=WALL,
        match=(("wall_type", "No-slip"),),
    ),
    BcTypeSpec(
        "wall_slip",
        "Wall",
        "wall",
        "wall",
        _THERMAL_WALL_FIELDS,
        write_U=_slip,
        write_p=_zero_grad,
        write_T=_wall_T,
        family=WALL,
        match=(("wall_type", "Slip"),),
    ),
    # A mirror plane: meshed as a plain patch (its own, named by the BC), made a
    # ``symmetry`` patch by the case writer at solve time (flat or not).
    BcTypeSpec(
        "symmetry",
        "Symmetry",
        "wall",
        "patch",
        (),
        write_U=_symmetry,
        write_p=_symmetry,
        family=SYMMETRY,
    ),
    # The far field around a body: the undisturbed flow comes in or leaves.
    BcTypeSpec(
        "freestream",
        "Freestream",
        "outlet",
        "patch",
        (
            SettingField("velocity", "Freestream velocity", "vector3", default=(0.0, 0.0, 0.0), unit="m/s", rate_kind="intensive"),
            SettingField("pressure", "Freestream pressure", "float", default=0.0, unit="Pa", rate_kind="intensive"),
        ),
        write_U=_freestream_U,
        write_p=_freestream_p,
        family=FREESTREAM,
    ),
    # A wall sliding along itself (tangential velocity) or turning about an axis:
    # no-slip relative to its motion, with the no-slip wall's turbulence.
    BcTypeSpec(
        "wall_moving",
        "Wall",
        "wall",
        "wall",
        (
            *_THERMAL_WALL_FIELDS,
            SettingField("velocity", "Wall velocity", "vector3", default=(0.0, 0.0, 0.0), unit="m/s", rate_kind="intensive"),
        ),
        write_U=_fixed_vector,
        write_p=_zero_grad,
        write_T=_wall_T,
        family=WALL,
        match=(("wall_type", "Moving"),),
    ),
    BcTypeSpec(
        "wall_rotating",
        "Wall",
        "wall",
        "wall",
        (
            *_THERMAL_WALL_FIELDS,
            SettingField("origin", "Origin", "vector3", default=(0.0, 0.0, 0.0), unit="m"),
            SettingField("axis", "Axis", "vector3", default=(0.0, 0.0, 1.0)),
            SettingField("omega", "Speed", "float", default=0.0, unit="rad/s", rate_kind="intensive"),
        ),
        write_U=_rotating_wall_U,
        write_p=_zero_grad,
        write_T=_wall_T,
        family=WALL,
        match=(("wall_type", "Rotating"),),
    ),
    # Flow driven in by a fixed total pressure (static + dynamic).
    BcTypeSpec(
        "total_pressure_inlet",
        "Total pressure inlet",
        "inlet",
        "patch",
        (SettingField("total_pressure", "Total pressure", "float", default=0.0, unit="Pa", rate_kind="intensive"),),
        write_U=_pressure_inlet_outlet_U,
        write_p=_total_p,
        family=TOTAL_PRESSURE,
    ),
)

BC_KEYS: tuple[str, ...] = tuple(spec.key for spec in BC_TYPES)


# --- Saved record -> BC type key and SI settings ---------------------------------

_UNIT_ALIASES = {
    # ft3/min is the CFM table key
    "ft3/min": "CFM",
    "ft³/min": "CFM",
    "m3/s": "m³/s",
    "m^3/s": "m³/s",
    "m3/h": "m³/h",
    "m^3/h": "m³/h",
}


def _to(q: str, v: Any, u: str, default_u: str) -> float | None:
    """``v`` in ``u`` (``default_u`` when blank) as SI; ``v`` itself for a unit
    the quantity does not know; None when there is no value."""
    if v is None:
        return None
    try:
        use = _UNIT_ALIASES.get(u if u else default_u, u if u else default_u)
        try:
            return float(to_si(q, float(v), use))  # type: ignore[arg-type]
        except ValueError:
            return float(v)
    except Exception:
        return float(v)


def _number(v: Any, default: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return n if math.isfinite(n) else default


def resolve_record(record: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Map a saved web BC record to (BC type key, settings in SI units).

    Values are converted to SI using the record's ``unit`` field where possible.
    A record of no family here reads as a no-slip wall.
    """
    d = dict(record or {})
    unit = str(d.get("unit") or "")
    val = d.get("value")
    settings: dict[str, Any] = {}

    if is_wall_bc(d):
        kind = wall_kind(d)
        if kind == "Moving":
            settings["velocity"] = wall_velocity(d)
            return "wall_moving", settings
        if kind == "Rotating":
            origin, axis, omega = wall_rotation(d)
            settings.update(origin=origin, axis=axis, omega=omega)
            return "wall_rotating", settings
        return ("wall_slip" if kind == "Slip" else "wall_noslip"), settings

    if is_velocity_inlet(d):
        vtype = str(d.get("velocity_type") or "")
        if re.search(r"flow\s*rate", vtype, re.I) or re.search(
            r"ft3/min|ft³/min|m3/s|m³/s|kg/s|lb/s", unit, re.I
        ):
            if re.search(r"mass", str(d.get("flow_rate_type") or ""), re.I) or (
                _to("mass_flow", val, unit, "kg/s") is not None
                and _to("volumetric_flow", val, unit, "m³/s") is None
            ):
                settings["mass_flow_rate"] = _to("mass_flow", val, unit, "kg/s") or 0.0
                return "velocity_inlet_mass", settings
            settings["volumetric_flow_rate"] = _to("volumetric_flow", val, unit, "m³/s") or 0.0
            return "velocity_inlet_volumetric", settings
        speed = _to("velocity", val, unit, "m/s")
        if speed is None:
            speed = 1.0
        if re.search(r"vector", str(d.get("direction") or ""), re.I) and isinstance(
            (vector := d.get("vector")), (list, tuple)
        ):
            vec = [float(x) for x in vector[:3]]
            if len(vec) != 3 or not all(math.isfinite(x) for x in vec):
                raise ValueError("Velocity direction requires three finite components")
            mag = math.hypot(*vec) or 1.0
            settings["direction_mode"] = "vector"
            settings["velocity"] = [speed * (vec[0] / mag), speed * (vec[1] / mag), speed * (vec[2] / mag)]
        else:
            settings["direction_mode"] = "normal"
            settings["speed"] = speed
        return "velocity_inlet_fixed", settings

    if is_velocity_outlet(d):
        return "velocity_outlet", settings

    if is_pressure_bc(d):
        p = _to("pressure", val, unit, "Pa")
        settings["gauge_pressure"] = 0.0 if p is None else p
        return "pressure_outlet_gauge", settings

    if is_symmetry(d):
        return "symmetry", settings

    if is_total_pressure_inlet(d):
        p0 = _to("pressure", val, unit, "Pa")
        settings["total_pressure"] = 0.0 if p0 is None else p0
        return "total_pressure_inlet", settings

    if is_freestream(d):
        speed = _to("velocity", val, unit, "m/s")
        direction = _vec3(d.get("vector"), (1.0, 0.0, 0.0))
        mag = math.hypot(*direction)
        if not mag > 0:
            direction, mag = (1.0, 0.0, 0.0), 1.0
        spd = abs(speed) if speed is not None else 0.0
        settings["velocity"] = [spd * c / mag for c in direction]
        settings["pressure"] = _number(d.get("freestream_pressure"), 0.0)
        return "freestream", settings

    # Fallback: wall
    return "wall_noslip", settings


# --- Families --------------------------------------------------------------------

# A velocity family's seed (w19 buildBc and the panel's create seeds).
_VELOCITY_SEED: dict[str, Any] = {
    "velocity_type": "Fixed",
    "flow_rate_type": "Volumetric flow",
    "value": 5,
    "direction": "Normal to face",
    "vector": [0, 0, 1],
    "apply_per_face": True,
}

# Which quantity a velocity record's value is (the first row that applies wins).
_VELOCITY_VALUES: tuple[tuple[str, str, str, dict[str, Any]], ...] = (
    ("value", "unit", "mass_flow", {"velocity_type": "Flow rate", "flow_rate_type": "Mass flow"}),
    ("value", "unit", "volumetric_flow", {"velocity_type": "Flow rate"}),
    ("value", "unit", "velocity", {}),
)

_VELOCITY_FIELDS: tuple[SchemaField, ...] = (
    SchemaField("velocity_type", "Velocity type", "choice", default="Fixed", choices=("Fixed", "Flow rate")),
    SchemaField(
        "flow_rate_type",
        "Flow rate type",
        "choice",
        default="Volumetric flow",
        choices=("Volumetric flow", "Mass flow"),
        depends_on={"velocity_type": "Flow rate"},
    ),
    SchemaField("value", "Value", "float", default=5),
    SchemaField("unit", "Unit", "text", default="m/s"),
    SchemaField(
        "direction",
        "Direction",
        "choice",
        default="Normal to face",
        choices=("Normal to face", "Vector"),
        depends_on={"velocity_type": "Fixed"},
    ),
    SchemaField(
        "vector",
        "Vector (X Y Z)",
        "vector3",
        default=(0.0, 0.0, 1.0),
        depends_on={"velocity_type": "Fixed", "direction": "Vector"},
    ),
)


# "Turbulence at the inlet" (inlet_turbulence.py): on the boundaries flow comes
# in through. The length scale is stored in metres; the panel shows it in the
# project's unit system.
TURBULENCE_FIELDS: tuple[SchemaField, ...] = (
    SchemaField(
        "turbulence_spec",
        "Turbulence at the inlet",
        "choice",
        default=_turb.AUTO,
        choices=_turb.SPECS,
        description="How turbulent the flow coming in is. Auto: 5 % intensity, length scale 0.07 x the largest inlet's hydraulic diameter.",
    ),
    SchemaField(
        "turbulence_intensity",
        "Turbulence intensity",
        "float",
        default=_turb.DEFAULT_INTENSITY_PCT,
        unit="%",
        min=0,
        max=100,
    ),
    SchemaField(
        "turbulence_length_scale",
        "Length scale",
        "float",
        default=_turb.DEFAULT_LENGTH_M,
        unit="m",
        quantity="length",
        min=0,
        depends_on={"turbulence_spec": _turb.LENGTH},
    ),
    SchemaField(
        "turbulence_viscosity_ratio",
        "Viscosity ratio",
        "float",
        default=_turb.DEFAULT_RATIO,
        min=0,
        depends_on={"turbulence_spec": _turb.RATIO},
        description="Turbulent viscosity over the fluid's own viscosity.",
    ),
)


# A wall's treatment and, for a moving or rotating wall, its motion. Numbers are
# stored in SI (the wall velocity in m/s, the origin in m); the panel shows
# them in the project's unit system. The rotation speed is in rpm.
WALL_FIELDS: tuple[SchemaField, ...] = (
    SchemaField("wall_type", "Wall type", "choice", default="No-slip", choices=("No-slip", "Slip", "Moving", "Rotating")),
    SchemaField(
        "wall_velocity",
        "Wall velocity (X Y Z)",
        "vector3",
        default=(1.0, 0.0, 0.0),
        unit="m/s",
        quantity="velocity",
        depends_on={"wall_type": "Moving"},
        description="How fast the wall slides along itself.",
    ),
    SchemaField("rotation_axis", "Axis (X Y Z)", "vector3", default=(0.0, 0.0, 1.0), depends_on={"wall_type": "Rotating"}),
    SchemaField(
        "rotation_origin",
        "Origin (X Y Z)",
        "vector3",
        default=(0.0, 0.0, 0.0),
        unit="m",
        quantity="length",
        depends_on={"wall_type": "Rotating"},
    ),
    SchemaField(
        "rotation_speed",
        "Speed",
        "float",
        default=100.0,
        unit="rpm",
        depends_on={"wall_type": "Rotating"},
        description="Turns about the axis by the right-hand rule; negative turns the other way.",
    ),
)

# A freestream's velocity: a speed (value + unit) along a direction, or the
# velocity's components (in ``unit``; ``value`` then holds their magnitude, so
# both read the same). Its pressure is gauge, stored in Pa.
FREESTREAM_INPUTS = ("Speed and direction", "Velocity vector")

_FREESTREAM_FIELDS: tuple[SchemaField, ...] = (
    SchemaField("velocity_input", "Velocity given as", "choice", default=FREESTREAM_INPUTS[0], choices=FREESTREAM_INPUTS),
    SchemaField("value", "Speed", "float", default=10, quantity="velocity"),
    SchemaField("unit", "Unit", "text", default="m/s"),
    SchemaField("vector", "Direction (X Y Z)", "vector3", default=(1.0, 0.0, 0.0)),
    SchemaField("freestream_pressure", "Freestream pressure", "float", default=0.0, unit="Pa", quantity="pressure"),
    *TURBULENCE_FIELDS,
)


def _freestream_defaults() -> dict[str, dict[str, Any]]:
    seed = {"velocity_input": FREESTREAM_INPUTS[0], "value": 10, "vector": [1, 0, 0], "freestream_pressure": 0}
    return {"metric": {**seed, "unit": "m/s"}, "imperial": {**seed, "unit": "ft/s"}}


def _velocity_defaults() -> dict[str, dict[str, Any]]:
    return {
        "metric": {**_VELOCITY_SEED, "unit": "m/s"},
        "imperial": {**_VELOCITY_SEED, "unit": "ft/s"},
    }


BC_FAMILIES: tuple[BcFamily, ...] = (
    BcFamily(
        key=VELOCITY_INLET,
        label="Velocity inlet",
        record_type="Velocity inlet",
        color="inlet",
        variants=("velocity_inlet_fixed", "velocity_inlet_volumetric", "velocity_inlet_mass"),
        defaults=_velocity_defaults(),
        values=_VELOCITY_VALUES,
        fields=(*_VELOCITY_FIELDS, *TURBULENCE_FIELDS),
        ui=BC_UI,
        resolve=resolve_record,
    ),
    BcFamily(
        key=VELOCITY_OUTLET,
        label="Velocity outlet",
        record_type="Velocity outlet",
        color="outlet",
        variants=("velocity_outlet",),
        defaults=_velocity_defaults(),
        values=_VELOCITY_VALUES,
        fields=_VELOCITY_FIELDS,
        ui=BC_UI,
        resolve=resolve_record,
    ),
    BcFamily(
        key=PRESSURE,
        label="Pressure",
        record_type="Pressure",
        aliases=("Pressure inlet", "Pressure outlet"),
        color="pressure",
        variants=("pressure_outlet_gauge",),
        defaults={
            "metric": {"pressure_type": "Fixed value", "value": 0, "unit": "Pa"},
            "imperial": {"pressure_type": "Fixed value", "value": 0, "unit": "psi"},
        },
        values=(("value", "unit", "pressure", {}),),
        fields=(
            SchemaField("pressure_type", "Pressure type", "choice", default="Fixed value", choices=("Fixed value",)),
            SchemaField("value", "Fixed value", "float", default=0, quantity="pressure"),
            SchemaField("unit", "Unit", "text", default="Pa"),
            *TURBULENCE_FIELDS,
        ),
        ui=BC_UI,
        resolve=resolve_record,
    ),
    BcFamily(
        key=TOTAL_PRESSURE,
        label="Total pressure inlet",
        record_type="Total pressure inlet",
        aliases=("Total pressure",),
        color="pressure",
        hint="Flow comes in, driven by a fixed total pressure",
        variants=("total_pressure_inlet",),
        defaults={"metric": {"value": 0, "unit": "Pa"}, "imperial": {"value": 0, "unit": "psi"}},
        values=(("value", "unit", "pressure", {}),),
        fields=(
            SchemaField("value", "Total pressure", "float", default=0, quantity="pressure"),
            SchemaField("unit", "Unit", "text", default="Pa"),
            *TURBULENCE_FIELDS,
        ),
        ui=BC_UI,
        resolve=resolve_record,
    ),
    BcFamily(
        key=FREESTREAM,
        label="Freestream",
        record_type="Freestream",
        aliases=("Far field", "Far-field"),
        color="freestream",
        hint="Far field around a body: the undisturbed flow comes in or leaves",
        variants=("freestream",),
        defaults=_freestream_defaults(),
        values=(("value", "unit", "velocity", {}),),
        fields=_FREESTREAM_FIELDS,
        ui=BC_UI,
        resolve=resolve_record,
    ),
    BcFamily(
        key=WALL,
        label="Wall",
        record_type="Wall",
        aliases=("Slip wall", "No-slip wall"),
        color="wall",
        hint="No-slip, slip, moving or rotating, face by face",
        variants=("wall_noslip", "wall_slip", "wall_moving", "wall_rotating"),
        # A face-by-face Wall exists to differ from the study's default treatment
        # (no-slip), so a new one starts slip.
        defaults={"metric": {"wall_type": "Slip"}, "imperial": {"wall_type": "Slip"}},
        fields=WALL_FIELDS,
        ui=BC_UI,
        resolve=resolve_record,
    ),
    BcFamily(
        key=SYMMETRY,
        label="Symmetry",
        record_type="Symmetry",
        aliases=("Symmetry plane",),
        color="symmetry",
        hint="Mirror plane: no flow through it, no friction",
        variants=("symmetry",),
        defaults={"metric": {}, "imperial": {}},
        ui=BC_UI,
        resolve=resolve_record,
    ),
)

BC_FAMILY_KEYS: tuple[str, ...] = tuple(f.key for f in BC_FAMILIES)


def register_bcs(hub: Any, plugin: str) -> None:
    """Register the BC types, then the families that name them."""
    types = hub.registry("bc")
    for spec in BC_TYPES:
        types.register(spec, plugin=plugin)
    families = hub.registry("bc_family")
    for fam in BC_FAMILIES:
        families.register(fam, plugin=plugin)
