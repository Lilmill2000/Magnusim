"""Boundary-condition type registry → OpenFOAM patch entries + snappy patch_type.

Adding a type is a data change here (plus optional UI schema), not a new code path
in the case writer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from cfddesk.registry.schema import SchemaField as SettingField

SemanticClass = Literal[
    "inlet",
    "outlet",
    "wall",
    "open",
    "symmetry",
    "empty",
    "wedge",
    "custom",
    "periodic",
]
PatchType = Literal["patch", "wall", "symmetry", "empty", "wedge"]


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


def _moving_wall_U(name: str, settings: dict, _ctx: dict) -> str:
    v = settings.get("velocity", (0.0, 0.0, 0.0))
    vx, vy, vz = float(v[0]), float(v[1]), float(v[2])
    return _entry(
        f"""    {name}
    {{
        type            movingWallVelocity;
        value           uniform ({vx:g} {vy:g} {vz:g});
    }}"""
    )


def _rotating_wall_U(name: str, settings: dict, _ctx: dict) -> str:
    origin = settings.get("origin", (0.0, 0.0, 0.0))
    axis = settings.get("axis", (0.0, 0.0, 1.0))
    rpm = float(settings.get("rpm", 0.0))
    omega = rpm * 2.0 * 3.141592653589793 / 60.0
    return _entry(
        f"""    {name}
    {{
        type            rotatingWallVelocity;
        origin          ({float(origin[0]):g} {float(origin[1]):g} {float(origin[2]):g});
        axis            ({float(axis[0]):g} {float(axis[1]):g} {float(axis[2]):g});
        omega           {omega:g};
        value           uniform (0 0 0);
    }}"""
    )


def _pressure_inlet_U(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            pressureInletVelocity;
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


def _pressure_inlet_outlet_U(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            pressureInletOutletVelocity;
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


def _total_pressure_p(name: str, settings: dict, _ctx: dict) -> str:
    p0 = float(settings.get("total_pressure", 0.0))
    return _entry(
        f"""    {name}
    {{
        type            totalPressure;
        p0              uniform {p0:g};
        gamma           1;
        value           uniform {p0:g};
    }}"""
    )


def _mean_value_p(name: str, settings: dict, _ctx: dict) -> str:
    p = float(settings.get("mean_pressure", 0.0))
    return _entry(
        f"""    {name}
    {{
        type            fixedMean;
        meanValue       {p:g};
        value           uniform {p:g};
    }}"""
    )


def _symmetry_all(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            symmetry;
    }}"""
    )


def _cyclic_all(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            cyclic;
    }}"""
    )


def _velocity_inlet_mean_U(name: str, settings: dict, ctx: dict) -> str:
    mode = str(settings.get("direction_mode", "normal"))
    if mode == "vector":
        return _fixed_vector(name, settings, ctx)
    speed = float(settings.get("speed_m_s", 0.0))
    n = ctx.get("inward_normal")
    if n is None:
        n = (-1.0, 0.0, 0.0)
    u = (n[0] * speed, n[1] * speed, n[2] * speed)
    vx, vy, vz = u[0], u[1], u[2]
    return _entry(
        f"""    {name}
    {{
        type            fixedMean;
        meanValue       uniform ({vx:g} {vy:g} {vz:g});
        value           uniform ({vx:g} {vy:g} {vz:g});
    }}"""
    )


def _freestream_U(name: str, settings: dict, ctx: dict) -> str:
    mode = str(settings.get("direction_mode", "normal"))
    if mode == "vector":
        v = settings.get("velocity", (0.0, 0.0, 0.0))
        vx, vy, vz = float(v[0]), float(v[1]), float(v[2])
    else:
        speed = float(settings.get("speed_m_s", 0.0))
        n = ctx.get("inward_normal")
        if n is None:
            n = (-1.0, 0.0, 0.0)
        vx, vy, vz = n[0] * speed, n[1] * speed, n[2] * speed
    return _entry(
        f"""    {name}
    {{
        type            freestreamVelocity;
        freestreamValue uniform ({vx:g} {vy:g} {vz:g});
        value           uniform ({vx:g} {vy:g} {vz:g});
    }}"""
    )


def _freestream_p(name: str, settings: dict, _ctx: dict) -> str:
    p = float(settings.get("freestream_pressure", settings.get("gauge_pressure", 0.0)))
    return _entry(
        f"""    {name}
    {{
        type            freestreamPressure;
        freestreamValue uniform {p:g};
        value           uniform {p:g};
    }}"""
    )


def _fan_pressure_p(name: str, settings: dict, _ctx: dict) -> str:
    p0 = float(settings.get("gauge_pressure", 0.0))
    direction = str(settings.get("direction", "in"))
    if direction not in ("in", "out"):
        direction = "in"
    return _entry(
        f"""    {name}
    {{
        type            fanPressure;
        direction       {direction};
        p0              uniform {p0:g};
        value           uniform {p0:g};
    }}"""
    )


def _empty_all(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            empty;
    }}"""
    )


