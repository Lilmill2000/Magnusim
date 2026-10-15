"""Stop a run when a monitor settles (OpenFOAM ESI v2606 ``runTimeControl``).

A run's ``settle`` setting (on its run record, cleaned by the run model):
``{"id": <monitor id>, "quantity": <key>, "tolerance": <amount>, "window": <iterations or s>}``.

The writer adds one ``runTimeControl`` with an ``average`` condition on the
monitor's function object: it is met when the result stays within
``tolerance`` (W, or K for a temperature) of its running average over the
window; the run then writes and ends. A function object publishes one value
per boundary, so a boundary monitor can stop the run when it is on one
boundary:

- Wall heat flux · Heat flow: the ``wallHeatFlux`` object's ``int(<patch>)``;
- Surface temperature · Average / Highest: ``areaAverage(<patch>,T)`` / ``max(<patch>,T)``;
- Thermocouple · Temperature: the mean over its points, ``average(T)``.

In a conjugate heat transfer case the objects are per region
(heat_transfer.cht_functions): a boundary monitor watches one boundary in one
region, a thermocouple its points in one region, and the ``runTimeControl``
names a region (without one it finds no mesh in a multi-region case and never
checks its condition: HT5).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .monitors import SURFACE_TEMPERATURE, THERMOCOUPLE, WALL_HEAT_FLUX

SETTLE_OBJECT = "settleStop"
SETTLE_CONDITION = "settle"
# The case's one wallHeatFlux function object (heat_transfer.functions).
WALL_HEAT_FLUX_OBJECT = "ht_wall_heat_flux"


@dataclass(frozen=True)
class SettleQuantity:
    key: str
    label: str
    unit: str


QUANTITIES: dict[str, tuple[SettleQuantity, ...]] = {
    WALL_HEAT_FLUX: (SettleQuantity("Q", "Heat flow", "W"),),
    SURFACE_TEMPERATURE: (
        SettleQuantity("T_avg", "Average temperature", "K"),
        SettleQuantity("T_max", "Highest temperature", "K"),
    ),
    THERMOCOUPLE: (SettleQuantity("T_pt", "Temperature (average of its points)", "K"),),
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
    """A settle setting as it is stored, or None (off, or not usable)."""
    if not isinstance(raw, dict):
        return None
    ident = str(raw.get("id") or "").strip()
    quantity = str(raw.get("quantity") or "").strip()
    tol = _num(raw.get("tolerance"))
    window = _num(raw.get("window"))
    if not ident or not quantity or tol is None or tol <= 0 or window is None or window <= 0:
        return None
    out: dict[str, Any] = {"source": "monitor", "id": ident, "quantity": quantity, "tolerance": tol}
    out["window"] = window if transient else int(max(1, round(window)))
    return out


def number_text(x: float) -> str:
    return f"{float(x):.6g}"


def shown_tolerance(q: SettleQuantity, tolerance: float, *, imperial: bool) -> tuple[float, str]:
    """A tolerance as the project shows it: a temperature difference in °C (metric, the same
    number as K) or °F (imperial, 1.8 times); anything else in its own unit."""
    if q.unit == "K":
        return (tolerance * 1.8, "°F") if imperial else (tolerance, "°C")
    return tolerance, q.unit


def plan_settle(spec: Any, monitor_plans: list[dict[str, Any]]) -> dict[str, Any] | None:
    """``{object, field, tolerance, window, label, text}`` for the case, ``{error, label?}`` when
    the stop cannot be written, None when the run has none. ``monitor_plans`` are the
    writer's (heat_transfer.functions.plan_monitors)."""
    settle = getattr(spec, "settle", None)
    if not settle:
        return None
    plan = next((p for p in monitor_plans if str(p.get("id") or "") == str(settle["id"])), None)
    if plan is None:
        return {"error": "the monitor it watches was deleted"}
    kind = str(plan["type"])
    q = next((x for x in QUANTITIES.get(kind, ()) if x.key == settle["quantity"]), None)
    name = str(plan.get("name") or "Monitor")
    if q is None:
        return {"error": f"{name} has no quantity the stop can watch"}
    label = f"{name} · {q.label}"
    transient = getattr(spec, "transient", None) is not None
    window = float(settle["window"])
    span = f"{number_text(window)} s" if transient else f"{int(window)} iteration{'s' if int(window) != 1 else ''}"
    from .contract import project_imperial

    tol, unit = shown_tolerance(q, float(settle["tolerance"]), imperial=project_imperial(getattr(spec, "project_dir", None)))
    text = f"{label} stayed within {number_text(tol)} {unit} of its average over {span}"
    if plan.get("cht"):
        return _plan_cht(plan, kind, q, settle, label=label, name=name, text=text, window=window)
    if kind == THERMOCOUPLE:
        if not plan.get("points"):
            return {"error": f"{name} has no points placed", "label": label}
        obj, fld = str(plan["key"]), "average(T)"
    else:
        patches = list(plan.get("patches") or [])
        if not patches:
            return {"error": f"{name} is on no boundary of this mesh", "label": label}
        if len(patches) > 1:
            return {"error": f"{name} is on {len(patches)} boundaries; the stop watches a monitor on one", "label": label}
        patch = patches[0]
        if kind == WALL_HEAT_FLUX:
            obj, fld = WALL_HEAT_FLUX_OBJECT, f"int({patch})"
        elif q.key == "T_max":
            obj, fld = f"ht_Tmax_{patch}", f"max({patch},T)"
        else:
            obj, fld = f"ht_Tavg_{patch}", f"areaAverage({patch},T)"
    return {"object": obj, "field": fld, "tolerance": float(settle["tolerance"]), "window": window, "label": label, "text": text}


