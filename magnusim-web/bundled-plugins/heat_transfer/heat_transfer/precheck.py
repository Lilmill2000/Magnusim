"""The pre-run check of a Heat Transfer run (run health, RH2; contract API 1.9
``RunModel.check``): the rules of :mod:`magnusim_sdk.runcheck` that apply to it.

- transient: the Courant rows (with no velocity limit: Heat Transfer writes none), the
  pressure correctors, the outer correctors at a low Courant number;
- the mesh's quality (checkMesh), its non-orthogonal cells against the study's
  non-orthogonal correctors, and a short steady run on a large mesh;
- a steady run's relaxation (buoyant SIMPLE) and, on a skewed mesh, the robust numerics
  preset as the alternative.

Heat Transfer passes no flow speed yet, so its runs get no time-step estimate, and its own
rules (Boussinesq validity, a Rayleigh-number laminar/turbulent check) are not made here.
"""

from __future__ import annotations

from typing import Any

NO_ESTIMATE = "No time-step estimate for Heat Transfer runs yet"
# What a check before the mesh leaves out ("Only its run settings were checked: ...").
UNCHECKED = "its mesh and physics are checked once the mesh is generated"


def check_inputs(spec: Any, settings: dict[str, Any] | None, context: dict[str, Any] | None, *, transient: bool) -> dict[str, Any]:
    """What :func:`magnusim_sdk.runcheck.check` reads of this run (``spec`` None: settings only)."""
    from .transient import normalize_transient

    ctx = context if isinstance(context, dict) else {}
    raw = settings if isinstance(settings, dict) else {}
    out: dict[str, Any] = {
        "time_dependency": "transient" if transient else "steady",
        "settings": normalize_transient(raw) if transient else {"end_time": raw.get("end_time"), "write_interval": raw.get("write_interval")},
        "mesh": ctx.get("mesh"),
        "mesh_ready": bool(ctx.get("mesh_ready")),
        "rates": None,
        "n_cells": ctx.get("n_cells"),
        "ranks": ctx.get("ranks"),
        "s_per_cell_step": ctx.get("s_per_cell_step"),
        "rate_source": ctx.get("rate_source"),
        "kept": ctx.get("kept") or [],
        "no_estimate": NO_ESTIMATE,
    }
    if spec is None or not getattr(spec, "ok", False):
        # Only the run's settings could be read (the spec needs a generated mesh): its mesh
        # and physics are not checked.
        out["inputs_complete"] = False
        out["unchecked"] = UNCHECKED
        return out
    ph = spec.physics
    # The study's own non-orthogonal correctors (Heat Transfer's runs have none of their own);
    # a steady run's buoyant SIMPLE relaxation and numerics preset too (steady_relax, and the
    # robust preset as mesh_skew's alternative), under the same study keys Incompressible Flow uses.
    numerics: dict[str, Any] = {"n_non_orthogonal": ph.n_non_orthogonal}
    if not transient:
        numerics.update({"relax_p": ph.relax_p, "relax_u": ph.relax_u, "simplec": False, "numerics_preset": ph.numerics})
    out.update(
        {
            "n_cells": spec.n_cells or out["n_cells"],
            "turbulence": _turbulence(ph.turbulence_model),
            "numerics": numerics,
            "steady_algorithm": "SIMPLE",
        }
    )
    return out


# The fields each of Heat Transfer's models can drive below zero.
_FIELDS = {"kOmegaSST": "k and omega", "kEpsilon": "k and epsilon", "realizableKE": "k and epsilon"}


def _turbulence(model: str) -> dict[str, Any]:
    """The study's turbulence model as the check reads it (the core names no model), with no
    wall-function rule: its walls also carry heat, and their y+ is not judged here."""
    from .physics import TURBULENCE_SHORT

    return {
        "laminar": model == "laminar",
        "label": TURBULENCE_SHORT.get(model, model),
        "fields": _FIELDS.get(model, ""),
        "wall_functions": False,
        "any_yplus": {"label": TURBULENCE_SHORT["kOmegaSST"], "key": "turbulence_model", "value": "kOmegaSST"},
    }


def run_check(*, transient: bool, inputs: Any = None, settings: dict[str, Any] | None = None, context: dict[str, Any] | None = None, spec: Any = None) -> dict[str, Any]:
    """``RunModel.check``: ``{"checks": [...], "estimate": {...}}`` (magnusim_sdk.runcheck)."""
    from magnusim_sdk.runcheck import check

    raw = settings if isinstance(settings, dict) else {}
    if spec is None and inputs is not None:
        from .runspec import load_spec

        spec = load_spec(inputs)
    return check(check_inputs(spec, raw, context, transient=transient))
