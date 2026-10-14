"""Heat Transfer's side of the analysis contract: the family, what blocks a run,
the run settings model, how a run is launched and the residual series.

One family, "Heat transfer" (a Steady/Transient pair): the solver follows the
study's materials. In this version every body is fluid, and the solver is
buoyantSimpleFoam (steady) or buoyantPimpleFoam (transient); a study that
still holds a development build's solid material is refused with the reason.

Start's messages show temperatures in the project's units (°C metric, °F
imperial); a temperature difference shows as a difference (no offset).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from cfddesk.registry.contract import AnalysisFamily, LogParserRef, ReadyContext, RunModel

from .physics import BOUSSINESQ_LIMIT, DENSITY_SHORT, TURBULENCE_SHORT, StudyPhysics

FAMILY = AnalysisFamily(
    key="heat_transfer",
    label="Heat transfer",
    title="Heat Transfer",
    description=(
        "Temperature and flow of one fluid heated or cooled through its walls and inlets, with "
        "buoyancy (natural convection) or without it (forced convection). Density follows the "
        "temperature: Boussinesq for liquids, incompressible perfect gas for gases."
    ),
    tags=("HEAT TRANSFER", "NATURAL AND FORCED CONVECTION", "BUOYANCY"),
    study_name="Heat transfer",
)

CATEGORY = "HEAT TRANSFER"
STEADY_SOLVER = "buoyantSimpleFoam"
TRANSIENT_SOLVER = "buoyantPimpleFoam"

RESIDUAL_SERIES: tuple[dict, ...] = (
    {"key": "U", "label": "U", "color": "#1570ef", "fields": ["Ux", "Uy", "Uz"], "swatch": "u"},
    {"key": "p_rgh", "label": "p_rgh", "color": "#6941c6", "always": True, "swatch": "p"},
    {"key": "h", "label": "h (energy)", "color": "#d92d20", "always": True},
    {"key": "k", "label": "k", "color": "#12b76a", "swatch": "k"},
    {"key": "omega", "label": "ω", "color": "#f79009", "swatch": "w"},
    {"key": "epsilon", "label": "ε", "color": "#0ba5ec", "swatch": "epsilon"},
)
COURANT_SERIES = {
    "key": "co_mean",
    "label": "Co mean",
    "color": "#667085",
    "dashed": True,
    "max_key": "co_max",
    "max_label": "max",
    "swatch": "co",
}
RESIDUAL_KEYS = tuple(s["key"] for s in RESIDUAL_SERIES)


def residual_series(td: str) -> tuple[dict, ...]:
    return (*RESIDUAL_SERIES, COURANT_SERIES) if td == "transient" else RESIDUAL_SERIES


LIVE_METRICS: tuple[dict, ...] = (
    {"key": "delta_t", "label": "Δt", "format": "time"},
    {"key": "co_mean", "label": "Co", "format": "sig2", "max_key": "co_max"},
)


def live_metrics(td: str) -> tuple[dict, ...]:
    return LIVE_METRICS if td == "transient" else ()


LOG_PARSER = LogParserRef("heat_transfer.parser", "HeatParser", str(Path(__file__).resolve().parents[1]))

UI = {"study_settings": "heat_transfer.study", "run_settings": "heat_transfer.run"}

WRITE_RUN_CASE_JOB = "heat_transfer.write_run_case"
# A buoyant iteration costs more than an incompressible one: smaller meshes go parallel.
SERIAL_BELOW_CELLS = {"steady": 50_000, "transient": 20_000}


def algorithm_label(td: str) -> str:
    return "PIMPLE" if td == "transient" else "SIMPLE"


def make_study_defaults(*, key: str):
    def study_defaults(time_dependency: str) -> dict[str, Any]:
        td = "transient" if time_dependency == "transient" else "steady"
        return {
            "analysis_type": key,
            "analysis": FAMILY.study_name,
            "analysis_title": FAMILY.title,
            "category": CATEGORY,
            "time_dependency": "Transient" if td == "transient" else "Steady-state",
            "algorithm": algorithm_label(td),
        }

    return study_defaults


def physics_label(physics: StudyPhysics, density: str) -> str:
    """The run note's physics: "Laminar, Boussinesq, gravity" ("no gravity" when off)."""
    grav = "gravity" if physics.gravity_on else "no gravity"
    return f"{TURBULENCE_SHORT.get(physics.turbulence_model, physics.turbulence_model)}, {DENSITY_SHORT.get(density, density)}, {grav}"


# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------


def boundary_temperatures(records: Any) -> list[tuple[str, float]]:
    """(name, K) of every temperature the BCs set: inlets, inflow at openings, fixed
    wall temperatures and the ambient of a heat transfer coefficient."""
    from incompressible_flow.flow_bcs import boundary_kind

    from .bcs import FIXED_T, HTC, backflow_temperature, inlet_temperature, wall_thermal

    out: list[tuple[str, float]] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        kind = boundary_kind(rec)
        name = str(rec.get("name") or "a boundary")
        if kind in ("inlet", "total_pressure"):
            out.append((name, inlet_temperature(rec)))
        elif kind in ("pressure", "velocity_outlet", "freestream"):
            out.append((name, backflow_temperature(rec)))
        elif kind == "wall":
            w = wall_thermal(rec)
            if w["mode"] == FIXED_T:
                out.append((name, float(w["T"])))
            elif w["mode"] == HTC:
                out.append((name, float(w["Ta"])))
    return out


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
    d = study if isinstance(study, dict) else {}
    td = str(d.get("time_dependency") or "").strip().lower()
    if td:
        return td.startswith("transient")
    return str(d.get("analysis_type") or "").endswith("_transient")


def project_imperial(project_dir: Path | None) -> bool:
    """The project shows imperial units (its project.json ``units``)."""
    try:
        doc = json.loads((Path(project_dir) / "project.json").read_text(encoding="utf-8")) if project_dir else {}
    except (OSError, ValueError):
        return False
    return isinstance(doc, dict) and "imperial" in str(doc.get("units") or "").lower()


def _fmt_t(kelvin: float, imperial: bool = False) -> str:
    """A temperature as the project shows it: °C (metric) or °F (imperial)."""
    if imperial:
        return f"{(kelvin - 273.15) * 9.0 / 5.0 + 32.0:.4g} °F"
    return f"{kelvin - 273.15:.4g} °C"


def material_issue(materials: Any, sim_id: str | None) -> dict[str, Any] | None:
    """What the study's materials lack or hold that this version cannot solve, else None."""
    from .materials import FLUID_MODEL, SOLID_MODEL, fluid_problem, record_bodies, study_materials

    mats = study_materials(list(materials or []), sim_id)
    solids = [m for m in mats if m.get("material_model") == SOLID_MODEL and record_bodies(m)]
    fluids = [m for m in mats if m.get("material_model") == FLUID_MODEL and record_bodies(m)]
    if solids:
        s = solids[0]
        bodies = ", ".join(record_bodies(s)[:3])
        return {
            "message": (
                f"{bodies} has the solid material {s.get('name') or 'Solid'}. Heat Transfer solves fluids only "
                "(buoyant flow): give every body a fluid material."
            ),
            "fix": {"go": "material", "id": s.get("id"), "name": s.get("name")},
        }
    if not fluids:
        return {"message": "Assign a fluid to a volume first", "fix": {"go": "material"}}
    for f in fluids:
        problem = fluid_problem(f)
        if problem:
            return {
                "message": f'Material "{f.get("name") or "Fluid"}": {problem}.',
                "fix": {"go": "material", "id": f.get("id"), "name": f.get("name")},
            }
    if len(fluids) > 1:
        names = ", ".join(str(f.get("name") or "Fluid") for f in fluids[:3])
        return {
            "message": (
                f"This simulation has {len(fluids)} fluids ({names}); it solves one fluid. "
                "Give every body the same fluid material."
            ),
            "fix": {"go": "material", "id": fluids[1].get("id"), "name": fluids[1].get("name")},
        }
    return None


