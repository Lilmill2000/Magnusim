"""Incompressible Flow's side of the analysis contract (API 1.1).

What the core used to decide itself, answered by the analysis: the Create modal
text, a new study's defaults, what blocks a run, the run settings model and its
preview, and the solver-output parser. H9 moves this module (with the rest of
Incompressible Flow) into ``bundled-plugins/incompressible_flow``.

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

# The residual series the run panel plots (U = max of Ux/Uy/Uz, R = max of the
# Reynolds-stress components; see scripts/w27-solve.js compactResidual).
RESIDUAL_KEYS = ("U", "p", "k", "omega", "epsilon", "R")

LOG_PARSER = LogParserRef("cfddesk.wsl.solve_run", "ProgressParser")

UI = {"study_panel": "SimulationPanel", "run_panel": "RunControl"}

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
    unit = str(bc.get("unit") or "Pa").lower()
    if unit in ("pa", ""):
        return v
    factors = {"kpa": 1e3, "bar": 1e5, "psi": 6894.757, "inh2o": 249.089, "in h2o": 249.089, "inwc": 249.089, "mmh2o": 9.80665}
    return v * factors.get(unit, 1.0)


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
    from cfddesk.project.paths import assemble_study_bcs, assemble_study_materials
    from cfddesk.project.web_adapter import (
        air_from_materials,
        bc_faces,
        is_pressure_bc,
        is_velocity_inlet,
        map_bc_to_patch,
        matches_study,
    )

    sid = ctx.simulation_id
    air = air_from_materials({"materials": assemble_study_materials(ctx.project_dir, sid)}, sid)
    records = [b for b in assemble_study_bcs(ctx.project_dir, sid) if matches_study(b, sid)]
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
    from cfddesk.project.transient import STEADY_DEFAULTS

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
    from cfddesk.project.transient import TRANSIENT_DEFAULTS

    return dict(TRANSIENT_DEFAULTS)


def _transient_normalize(raw: dict[str, Any]) -> dict[str, Any]:
    from cfddesk.project.transient import normalize_transient

    return dict(normalize_transient(raw))


def transient_preview(
    *,
    project_dir: str | Path,
    run_id: str = "",
    simulation_id: str = "",
    mesh_id: str = "",
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The numbers a transient run would be written with right now.

    The same call prepare_run makes (load_run_spec → resolve_transient_control
    with the run's mesh metadata and reference speed), so the Run panel shows
    the Δt that lands in controlDict. Partial (settings only) until the run has
    a mesh and a flow-driving boundary condition.
    """
    from cfddesk.project import web_adapter
    from cfddesk.project.transient import control_to_web, resolve_transient_control

    raw = settings if isinstance(settings, dict) else {}
    spec = web_adapter.load_run_spec(
        Path(project_dir),
        run_id=run_id or "preview",
        mesh_id=mesh_id or None,
        simulation_id=simulation_id or None,
        require_mesh=True,
        transient_override=raw,
        time_dependency="transient",
    )
    bcs = [m.get("bc") for m in (spec.mapped or [])]
    driven = any(web_adapter.is_velocity_inlet(b) for b in bcs) or sum(
        1 for b in bcs if web_adapter.is_pressure_bc(b)
    ) >= 2
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
