"""A boundary's "Varies with time" table (transient studies only).

A velocity inlet (a speed normal to the face or along a vector, a volumetric or
a mass flow), a pressure boundary and a total-pressure inlet can follow a table
of (time, value) rows instead of their fixed value. The BC record carries:

- ``time_varying``: the table is on;
- ``time_table``: the rows, ``[[time in s, value], ...]``;
- ``time_table_unit``: the unit the values were typed in (the BC's unit then;
  a table typed for another quantity, e.g. before the BC became a pressure, is
  refused, never read as this one);
- ``time_after_last``: ``Hold`` (keep the last value) or ``Repeat`` (start the
  table over: a periodic pulse).

Between rows the value is linear. A steady study ignores the table: its fixed
value is solved. The case gets OpenFOAM ``table`` Function1s
(uniformNormalFixedValue, uniformFixedValue, flowRateInletVelocity,
uniformTotalPressure), ``outOfBounds clamp`` for Hold and ``repeat`` for Repeat.
"""

from __future__ import annotations

import math
import re
from typing import Any

from magnusim_sdk.units import SI_DEFAULT, UNITS

AFTER_LAST: tuple[str, ...] = ("Hold", "Repeat")
OUT_OF_BOUNDS = {"Hold": "clamp", "Repeat": "repeat"}

# The quantities a table holds, as the panel names them.
QUANTITY_WORDS = {
    "velocity": "speed",
    "volumetric_flow": "volumetric flow",
    "mass_flow": "mass flow",
    "pressure": "pressure",
}


def varies_with_time(bc: Any) -> bool:
    """The record's "Varies with time" is on."""
    v = (bc or {}).get("time_varying") if isinstance(bc, dict) else None
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes", "on", "1")
    return v is True


def in_effect(bc: Any, transient: bool) -> bool:
    """The table replaces the fixed value: on, in a transient study."""
    return bool(transient) and varies_with_time(bc)


def after_last(bc: Any) -> str:
    """One of AFTER_LAST (Hold when blank or unknown)."""
    want = str((bc or {}).get("time_after_last") or "").strip().lower()
    return next((a for a in AFTER_LAST if a.lower() == want), "Hold")


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool) or (isinstance(v, str) and not v.strip()):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def raw_rows(bc: Any) -> list[tuple[float | None, float | None]]:
    """The saved rows as (time, value); a blank or non-number cell is None."""
    rows = (bc or {}).get("time_table") if isinstance(bc, dict) else None
    if not isinstance(rows, (list, tuple)):
        return []
    out: list[tuple[float | None, float | None]] = []
    for r in rows:
        if isinstance(r, dict):
            out.append((_num(r.get("t", r.get("time"))), _num(r.get("value"))))
        elif isinstance(r, (list, tuple)):
            out.append((_num(r[0]) if len(r) > 0 else None, _num(r[1]) if len(r) > 1 else None))
        else:
            out.append((None, None))
    return out


def _unit_key(unit: str) -> str:
    return re.sub(r"\s+", "", unit).lower().replace("^3", "3").replace("³", "3").replace("₂", "2")


def unit_factor(quantity: str, unit: str) -> float | None:
    """SI factor of ``unit`` for ``quantity`` (any case; m3/s = m³/s), None when it is not one of its units."""
    table = UNITS.get(quantity)  # type: ignore[call-overload]
    if not table:
        return None
    if unit in table:
        return float(table[unit])
    want = _unit_key(unit)
    return next((float(f) for u, f in table.items() if _unit_key(u) == want), None)


def table_unit(bc: Any, quantity: str) -> str:
    """The unit the table's values are in: its own, else the BC's, else SI."""
    d = bc or {}
    return str(d.get("time_table_unit") or d.get("unit") or SI_DEFAULT.get(quantity, ""))  # type: ignore[call-overload]


def table_problem(bc: Any, quantity: str) -> str | None:
    """What keeps the table from being solved, in the user's words, else None."""
    rows = raw_rows(bc)
    if len(rows) < 2:
        return "the table needs at least 2 rows (time, value)"
    for i, (t, v) in enumerate(rows, 1):
        if t is None:
            return f"row {i} has no time"
        if v is None:
            return f"row {i} has no value"
    times = [float(t or 0.0) for t, _v in rows]
    for i in range(1, len(times)):
        if not times[i] > times[i - 1]:
            return f"the times must increase from row to row (row {i + 1} is at {times[i]:g} s, not after {times[i - 1]:g} s)"
    unit = table_unit(bc, quantity)
    if unit_factor(quantity, unit) is None:
        word = QUANTITY_WORDS.get(quantity, quantity)
        return f"its values are in {unit}, which is not a unit of {word}: type them again"
    return None