def _plan_cht(
    plan: dict[str, Any], kind: str, q: SettleQuantity, settle: dict[str, Any], *, label: str, name: str, text: str, window: float
) -> dict[str, Any]:
    """The stop of a conjugate heat transfer case's monitor (its objects are per region)."""
    from .cht_functions import surface_objects, wall_heat_flux_object

    if kind == THERMOCOUPLE:
        probes = list(plan.get("probes") or [])
        if not plan.get("points"):
            return {"error": f"{name} has no points placed", "label": label}
        if not probes:
            return {"error": f"{name} has no point inside the mesh", "label": label}
        if len(probes) > 1:
            return {"error": f"{name} has points in {len(probes)} bodies; the stop watches a thermocouple in one", "label": label}
        obj, fld = str(probes[0]["key"]), "average(T)"
    else:
        targets = list(plan.get("targets") or [])
        if not targets:
            return {"error": f"{name} is on no boundary of this mesh", "label": label}
        if len(targets) > 1:
            return {"error": f"{name} is on {len(targets)} boundaries; the stop watches a monitor on one", "label": label}
        region, patch = str(targets[0]["region"]), str(targets[0]["patch"])
        if kind == WALL_HEAT_FLUX:
            obj, fld = wall_heat_flux_object(region), f"int({patch})"
        elif q.key == "T_max":
            obj, fld = surface_objects(region, patch)[1], f"max({patch},T)"
        else:
            obj, fld = surface_objects(region, patch)[0], f"areaAverage({patch},T)"
    return {"object": obj, "field": fld, "tolerance": float(settle["tolerance"]), "window": window, "label": label, "text": text}


def settle_functions_text(plan: dict[str, Any] | None, *, region: str = "") -> str:
    """The runTimeControl block for a written plan ('' when there is none). ``region``: any
    region of a multi-region case (the object needs one to load; it reads the watched
    object's results whatever their region)."""
    if not plan or "error" in plan:
        return ""
    region_line = f"\n        region          {region};" if region else ""
    return f"""    {SETTLE_OBJECT}
    {{
        type            runTimeControl;
        libs            (utilityFunctionObjects);{region_line}
        conditions
        {{
            {SETTLE_CONDITION}
            {{
                type            average;
                functionObject  {plan["object"]};
                fields          ( {plan["field"]} );
                tolerance       {number_text(plan["tolerance"])};
                window          {number_text(plan["window"])};
                windowType      approximate;
                log             false;
            }}
        }}
        satisfiedAction end;
    }}"""