def validate_ready(ctx: ReadyContext) -> list[dict[str, Any]]:
    """What blocks a run: the materials, a patch per BC, each BC's settings, what moves
    the fluid, a pressure level, and the density model against gravity and the temperatures."""
    from incompressible_flow.flow_bcs import (
        boundary_kind,
        first_boundary_problem,
        varies_with_time,
        wall_motion,
    )
    from magnusim_sdk.study import bc_faces, map_bc_to_patch, matches_study

    from .bcs import ADIABATIC, FIXED_T, HEAT_FLUX, HTC, thermal_problem, wall_mode
    from .materials import FLUID_MODEL, fluid_props, record_bodies, study_materials
    from .physics import physics_from_record, physics_problem

    sid = ctx.simulation_id
    imperial = project_imperial(ctx.project_dir)
    issue = material_issue(ctx.materials, sid)
    if issue:
        return [issue]
    setting = physics_problem(ctx.study if isinstance(ctx.study, dict) else None)
    if setting:
        return [{"message": f"Study settings: {setting}.", "fix": {"go": "study"}}]
    fluid_rec = next(
        m for m in study_materials(list(ctx.materials), sid) if m.get("material_model") == FLUID_MODEL and record_bodies(m)
    )
    fluid = fluid_props(fluid_rec)
    physics = physics_from_record(ctx.study if isinstance(ctx.study, dict) else None)
    records = [b for b in ctx.bcs if matches_study(b, sid) and bc_faces(b)]

    patch_names = set(ctx.patches)
    web_bcs = _mesh_web_bcs(ctx.mesh_case_dir)
    for bc in records:
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
    transient = study_is_transient(ctx.study)
    # Incompressible Flow's own checks first, in its Start's order across the records
    # (every inlet's turbulence, then every table, then every wall's motion).
    flow_problem = first_boundary_problem(records, turbulence_model=physics.turbulence_model, transient=transient)
    if flow_problem is not None:
        owner = next(
            (b for b in records if first_boundary_problem([b], turbulence_model=physics.turbulence_model, transient=transient)
             == flow_problem),
            {},
        )
        return [{"message": flow_problem.message, "fix": {"go": "bc", "id": owner.get("id"), "name": owner.get("name")}}]
    for bc in records:
        kind = boundary_kind(bc) or ""
        fix = {"go": "bc", "id": bc.get("id"), "name": bc.get("name")}
        problem = thermal_problem(bc, kind)
        if not problem and transient and kind in ("pressure", "total_pressure") and varies_with_time(bc, transient=True):
            problem = (
                '"Varies with time" is not used on pressure boundaries in heat transfer studies; '
                "turn it off and give the boundary a fixed pressure"
            )
        if problem:
            return [{"message": f'"{bc.get("name")}": {problem}.', "fix": fix}]
        mode = wall_mode(bc)
        if kind == "wall" and wall_motion(bc) == "slip" and mode != ADIABATIC:
            what = {FIXED_T: "a fixed temperature", HEAT_FLUX: "a heat flux", HTC: "a heat transfer coefficient"}[mode]
            return [
                {
                    "message": (
                        f'Wall "{bc.get("name")}" is a slip wall with {what}: a slip wall has no boundary layer, '
                        "so the heat through it would be wrong. Make it a No-slip wall, or set its Thermal to Adiabatic."
                    ),
                    "fix": fix,
                }
            ]

    kinds = [boundary_kind(b) for b in records]
    openings = [k for k in kinds if k in ("inlet", "pressure", "velocity_outlet", "freestream", "total_pressure")]
    pressure_level = [k for k in kinds if k in ("pressure", "freestream", "total_pressure")]
    if openings and not pressure_level:
        return [{"message": "Add a pressure boundary with an assigned face", "fix": {"go": "bc-picker"}}]
    for bc in records:
        if boundary_kind(bc) == "velocity_outlet":
            try:
                zero = float(bc.get("value")) == 0  # type: ignore[arg-type]
            except (TypeError, ValueError):
                zero = False
            if zero:
                return [
                    {
                        "message": (
                            f'Velocity outlet "{bc.get("name")}" lets nothing out (its value is 0). '
                            "Give it an outflow, or make it a Wall."
                        ),
                        "fix": {"go": "bc", "id": bc.get("id"), "name": bc.get("name")},
                    }
                ]

    density = physics.density_for(fluid)
    temps = boundary_temperatures(records)
    if not openings:
        walls = [b for b in records if boundary_kind(b) == "wall"]
        moving = any(wall_motion(b) in ("moving", "rotating") for b in walls)
        if not physics.gravity_on and not moving:
            return [
                {
                    "message": (
                        "Nothing moves the fluid: the domain is closed, gravity is off and no wall moves. "
                        "Turn gravity on (natural convection), make a wall Moving or Rotating, or add an inlet "
                        "and an outlet."
                    ),
                    "fix": {"go": "study"},
                }
            ]
        modes = [wall_mode(b) for b in walls]
        heated = any(m != ADIABATIC for m in modes)
        if not heated:
            return [
                {
                    "message": (
                        "Nothing heats or cools the fluid: every wall is adiabatic. Give a wall a temperature, "
                        "a heat flux or a heat transfer coefficient."
                    ),
                    "fix": {"go": "bc-picker"},
                }
            ]
        if not transient and not any(m in (FIXED_T, HTC) for m in modes):
            return [
                {
                    "message": (
                        "A steady solve of a closed domain needs a wall that can take heat out: here heat only "
                        "comes in or goes out as fixed heat fluxes, so there is no steady temperature. Give a wall a "
                        "fixed temperature or a heat transfer coefficient, add an inlet and an outlet, or solve it "
                        "as a transient study."
                    ),
                    "fix": {"go": "bc-picker"},
                }
            ]
    if density == "constant" and physics.gravity_on:
        return [
            {
                "message": (
                    "Constant density cannot carry buoyancy: with gravity on, use Boussinesq or incompressible "
                    "perfect gas, or turn gravity off for forced convection."
                ),
                "fix": {"go": "study"},
            }
        ]
    if density == "perfect_gas" and not fluid.gas:
        return [
            {
                "message": (
                    f"Incompressible perfect gas is for gases, and {fluid.name} is a liquid "
                    f"({fluid.rho:g} kg/m³). Use Boussinesq."
                ),
                "fix": {"go": "study"},
            }
        ]
    if density == "boussinesq":
        t_ref = physics.reference_temperature
        all_t = [*temps, ("the starting temperature", physics.start_temperature())]
        worst = max(all_t, key=lambda nt: abs(nt[1] - t_ref))
        product = fluid.beta * abs(worst[1] - t_ref)
        if product >= BOUSSINESQ_LIMIT:
            return [
                {
                    "message": (
                        f"Boussinesq holds for small temperature differences: β·ΔT is {product:.2f} "
                        f"({_fmt_t(worst[1], imperial)} at {worst[0]} against the reference {_fmt_t(t_ref, imperial)}), "
                        "and it must stay "
                        f"below {BOUSSINESQ_LIMIT:g}. Use incompressible perfect gas, or bring the temperatures "
                        "closer to the reference."
                    ),
                    "fix": {"go": "study"},
                }
            ]
    if any(not math.isfinite(t) or t <= 0 for _n, t in temps):
        return [{"message": "A boundary temperature is not above absolute zero.", "fix": {"go": "bc-picker"}}]
    return []


