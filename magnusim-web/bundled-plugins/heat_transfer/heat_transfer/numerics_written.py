"""What a Heat Transfer run's case is written with (run health, RH3): the Run panel's "Numerics
as written" (``[data-run-numerics]``) and the Assistant's ``read_setup {what:'numerics'}``, built
from the same values the writer uses (heat_transfer.writer), and the stored values outside their
field's range the pre-run check lists (``setting_out_of_range``).
"""

from __future__ import annotations

from typing import Any

from magnusim_sdk.numerics_settings import (
    RUN_KEYS,
    bounded,
    bounds_of,
    foam_number,
    limit_value,
    out_of_range,
    row,
    scheme_choices,
    solver_value,
    velocity_cap,
)

from .physics import StudyPhysics, solved_turbulence_fields

SCHEMES = "Schemes"
SOLVERS = "Linear solvers"
RELAXATION = "Relaxation"
PIMPLE = "PIMPLE"
LIMITERS = "Limiters"
FIXED = "Stays fixed"
# Heat Transfer's reference speed (the fastest inlet's) is read when the case is written.
SPEED_UNKNOWN = "the speed is the fastest inlet's, read when the case is written"


def _eq_names(model: str) -> str:
    return ", ".join(("U", "h", *solved_turbulence_fields(model)))


def numerics_rows(physics: StudyPhysics, *, transient: Any = None, cht: bool = False) -> list[dict[str, str]]:
    """The rows of "Numerics as written": ``transient`` the run's TransientControl (None for a
    steady run), ``cht`` a conjugate heat transfer case (its solids' solver stays fixed)."""
    from magnusim_sdk.numerics_advice import LIMIT_FACTOR, LIMIT_FLOOR

    from .writer import OPENFOAM_MAX_ITER, linear_solvers, schemes

    ns = physics.numerics_settings
    model = physics.turbulence_model
    steady = transient is None
    preset = physics.numerics if physics.numerics in ("robust", "accurate") else "robust"
    ch = scheme_choices(ns, preset=preset)
    s = schemes(physics.numerics, ns)
    src = lambda key: ch[key][1]  # noqa: E731
    rows: list[dict[str, str]] = [
        row(SCHEMES, "Gradient limiter", s["grad"], src("grad_limiter")),
        row(SCHEMES, "Momentum convection", bounded(s["momentum"], steady), src("momentum_convection")),
    ]
    if solved_turbulence_fields(model):
        rows.append(row(SCHEMES, "Turbulence convection", bounded(s["turb"], steady), src("turbulence_convection")))
    rows.append(row(SCHEMES, "Energy convection", bounded(s["energy"], steady), src("energy_convection")))
    rows.append(row(SCHEMES, "Non-orthogonal correction", f"{s['laplacian']} (snGrad {s['sn_grad']})", src("non_orth_correction")))
    ls = linear_solvers(ns)
    rows.append(row(SOLVERS, "p_rgh", solver_value("GAMG", ls["p"]["tol"], ls["p"]["rel_tol"], ls["p"]["max_iter"]), "study" if (ns.p_tolerance or ns.p_rel_tol is not None or ns.p_max_iter) else "default"))
    rows.append(
        row(
            SOLVERS,
            _eq_names(model),
            solver_value("PBiCGStab", ls["eq"]["tol"], ls["eq"]["rel_tol"], ls["eq"]["max_iter"], default_max=f"maxIter OpenFOAM's {OPENFOAM_MAX_ITER}"),
            "study" if (ns.eq_tolerance or ns.eq_rel_tol is not None or ns.eq_max_iter) else "default",
        )
    )
    if steady:
        rows.append(row(RELAXATION, "p_rgh", foam_number(physics.relax_p)))
        rows.append(row(RELAXATION, "U", foam_number(physics.relax_u)))
        rows.append(row(RELAXATION, "h", foam_number(physics.relax_h)))
        if solved_turbulence_fields(model):
            own = ns.relax_turbulence
            turb = own if own is not None else physics.relax_u
            rows.append(row(RELAXATION, "Turbulence", foam_number(turb) + ("" if own is not None else " (as U)"), "study" if own is not None else ""))
    else:
        n_outer = max(1, int(transient.n_outer_correctors))
        adjust = bool(getattr(transient, "adjust_time_step", True))
        rows.append(row(PIMPLE, "Max Courant", foam_number(transient.max_co) if adjust else "Not used: a fixed time step", "run"))
        rows.append(row(PIMPLE, "Outer correctors", f"{n_outer} ({'PISO' if n_outer <= 1 else 'PIMPLE'})", "run"))
        rp = getattr(transient, "outer_relax_p", None)
        re_ = getattr(transient, "outer_relax_eq", None)
        tol = getattr(transient, "outer_tolerance", None)
        if n_outer <= 1:
            rows.append(row(PIMPLE, "Outer relaxation", "None: with 1 outer corrector every equation is solved unrelaxed (1)", "default"))
            rows.append(row(PIMPLE, "Outer tolerance", "Not used with 1 outer corrector", "default"))
        else:
            relaxed = rp or re_
            rows.append(
                row(
                    PIMPLE,
                    "Outer relaxation",
                    f"p_rgh {foam_number(rp or 1)}, equations {foam_number(re_ or 1)}; the final outer loop 1" if relaxed else "None (1)",
                    "run" if relaxed else "default",
                )
            )
            rows.append(row(PIMPLE, "Outer tolerance", f"{foam_number(tol)} (p_rgh and the equations, relTol 0)" if tol else "Off: every outer corrector runs", "run" if tol else "default"))
    cap = velocity_cap(ns, 0.0, default="off", factor=LIMIT_FACTOR, floor=LIMIT_FLOOR)
    rows.append(row(LIMITERS, "Velocity limit", limit_value(cap, speed=None, factor=LIMIT_FACTOR, floor=LIMIT_FLOOR, unknown=SPEED_UNKNOWN), "study" if ns.velocity_limit else "default"))
    rows.append(row(FIXED, "Solver types", f"GAMG for p_rgh, PBiCGStab (DILU) for {_eq_names(model)}", "fixed"))
    rows.append(row(FIXED, "grad(h)", "Gauss linear", "fixed"))
    rows.append(row(FIXED, "div(phi,K)", bounded(s["K"], steady) + " (the preset's)", "fixed"))
    rows.append(row(FIXED, "momentumPredictor", "yes", "fixed"))
    if not steady:
        rows.append(row(FIXED, "p_rghFinal", "tolerance 1e-6, relTol 0", "fixed"))
        rows.append(row(FIXED, "Final loop relTol", "0", "fixed"))
    if cht:
        rows.append(row(FIXED, "Solid regions' h solver", "PCG (DIC), tolerance 1e-8, relTol 0.01", "fixed"))
    return rows


def stored_out_of_range(study: dict[str, Any] | None, settings: dict[str, Any] | None, *, transient: bool) -> list[dict[str, Any]]:
    """The study's numerics and the run's RH3 keys stored outside their field's range, which the
    case is written with as saved (``setting_out_of_range``)."""
    from .analyses import control_schema, numerics_schema

    rows = out_of_range(bounds_of(numerics_schema(transient=transient)), study if isinstance(study, dict) else {})
    if transient:
        run = [f for f in bounds_of(control_schema(transient=True)) if f["key"] in RUN_KEYS]
        rows += out_of_range(run, settings if isinstance(settings, dict) else {})
    return rows