def si_rows(bc: Any, quantity: str) -> list[tuple[float, float]] | None:
    """The rows with SI values (m/s, m³/s, kg/s or Pa), None when the table has a problem."""
    if table_problem(bc, quantity) is not None:
        return None
    factor = unit_factor(quantity, table_unit(bc, quantity)) or 1.0
    return [(float(t), float(v) * factor) for t, v in raw_rows(bc)]  # type: ignore[arg-type]


def peak_si(bc: Any, quantity: str) -> float | None:
    """The largest SI value the table reaches (in size), None when the table has a problem."""
    rows = si_rows(bc, quantity)
    return max(abs(v) for _t, v in rows) if rows else None


def span_si(bc: Any, quantity: str) -> tuple[float, float] | None:
    """The lowest and highest SI value of the table, None when it has a problem."""
    rows = si_rows(bc, quantity)
    if not rows:
        return None
    values = [v for _t, v in rows]
    return min(values), max(values)


# --- OpenFOAM entries -----------------------------------------------------------


def _fmt(x: float) -> str:
    """Ten significant digits, no trailing zeros (0.2, -3, 1.5e-05); never "-0"."""
    return format(float(x) + 0.0, ".10g")


def function1(rows: list[tuple[float, str]], after: str) -> str:
    """A ``table`` Function1 as a sub-dictionary: the patch entry's value (the
    vol field writer closes it with ``;``, which OpenFOAM reads)."""
    lines = ["", "        {", "            type            table;", "            values", "            ("]
    lines += [f"                ({_fmt(t)} {v})" for t, v in rows]
    lines += [
        "            );",
        f"            outOfBounds     {OUT_OF_BOUNDS.get(after, 'clamp')};",
        "            interpolationScheme linear;",
        "        }",
    ]
    return "\n".join(lines)


def inlet_velocity(
    bc: Any,
    *,
    quantity: str,
    n_faces: int,
    rho: float,
    direction: list[float] | None,
) -> dict[str, str] | None:
    """A velocity inlet's 0/U entry from its table, None when the table has a problem.

    A flow rate is per assigned face (the rate times the faces, as a fixed
    one); a speed along a vector is that unit vector times the speed; a speed
    normal to the face is positive into the domain (negative blows out).
    """
    rows = si_rows(bc, quantity)
    if rows is None:
        return None
    after = after_last(bc)
    n = max(1, int(n_faces))
    if quantity in ("mass_flow", "volumetric_flow"):
        entry = {"type": "flowRateInletVelocity"}
        table = function1([(t, _fmt(v * n)) for t, v in rows], after)
        if quantity == "mass_flow":
            entry.update(massFlowRate=table, rhoInlet=f"{rho}")
        else:
            entry["volumetricFlowRate"] = table
        entry.update(extrapolateProfile="false", value="uniform (0 0 0)")
        return entry
    if direction is not None:
        vectors = [(t, "(" + " ".join(_fmt(c * v) for c in direction) + ")") for t, v in rows]
        return {"type": "uniformFixedValue", "uniformValue": function1(vectors, after), "value": f"uniform {vectors[0][1]}"}
    # uniformNormalFixedValue: positive along the outward normal, so an inflow is negative.
    return {
        "type": "uniformNormalFixedValue",
        "uniformValue": function1([(t, _fmt(-v)) for t, v in rows], after),
        "value": "uniform (0 0 0)",
    }


def pressure_p(bc: Any, rho: float, *, total: bool = False) -> dict[str, str] | None:
    """A pressure boundary's (or, ``total``, a total-pressure inlet's) 0/p entry
    from its table, kinematic (Pa / rho); None when the table has a problem."""
    rows = si_rows(bc, "pressure")
    if rows is None:
        return None
    kin = [(t, _fmt(v / rho)) for t, v in rows]
    table = function1(kin, after_last(bc))
    if total:
        return {"type": "uniformTotalPressure", "p0": table, "value": f"uniform {kin[0][1]}"}
    return {"type": "uniformFixedValue", "uniformValue": table, "value": f"uniform {kin[0][1]}"}