# ---------------------------------------------------------------------------
# Run model
# ---------------------------------------------------------------------------


def _steady_defaults() -> dict[str, Any]:
    from .transient import STEADY_DEFAULTS

    return dict(STEADY_DEFAULTS)


def _settle_into(out: dict[str, Any], raw: dict[str, Any], *, transient: bool) -> None:
    if "settle" in raw:
        from .settle import clean_settle

        out["settle"] = clean_settle(raw.get("settle"), transient=transient)


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


def _steady_preview(**kwargs: Any) -> dict[str, Any]:
    return {"ok": True, "partial": False, "control": _steady_normalize(dict(kwargs.get("settings") or {}))}


def _transient_defaults() -> dict[str, Any]:
    from .transient import TRANSIENT_DEFAULTS

    return dict(TRANSIENT_DEFAULTS)


def _transient_normalize(raw: dict[str, Any]) -> dict[str, Any]:
    from .transient import normalize_transient

    out = dict(normalize_transient({k: v for k, v in raw.items() if k != "settle"}))
    _settle_into(out, raw, transient=True)
    return out


def _transient_preview(*, inputs: Any = None, settings: dict[str, Any] | None = None, **_kwargs: Any) -> dict[str, Any]:
    """The numbers a transient run would be written with now (partial without a mesh)."""
    from .runspec import load_spec
    from .transient import control_to_web, resolve_transient

    raw = settings if isinstance(settings, dict) else {}
    if inputs is None:
        return {"ok": True, "partial": True, "reason": None, "control": control_to_web(resolve_transient(raw), raw)}
    spec = load_spec(inputs)
    if not spec.ok or spec.transient is None:
        return {"ok": True, "partial": True, "reason": spec.error, "control": control_to_web(resolve_transient(raw), raw)}
    return {"ok": True, "partial": False, "control": control_to_web(spec.transient, raw), "n_cells": spec.n_cells}


STEADY_RUN_MODEL = RunModel(defaults=_steady_defaults, normalize=_steady_normalize, preview=_steady_preview)
TRANSIENT_RUN_MODEL = RunModel(defaults=_transient_defaults, normalize=_transient_normalize, preview=_transient_preview)
