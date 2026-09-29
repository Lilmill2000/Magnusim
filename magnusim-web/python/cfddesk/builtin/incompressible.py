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


_TURBULENCE_LABELS: tuple[str, ...] = (
    "Laminar",
    "k-epsilon",
    "k-omega SST",
    "LRR (Reynolds stress)",
    "SSG (Reynolds stress)",
)


def _settings_schema() -> tuple[SchemaField, ...]:
    """Per-analysis settings the solve reads (cfddesk.project.study_physics)."""
    return (
        SchemaField(
            "turbulence_model",
            "Turbulence model",
            "choice",
            default="kOmegaSST",
            choices=_TURBULENCE_MODELS,
            choice_labels=_TURBULENCE_LABELS,
            group="flow",
            description=(
                "Which turbulence closure the solver uses. k-omega SST is the general-purpose "
                "default and handles walls at any y+. k-epsilon and the Reynolds-stress models "
                "(LRR, SSG) use high-Re wall functions (y+ above about 30). Reynolds-stress models "
                "suit strong swirl but may need a converged k-epsilon run first. Laminar solves "
                "no turbulence at all."
            ),
        ),
    )


def _numerics_schema(*, transient: bool) -> tuple[SchemaField, ...]:
    """Steady SIMPLE numerics. Transient runs take PIMPLE settings from the run panel.

    Defaults are the values the solve used before these fields were wired, so
    untouched studies solve unchanged.
    """
    if transient:
        return ()
    return (
        SchemaField(
            "residual_u",
            "Residual U",
            "float",
            default=1e-4,
            min=0.0,
            group="residuals",
            description=(
                "Convergence target for the velocity and turbulence equations. The run stops "
                "early once every residual is below its target; otherwise it runs to the "
                "iteration limit."
            ),
        ),
        SchemaField(
            "residual_p",
            "Residual p",
            "float",
            default=1e-4,
            min=0.0,
            group="residuals",
            description=(
                "Convergence target for the pressure equation. The run stops early once every "
                "residual is below its target."
            ),
        ),
        SchemaField(
            "relax_u",
            "Relaxation U",
            "float",
            default=0.7,
            min=0.0,
            max=1.0,
            group="relaxation",
            description=(
                "Under-relaxation for the velocity and turbulence equations (0 to 1). Lower is "
                "more stable but converges more slowly. Reynolds-stress models (LRR, SSG) start "
                "at 0.5."
            ),
        ),
        SchemaField(
            "relax_p",
            "Relaxation p",
            "float",
            default=0.3,
            min=0.0,
            max=1.0,
            group="relaxation",
            description=(
                "Under-relaxation for pressure (0 to 1). SIMPLE usually needs about 0.3; lower it "
                "if the solve oscillates or diverges."
            ),
        ),
        SchemaField(
            "n_non_orthogonal",
            "Non-orthogonal correctors",
            "int",
            default=3,
            min=0,
            max=20,
            group="solution",
            description=(
                "Extra pressure corrections per iteration for skewed or non-orthogonal cells. "
                "0 is enough for clean hex meshes; tetrahedral meshes usually need 1 to 3."
            ),
        ),
    )


