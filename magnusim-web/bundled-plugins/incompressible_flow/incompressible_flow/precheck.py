"""The pre-run check of an Incompressible Flow run (run health, RH2; contract API 1.9
``RunModel.check``): the run's inputs as :mod:`magnusim_sdk.runcheck` reads them, from
the same RunSpec its case is written with.

- the reference speed, the main inlet's direction and name (the speed the turbulence
  inlet values and the velocity limit use);
- the velocity limit the case is written with (``max(50, 10 × the reference speed)``, or
  the study's own, RH3);
- the study's numerics and the run's RH3 keys stored outside their field's range, which the
  case is written with as saved (``setting_out_of_range``);
- the study's physics (turbulence model, starting flow, potential flow, numerics) and
  whether a boundary condition varies with time or moves;
- the Δt a fixed time step is written with when it is left blank.

The core passes the mesh's facts and Courant-rate table, the ranks, this PC's solve rate
and the codes kept as set (``context``, cfddesk.project.run_check).
"""

from __future__ import annotations

from typing import Any

# The models whose wall functions assume y+ above about 30 (k-epsilon and the Reynolds-stress
# models, which start from it); k-omega SST handles any y+.
WALL_FUNCTION_MODELS = frozenset({"kEpsilon", "realizableKE", "LRR", "SSG"})
ANY_YPLUS_MODEL = "kOmegaSST"
# The estimate line before the run's mesh is generated (its spec needs the mesh).
NO_MESH_ESTIMATE = "No time-step estimate until the mesh is generated"
# What a check before the mesh leaves out ("Only its run settings were checked: ...").
UNCHECKED = "its mesh and physics are checked once the mesh is generated"


def turbulence_words(model: str) -> dict[str, Any]:
    """The study's turbulence model as the pre-run check reads it (the core names no model):
    whether it is laminar, its name, the fields it can drive below zero, whether it relies on
    wall functions, and the study setting of the model that handles any y+."""
    from .physics import TURBULENCE_SHORT_LABELS, turbulence_fields

    fields = [f for f in turbulence_fields(model) if f not in ("nut", "R")]
    return {
        "laminar": model == "laminar",
        "label": TURBULENCE_SHORT_LABELS.get(model, model),
        "fields": " and ".join(fields),
        "wall_functions": model in WALL_FUNCTION_MODELS,
        "any_yplus": {"label": TURBULENCE_SHORT_LABELS[ANY_YPLUS_MODEL], "key": "turbulence_model", "value": ANY_YPLUS_MODEL},
    }


def _transient_settings(spec: Any, raw: dict[str, Any] | None) -> dict[str, Any]:
    from .transient import normalize_transient

    t = normalize_transient(raw if isinstance(raw, dict) else {})
    tc = getattr(spec, "transient", None) if spec is not None else None
    out = dict(t)
    if tc is not None:
        out["end_time"] = float(tc.end_time)
        out["write_count"] = int(tc.write_count)
    return out


