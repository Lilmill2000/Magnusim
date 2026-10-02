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

TURBULENCE_LABELS = {
    "laminar": "Laminar",
    "kEpsilon": "k-epsilon",
    "kOmegaSST": "k-omega SST",
    "LRR": "LRR",
    "SSG": "SSG",
}


def algorithm_label(time_dependency: str) -> str:
    return "PIMPLE" if time_dependency == "transient" else "SIMPLE"


def make_study_defaults(*, key: str, label: str, category: str, default_turbulence: str):
    """study_defaults(time_dependency) for one of the two analyses.

    The same record Node's W17 defaults carried: analysis key, the Create
    modal's bank name, label, category, turbulence (key and label), time
    dependency and algorithm.
    """

    def study_defaults(time_dependency: str) -> dict[str, Any]:
        td = "transient" if time_dependency == "transient" else "steady"
        turb = str(default_turbulence or "kOmegaSST")
        return {
            "analysis_type": key,
            "analysis": FAMILY.study_name,
            # The family title for both siblings (what every study carried before H8).
            "analysis_title": FAMILY.title,
            "category": category,
            "flow_group": "FLOW",
            "turbulence_model_key": turb,
            "turbulence_model": TURBULENCE_LABELS.get(turb, turb or "k-omega SST"),
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


def validate_ready(ctx: ReadyContext) -> list[dict[str, Any]]:
    """What blocks a run: a fluid, a flow driver, a mesh patch per BC, a pressure difference."""
    from magnusim_sdk.study import (
        bc_faces,
        is_pressure_bc,
        is_velocity_inlet,
        map_bc_to_patch,
        matches_study,
    )

    from .runspec import air_from_materials

    sid = ctx.simulation_id
    air = air_from_materials({"materials": list(ctx.materials)}, sid)
    records = [b for b in ctx.bcs if matches_study(b, sid)]
    inlets = [b for b in records if is_velocity_inlet(b) and bc_faces(b)]
    pressures = [b for b in records if is_pressure_bc(b) and bc_faces(b)]

    if not air or not air.get("assigned"):
        return [{"message": "Assign a fluid to a volume first", "fix": {"go": "material"}}]
    if not inlets and len(pressures) < 2:
        incomplete = next((b for b in records if not bc_faces(b)), None)
        return [
            {
                "message": "Add a velocity inlet, or two pressure boundaries, each with an assigned face",
                "fix": (
                    {"go": "bc", "id": incomplete.get("id"), "name": incomplete.get("name")}
                    if incomplete
                    else {"go": "bc-picker"}
                ),
            }
        ]
    if not pressures:
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
    if not inlets and len(pressures) >= 2:
        vals = [_pressure_pa(b) for b in pressures]
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

    return {
        "end_time": _int(raw.get("end_time"), int(d["end_time"])),
        "write_interval": _int(raw.get("write_interval"), int(d["write_interval"])),
    }


def _steady_preview(**kwargs: Any) -> dict[str, Any]:
    return {"ok": True, "partial": False, "control": _steady_normalize(dict(kwargs.get("settings") or {}))}


def _transient_defaults() -> dict[str, Any]:
    from .transient import TRANSIENT_DEFAULTS

    return dict(TRANSIENT_DEFAULTS)


def _transient_normalize(raw: dict[str, Any]) -> dict[str, Any]:
    from .transient import normalize_transient

    return dict(normalize_transient(raw))


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
    from magnusim_sdk.study import is_pressure_bc, is_velocity_inlet

    from .runspec import load_run_spec
    from .transient import control_to_web, resolve_transient_control

    raw = settings if isinstance(settings, dict) else {}
    if inputs is None:
        return {"ok": True, "partial": True, "reason": None, "control": control_to_web(resolve_transient_control(raw, {}), raw)}
    spec = load_run_spec(inputs)
    bcs = [m.get("bc") for m in (spec.mapped or [])]
    driven = any(is_velocity_inlet(b) for b in bcs) or sum(1 for b in bcs if is_pressure_bc(b)) >= 2
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
