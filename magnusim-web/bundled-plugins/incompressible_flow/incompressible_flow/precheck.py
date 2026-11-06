"""The pre-run check of an Incompressible Flow run (run health, RH2; contract API 1.9
``RunModel.check``): the run's inputs as :mod:`magnusim_sdk.runcheck` reads them, from
the same RunSpec its case is written with.

- the reference speed, the main inlet's direction and name (the speed the turbulence
  inlet values and the velocity limit use; a freestream's own when it sets it, even at 1 m/s
  or below);
- the length Re is taken on: the largest inlet's hydraulic diameter (on a mesh one cell across,
  a 2D channel's: twice the inlet's height in the plane, not the depth's circle), else the
  study's reference length when a freestream sets the speed (a body in a stream);
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
    from .runspec import closed_domain
    from .time_table import in_effect
    from .writer import (
        _bc_dict,
        faces_area,
        fixed_inflow,
        inlet_ref_speed,
        reference_speed,
        wall_drive,
    )

    speed, d_hyd, source = reference_speed(spec)
    # A moving or rotating wall that sets the speed: the length Re is taken on runs along the way
    # a moving wall slides (a lid-driven cavity's Re on the box's length along the lid).
    walls = wall_drive(spec) if source == "wall" else []
    wall_dir = walls[0]["direction"] if walls else None
    rho = float(getattr(spec, "rho", 0) or 0) or 1.2
    props = getattr(spec, "face_props", None) or {}
    inlets = [m.get("bc") for m in spec.mapped or [] if is_velocity_inlet(m.get("bc"))]
    name = ""
    best = -1.0
    inlet_area = 0.0
    for raw_bc in inlets:
        bc = _bc_dict(raw_bc)
        faces = bc_faces(bc)
        area = faces_area(faces, props)
        s = inlet_ref_speed(bc, area / max(1, len(faces)), rho)
        if s > best:
            best, name = s, str(bc.get("name") or "")
        inlet_area = max(inlet_area, area)
    physics = spec.physics
    # A mesh one cell across is a 2D slice of an arbitrary depth: an inlet's hydraulic diameter
    # is a 2D channel's, twice its height in the plane (Re_D of a channel), not the circle of its
    # area (which grows with the depth: a 2D step read "Re ≈ 55" at Re_D 100).
    depth = _one_cell_depth(ctx.get("mesh"))
    re_d = 2.0 * inlet_area / depth if inlets and depth and inlet_area > 0 else (float(d_hyd) if inlets and d_hyd else None)
    # A body in a stream: Re on the length the study measures its forces against, when it set one.
    ref_length = None
    if not inlets and source == "freestream":
        from .reference import resolve_reference

        ref_length = resolve_reference(spec).length
    out.update(
        {
            "n_cells": spec.n_cells or out["n_cells"],
            "speed": float(speed) if inlets or speed > 1.0 or source in ("wall", "freestream") else None,
            "direction": list(inlet_flow_direction(spec) or wall_dir or (1.0, 0.0, 0.0)),
            # Nothing flows in or out (a box its walls drive): no flow-through time to speak of.
            "closed": closed_domain(spec, source),
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
            "d_hyd": re_d,
            "ref_length": ref_length,
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
    unmirrored = two_d_unmirrored(spec, ctx.get("mesh"))
    if unmirrored:
        out["two_d_unmirrored"] = unmirrored
    if out["closed"] and not holds_pressure(spec):
        through, curved = walls_across(spec)
        if through:
            out["walls_through"] = through
        if curved:
            out["walls_curved"] = curved
    tc = getattr(spec, "transient", None)
    if transient and tc is not None and not tc.adjust_time_step:
        # A blank fixed step is written with the case's own estimate.
        out["delta_t_written"] = float(tc.delta_t)
    return out


# A Moving wall's velocity counts as along a face when its part across it is under this
# fraction of its speed (the solver's own check, adjustPhi, trips at 1e-8 of the flux).
ALONG_FACE = 1e-6


def holds_pressure(spec: Any) -> bool:
    """A boundary holds the pressure's value (a pressure BC, a total-pressure inlet or a
    freestream): the solver then needs no pressure reference and balances no flux."""
    from magnusim_sdk.study import is_pressure_bc

    from .bc_kinds import is_freestream, is_total_pressure_inlet

    for m in getattr(spec, "mapped", None) or []:
        bc = m.get("bc") if isinstance(m, dict) else None
        if bc and (is_pressure_bc(bc) or is_total_pressure_inlet(bc) or is_freestream(bc)):
            return True
    return False


def walls_across(spec: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The study's Moving walls whose velocity has a part across their own faces, and those with
    curved faces it could not check everywhere: ``([{name, faces, velocity}], [{name, faces}])``.

    A Moving wall is written as a fixed velocity on its faces (writer: fixedValue), so a velocity
    across a face pushes fluid through it. In a closed box nothing can leave, and the solver
    stops on its first iteration ("Continuity error cannot be removed by adjusting the outflow").
    A face's normal is the CAD face table's at its middle: a flat face is checked whole; a curved
    one only there, so a wall on curved faces whose velocity is along them there is listed as
    unchecked. A Rotating wall's velocity is made along its faces by the solver (no row)."""
    import math

    from magnusim_sdk.study import bc_faces, is_wall_bc

    from .bc_kinds import wall_kind, wall_moves, wall_velocity
    from .writer import _bc_dict

    props = getattr(spec, "face_props", None) or {}
    through: list[dict[str, Any]] = []
    curved: list[dict[str, Any]] = []
    for m in getattr(spec, "mapped", None) or []:
        raw = m.get("bc") if isinstance(m, dict) else None
        if not raw:
            continue
        bc = _bc_dict(raw)
        if not is_wall_bc(bc) or wall_kind(bc) != "Moving" or not wall_moves(bc):
            continue
        v = [float(c) for c in wall_velocity(bc)]
        speed = math.hypot(*v)
        across: list[str] = []
        unchecked: list[str] = []
        for face in bc_faces(bc):
            fp = props.get(face)
            n = getattr(fp, "normal", None) if fp is not None else None
            if not n or len(n) != 3:
                continue
            size = math.hypot(*n) or 1.0
            if abs(sum(float(a) * b for a, b in zip(n, v, strict=True))) / size > ALONG_FACE * speed:
                across.append(_face_label(face))
            elif getattr(fp, "planar", None) is False:
                unchecked.append(_face_label(face))
        name = str(bc.get("name") or "")
        if across:
            through.append({"name": name, "faces": across, "velocity": v})
        elif unchecked:
            curved.append({"name": name, "faces": unchecked})
    return through, curved


