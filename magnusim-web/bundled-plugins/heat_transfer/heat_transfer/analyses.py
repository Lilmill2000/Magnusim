"""Heat Transfer's two AnalysisTypes (steady and transient) and their schemas."""

from __future__ import annotations

from typing import Any

from cfddesk.registry.analysis import AnalysisType, CaseContext, ResultField
from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField
from magnusim_sdk.numerics_advice import description as advice_description
from magnusim_sdk.numerics_settings import run_field_specs, study_field_specs

from .bcs import BC_FIELDS, BC_SEEDS, BC_TYPES
from .materials import FLUID_MODEL, SOLID_MODEL
from .monitors import MONITOR_KEYS, MONITOR_QUANTITIES
from .physics import (
    DEFAULT_DENSITY,
    DEFAULT_GRAVITY,
    DEFAULT_NUMERICS,
    DEFAULT_OPERATING_PRESSURE,
    DEFAULT_REFERENCE_T,
    DEFAULT_TURBULENCE,
    DENSITY_LABELS,
    DENSITY_MODELS,
    GRAVITY_CHOICES,
    GRAVITY_LABELS,
    NUMERICS_LABELS,
    NUMERICS_PRESETS,
    STANDARD_GRAVITY,
    TURBULENCE_LABELS,
    TURBULENCE_MODELS,
)

STEADY_KEY = "heat_transfer_steady"
TRANSIENT_KEY = "heat_transfer_transient"
LABEL = "Heat Transfer"

_FIELDS: tuple[str, ...] = ("U", "p_rgh", "p", "T", "k", "omega", "epsilon", "nut", "alphat")

RESULT_FIELDS: tuple[ResultField, ...] = (
    ResultField("T", "Temperature", "temperature", "scalar", unit="K"),
    ResultField("U", "Velocity", "velocity", "vector", unit="m/s", magnitude_label="Velocity Magnitude"),
    ResultField("p", "Pressure", "pressure", "scalar", unit="Pa"),
    ResultField("p_rgh", "Pressure without hydrostatic", "pressure", "scalar", unit="Pa"),
    ResultField("rho", "Density", "density", "scalar", unit="kg/m³"),
    ResultField("wallHeatFlux", "Wall heat flux", "heat_flux", "scalar", unit="W/m²"),
    ResultField("htc", "Heat transfer coefficient", "heat_transfer_coefficient", "scalar", unit="W/(m²·K)"),
    ResultField("k", "Turbulent kinetic energy", "specific_energy", "scalar", unit="m²/s²"),
    ResultField("omega", "Specific dissipation rate", "specific_dissipation_rate", "scalar", unit="1/s"),
    ResultField("epsilon", "Turbulent dissipation rate", "dissipation_rate", "scalar", unit="m²/s³"),
    ResultField("nut", "Turbulent viscosity", "kinematic_viscosity", "scalar", unit="m²/s"),
)