def _wedge_all(name: str, _s: dict, _c: dict) -> str:
    return _entry(
        f"""    {name}
    {{
        type            wedge;
    }}"""
    )


def _custom_field(field: str) -> WriterFn:
    def _write(name: str, settings: dict, _ctx: dict) -> str:
        raw = settings.get("raw", {})
        if not isinstance(raw, dict):
            raw = {}
        body = raw.get(field)
        if not body:
            return _entry(
                f"""    {name}
    {{
        type            zeroGradient;
    }}"""
            )
        # Verbatim user block (must include type …;)
        indented = "\n".join(
            ("        " + ln if ln.strip() else ln) for ln in str(body).splitlines()
        )
        return _entry(f"    {name}\n    {{\n{indented}\n    }}")

    return _write


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
        "Velocity inlet — fixed value",
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
        "Velocity inlet — volumetric flow",
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
        "velocity_inlet_mean",
        "Velocity inlet — mean value",
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
        write_U=_velocity_inlet_mean_U,
        write_p=_zero_grad,
        write_T=_T_fixed,
    )
)
_reg(
    BcTypeSpec(
        "velocity_inlet_freestream",
        "Velocity inlet — freestream",
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
            SettingField(
                "freestream_pressure",
                "Freestream pressure",
                "float",
                default=0.0,
                unit="Pa",
                rate_kind="intensive",
            ),
            *_INLET_T,
        ),
        write_U=_freestream_U,
        write_p=_freestream_p,
        write_T=_T_fixed,
    )
)
_reg(
    BcTypeSpec(
        "velocity_inlet_mass",
        "Velocity inlet — mass flow",
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
        "Velocity outlet — fixed value",
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
        "pressure_inlet_gauge",
        "Pressure inlet — fixed gauge",
        "inlet",
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
            *_INLET_T,
        ),
        write_U=_pressure_inlet_U,
        write_p=_fixed_p,
        write_T=_T_fixed,
    )
)
_reg(
    BcTypeSpec(
        "pressure_inlet_total",
        "Pressure inlet — total pressure",
        "inlet",
        "patch",
        (
            SettingField("total_pressure", "Total pressure", "float", default=0.0, unit="Pa"),
            *_INLET_T,
        ),
        write_U=_pressure_inlet_U,
        write_p=_total_pressure_p,
        write_T=_T_fixed,
    )
)
_reg(
    BcTypeSpec(
        "pressure_outlet_gauge",
        "Pressure outlet — fixed gauge",
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
        "pressure_outlet_total",
        "Pressure outlet — total pressure",
        "outlet",
        "patch",
        (SettingField("total_pressure", "Total pressure", "float", default=0.0, unit="Pa"),),
        write_U=_inlet_outlet_U,
        write_p=_total_pressure_p,
    )
)
_reg(
    BcTypeSpec(
        "pressure_outlet_mean",
        "Pressure outlet — mean value",
        "outlet",
        "patch",
        (SettingField("mean_pressure", "Mean pressure", "float", default=0.0, unit="Pa"),),
        write_U=_inlet_outlet_U,
        write_p=_mean_value_p,
    )
)
_reg(
    BcTypeSpec(
        "wall_noslip",
        "Wall — no-slip",
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
        "Wall — slip",
        "wall",
        "wall",
        _THERMAL_WALL_FIELDS,
        write_U=_slip,
        write_p=_zero_grad,
        write_T=_wall_T,
    )
)
_reg(
    BcTypeSpec(
        "wall_moving",
        "Wall — moving",
        "wall",
        "wall",
        (
            SettingField(
                "velocity",
                "Wall velocity",
                "vector3",
                default=(0.0, 0.0, 0.0),
                unit="m/s",
                rate_kind="intensive",
            ),
            *_THERMAL_WALL_FIELDS,
        ),
        write_U=_moving_wall_U,
        write_p=_zero_grad,
        write_T=_wall_T,
    )
)
_reg(
    BcTypeSpec(
        "wall_rotating",
        "Wall — rotating",
        "wall",
        "wall",
        (
            SettingField("origin", "Origin", "vector3", default=(0.0, 0.0, 0.0), unit="m"),
            SettingField("axis", "Axis", "vector3", default=(0.0, 0.0, 1.0)),
            SettingField("rpm", "RPM", "float", default=0.0, unit="1/min"),
            *_THERMAL_WALL_FIELDS,
        ),
        write_U=_rotating_wall_U,
        write_p=_zero_grad,
        write_T=_wall_T,
    )
)
_reg(
    BcTypeSpec(
        "fan",
        "Fan",
        "inlet",
        "patch",
        (
            SettingField(
                "gauge_pressure",
                "Reference pressure",
                "float",
                default=0.0,
                unit="Pa",
                rate_kind="intensive",
            ),
            SettingField(
                "direction",
                "Direction",
                "choice",
                default="in",
                choices=("in", "out"),
            ),
        ),
        write_U=_inlet_outlet_U,
        write_p=_fan_pressure_p,
    )
)
_reg(
    BcTypeSpec(
        "periodic",
        "Periodic",
        "periodic",
        "patch",
        (
            SettingField("paired_bc_id", "Paired BC", "text", default=""),
            SettingField(
                "transform",
                "Transform",
                "choice",
                default="translational",
                choices=("rotational", "translational"),
            ),
            SettingField(
                "rotationAxis",
                "Rotation axis",
                "vector3",
                default=(0.0, 0.0, 1.0),
            ),
            SettingField(
                "rotationCentre",
                "Rotation centre",
                "vector3",
                default=(0.0, 0.0, 0.0),
                unit="m",
            ),
            SettingField(
                "separationVector",
                "Separation vector",
                "vector3",
                default=(1.0, 0.0, 0.0),
                unit="m",
            ),
        ),
        write_U=_cyclic_all,
        write_p=_cyclic_all,
        write_T=_cyclic_all,
        supported=False,
    )
)
_reg(
    BcTypeSpec(
        "natural_convection",
        "Natural convection inlet/outlet",
        "open",
        "patch",
        (
            SettingField("total_pressure", "Total pressure", "float", default=0.0, unit="Pa"),
            *_INLET_T,
        ),
        write_U=_pressure_inlet_outlet_U,
        write_p=_total_pressure_p,
        write_T=_T_fixed,
    )
)
_reg(
    BcTypeSpec(
        "symmetry",
        "Symmetry",
        "symmetry",
        "symmetry",
        (),
        write_U=_symmetry_all,
        write_p=_symmetry_all,
        write_T=_symmetry_all,
    )
)
_reg(
    BcTypeSpec(
        "wedge",
        "Wedge",
        "wedge",
        "wedge",
        (),
        write_U=_wedge_all,
        write_p=_wedge_all,
        write_T=_wedge_all,
        supported=False,
    )
)
_reg(
    BcTypeSpec(
        "empty",
        "Empty / 2D",
        "empty",
        "empty",
        (),
        write_U=_empty_all,
        write_p=_empty_all,
        write_T=_empty_all,
        supported=False,
    )
)
_reg(
    BcTypeSpec(
        "custom",
        "Custom (raw OpenFOAM)",
        "custom",
        "patch",
        (
            SettingField(
                "raw",
                "Per-field raw entries (U/p/T/…)",
                "raw_dict",
                default={"U": "type            zeroGradient;", "p": "type            zeroGradient;"},
            ),
            SettingField(
                "patch_type_override",
                "Mesh patch type",
                "choice",
                default="patch",
                choices=("patch", "wall", "symmetry"),
            ),
        ),
        write_U=_custom_field("U"),
        write_p=_custom_field("p"),
        write_T=_custom_field("T"),
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
    if bc_type == "custom" and settings:
        override = settings.get("patch_type_override")
        if override in ("patch", "wall", "symmetry"):
            return override  # type: ignore[return-value]
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
