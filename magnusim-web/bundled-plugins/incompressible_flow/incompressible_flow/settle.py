"""Stop a run when a monitor settles (OpenFOAM ESI v2606 ``runTimeControl``).

A run's ``settle`` setting (saved on its run record, cleaned by the run model):
``{"source": "monitor" | "boundary", "id": <monitor or BC id>, "quantity": <key>,
"tolerance": <amount in the quantity's unit>, "window": <iterations or seconds>}``.

The writer adds one ``runTimeControl`` function object with an ``average``
condition on the monitor's function object. v2606's condition
(valueAverageBase) keeps a running mean of the result over the window and is
met when ``|mean - current|`` is at most ``tolerance``: an absolute amount in
the result's own units, not a percentage. Once met (and at least 10 steps in,
its ``nIterStartUp``) the run writes and ends: ``satisfiedAction end``.

Only results a function object publishes while the run solves can be watched
(``state_.getObjectResult``), so only these are offered:

- an area-average monitor (``rc_<slug>``) and a boundary's monitor
  (``mon_<patch>``): ``areaAverage(<region>,p)`` (kinematic: the tolerance in Pa
  is divided by the density) and ``areaAverage(<region>,U)`` (a vector: the
  change of the whole vector);
- a boundary's flow (``flow_<patch>``): ``sum(<patch>,phi)``;
- a Forces monitor's coefficients (``coeffs_<slug>``): ``Cd``, ``Cl``, ``Cs``,
  ``CmPitch`` (the study needs a reference area; Cm a reference length too);
- a Point probe (``probes_<slug>``): ``average(p)`` and ``average(U)``, the mean
  over its points (one point: that point's value).

surfaceFieldValue and probes compute their result only when they write: a
transient run's monitors write 50 times per result frame, so its window is at
least 10 of those samples (a shorter one would see a value that does not move
between samples and stop early).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

# The runTimeControl function object and its condition (the log names the condition).
SETTLE_OBJECT = "settleStop"
SETTLE_CONDITION = "settle"
# A transient window spans at least this many monitor samples (see the module note).
MIN_SAMPLES = 10
# Monitor samples per result frame (function_objects.monitor_write_control_text).
SAMPLES_PER_FRAME = 50


@dataclass(frozen=True)
class SettleQuantity:
    key: str
    label: str
    unit: str
    # The result name the function object publishes ({region} is filled in).
    result: str
    # Kinematic in the case (divided by density): the tolerance is too.
    kinematic: bool = False
    # Which of the monitor's function objects publishes it ("mon"/"flow" for a boundary).
    object: str = ""
    # The result changes only when the function object writes (transient: sampled).
    sampled: bool = True


AREA_AVERAGE = (
    SettleQuantity("p", "Pressure", "Pa", "areaAverage({region},p)", kinematic=True),
    SettleQuantity("U", "Velocity", "m/s", "areaAverage({region},U)"),
)
BOUNDARY = (
    SettleQuantity("p", "Pressure", "Pa", "areaAverage({region},p)", kinematic=True, object="mon"),
    SettleQuantity("U", "Velocity", "m/s", "areaAverage({region},U)", object="mon"),
    SettleQuantity("Q", "Flow rate", "m³/s", "sum({region},phi)", object="flow"),
)
FORCES = (
    SettleQuantity("Cd", "Cd", "", "Cd", sampled=False),
    SettleQuantity("Cl", "Cl", "", "Cl", sampled=False),
    SettleQuantity("Cs", "Cs", "", "Cs", sampled=False),
    SettleQuantity("Cm", "Cm", "", "CmPitch", sampled=False),
)
PROBE = (
    SettleQuantity("p", "Pressure (average of its points)", "Pa", "average(p)", kinematic=True),
    SettleQuantity("U", "Velocity (average of its points)", "m/s", "average(U)"),
)
# Per monitor kind: a result control's monitor_type, or "boundary".
QUANTITIES: dict[str, tuple[SettleQuantity, ...]] = {
    "area_average": AREA_AVERAGE,
    "boundary": BOUNDARY,
    "forces": FORCES,
    "probe": PROBE,
}


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def clean_settle(raw: Any, *, transient: bool) -> dict[str, Any] | None:
    """A settle setting as it is stored, or None (off, or not usable).

    ``tolerance`` > 0; ``window`` > 0 (a steady run's a whole number of iterations, at least 1).
    """
    if not isinstance(raw, dict):
        return None
    ident = str(raw.get("id") or "").strip()
    quantity = str(raw.get("quantity") or "").strip()
    source = "boundary" if raw.get("source") == "boundary" else "monitor"
    tol = _num(raw.get("tolerance"))
    window = _num(raw.get("window"))
    if not ident or not quantity or tol is None or tol <= 0 or window is None or window <= 0:
        return None
    if not transient:
        window = float(max(1, int(round(window))))
    out: dict[str, Any] = {"source": source, "id": ident, "quantity": quantity, "tolerance": tol}
    out["window"] = window if transient else int(window)
    return out


def number_text(x: float) -> str:
    """A tolerance or window as the panel and the run's texts show it (up to 6 significant digits)."""
    text = f"{float(x):.6g}"
    return text


def _monitor_record(result_controls: list | None, ident: str) -> dict[str, Any] | None:
    for rec in result_controls or []:
        if isinstance(rec, dict) and str(rec.get("id") or "") == ident:
            return rec
    return None


def _monitor_kind(rec: dict[str, Any]) -> str:
    from .monitors import custom_monitor_records

    kind = str(rec.get("monitor_type") or "")
    if kind:
        return kind
    return "area_average" if custom_monitor_records([rec]) else ""


def _quantity(kind: str, key: str) -> SettleQuantity | None:
    return next((q for q in QUANTITIES.get(kind, ()) if q.key == key), None)


def describe(settle: dict[str, Any], *, name: str, quantity: SettleQuantity, transient: bool) -> dict[str, str]:
    """The label ("Forces 1 · Cd") and the sentence the run ends with once it settles."""
    unit = f" {quantity.unit}" if quantity.unit else ""
    window = settle["window"]
    span = f"{number_text(window)} s" if transient else f"{int(window)} iteration{'s' if int(window) != 1 else ''}"
    label = f"{name} · {quantity.label}"
    text = f"{label} stayed within {number_text(settle['tolerance'])}{unit} of its average over {span}"
    return {"label": label, "text": text}


def settle_target(spec: Any, settle: dict[str, Any] | None) -> dict[str, Any] | None:
    """What a settle setting watches on this run, before the case is written:
    ``{kind, name, quantity, label, text}``, or ``{error}`` when its monitor is gone
    or cannot be watched. None when the run has none."""
    if not settle:
        return None
    transient = getattr(spec, "transient", None) is not None or getattr(spec, "time_dependency", "") == "transient"
    ident = str(settle.get("id") or "")
    if settle.get("source") == "boundary":
        hit = next(
            (m for m in getattr(spec, "mapped", None) or [] if str((m.get("bc") or {}).get("id") or "") == ident),
            None,
        )
        if hit is None:
            return {"error": "the boundary it watches has no faces or was deleted"}
        kind = "boundary"
        name = str((hit.get("bc") or {}).get("name") or hit.get("patch") or "Boundary")
    else:
        rec = _monitor_record(getattr(spec, "result_controls", None), ident)
        if rec is None:
            return {"error": "the monitor it watches was deleted"}
        kind = _monitor_kind(rec)
        name = str(rec.get("name") or "Monitor")
    quantity = _quantity(kind, str(settle.get("quantity") or ""))
    if quantity is None:
        return {"error": f"{name} has no quantity the stop can watch"}
    return {"kind": kind, "name": name, "quantity": quantity, **describe(settle, name=name, quantity=quantity, transient=transient)}


def plan_settle(
    spec: Any,
    *,
    custom_meta: list[dict[str, Any]] | None = None,
    forces_plans: list[dict[str, Any]] | None = None,
    probe_plans: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """The runTimeControl the case gets: ``{object, field, tolerance, window, label, text}``
    (tolerance and window as written: case units, case time), or ``{error, label?}`` when
    the stop cannot be written on this run. None when the run has none."""
    settle = getattr(spec, "settle", None)
    target = settle_target(spec, settle)
    if target is None or "error" in target:
        return target
    assert settle is not None
    q: SettleQuantity = target["quantity"]
    kind = target["kind"]
    ident = str(settle["id"])
    label = target["label"]
    region = ""
    obj = ""
    if kind == "boundary":
        hit = next(m for m in spec.mapped if str((m.get("bc") or {}).get("id") or "") == ident)
        patch = str(hit.get("patch") or "")
        if patch not in (getattr(spec, "monitor_patches", None) or []):
            return {"error": f"{target['name']} is not an opening the case monitors", "label": label}
        region = patch
        obj = f"{q.object}_{patch}"
    elif kind == "area_average":
        meta = next((m for m in custom_meta or [] if str(m.get("id") or "") == ident), None)
        if meta is None:
            return {"error": f"{target['name']} is not placed on any faces of this geometry", "label": label}
        region = obj = str(meta["key"])
    elif kind == "forces":
        plan = next((p for p in forces_plans or [] if str(p.get("id") or "") == ident), None)
        if plan is None or not plan.get("key"):
            return {"error": f"{target['name']} measures no walls on this mesh", "label": label}
        if not plan.get("coeffs_key"):
            return {"error": "force coefficients need the study's reference area", "label": label}
        if q.key == "Cm" and not plan.get("moment_coefficient"):
            return {"error": "the moment coefficient needs the study's reference length", "label": label}
        obj = str(plan["coeffs_key"])
    elif kind == "probe":
        plan = next((p for p in probe_plans or [] if str(p.get("id") or "") == ident), None)
        if plan is None:
            return {"error": f"{target['name']} has no points placed", "label": label}
        obj = str(plan["key"])
    else:  # pragma: no cover - settle_target only returns the kinds above
        return {"error": "unknown monitor", "label": label}
    tolerance = float(settle["tolerance"])
    if q.kinematic:
        tolerance = tolerance / float(spec.rho)
    window = float(settle["window"])
    transient = getattr(spec, "transient", None)
    min_window = None
    if transient is not None and q.sampled:
        sample = float(transient.write_interval) / SAMPLES_PER_FRAME
        min_window = MIN_SAMPLES * sample
        window = max(window, min_window)
    out: dict[str, Any] = {
        "object": obj,
        "field": q.result.format(region=region),
        "tolerance": tolerance,
        "window": window,
        "label": label,
        "text": target["text"],
    }
    if min_window is not None and window > float(settle["window"]):
        out["text"] = describe(
            {**settle, "window": window}, name=target["name"], quantity=q, transient=True
        )["text"]
        out["note"] = f"Window raised to {number_text(window)} s: at least {MIN_SAMPLES} monitor samples."
    return out


def check_settle(spec: Any) -> dict[str, Any] | None:
    """plan_settle as far as it is known before the case is written (the run's plan):
    the Forces monitors and probes planned on the mesh's patches with the study's
    reference values, the area averages that have faces. ``{label, text}`` when it will
    be written, ``{error, label?}`` when not, None when the run has none. (An area
    average whose faces turn out not to be on the geometry is found only when the
    case is written: ``w27-case.json`` ``settle``.)"""
    if getattr(spec, "settle", None) is None:
        return None
    from .force_objects import plan_forces_monitors, plan_probe_monitors
    from .function_objects import custom_monitor_key
    from .reference import resolve_reference

    patches = set(getattr(spec, "patches", None) or []) or None
    taken: set[str] = set()
    custom = [
        {"id": m.get("id"), "key": custom_monitor_key(str(m.get("name") or "monitor"), taken)}
        for m in getattr(spec, "custom_monitors", None) or []
    ]
    plan = plan_settle(
        spec,
        custom_meta=custom,
        forces_plans=plan_forces_monitors(spec, patches, resolve_reference(spec)),
        probe_plans=plan_probe_monitors(spec),
    )
    if plan is None:
        return None
    if "error" in plan:
        return {k: plan[k] for k in ("label", "error") if k in plan}
    return {"label": plan["label"], "text": plan["text"]}


def settle_functions_text(plan: dict[str, Any] | None) -> str:
    """The runTimeControl block for a written plan ('' when there is none)."""
    if not plan or "error" in plan:
        return ""
    from .force_objects import num

    return f"""    {SETTLE_OBJECT}
    {{
        type            runTimeControl;
        libs            (utilityFunctionObjects);
        conditions
        {{
            {SETTLE_CONDITION}
            {{
                type            average;
                functionObject  {plan["object"]};
                fields          ( {plan["field"]} );
                tolerance       {num(plan["tolerance"])};
                window          {num(plan["window"])};
                windowType      approximate;
                log             false;
            }}
        }}
        satisfiedAction end;
    }}"""