def settings_schema() -> tuple[SchemaField, ...]:
    """The study panel's physics (heat_transfer.physics reads every key)."""
    return (
        SchemaField(
            "gravity",
            "Gravity",
            "choice",
            default=DEFAULT_GRAVITY,
            choices=GRAVITY_CHOICES,
            choice_labels=GRAVITY_LABELS,
            group="gravity",
            description=(
                "The direction gravity pulls in, in the model's coordinates. With gravity, warm fluid rises "
                "(natural convection). Off solves forced convection only."
            ),
        ),
        SchemaField(
            "gravity_vector",
            "Gravity direction",
            "vector3",
            default=[0.0, 0.0, -1.0],
            depends_on={"gravity": "custom"},
            group="gravity",
            description="Any direction; its length does not matter (the magnitude below sets it).",
        ),
        SchemaField(
            "gravity_magnitude",
            "Gravity magnitude",
            "float",
            default=STANDARD_GRAVITY,
            min=0.0,
            quantity="acceleration",
            group="gravity",
        ),
        SchemaField(
            "density_model",
            "Density",
            "choice",
            default=DEFAULT_DENSITY,
            choices=DENSITY_MODELS,
            choice_labels=DENSITY_LABELS,
            group="fluid",
            description=(
                "How the fluid's density follows its temperature. Incompressible perfect gas (gases): ρ = p_op M / (R T). "
                "Boussinesq (liquids, small temperature differences): ρ = ρ₀ (1 − β (T − T_ref)). Constant density "
                "only suits forced convection, with gravity off."
            ),
        ),
        SchemaField(
            "operating_pressure",
            "Operating pressure",
            "float",
            default=DEFAULT_OPERATING_PRESSURE,
            min=0.0,
            quantity="pressure",
            group="fluid",
            description=(
                "The absolute pressure of the surroundings. Pressures in boundary conditions and results are "
                "relative to it (gauge); it sets the density of a perfect gas."
            ),
        ),
        SchemaField(
            "reference_temperature",
            "Reference temperature",
            "float",
            default=DEFAULT_REFERENCE_T,
            min=0.0,
            quantity="temperature",
            group="fluid",
            description=(
                "The temperature the Boussinesq density and the heat transfer coefficient results are measured "
                "against; usually the surroundings' or the inlet's."
            ),
        ),
        SchemaField(
            "initial_temperature",
            "Starting temperature",
            "float",
            min=0.0,
            quantity="temperature",
            group="fluid",
            optional=True,
            description="The fluid's temperature everywhere when the solve starts. Blank uses the reference temperature.",
        ),
        SchemaField(
            "turbulence_model",
            "Turbulence model",
            "choice",
            default=DEFAULT_TURBULENCE,
            choices=TURBULENCE_MODELS,
            choice_labels=TURBULENCE_LABELS,
            group="flow",
            description=(
                "Laminar suits slow natural convection (a Rayleigh number below about 10⁹) and low-Reynolds flow. "
                "k-omega SST is the general-purpose model (Spalding's law at the wall: a first cell at y+ from about "
                "5 to 100, or below about 0.5); k-epsilon and realizable "
                "k-epsilon use wall functions (y+ above about 30)."
            ),
        ),
    )


# What Heat Transfer adds after a numerics key's advice (its own defaults).
_RH3_EXTRA: dict[str, str] = {
    "eq_max_iter": "Blank is OpenFOAM's 1000.",
    "velocity_limit": "Heat Transfer's default is Off.",
    "outer_relax_p": "Blank is 1 (none).",
    "outer_relax_eq": "Blank is 1 (none).",
}


def _rh3_study_fields(*, transient: bool) -> list[SchemaField]:
    """RH3: the study's schemes, linear solvers, turbulence relaxation (steady) and velocity
    limit (magnusim_sdk.numerics_settings), under Advanced settings. Defaults are today's
    values; a blank one is written as before (the preset's, or OpenFOAM's own)."""
    return [
        SchemaField(**kw)
        for kw in study_field_specs(
            transient=transient,
            energy=True,
            simplec=False,
            p_name="p_rgh",
            eq_max_iter_default=None,
            velocity_limit_default="off",
            extra=_RH3_EXTRA,
        )
    ]


def numerics_schema(*, transient: bool) -> tuple[SchemaField, ...]:
    fields: list[SchemaField] = [
        SchemaField(
            "numerics_preset",
            "Numerics",
            "choice",
            default=DEFAULT_NUMERICS,
            choices=NUMERICS_PRESETS,
            choice_labels=NUMERICS_LABELS,
            group="solution",
            description=(
                "Robust solves the turbulence equations to first order with strongly limited gradients and suits "
                "any mesh. Accurate is second order throughout with full non-orthogonal correction: sharper on a "
                "good mesh, but it may not converge on a poor one. Energy is second order in both."
            ),
        ),
    ]
    if not transient:
        fields.extend(
            SchemaField(key, label, "float", default=default, min=0.0, max=1.0, group="relaxation", description=text)
            for key, label, default, text in (
                ("relax_u", "Relaxation U", 0.7, "Under-relaxation of velocity and turbulence (0 to 1). Lower it if the solve oscillates."),
                ("relax_p", "Relaxation p_rgh", 0.3, "Under-relaxation of the pressure (0 to 1)."),
                ("relax_h", "Relaxation energy", 0.5, "Under-relaxation of the energy equation (0 to 1). 0.5 keeps the heat balance of a flow through openings; a closed natural-convection case settles sooner at 0.9."),
            )
        )
        fields.append(
            SchemaField(
                "residual_target",
                "Residual target",
                "float",
                default=1e-5,
                min=0.0,
                group="residuals",
                description="The run stops once the velocity, energy and pressure residuals are all below it.",
            )
        )
    fields.append(
        SchemaField(
            "n_non_orthogonal",
            "Non-orthogonal correctors",
            "int",
            default=1,
            min=0,
            max=10,
            group="solution",
            description="Extra pressure corrections for skewed cells: 0 for clean hex meshes, 1 to 3 for tetrahedra.",
        )
    )
    fields.extend(_rh3_study_fields(transient=transient))
    return tuple(fields)


