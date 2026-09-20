"""Boundary-condition type registry → OpenFOAM patch entries + snappy patch_type.

Product types: Velocity inlet, Velocity outlet, Pressure, Wall.
Flow-rate and slip/no-slip are settings of those types, not extra types.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from cfddesk.registry.schema import SchemaField as SettingField

SemanticClass = Literal["inlet", "outlet", "wall"]
PatchType = Literal["patch", "wall"]


WriterFn = Callable[[str, dict[str, Any], dict[str, Any]], str]
# (patch_name, settings, context) -> Foam boundaryField entry body (without name braces)


@dataclass(frozen=True)
class BcTypeSpec:
    key: str
    label: str
    semantic: SemanticClass
    patch_type: PatchType
    settings_schema: tuple[SettingField, ...] = ()
    write_U: WriterFn | None = None
    write_p: WriterFn | None = None
    write_T: WriterFn | None = None  # energy
    # Turbulence handled via semantic class in ras.py helpers
    supported: bool = True


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


BC_TYPES: dict[str, BcTypeSpec] = {}


def _reg(spec: BcTypeSpec) -> None:
    BC_TYPES[spec.key] = spec


_reg(
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
    )
)
_reg(
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
    )
)
_reg(
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
    )
)
_reg(
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
    )
)
_reg(
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
    )
)
_reg(
    BcTypeSpec(
        "wall_noslip",
        "Wall",
        "wall",
        "wall",
        _THERMAL_WALL_FIELDS,
        write_U=_no_slip,
        write_p=_zero_grad,
        write_T=_wall_T,
    )
)
_reg(
    BcTypeSpec(
        "wall_slip",
        "Wall",
        "wall",
        "wall",
        _THERMAL_WALL_FIELDS,
        write_U=_slip,
        write_p=_zero_grad,
        write_T=_wall_T,
    )
)


def get_type(key: str) -> BcTypeSpec:
    if key not in BC_TYPES:
        raise KeyError(f"Unknown BC type {key!r}")
    return BC_TYPES[key]


def type_labels() -> list[tuple[str, str]]:
    return [(k, v.label) for k, v in BC_TYPES.items()]


def variant_has_extensive(spec: BcTypeSpec) -> bool:
    return any(f.rate_kind == "extensive" for f in spec.settings_schema)


def patch_type_for(bc_type: str, settings: dict | None = None) -> PatchType:
    spec = get_type(bc_type)
    return spec.patch_type


def default_settings(bc_type: str) -> dict[str, Any]:
    spec = get_type(bc_type)
    out: dict[str, Any] = {}
    for f in spec.settings_schema:
        out[f.key] = f.default
    return out


def sanitize_patch_name(label: str, existing: set[str]) -> str:
    import re

    base = re.sub(r"[^A-Za-z0-9_]+", "_", label.strip()).strip("_").lower() or "patch"
    if base[0].isdigit():
        base = "p_" + base
    name = base
    n = 2
    while name in existing:
        name = f"{base}_{n}"
        n += 1
    return name
