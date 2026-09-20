"""Built-in incompressible AnalysisType specs (Phase 2 land2)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from cfddesk.registry.analysis import AnalysisType, CaseContext, ResultField
from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

# Matches project.settings.TURBULENCE_MODELS / case.ras â€” inlined so registry
# builtins do not import project/cad (OCP) at load_all time.
_TURBULENCE_MODELS: tuple[str, ...] = (
    "laminar",
    "kEpsilon",
    "kOmegaSST",
    "LRR",
    "SSG",
)

# Product BC keys from case.bc_registry.BC_TYPES (placeholders OK until BC wrap).
_INCOMPRESSIBLE_BC_TYPES: tuple[str, ...] = (
    "velocity_inlet_fixed",
    "velocity_inlet_volumetric",
    "velocity_inlet_mass",
    "velocity_outlet",
    "pressure_outlet_gauge",
    "wall_noslip",
    "wall_slip",
)

_FIELDS: tuple[str, ...] = ("U", "p", "k", "omega", "nut")

_RESULT_FIELDS: tuple[ResultField, ...] = (
    ResultField("U", "Velocity", "velocity", "vector"),
    ResultField("p", "Pressure", "pressure", "scalar"),
    ResultField("k", "Turbulent kinetic energy", "specific_energy", "scalar"),
    ResultField("omega", "Specific dissipation rate", "specific_dissipation_rate", "scalar"),
    ResultField("nut", "Turbulent viscosity", "kinematic_viscosity", "scalar"),
)

# MonitorType keys (wired to registry in land5; flow->flow_rate bag fix).
_MONITORS: tuple[str, ...] = ("area_average", "flow_rate")

_MATERIAL_MODELS: tuple[str, ...] = ("newtonian_incompressible",)


def _settings_schema() -> tuple[SchemaField, ...]:
    """Per-analysis settings aligned with W17_DEFAULTS + TurbulenceModel."""
    return (
        SchemaField(
            "turbulence_model",
            "Turbulence model",
            "choice",
            default="kOmegaSST",
            choices=_TURBULENCE_MODELS,
            group="flow",
        ),
        SchemaField(
            "passive_species",
            "Passive species",
            "int",
            default=0,
            min=0,
            max=20,
            group="flow",
        ),
        SchemaField(
            "energy",
            "Energy",
            "bool",
            default=False,
            group="flow",
            advanced=True,
        ),
    )


def _numerics_schema(*, transient: bool) -> tuple[SchemaField, ...]:
    ddt_default = "Euler" if transient else "steadyState"
    return (
        SchemaField(
            "residual_u",
            "Residual U",
            "float",
            default=1e-6,
            min=0.0,
            group="residuals",
        ),
        SchemaField(
            "residual_p",
            "Residual p",
            "float",
            default=1e-6,
            min=0.0,
            group="residuals",
        ),
        SchemaField(
            "relax_u",
            "Relaxation U",
            "float",
            default=0.7,
            min=0.0,
            max=1.0,
            group="relaxation",
        ),
        SchemaField(
            "relax_p",
            "Relaxation p",
            "float",
            default=0.3,
            min=0.0,
            max=1.0,
            group="relaxation",
        ),
        SchemaField(
            "n_non_orthogonal",
            "Non-orthogonal correctors",
            "int",
            default=1,
            min=0,
            group="solution",
        ),
        SchemaField(
            "ddt_default",
            "Time scheme",
            "text",
            default=ddt_default,
            group="schemes",
            advanced=True,
        ),
    )


def _control_schema(*, transient: bool) -> tuple[SchemaField, ...]:
    fields: list[SchemaField] = [
        SchemaField(
            "end_time",
            "End time",
            "float",
            default=1000.0 if not transient else 1.0,
            min=0.0,
            group="control",
        ),
        SchemaField(
            "write_interval",
            "Write interval",
            "int",
            default=1000 if not transient else 50,
            min=1,
            group="control",
        ),
        SchemaField(
            "write_control",
            "Write control",
            "choice",
            default="timeStep",
            choices=("timeStep", "runTime", "adjustableRunTime"),
            group="control",
        ),
    ]
    if transient:
        fields.insert(
            1,
            SchemaField(
                "delta_t",
                "Time step",
                "float",
                default=0.001,
                min=0.0,
                group="control",
            ),
        )
        fields.append(
            SchemaField(
                "max_co",
                "Max Courant",
                "float",
                default=1.0,
                min=0.0,
                group="control",
                advanced=True,
            )
        )
    return tuple(fields)


def _validate_region_roles(project: Any, region_roles: tuple[str, ...]) -> list[str]:
    """Reject when geometry lacks a body for each required AnalysisType role."""
    if project is None:
        return []
    geom = getattr(project, "primary_geometry", lambda: None)()
    if geom is None:
        return []
    bodies = getattr(geom, "bodies", None) or []
    present = {getattr(b, "role", "fluid") for b in bodies}
    errors: list[str] = []
    for role in region_roles:
        if role not in present and bodies:
            # Only complain when bodies exist but required role is missing
            # (empty bodies = not yet enumerated — defer).
            errors.append(f"analysis requires a body with role={role!r}")
    return errors


def _validate_minimal(
    project: Any = None,
    _simulation: Any = None,
    *,
    region_roles: tuple[str, ...] = ("fluid",),
    mesher: Any = None,
    **_kwargs: Any,
) -> list[str]:
    """Region-role + multi-region mesher checks (soft-pass geometry land7)."""
    errors = _validate_region_roles(project, region_roles)
    try:
        from cfddesk.registry.mesher import validate_multi_region_meshing

        errors.extend(validate_multi_region_meshing(project, mesher))
    except Exception:
        pass
    return errors


def _write_web_solve_case(ctx: CaseContext) -> dict:
    """Delegate to write_solve_case (steady + transient via RunSpec).

    Lazy-import so load_all / builtin registration does not pull OCP / web_adapter
    at registry bootstrap time.
    """
    from pathlib import Path as _Path

    from cfddesk.case.writer import write_solve_case

    if ctx.run_spec is None:
        raise ValueError("CaseContext.run_spec is required for AnalysisType.write_case")
    out = ctx.out_dir
    if out is None:
        raise ValueError("CaseContext.out_dir is required for AnalysisType.write_case")
    return write_solve_case(ctx.run_spec, _Path(out))


def _write_case_steady(ctx: CaseContext) -> dict:
    """incompressible_steady write_case -> Phase 1 simpleFoam / web_case path."""
    spec = ctx.run_spec
    if spec is not None and getattr(spec, "transient", None) is not None:
        raise ValueError(
            "incompressible_steady.write_case requires RunSpec.transient is None"
        )
    return _write_web_solve_case(ctx)


def _write_case_transient(ctx: CaseContext) -> dict:
    """incompressible_transient write_case -> Phase 1 pimpleFoam / web_case path."""
    spec = ctx.run_spec
    if spec is None or getattr(spec, "transient", None) is None:
        raise ValueError(
            "incompressible_transient.write_case requires RunSpec.transient set"
        )
    return _write_web_solve_case(ctx)


def build_incompressible_steady() -> AnalysisType:
    return AnalysisType(
        key="incompressible_steady",
        label="Incompressible Fluid Flow",
        category="FLUID DYNAMICS",
        time_dependency="steady",
        fields=_FIELDS,
        turbulence_models=_TURBULENCE_MODELS,
        default_turbulence="kOmegaSST",
        bc_types=_INCOMPRESSIBLE_BC_TYPES,
        material_models=_MATERIAL_MODELS,
        solver_backends=("simpleFoam", "simpleFoam_amgx"),
        default_solver="simpleFoam",
        monitors=_MONITORS,
        result_fields=_RESULT_FIELDS,
        settings_schema=_settings_schema(),
        numerics_schema=_numerics_schema(transient=False),
        control_schema=_control_schema(transient=False),
        validate=_validate_minimal,
        region_roles=("fluid",),
        write_case=_write_case_steady,
        parse_log_line=None,
        requires=(Requirement("wsl_tool", "simpleFoam"),),
    )


def build_incompressible_transient() -> AnalysisType:
    return AnalysisType(
        key="incompressible_transient",
        label="Incompressible Fluid Flow (Transient)",
        category="FLUID DYNAMICS",
        time_dependency="transient",
        fields=_FIELDS,
        turbulence_models=_TURBULENCE_MODELS,
        default_turbulence="kOmegaSST",
        bc_types=_INCOMPRESSIBLE_BC_TYPES,
        material_models=_MATERIAL_MODELS,
        solver_backends=("pimpleFoam",),
        default_solver="pimpleFoam",
        monitors=_MONITORS,
        result_fields=_RESULT_FIELDS,
        settings_schema=_settings_schema(),
        numerics_schema=_numerics_schema(transient=True),
        control_schema=_control_schema(transient=True),
        validate=_validate_minimal,
        region_roles=("fluid",),
        write_case=_write_case_transient,
        parse_log_line=None,
        requires=(Requirement("wsl_tool", "pimpleFoam"),),
    )


def register_incompressible(hub: RegistryHub) -> None:
    """Register both incompressible AnalysisTypes (idempotent same-plugin)."""
    reg = hub.registry("analysis")
    reg.register(build_incompressible_steady(), plugin="builtin")
    reg.register(build_incompressible_transient(), plugin="builtin")