def control_schema(*, transient: bool) -> tuple[SchemaField, ...]:
    from .transient import STEADY_DEFAULTS, TRANSIENT_DEFAULTS

    if not transient:
        return (
            SchemaField("end_time", "Number of iterations", "int", default=int(STEADY_DEFAULTS["end_time"]), min=1,
                        group="control", description="Iterations to run. The run stops earlier when the residuals reach their target."),
            SchemaField("write_interval", "Write interval", "int", default=int(STEADY_DEFAULTS["write_interval"]), min=1,
                        group="control", description="How often results are saved, in iterations."),
        )
    d = TRANSIENT_DEFAULTS
    return (
        SchemaField("end_time", "Simulation time", "float", default=float(d["end_time"]), min=0.0, unit="s", group="control",
                    description="Simulated time to stop at, in seconds."),
        SchemaField("write_count", "Result frames", "int", default=int(d["write_count"]), min=1, max=5000, group="control",
                    description="Result frames saved over the simulation time."),
        SchemaField("time_step_mode", "Time step", "choice", default=str(d["time_step_mode"]), choices=("adjustable", "fixed"),
                    choice_labels=("Adjustable", "Fixed"), group="control", advanced=True,
                    description="Adjustable keeps the Courant number at or below the maximum; fixed uses one step throughout."),
        SchemaField("max_co", "Max Courant", "float", default=float(d["max_co"]), min=0.0, group="control", advanced=True,
                    description=advice_description("max_co")),
        SchemaField("delta_t", "Initial time step", "float", default=d["delta_t"], min=0.0, unit="s", group="control",
                    advanced=True, optional=True,
                    description="Blank calculates it from the mean cell size and the case's speed."),
        SchemaField("max_delta_t", "Max time step", "float", default=d["max_delta_t"], min=0.0, unit="s", group="control",
                    advanced=True, optional=True, description="Blank uses the frame interval, so every frame is written."),
        SchemaField("time_scheme", "Time scheme", "choice", default=str(d["time_scheme"]), choices=("Euler", "backward"),
                    choice_labels=("Euler (1st order)", "Backward (2nd order)"), group="control", advanced=True),
        SchemaField("n_outer_correctors", "Outer correctors", "int", default=int(d["n_outer_correctors"]), min=1, max=50,
                    group="control", advanced=True, description=advice_description("n_outer_correctors")),
        SchemaField("n_correctors", "Pressure correctors", "int", default=int(d["n_correctors"]), min=1, max=10,
                    group="control", advanced=True),
        # RH3: the PIMPLE outer loops' relaxation and tolerance (blank = as today).
        *(SchemaField(**kw) for kw in run_field_specs(p_name="p_rgh", extra=_RH3_EXTRA)),
    )


# ---------------------------------------------------------------------------
# Contract hooks
# ---------------------------------------------------------------------------


def _spec(ctx: CaseContext) -> Any:
    if ctx.run_spec is not None:
        return ctx.run_spec
    if ctx.inputs is None:
        raise ValueError("CaseContext needs inputs (RunInputs) or run_spec")
    from .runspec import load_spec

    return load_spec(ctx.inputs)