def _face_label(face: str) -> str:
    """A face as the panels name it ("Face 3@Body1")."""
    s = str(face)
    return s[:1].upper() + s[1:] if s.lower().startswith("face ") else s


def _one_cell_depth(facts: Any) -> float | None:
    """The depth (m) of a mesh made one cell across (the mesh facts' ``two_d``), else None."""
    two = facts.get("two_d") if isinstance(facts, dict) else None
    if not isinstance(two, dict) or two.get("cells_across") != 1:
        return None
    try:
        depth = float(two.get("depth_m") or 0)
    except (TypeError, ValueError):
        return None
    return depth if depth > 0 else None


def two_d_unmirrored(spec: Any, facts: Any) -> list[dict[str, Any]]:
    """The ends of a mesh made one cell across (2D; the mesh facts' ``two_d``) whose patch's
    boundary condition in this study is not a Symmetry: ``[{faces, bc}]``, one per such BC.

    An end whose patch no boundary condition holds any more (its Symmetry deleted, or its faces
    taken off it) is solved as the walls with no BC are (the writer's default wall): ``bc`` is
    None and ``default_wall`` names that treatment. A Slip default mirrors the flow as a
    Symmetry does, so it is not listed."""
    from .bc_kinds import is_symmetry, wall_kind
    from .writer import _bc_dict

    two = facts.get("two_d") if isinstance(facts, dict) else None
    if not isinstance(two, dict):
        return []
    by_patch = {str(m.get("patch") or ""): _bc_dict(m.get("bc") or {}) for m in getattr(spec, "mapped", None) or [] if m.get("bc")}
    default_wall = wall_kind({"wall_type": getattr(spec, "wall_default", "") or ""})
    out: dict[str, dict[str, Any]] = {}
    for end in (two.get("front"), two.get("back")):
        if not isinstance(end, dict) or not str(end.get("patch") or ""):
            continue
        bc = by_patch.get(str(end.get("patch") or ""))
        if bc is not None and is_symmetry(bc):
            continue
        if bc is None and default_wall == "Slip":
            continue
        name = str(bc.get("name") or bc.get("bc_type") or "") if bc is not None else ""
        row = out.setdefault(name, {"faces": [], "bc": name} if bc is not None else {"faces": [], "bc": None, "default_wall": default_wall})
        row["faces"] += [str(f) for f in end.get("faces") or [] if str(f) not in row["faces"]]
    return list(out.values())


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
