"""What a run's case is written with (run health, RH3): the Run panel's "Numerics as written"
(``[data-run-numerics]``) and the Assistant's ``read_setup {what:'numerics'}``, built from the
same values the writer uses (incompressible_flow.writer), and the stored values outside their
field's range the pre-run check lists (``setting_out_of_range``).
"""

from __future__ import annotations

from typing import Any

from magnusim_sdk.numerics_settings import (
    RUN_KEYS,
    bounds_of,
    foam_number,
    limit_value,
    out_of_range,
    row,
    scheme_choices,
    solver_value,
    velocity_cap,
    with_preset_name,
)

from .physics import StudyPhysics, solved_turbulence_fields

SCHEMES = "Schemes"
SOLVERS = "Linear solvers"
RELAXATION = "Relaxation"
PIMPLE = "PIMPLE"
LIMITERS = "Limiters"
FIXED = "Stays fixed"


def _eq_names(model: str) -> str:
    return ", ".join(("U", *solved_turbulence_fields(model)))


def _limiter_words(model: str, s: dict[str, str]) -> str:
    """Where the study's gradient limiter is written (writer._scheme_strings): on the gradient
    linearUpwind reads (limitedGradU) and on the turbulence fields' gradients."""
    from .writer import CONVECTION_GRAD, VELOCITY_GRAD

    parts: list[str] = []
    if s["convection_grad"]:
        parts.append(f"{CONVECTION_GRAD} {s['convection_grad']}")
    elif "linearUpwind grad(U)" in s["momentum"]:
        parts.append(f"linearUpwind reads grad(U) ({VELOCITY_GRAD}, unlimited)")
    turb = [f"grad({f})" for f in solved_turbulence_fields(model) if f != "R"]
    if turb:
        parts.append(f"{', '.join(turb)} {s['grad']}")
    return "; ".join(parts) or f"{s['grad']} (no scheme reads a limited gradient)"


def numerics_rows(
    physics: StudyPhysics,
    *,
    transient: Any = None,
    speed: float | None = None,
    inlet: str = "",
) -> list[dict[str, str]]:
    """The rows of "Numerics as written": ``transient`` the run's TransientControl (None for a
    steady run), ``speed`` the reference speed the velocity limit is made from (None before the
    mesh is generated), ``inlet`` the inlet it comes from."""
    from magnusim_sdk.numerics_advice import LIMIT_FACTOR, LIMIT_FLOOR

    from .writer import (
        FLUX_INTERPOLATION_ENTRY,
        OUTER_RELAX_EQ,
        OUTER_RELAX_P,
        VELOCITY_GRAD,
        linear_solvers,
        solve_relax_turbulence,
        steady_schemes,
        transient_schemes,
        wall_treatment_words,
    )

    ns = physics.numerics_settings
    model = physics.turbulence_model
    steady = transient is None
    preset = physics.numerics if steady else None
    ch = scheme_choices(ns, preset=preset)
    # The writer's own strings (what fvSchemes holds).
    s = steady_schemes(physics) if steady else transient_schemes(ns)
    rows: list[dict[str, str]] = []
    src = lambda key: ch[key][1]  # noqa: E731
    rows.append(row(SCHEMES, "Gradient limiter", _limiter_words(model, s), src("grad_limiter")))
    rows.append(row(SCHEMES, "Momentum convection", s["momentum"], src("momentum_convection")))
    if solved_turbulence_fields(model):
        rows.append(row(SCHEMES, "Turbulence convection", s["turb_div"], src("turbulence_convection")))
    rows.append(row(SCHEMES, "Non-orthogonal correction", f"{s['laplacian']} (snGrad {s['sn_grad']})", src("non_orth_correction")))
    ls = linear_solvers(ns)
    rows.append(row(SOLVERS, "p", solver_value("GAMG", ls["p"]["tol"], ls["p"]["rel_tol"], ls["p"]["max_iter"]), "study" if (ns.p_tolerance or ns.p_rel_tol is not None or ns.p_max_iter) else "default"))
    rows.append(row(SOLVERS, _eq_names(model), solver_value("smoothSolver", ls["eq"]["tol"], ls["eq"]["rel_tol"], ls["eq"]["max_iter"]), "study" if (ns.eq_tolerance or ns.eq_rel_tol is not None or ns.eq_max_iter) else "default"))
    if steady:
        simplec = " (SIMPLEC's own)" if physics.simplec else ""
        rows.append(row(RELAXATION, "p", foam_number(physics.solve_relax_p()) + simplec))
        rows.append(row(RELAXATION, "U", foam_number(physics.solve_relax_u()) + simplec))
        if solved_turbulence_fields(model):
            own = ns.relax_turbulence is not None and not physics.simplec
            rows.append(row(RELAXATION, "Turbulence", foam_number(solve_relax_turbulence(physics)) + ("" if own else " (as U)"), "study" if own else ""))
    else:
        n_outer = max(1, int(round(transient.n_outer_correctors)))
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
            rows.append(
                row(
                    PIMPLE,
                    "Outer relaxation",
                    f"p {foam_number(rp or OUTER_RELAX_P)}, equations {foam_number(re_ or OUTER_RELAX_EQ)}; the final outer loop 1",
                    "run" if (rp or re_) else "default",
                )
            )
            rows.append(row(PIMPLE, "Outer tolerance", f"{foam_number(tol)} (p and the equations, relTol 0)" if tol else "Off: every outer corrector runs", "run" if tol else "default"))
    cap = velocity_cap(ns, speed or 0.0, default="auto", factor=LIMIT_FACTOR, floor=LIMIT_FLOOR)
    rows.append(row(LIMITERS, "Velocity limit", limit_value(cap, speed=speed, factor=LIMIT_FACTOR, floor=LIMIT_FLOOR, inlet=inlet), "study" if ns.velocity_limit else "default"))
    reads = "the viscous terms and turbulence production" if solved_turbulence_fields(model) else "the viscous terms"
    rows.append(row(FIXED, "Velocity gradient", f"grad(U) {VELOCITY_GRAD}, never limited ({reads})", "fixed"))
    rows.append(row(FIXED, "Flux interpolation", f"{FLUX_INTERPOLATION_ENTRY}; the rest linear", "fixed"))
    walls = wall_treatment_words(model)
    if walls:
        rows.append(row(FIXED, "Wall treatment", walls, "fixed"))
    rows.append(row(FIXED, "Solver types", "GAMG for p, smoothSolver (symGaussSeidel) for " + _eq_names(model), "fixed"))
    rows.append(row(FIXED, "nCellsInCoarsestLevel", "20", "fixed"))
    if not steady:
        rows.append(row(FIXED, "Final loop relTol", "0", "fixed"))
        rows.append(row(FIXED, "momentumPredictor", "yes", "fixed"))
        rows.append(row(FIXED, "turbOnFinalIterOnly", "yes", "fixed"))
        rows.append(row(FIXED, "consistent", "no", "fixed"))
    return with_preset_name(rows, preset)


def stored_out_of_range(study: dict[str, Any] | None, settings: dict[str, Any] | None, *, transient: bool) -> list[dict[str, Any]]:
    """The study's numerics and the run's RH3 keys stored outside their field's range, which the
    case is written with as saved (``setting_out_of_range``)."""
    from .analyses import _control_schema, _numerics_schema

    rows = out_of_range(bounds_of(_numerics_schema(transient=transient)), study if isinstance(study, dict) else {})
    if transient:
        run = [f for f in bounds_of(_control_schema(transient=True)) if f["key"] in RUN_KEYS]
        rows += out_of_range(run, settings if isinstance(settings, dict) else {})
    return rows