def _decision(spec: Any, ctx: CaseContext) -> dict[str, Any]:
    from incompressible_flow.flow_bcs import boundary_kind
    from magnusim_sdk.study import bc_faces

    from .contract import algorithm_label, physics_label
    from .runspec import convergence_stops_off
    from .transient import control_to_web, describe_transient

    rows = []
    for bc in spec.records:
        rows.append({"name": bc.get("name"), "bc_type": bc.get("bc_type"), "kind": boundary_kind(bc), "faces": bc_faces(bc),
                     "value": bc.get("value"), "unit": bc.get("unit") or None})
    override = getattr(ctx.inputs, "transient_override", None) if ctx.inputs is not None else None
    control = control_to_web(spec.transient, override) if spec.transient is not None else None
    density = spec.density_model
    label = physics_label(spec.physics, density)
    if spec.cht:
        from .cht import bodies_text, record_bodies

        solids = [b for rec in spec.solid_records for b in record_bodies(rec)]
        label = f"conjugate heat transfer ({bodies_text(solids)} solid)" + (f", {label}" if spec.fluid_records else "")
    out: dict[str, Any] = {
        "bcs": rows,
        "transient_control": control,
        "note_detail": describe_transient(control) if control is not None else "",
        "physics_label": label,
        "algorithm": algorithm_label(spec.time_dependency),
        "n_procs": spec.n_procs,
        "end_time": spec.end_time,
        "write_interval": spec.write_interval,
        "density_model": density,
        "transient": spec.transient is not None,
    }
    context = getattr(ctx.inputs, "check_context", None) if ctx.inputs is not None else None
    if isinstance(context, dict):
        # RH2 (API 1.9): the pre-run check as the run starts (prepare_run.checks).
        from .precheck import run_check

        settings = override if spec.transient is not None else {"end_time": spec.end_time, "write_interval": spec.write_interval}
        try:
            out["checks"] = run_check(transient=spec.transient is not None, spec=spec, inputs=ctx.inputs, settings=settings or {}, context=context)["checks"]
        except Exception as exc:  # noqa: BLE001 (the check never stops a Start: it is left out, and says why)
            out["checks_error"] = f"{type(exc).__name__}: {exc}"[:200]
    if convergence_stops_off(spec):
        out["stops_off"] = True
        return out
    # chtMultiRegionSimpleFoam does not stop on its residuals (it runs its iterations,
    # or until a monitor settles).
    if spec.transient is None and not spec.cht:
        out["residual_control"] = True
    if spec.settle:
        stop = _stop_when(spec)
        if stop is not None:
            out["stop_when"] = stop
    return out


def _stop_when(spec: Any) -> dict[str, Any] | None:
    """The settle stop as the run record keeps it: ``{label, text}``, or ``{error, label?}``."""
    from .settle import plan_settle

    if spec.cht:
        return _cht_stop_when(spec)
    patches = {str(rec.get("id")): f"bc_{rec.get('id')}" for rec in spec.records}
    plans = []
    for m in spec.monitors:
        row: dict[str, Any] = {"id": m.get("id"), "name": m.get("name"), "type": m["type"]}
        if m["type"] == "ht_thermocouple":
            row["points"] = m.get("points") or []
            row["key"] = "ht_probe"
        else:
            row["patches"] = [patches.get(str(b), str(b)) for b in m.get("boundaries") or []]
        plans.append(row)
    plan = plan_settle(spec, plans)
    if plan is None:
        return None
    if "error" in plan:
        return {k: plan[k] for k in ("label", "error") if k in plan}
    return {"label": plan["label"], "text": plan["text"]}


def _cht_stop_when(spec: Any) -> dict[str, Any] | None:
    """A CHT run's settle stop as its case will be written (its objects are per region)."""
    from pathlib import Path

    from .cht import ChtError, layout
    from .cht_functions import plan_cht_monitors
    from .cht_writer import _patch_records
    from .settle import plan_settle

    mesh = (spec.inputs.mesh or {}) if spec.inputs is not None else {}
    poly = Path(spec.mesh_case_dir) / "constant" / "polyMesh"
    try:
        lay = layout(mesh.get("regions"), [*spec.fluid_records, *spec.solid_records], poly, keep=True)
        by_patch = _patch_records(spec, list(lay.patch_types))
        plan = plan_settle(spec, plan_cht_monitors(spec, lay, by_patch, out=Path(spec.mesh_case_dir), poly_dir=poly))
    except ChtError:
        return None
    if plan is None:
        return None
    if "error" in plan:
        return {k: plan[k] for k in ("label", "error") if k in plan}
    return {"label": plan["label"], "text": plan["text"]}


def write_case(ctx: CaseContext) -> dict[str, Any]:
    from pathlib import Path

    from .writer import write_case as _write

    spec = _spec(ctx)
    if not spec.ok:
        return {"ok": False, "error": spec.error or "the run is not ready"}
    if ctx.out_dir is None:
        raise ValueError("CaseContext.out_dir is required for AnalysisType.write_case")
    result = _write(spec, Path(ctx.out_dir))
    return {**result, **_decision(spec, ctx)} if result.get("ok") else result