def _control_schema(*, transient: bool) -> tuple[SchemaField, ...]:
    """Run control fields. Defaults come from cfddesk.project.transient
    (TRANSIENT_DEFAULTS / STEADY_DEFAULTS), the one copy: Node and the page read
    them back from the registry, so every layer starts a run from the same values.
    A default of None means "calculate for me" (the auto time step)."""
    from cfddesk.project.transient import STEADY_DEFAULTS, TRANSIENT_DEFAULTS

    if not transient:
        return (
            SchemaField(
                "end_time",
                "Number of iterations",
                "int",
                default=int(STEADY_DEFAULTS["end_time"]),
                min=1,
                group="control",
                description="Iterations to run. The run stops earlier when the residuals reach their targets.",
            ),
            SchemaField(
                "write_interval",
                "Write interval",
                "int",
                default=int(STEADY_DEFAULTS["write_interval"]),
                min=1,
                group="control",
                description="How often results are saved, in iterations.",
            ),
        )
    d = TRANSIENT_DEFAULTS
    return (
        SchemaField(
            "end_time",
            "Simulation time",
            "float",
            default=float(d["end_time"]),
            min=0.0,
            unit="s",
            group="control",
            description="Simulated time to stop at, in seconds.",
        ),
        SchemaField(
            "write_count",
            "Result frames",
            "int",
            default=int(d["write_count"]),
            min=1,
            max=5000,
            group="control",
            description="Result frames saved over the simulation time.",
        ),
        SchemaField(
            "time_step_mode",
            "Time step",
            "choice",
            default=str(d["time_step_mode"]),
            choices=("adjustable", "fixed"),
            choice_labels=("Adjustable", "Fixed"),
            group="control",
            advanced=True,
            description="Adjustable keeps the Courant number at or below the maximum; fixed uses one step throughout.",
        ),
        SchemaField(
            "max_co",
            "Max Courant",
            "float",
            default=float(d["max_co"]),
            min=0.0,
            group="control",
            advanced=True,
            description=(
                "Largest Courant number allowed when the time step adjusts: how many cells "
                "flow may cross in one step. Keep at or below 1 for stability."
            ),
        ),
        SchemaField(
            "delta_t",
            "Initial time step",
            "float",
            default=d["delta_t"],
            min=0.0,
            unit="s",
            group="control",
            advanced=True,
            optional=True,
            description="Blank calculates it from the smallest cell and the inlet speed.",
        ),
        SchemaField(
            "max_delta_t",
            "Max time step",
            "float",
            default=d["max_delta_t"],
            min=0.0,
            unit="s",
            group="control",
            advanced=True,
            optional=True,
            description="Blank uses the frame interval, so every frame is written.",
        ),
        SchemaField(
            "time_scheme",
            "Time scheme",
            "choice",
            default=str(d["time_scheme"]),
            choices=("Euler", "backward"),
            choice_labels=("Euler (1st order)", "Backward (2nd order)"),
            group="control",
            advanced=True,
            description="Euler is robust; backward is more accurate in time.",
        ),
        SchemaField(
            "n_outer_correctors",
            "Outer correctors",
            "int",
            default=int(d["n_outer_correctors"]),
            min=1,
            max=50,
            group="control",
            advanced=True,
            description="PIMPLE outer loops per time step. 1 is PISO mode.",
        ),
        SchemaField(
            "n_correctors",
            "Pressure correctors",
            "int",
            default=int(d["n_correctors"]),
            min=1,
            max=10,
            group="control",
            advanced=True,
            description="Pressure corrections per outer loop.",
        ),
        SchemaField(
            "n_non_orth_correctors",
            "Non-orthogonal correctors",
            "int",
            default=int(d["n_non_orth_correctors"]),
            min=0,
            max=5,
            group="control",
            advanced=True,
            description="Extra pressure corrections for skewed or non-orthogonal cells.",
        ),
    )


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


def _contract_fields(td: str, *, key: str, label: str) -> dict:
    """Contract 1.1 hooks (cfddesk.builtin.incompressible_contract)."""
    from cfddesk.builtin import incompressible_contract as ic

    return {
        "family": ic.FAMILY,
        "algorithm_label": ic.algorithm_label(td),
        "residual_keys": ic.RESIDUAL_KEYS,
        "x_axis": "seconds" if td == "transient" else "iterations",
        "study_defaults": ic.make_study_defaults(
            key=key, label=label, category="FLUID DYNAMICS", default_turbulence="kOmegaSST"
        ),
        "validate_ready": ic.validate_ready,
        "run_model": ic.TRANSIENT_RUN_MODEL if td == "transient" else ic.STEADY_RUN_MODEL,
        "log_parser": ic.LOG_PARSER,
        "frame_fields": ("U", "p"),
        "ui": dict(ic.UI),
    }


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
        **_contract_fields("steady", key="incompressible_steady", label="Incompressible Fluid Flow"),
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
        **_contract_fields("transient", key="incompressible_transient", label="Incompressible Fluid Flow (Transient)"),
    )


def register_incompressible(hub: RegistryHub) -> None:
    """Register both incompressible AnalysisTypes (idempotent same-plugin)."""
    reg = hub.registry("analysis")
    reg.register(build_incompressible_steady(), plugin="builtin")
    reg.register(build_incompressible_transient(), plugin="builtin")