def check_inputs(spec: Any, settings: dict[str, Any] | None, context: dict[str, Any] | None, *, transient: bool, inputs: Any = None) -> dict[str, Any]:
    """What :func:`magnusim_sdk.runcheck.check` reads of this run (``spec`` None: settings only)."""
    ctx = context if isinstance(context, dict) else {}
    raw = settings if isinstance(settings, dict) else {}
    out: dict[str, Any] = {
        "time_dependency": "transient" if transient else "steady",
        "settings": _transient_settings(spec, raw) if transient else {"end_time": raw.get("end_time"), "write_interval": raw.get("write_interval")},
        "mesh": ctx.get("mesh"),
        "mesh_ready": bool(ctx.get("mesh_ready")),
        "rates": ctx.get("rates"),
        "n_cells": ctx.get("n_cells"),
        "ranks": ctx.get("ranks"),
        "s_per_cell_step": ctx.get("s_per_cell_step"),
        "rate_source": ctx.get("rate_source"),
        "kept": ctx.get("kept") or [],
        "steady_copy": bool(transient),
    }
    from .numerics_written import stored_out_of_range

    study = getattr(inputs, "study", None) if inputs is not None else None
    out["out_of_range"] = stored_out_of_range(study, raw, transient=transient)
    if spec is None or not getattr(spec, "ok", False):
        # Only the run's settings could be read (the spec needs a generated mesh): the mesh,
        # the inlets and the physics are not checked, and the line says why there is no step.
        out["inputs_complete"] = False
        out["unchecked"] = UNCHECKED
        if transient:
            out["no_estimate"] = NO_MESH_ESTIMATE
        return out
    from magnusim_sdk.study import bc_faces, is_velocity_inlet

    from .bc_kinds import wall_kind
    from .reference import inlet_flow_direction
    from .time_table import in_effect
    from .writer import _bc_dict, faces_area, fixed_inflow, inlet_ref_speed, resolve_speed_and_dhyd

    speed, d_hyd = resolve_speed_and_dhyd(spec)
    rho = float(getattr(spec, "rho", 0) or 0) or 1.2
    props = getattr(spec, "face_props", None) or {}
    inlets = [m.get("bc") for m in spec.mapped or [] if is_velocity_inlet(m.get("bc"))]
    name = ""
    best = -1.0
    for raw_bc in inlets:
        bc = _bc_dict(raw_bc)
        faces = bc_faces(bc)
        s = inlet_ref_speed(bc, faces_area(faces, props) / max(1, len(faces)), rho)
        if s > best:
            best, name = s, str(bc.get("name") or "")
    physics = spec.physics
    out.update(
        {
            "n_cells": spec.n_cells or out["n_cells"],
            "speed": float(speed) if inlets or speed > 1.0 else None,
            "direction": list(inlet_flow_direction(spec) or (1.0, 0.0, 0.0)),
            "inlet": name,
            # The velocity limit the case is written with (writer: limitVelocity; RH3: None when
            # the study turned it off), transient only.
            "velocity_cap": _cap(physics, speed) if transient else None,
            "fixed_inflow": fixed_inflow(spec),
            "time_varying": any(in_effect(_bc_dict(m.get("bc")), transient) for m in spec.mapped or [] if m.get("bc")),
            "moving": any(wall_kind(m.get("bc")) in ("Moving", "Rotating") for m in spec.mapped or [] if m.get("bc")),
            "turbulence": turbulence_words(physics.turbulence_model),
            "steady_algorithm": "SIMPLEC" if physics.simplec else "SIMPLE",
            "nu": float(spec.nu),
            "d_hyd": float(d_hyd) if inlets and d_hyd else None,
            "initial_flow": physics.initial_flow,
            "potential_flow": bool(physics.potential_flow),
            "inlet_driven": bool(inlets),
            "numerics": (
                {}
                if transient
                else {
                    "relax_p": physics.relax_p,
                    "relax_u": physics.relax_u,
                    "simplec": physics.simplec,
                    "n_non_orthogonal": physics.n_non_orthogonal,
                    "numerics_preset": physics.numerics,
                }
            ),
        }
    )
    tc = getattr(spec, "transient", None)
    if transient and tc is not None and not tc.adjust_time_step:
        # A blank fixed step is written with the case's own estimate.
        out["delta_t_written"] = float(tc.delta_t)
    return out


def _cap(physics: Any, speed: float) -> float | None:
    """The velocity limit the case is written with (writer.velocity_cap), None when off."""
    from magnusim_sdk.numerics_advice import LIMIT_FACTOR, LIMIT_FLOOR
    from magnusim_sdk.numerics_settings import velocity_cap

    return velocity_cap(physics.numerics_settings, float(speed), default="auto", factor=LIMIT_FACTOR, floor=LIMIT_FLOOR)["cap"]


def numerics(spec: Any, inputs: Any, settings: dict[str, Any], *, transient: bool) -> list[dict[str, str]]:
    """RH3: "Numerics as written" of this run, from the spec its case is written with (before
    the mesh is generated: the study's record and the run's settings)."""
    from .numerics_written import numerics_rows

    if spec is not None and getattr(spec, "ok", False):
        from .writer import resolve_speed_and_dhyd

        speed, _ = resolve_speed_and_dhyd(spec)
        if spec.speed_for_k and spec.speed_for_k != 1.0:
            speed = float(spec.speed_for_k)
        words = check_inputs(spec, settings, {}, transient=transient)
        return numerics_rows(spec.physics, transient=spec.transient, speed=float(speed), inlet=str(words.get("inlet") or ""))
    from .physics import physics_from_record
    from .transient import resolve_transient_control

    physics = physics_from_record(getattr(inputs, "study", None) if inputs is not None else None)
    ctrl = resolve_transient_control(settings, {}) if transient else None
    return numerics_rows(physics, transient=ctrl, speed=None)


def run_check(*, transient: bool, inputs: Any = None, settings: dict[str, Any] | None = None, context: dict[str, Any] | None = None, spec: Any = None) -> dict[str, Any]:
    """``RunModel.check``: ``{"checks": [...], "estimate": {...}, "numerics": [...]}``
    (magnusim_sdk.runcheck; RH3: "Numerics as written")."""
    from magnusim_sdk.runcheck import check

    raw = settings if isinstance(settings, dict) else {}
    if spec is None and inputs is not None:
        from .runspec import load_run_spec

        spec = load_run_spec(inputs)
    out = check(check_inputs(spec, raw, context, transient=transient, inputs=inputs))
    try:
        out["numerics"] = numerics(spec, inputs, raw, transient=transient)
    except (AttributeError, TypeError, ValueError) as exc:
        # "Numerics as written" is left out (and says why); the check's rows stand.
        out["numerics"] = []
        out["numerics_error"] = f"{type(exc).__name__}: {exc}"[:200]
    return out
