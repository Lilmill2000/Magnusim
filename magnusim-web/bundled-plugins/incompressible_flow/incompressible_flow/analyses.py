"""Incompressible Flow's two AnalysisTypes (steady and transient) and their schemas."""

from __future__ import annotations

from typing import Any

from cfddesk.registry.analysis import AnalysisType, CaseContext, ResultField
from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField

from .bcs import BC_KEYS
from .function_objects import (
    MEAN_PRESSURE_FIELD,
    MEAN_VELOCITY_FIELD,
    Q_FIELD,
    TOTAL_PRESSURE_FIELD,
    VORTICITY_FIELD,
    WALL_SHEAR_STRESS_FIELD,
    YPLUS_FIELD,
)
from .monitors import MONITOR_QUANTITIES
from .physics import DEFAULT_TURBULENCE, KINEMATIC_FIELDS, TURBULENCE_MODELS

# Both analyses offer every BC type this plugin registers (bcs.BC_TYPES).
_INCOMPRESSIBLE_BC_TYPES: tuple[str, ...] = BC_KEYS

_FIELDS: tuple[str, ...] = ("U", "p", "k", "omega", "nut")

# What results colour by, with the units the page shows them in (pressure in
# Pa: the case stores p divided by rho, see KINEMATIC_FIELDS). R, the Reynolds
# stress the LRR and SSG models write, is a tensor: listed, never coloured by.
# The rows after R are written by function objects at the saved times
# (function_objects.result_fields_functions_text): y+ only by turbulent runs,
# the time averages only by transient runs (and only from their "Average
# from" time on). Results lists a row only when the frame wrote it.
_RESULT_FIELDS: tuple[ResultField, ...] = (
    ResultField("U", "Velocity", "velocity", "vector", unit="m/s", magnitude_label="Velocity Magnitude"),
    ResultField("p", "Pressure", "pressure", "scalar", unit="Pa"),
    ResultField(TOTAL_PRESSURE_FIELD, "Total pressure", "pressure", "scalar", unit="Pa"),
    ResultField("k", "Turbulent kinetic energy", "specific_energy", "scalar", unit="m²/s²"),
    ResultField("omega", "Specific dissipation rate", "specific_dissipation_rate", "scalar", unit="1/s"),
    ResultField("epsilon", "Turbulent dissipation rate", "dissipation_rate", "scalar", unit="m²/s³"),
    ResultField("nut", "Turbulent viscosity", "kinematic_viscosity", "scalar", unit="m²/s"),
    ResultField("R", "Reynolds stress", "specific_energy", "symm_tensor", unit="m²/s²"),
    ResultField(YPLUS_FIELD, "y+", "dimensionless", "scalar"),
    ResultField(
        WALL_SHEAR_STRESS_FIELD,
        "Wall shear stress",
        "pressure",
        "vector",
        unit="Pa",
        magnitude_label="Wall shear stress magnitude",
    ),
    ResultField(
        VORTICITY_FIELD, "Vorticity", "vorticity", "vector", unit="1/s", magnitude_label="Vorticity magnitude"
    ),
    ResultField(Q_FIELD, "Q-criterion", "q_criterion", "scalar", unit="1/s²"),
    ResultField(
        MEAN_VELOCITY_FIELD,
        "Mean velocity",
        "velocity",
        "vector",
        unit="m/s",
        magnitude_label="Mean velocity magnitude",
    ),
    ResultField(MEAN_PRESSURE_FIELD, "Mean pressure", "pressure", "scalar", unit="Pa"),
)

# MonitorType keys (wired to registry in land5; flow->flow_rate bag fix).
_MONITORS: tuple[str, ...] = ("area_average", "flow_rate")

_MATERIAL_MODELS: tuple[str, ...] = ("newtonian_incompressible",)


# The study panel's names for physics.TURBULENCE_MODELS, in the same order.
_TURBULENCE_LABELS: tuple[str, ...] = (
    "Laminar",
    "k-epsilon",
    "k-omega SST",
    "LRR (Reynolds stress)",
    "SSG (Reynolds stress)",
)


