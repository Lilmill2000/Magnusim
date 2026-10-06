"""Incompressible Flow's side of the analysis contract (API 1.1).

What the core used to decide itself, answered by the analysis: the Create modal
text, a new study's defaults, what blocks a run, the run settings model and its
preview, and the solver-output parser.

``validate_ready`` is a line-for-line port of Node's former validateSolveReady
checks: same order, same messages, same fix targets (the page matches some of
these texts).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from cfddesk.registry.contract import AnalysisFamily, LogParserRef, ReadyContext, RunModel

from .physics import TURBULENCE_SHORT_LABELS

FAMILY = AnalysisFamily(
    key="incompressible",
    label="Incompressible",
    title="Incompressible Fluid Flow",
    description=(
        "Simulate flow of a single fluid for which the maximum Mach number is lower than 0.3. "
        "Density variations are negligible — approximated as incompressible."
    ),
    tags=("FLUID FLOW (GAS OR LIQUID)", "MACH<0.3 (100 M/S)", "NEGLIGIBLE DENSITY VARIATION"),
    study_name="Incompressible",
)

# The residual series the run panel plots, with the V0.1.0 colors: U is the
# largest of Ux/Uy/Uz, R the largest Reynolds-stress component. U and p are
# always in the legend; turbulence series only when the run solves them.
RESIDUAL_SERIES: tuple[dict, ...] = (
    {"key": "U", "label": "U", "color": "#1570ef", "fields": ["Ux", "Uy", "Uz"], "always": True, "swatch": "u"},
    {"key": "p", "label": "p", "color": "#6941c6", "always": True, "swatch": "p"},
    {"key": "k", "label": "k", "color": "#12b76a", "swatch": "k"},
    {"key": "omega", "label": "ω", "color": "#f79009", "swatch": "w"},
    {"key": "epsilon", "label": "ε", "color": "#0ba5ec", "swatch": "epsilon"},
    {"key": "R", "label": "R", "color": "#dd2590", "fields": ["Rxx", "Rxy", "Rxz", "Ryy", "Ryz", "Rzz"], "swatch": "r"},
    # Spalart-Allmaras's one equation (its legend swatch takes the colour).
    {"key": "nuTilda", "label": "ν̃", "color": "#0e9384"},
)
# Transient runs also plot the mean Courant number per time step (dashed).
COURANT_SERIES = {
    "key": "co_mean",
    "label": "Co mean",
    "color": "#d92d20",
    "dashed": True,
    "max_key": "co_max",
    "max_label": "max",
    "swatch": "co",
}
RESIDUAL_KEYS = tuple(s["key"] for s in RESIDUAL_SERIES)


def residual_series(td: str) -> tuple[dict, ...]:
    return (*RESIDUAL_SERIES, COURANT_SERIES) if td == "transient" else RESIDUAL_SERIES

# The solver-output parser lives in this package; the runner imports it from
# the plugin folder (``path``).
LOG_PARSER = LogParserRef(
    "incompressible_flow.parser", "IncompressibleParser", str(Path(__file__).resolve().parents[1])
)

# The components this plugin's UI (ui/index.tsx) registers for the study and
# run panels' settings slots.
UI = {"study_settings": "incompressible_flow.study", "run_settings": "incompressible_flow.run"}

# How a run is launched (API 1.5): its case is written by this plugin's own job
# (incompressible_flow/jobs/write_run_case.py, registered in plugin.py), and a
# mesh with fewer cells than this runs serial (the rule before 1.5).
WRITE_RUN_CASE_JOB = "incompressible_flow.write_run_case"
SERIAL_BELOW_CELLS = {"steady": 200_000, "transient": 50_000}

# The Run panel's progress line after the time of a transient run (API 1.5):
# the time step, and the mean Courant number with its maximum. A steady run
# shows none.
LIVE_METRICS: tuple[dict, ...] = (
    {"key": "delta_t", "label": "Δt", "format": "time"},
    {"key": "co_mean", "label": "Co", "format": "sig2", "max_key": "co_max"},
)


def live_metrics(td: str) -> tuple[dict, ...]:
    return LIVE_METRICS if td == "transient" else ()

# The run note's name of each model (physics.TURBULENCE_SHORT_LABELS).
TURBULENCE_LABELS = TURBULENCE_SHORT_LABELS


def algorithm_label(time_dependency: str) -> str:
    return "PIMPLE" if time_dependency == "transient" else "SIMPLE"


def make_study_defaults(*, key: str, label: str, category: str):
    """study_defaults(time_dependency) for one of the two analyses.

    The study's identity: analysis key, the Create modal's bank name, the
    family title, category, time dependency and algorithm. The turbulence
    model is left out on purpose: the core fills it from the analysis's
    settings_schema default, so an analysis that clones this one with its own
    default (a laminar copy) starts its studies on that default.
    """

    def study_defaults(time_dependency: str) -> dict[str, Any]:
        td = "transient" if time_dependency == "transient" else "steady"
        return {
            "analysis_type": key,
            "analysis": FAMILY.study_name,
            # The family title for both siblings (what every study carried before H8).
            "analysis_title": FAMILY.title,
            "category": category,
            "time_dependency": "Transient" if td == "transient" else "Steady-state",
            "algorithm": algorithm_label(td),
        }

    return study_defaults


# ---------------------------------------------------------------------------
# Readiness (was Node validateSolveReady)
# ---------------------------------------------------------------------------


def _pressure_pa(bc: dict[str, Any]) -> float:
    """Static pressure in Pa (gauge) for a Pressure boundary (Node pressurePa)."""
    try:
        v = float(bc.get("value"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    from .writer import PRESSURE_PA_FACTORS

    unit = str(bc.get("unit") or "Pa").lower()
    return v * PRESSURE_PA_FACTORS.get(unit, 1.0)


def _mesh_web_bcs(case_dir: Path | None) -> list[dict[str, Any]]:
    if not case_dir:
        return []
    try:
        meta = json.loads((Path(case_dir) / "standard-meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = meta.get("web_bcs") if isinstance(meta, dict) else None
    return [b for b in rows if isinstance(b, dict)] if isinstance(rows, list) else []


def study_is_transient(study: Any) -> bool:
    """The study solves in time (its time dependency, else its analysis key)."""
    d = study if isinstance(study, dict) else {}
    td = str(d.get("time_dependency") or "").strip().lower()
    if td:
        return td.startswith("transient")
    return str(d.get("analysis_type") or "").endswith("_transient")


def validate_ready(ctx: ReadyContext) -> list[dict[str, Any]]:
    """What blocks a run: a fluid, a flow driver, a mesh patch per BC, a pressure difference."""
    from magnusim_sdk.study import (
        bc_faces,
        is_pressure_bc,
        is_velocity_inlet,
        is_velocity_outlet,
        is_wall_bc,
        map_bc_to_patch,
        matches_study,
    )

    from .bc_kinds import is_freestream, is_total_pressure_inlet, wall_motion_problem
    from .inlet_turbulence import settings_problem
    from .physics import physics_from_record
    from .runspec import air_from_materials
    from .time_table import table_problem, varies_with_time
    from .writer import carries_inlet_turbulence, inlet_quantity, outlet_outflow, pressure_values_pa

    sid = ctx.simulation_id
    air = air_from_materials({"materials": list(ctx.materials)}, sid)
    records = [b for b in ctx.bcs if matches_study(b, sid)]
    inlets = [b for b in records if is_velocity_inlet(b) and bc_faces(b)]
    # A total-pressure inlet holds a pressure too (its total pressure).
    pressures = [b for b in records if (is_pressure_bc(b) or is_total_pressure_inlet(b)) and bc_faces(b)]
    # A velocity outlet draws its outflow (the inflow then comes through a pressure boundary).
    outlets = [b for b in records if is_velocity_outlet(b) and bc_faces(b)]
    # A freestream both brings the flow and holds the pressure level.
    freestreams = [b for b in records if is_freestream(b) and bc_faces(b)]
    driven = bool(inlets or outlets or freestreams)

    if not air or not air.get("assigned"):
        return [{"message": "Assign a fluid to a volume first", "fix": {"go": "material"}}]
    if not driven and len(pressures) < 2:
        incomplete = next((b for b in records if not bc_faces(b)), None)
        return [
            {
                "message": (
                    "Add a velocity inlet or outlet, a freestream, or two pressure boundaries, "
                    "each with an assigned face"
                ),
                "fix": (
                    {"go": "bc", "id": incomplete.get("id"), "name": incomplete.get("name")}
                    if incomplete
                    else {"go": "bc-picker"}
                ),
            }
        ]
    if not pressures and not freestreams:
        return [{"message": "Add a pressure boundary with an assigned face", "fix": {"go": "bc-picker"}}]

    patch_names = set(ctx.patches)
    web_bcs = _mesh_web_bcs(ctx.mesh_case_dir)
    for bc in records:
        if not bc_faces(bc):
            continue
        patch = map_bc_to_patch(bc, patch_names, web_bcs)
        if patch not in patch_names:
            return [
                {
                    "message": (
                        f'Mesh has no patch for "{bc.get("name")}" (looked for {patch}). '
                        "Generate the mesh after assigning BCs."
                    ),
                    "fix": {"go": "mesh", "id": ctx.mesh.get("mesh_id"), "name": ctx.mesh.get("mesh_name")},
                    "patches": list(ctx.patches),
                }
            ]
    model = physics_from_record(ctx.study if isinstance(ctx.study, dict) else None).turbulence_model
    if model != "laminar":
        for bc in records:
            problem = settings_problem(bc, model) if bc_faces(bc) and carries_inlet_turbulence(bc) else None
            if problem:
                return [
                    {
                        "message": f'Turbulence at the inlet of "{bc.get("name")}": {problem}.',
                        "fix": {"go": "bc", "id": bc.get("id"), "name": bc.get("name")},
                    }
                ]
    # "Varies with time" tables (transient studies only; a steady one solves the fixed value).
    transient = study_is_transient(ctx.study)
    for bc in records if transient else []:
        if not bc_faces(bc) or not varies_with_time(bc):
            continue
        if is_velocity_inlet(bc):
            problem = table_problem(bc, inlet_quantity(bc))
        elif is_pressure_bc(bc) or is_total_pressure_inlet(bc):
            problem = table_problem(bc, "pressure")
        else:
            continue
        if problem:
            return [
                {
                    "message": f'"Varies with time" on "{bc.get("name")}": {problem}.',
                    "fix": {"go": "bc", "id": bc.get("id"), "name": bc.get("name")},
                }
            ]
    for bc in records:
        problem = wall_motion_problem(bc) if bc_faces(bc) and is_wall_bc(bc) else None
        if problem:
            return [
                {
                    "message": f'Wall "{bc.get("name")}": {problem}.',
                    "fix": {"go": "bc", "id": bc.get("id"), "name": bc.get("name")},
                }
            ]
    closed = next((b for b in outlets if outlet_outflow(b) == 0), None)
    if closed is not None:
        return [
            {
                "message": (
                    f'Velocity outlet "{closed.get("name")}" lets nothing out (its value is 0). '
                    "Give it an outflow, or make it a Wall."
                ),
                "fix": {"go": "bc", "id": closed.get("id"), "name": closed.get("name")},
            }
        ]
    if not driven and len(pressures) >= 2:
        # A table's lowest and highest pressure count (the flow is driven while they differ).
        vals = [v for b in pressures for v in pressure_values_pa(b, transient)]
        if max(vals) - min(vals) == 0:
            return [
                {
                    "message": (
                        "Both pressure boundaries have the same value, so nothing drives the flow. "
                        "Give them different pressures or add a velocity inlet."
                    ),
                    "fix": {"go": "bc", "id": pressures[0].get("id"), "name": pressures[0].get("name")},
                }
            ]
    return []


# ---------------------------------------------------------------------------
# Run model
# ---------------------------------------------------------------------------


def _steady_defaults() -> dict[str, Any]:
    from .transient import STEADY_DEFAULTS

    return dict(STEADY_DEFAULTS)


def _steady_normalize(raw: dict[str, Any]) -> dict[str, Any]:
    d = _steady_defaults()

    def _int(v: Any, fallback: int) -> int:
        try:
            n = int(round(float(v)))
        except (TypeError, ValueError):
            return fallback
        return max(1, n)

    out: dict[str, Any] = {
        "end_time": _int(raw.get("end_time"), int(d["end_time"])),
        "write_interval": _int(raw.get("write_interval"), int(d["write_interval"])),
    }
    _settle_into(out, raw, transient=False)
    return out


def _settle_into(out: dict[str, Any], raw: dict[str, Any], *, transient: bool) -> None:
    """The run's "Stop when a monitor settles" (stored on the run record as ``settle``),
    cleaned: only when the edits name it (None turns it off), so a run without one
    normalizes as before."""
    if "settle" in raw:
        from .settle import clean_settle

        out["settle"] = clean_settle(raw.get("settle"), transient=transient)


def _steady_preview(**kwargs: Any) -> dict[str, Any]:
    return {"ok": True, "partial": False, "control": _steady_normalize(dict(kwargs.get("settings") or {}))}


def _transient_defaults() -> dict[str, Any]:
    from .transient import TRANSIENT_DEFAULTS

    return dict(TRANSIENT_DEFAULTS)


def _transient_normalize(raw: dict[str, Any]) -> dict[str, Any]:
    from .transient import normalize_transient

    out = dict(normalize_transient({k: v for k, v in raw.items() if k != "settle"}))
    out.pop("settle", None)
    _settle_into(out, raw, transient=True)
    return out


def transient_preview(
    *,
    inputs: Any = None,
    settings: dict[str, Any] | None = None,
    **_kwargs: Any,
) -> dict[str, Any]:
    """The numbers a transient run would be written with right now.

    The same call prepare_run makes (load_run_spec → resolve_transient_control
    with the run's mesh metadata and reference speed), so the Run panel shows
    the Δt that lands in controlDict. Partial (settings only) until the run has
    a mesh and a flow-driving boundary condition.
    """
    from magnusim_sdk.study import is_pressure_bc, is_velocity_inlet, is_velocity_outlet

    from .bc_kinds import is_freestream, is_total_pressure_inlet
    from .runspec import load_run_spec
    from .transient import control_to_web, resolve_transient_control

    raw = settings if isinstance(settings, dict) else {}
    if inputs is None:
        return {"ok": True, "partial": True, "reason": None, "control": control_to_web(resolve_transient_control(raw, {}), raw)}
    spec = load_run_spec(inputs)
    bcs = [m.get("bc") for m in (spec.mapped or [])]
    driven = any(is_velocity_inlet(b) or is_velocity_outlet(b) or is_freestream(b) for b in bcs) or (
        sum(1 for b in bcs if is_pressure_bc(b) or is_total_pressure_inlet(b)) >= 2
    )
    if not spec.ok or spec.transient is None or not driven:
        reason = spec.error if not spec.ok else ("no flow-driving boundary condition" if not driven else None)
        return {
            "ok": True,
            "partial": True,
            "reason": reason,
            "control": control_to_web(resolve_transient_control(raw, {}), raw),
        }
    return {
        "ok": True,
        "partial": False,
        "control": control_to_web(spec.transient, raw),
        "n_cells": spec.n_cells,
    }


STEADY_RUN_MODEL = RunModel(defaults=_steady_defaults, normalize=_steady_normalize, preview=_steady_preview)
TRANSIENT_RUN_MODEL = RunModel(defaults=_transient_defaults, normalize=_transient_normalize, preview=transient_preview)