def plan_case(ctx: CaseContext) -> dict[str, Any]:
    from .writer import solver_app

    spec = _spec(ctx)
    if not spec.ok:
        return {"ok": False, "error": spec.error or "the run is not ready"}
    return {"ok": True, "run_id": spec.run_id, "solver": solver_app(spec), **_decision(spec, ctx)}


def study_is_cht(inputs: Any) -> bool:
    """The run's study has a body of a solid material (the core's RunInputs)."""
    from .contract import study_solids

    if inputs is None:
        return False
    return bool(study_solids(getattr(inputs, "materials", None) or {}, getattr(inputs, "simulation_id", None)))


def _launch(td: str) -> Any:
    from . import contract as hc

    default = hc.TRANSIENT_SOLVER if td == "transient" else hc.STEADY_SOLVER
    cht = hc.CHT_TRANSIENT_SOLVER if td == "transient" else hc.CHT_STEADY_SOLVER

    def launch(solver_key: str | None = None, inputs: Any = None, **_ignored: Any) -> Any:
        """The buoyant solver, or the CHT one when the run's study has a solid body (host API
        1.8 passes the run's inputs when it plans a run). The log parser reads both."""
        from cfddesk.registry.contract import ContractError, LaunchSpec
        from cfddesk.registry.discovery import get_registry

        key = cht if study_is_cht(inputs) else str(solver_key or default)
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
            log_parser=hc.LOG_PARSER,
            frame_fields=("T", "U"),
            kinematic_fields=(),
            serial_below_cells=hc.SERIAL_BELOW_CELLS[td],
            prepare_job=hc.WRITE_RUN_CASE_JOB,
        )

    return launch


def _contract_fields(td: str, *, key: str) -> dict[str, Any]:
    from . import contract as hc
    from .results import run_monitors

    return {
        "family": hc.FAMILY,
        "algorithm_label": hc.algorithm_label(td),
        "residual_keys": hc.RESIDUAL_KEYS,
        "residual_series": hc.residual_series(td),
        "x_axis": "seconds" if td == "transient" else "iterations",
        "study_defaults": hc.make_study_defaults(key=key),
        "validate_ready": hc.validate_ready,
        "run_model": hc.TRANSIENT_RUN_MODEL if td == "transient" else hc.STEADY_RUN_MODEL,
        "log_parser": hc.LOG_PARSER,
        "launch": _launch(td),
        "live_metrics": hc.live_metrics(td),
        "plan_case": plan_case,
        "run_monitors": run_monitors,
        "frame_fields": ("T", "U"),
        "kinematic_fields": (),
        "monitor_quantities": MONITOR_QUANTITIES,
        "ui": dict(hc.UI),
    }


# A new mesh of a Heat Transfer study starts on Hex-dominant (host API 1.8 default_mesher):
# on Standard's tetrahedra the heat through walls is less accurate (VALIDATION.md).
DEFAULT_MESHER = "snappy_hexdominant"


def _build(td: str) -> AnalysisType:
    from . import contract as hc

    transient = td == "transient"
    key = TRANSIENT_KEY if transient else STEADY_KEY
    solver = hc.TRANSIENT_SOLVER if transient else hc.STEADY_SOLVER
    cht_solver = hc.CHT_TRANSIENT_SOLVER if transient else hc.CHT_STEADY_SOLVER
    return AnalysisType(
        key=key,
        label=f"{LABEL} (Transient)" if transient else LABEL,
        category=hc.CATEGORY,
        time_dependency="transient" if transient else "steady",
        fields=_FIELDS,
        bc_types=BC_TYPES,
        material_models=(FLUID_MODEL, SOLID_MODEL),
        solver_backends=(solver, cht_solver),
        default_solver=solver,
        monitors=MONITOR_KEYS,
        result_fields=RESULT_FIELDS,
        settings_schema=settings_schema(),
        numerics_schema=numerics_schema(transient=transient),
        control_schema=control_schema(transient=transient),
        region_roles=("fluid", "solid"),
        write_case=write_case,
        requires=(Requirement("wsl_tool", solver), Requirement("wsl_tool", cht_solver)),
        bc_fields=BC_FIELDS,
        bc_seeds=BC_SEEDS,
        default_mesher=DEFAULT_MESHER,
        **_contract_fields(td, key=key),
    )


def build_heat_transfer_steady() -> AnalysisType:
    return _build("steady")


def build_heat_transfer_transient() -> AnalysisType:
    return _build("transient")