def _settings_schema() -> tuple[SchemaField, ...]:
    """Per-analysis settings the solve reads (incompressible_flow.physics)."""
    return (
        SchemaField(
            "turbulence_model",
            "Turbulence model",
            "choice",
            # A new study's turbulence model (the core copies schema defaults
            # into its record; contract.make_study_defaults leaves it out).
            default=DEFAULT_TURBULENCE,
            choices=TURBULENCE_MODELS,
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
    """Run control fields. Defaults come from incompressible_flow.transient
    (TRANSIENT_DEFAULTS / STEADY_DEFAULTS), the one copy: Node and the page read
    them back from the registry, so every layer starts a run from the same values.
    A default of None means "calculate for me" (the auto time step)."""
    from .transient import STEADY_DEFAULTS, TRANSIENT_DEFAULTS

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
        SchemaField(
            "average_from",
            "Average from",
            "float",
            default=float(d["average_from"]),
            min=0.0,
            unit="s",
            group="control",
            description=(
                "Time the mean velocity and mean pressure results start averaging from. "
                "0 averages from the start; a later time leaves out the start-up."
            ),
        ),
    )


def _spec(ctx: CaseContext) -> Any:
    """The RunSpec for this case: the one given, else built from the core's RunInputs."""
    if ctx.run_spec is not None:
        return ctx.run_spec
    if ctx.inputs is None:
        raise ValueError("CaseContext needs inputs (RunInputs) or run_spec")
    from .runspec import load_run_spec

    return load_run_spec(ctx.inputs)


def _decision(spec: Any, ctx: CaseContext) -> dict:
    """What the core records about the case: the mapping, the wall default, the
    transient numbers written to controlDict, and the run note's physics."""
    from magnusim_sdk.study import bc_faces, is_wall_bc, wall_treatment

    from .contract import TURBULENCE_LABELS, algorithm_label
    from .transient import control_to_web, describe_transient

    rows = []
    for m in spec.mapped or []:
        bc = m.get("bc") or {}
        row = {
            "name": bc.get("name"),
            "bc_type": bc.get("bc_type"),
            "patch": m.get("patch"),
            "faces": bc_faces(bc),
            "value": bc.get("value"),
            "unit": bc.get("unit") or None,
        }
        if is_wall_bc(bc):
            row["wall_type"] = wall_treatment(bc)
        rows.append(row)
    override = getattr(ctx.inputs, "transient_override", None) if ctx.inputs is not None else None
    model = spec.physics.turbulence_model
    control = control_to_web(spec.transient, override) if spec.transient is not None else None
    return {
        "bcs": rows,
        "wall_default": spec.wall_default,
        "transient_control": control,
        # The run note's detail after the physics ("5 s · 50 frames · Co ≤ 1").
        "note_detail": describe_transient(control) if control is not None else "",
        "physics_label": TURBULENCE_LABELS.get(model, model),
        "algorithm": algorithm_label(spec.time_dependency),
        "n_procs": spec.n_procs,
        "end_time": spec.end_time,
        "write_interval": spec.write_interval,
        "nu": spec.nu,
        "rho": spec.rho,
        "monitor_patches": spec.monitor_patches,
        "patches": spec.patches,
        "transient": spec.transient is not None,
    }


def _write_web_solve_case(ctx: CaseContext) -> dict:
    """Write the case (steady or transient, from the RunSpec) and report what was written."""
    from pathlib import Path as _Path

    from .writer import write_solve_case

    spec = _spec(ctx)
    if not spec.ok:
        return {"ok": False, "error": spec.error or "the run is not ready"}
    out = ctx.out_dir
    if out is None:
        raise ValueError("CaseContext.out_dir is required for AnalysisType.write_case")
    result = write_solve_case(spec, _Path(out), services=ctx.services)
    return {**result, **_decision(spec, ctx)}


def _plan_case(ctx: CaseContext) -> dict:
    """The same report as write_case, without writing anything (prepare_run --validate-only)."""
    spec = _spec(ctx)
    if not spec.ok:
        return {"ok": False, "error": spec.error or "the run is not ready"}
    return {"ok": True, "run_id": spec.run_id, "solver": spec.solver_app, **_decision(spec, ctx)}


def _write_case_steady(ctx: CaseContext) -> dict:
    return _write_web_solve_case(ctx)


def _write_case_transient(ctx: CaseContext) -> dict:
    return _write_web_solve_case(ctx)


def _launch(td: str) -> Any:
    """How a run is launched (the contract's ``launch`` hook): the run's solver
    (simpleFoam or pimpleFoam) as its registered SolverApp says, every frame of
    a transient run and the latest of a steady one, and (API 1.5) the serial
    threshold and this plugin's own case-writing job."""
    from cfddesk.registry.contract import ContractError, LaunchSpec
    from cfddesk.registry.discovery import get_registry

    from . import contract as ic

    default = "pimpleFoam" if td == "transient" else "simpleFoam"

    def launch(solver_key: str | None = None, **_ignored: Any) -> LaunchSpec:
        key = str(solver_key or default)
        solvers = get_registry("solver")
        if key not in set(solvers.keys()):
            raise ContractError(f"solver {key!r} is not registered")
        app = solvers.get(key)
        return LaunchSpec(
            app=str(app.application),
            keep_frames="all" if td == "transient" else "latest",
            process_names=(str(app.application),),
            stop_strategy=str(app.stop_strategy),
            parallel=str(app.parallel) == "mpirun",
            log_parser=ic.LOG_PARSER,
            frame_fields=("U", "p"),
            kinematic_fields=KINEMATIC_FIELDS,
            serial_below_cells=ic.SERIAL_BELOW_CELLS[td],
            prepare_job=ic.WRITE_RUN_CASE_JOB,
        )

    return launch


def _contract_fields(td: str, *, key: str, label: str) -> dict:
    """Contract 1.1 hooks (incompressible_flow.contract)."""
    from . import contract as ic
    from .results import run_monitors

    return {
        "family": ic.FAMILY,
        "algorithm_label": ic.algorithm_label(td),
        "residual_keys": ic.RESIDUAL_KEYS,
        "residual_series": ic.residual_series(td),
        "x_axis": "seconds" if td == "transient" else "iterations",
        "study_defaults": ic.make_study_defaults(
            key=key, label=label, category="FLUID DYNAMICS"
        ),
        "validate_ready": ic.validate_ready,
        "run_model": ic.TRANSIENT_RUN_MODEL if td == "transient" else ic.STEADY_RUN_MODEL,
        "log_parser": ic.LOG_PARSER,
        "launch": _launch(td),
        "live_metrics": ic.live_metrics(td),
        "plan_case": _plan_case,
        "run_monitors": run_monitors,
        "frame_fields": ("U", "p"),
        "kinematic_fields": KINEMATIC_FIELDS,
        "monitor_quantities": MONITOR_QUANTITIES,
        "ui": dict(ic.UI),
    }


def build_incompressible_steady() -> AnalysisType:
    return AnalysisType(
        key="incompressible_steady",
        label="Incompressible Fluid Flow",
        category="FLUID DYNAMICS",
        time_dependency="steady",
        fields=_FIELDS,
        bc_types=_INCOMPRESSIBLE_BC_TYPES,
        material_models=_MATERIAL_MODELS,
        solver_backends=("simpleFoam",),
        default_solver="simpleFoam",
        monitors=_MONITORS,
        result_fields=_RESULT_FIELDS,
        settings_schema=_settings_schema(),
        numerics_schema=_numerics_schema(transient=False),
        control_schema=_control_schema(transient=False),
        region_roles=("fluid",),
        write_case=_write_case_steady,
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
        bc_types=_INCOMPRESSIBLE_BC_TYPES,
        material_models=_MATERIAL_MODELS,
        solver_backends=("pimpleFoam",),
        default_solver="pimpleFoam",
        monitors=_MONITORS,
        result_fields=_RESULT_FIELDS,
        settings_schema=_settings_schema(),
        numerics_schema=_numerics_schema(transient=True),
        control_schema=_control_schema(transient=True),
        region_roles=("fluid",),
        write_case=_write_case_transient,
        requires=(Requirement("wsl_tool", "pimpleFoam"),),
        **_contract_fields("transient", key="incompressible_transient", label="Incompressible Fluid Flow (Transient)"),
    )
