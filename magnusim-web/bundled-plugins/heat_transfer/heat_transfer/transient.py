"""Run control: a steady run's iterations and a transient run's time stepping.

``TRANSIENT_DEFAULTS`` / ``STEADY_DEFAULTS`` are the one copy of the defaults:
the registered control schemas are built from them and the Run panel reads
them back from the registry. ``resolve_transient`` turns a run's saved
settings into the numbers controlDict gets, and ``control_to_web`` into the
shape the run record and the Run panel keep (``end_time``, ``write_count``,
``write_interval``, ``delta_t``, ``max_delta_t``, ``adjust_time_step``,
``max_co``, ``source``).

The time step adjusts to keep the Courant number at or below its maximum
(buoyantPimpleFoam ``adjustTimeStep``); the first step is small and grows.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from magnusim_sdk.numerics_settings import RUN_KEYS, clamp_edit, run_value

# 1500 iterations: the heat-sink sample carries its 10 W out within about 1 % by then (VALIDATION.md, README).
STEADY_DEFAULTS: dict[str, Any] = {"end_time": 1500, "write_interval": 100}

TRANSIENT_DEFAULTS: dict[str, Any] = {
    "end_time": 10.0,
    "write_count": 20,
    "time_step_mode": "adjustable",
    "max_co": 0.8,
    "delta_t": None,
    "max_delta_t": None,
    "time_scheme": "Euler",
    "n_outer_correctors": 1,
    "n_correctors": 2,
    # RH3: the PIMPLE outer loops' relaxation and tolerance (only with 2 or more outer
    # correctors). None = as today: no relaxation (1), and every outer corrector on every step.
    "outer_relax_p": None,
    "outer_relax_eq": None,
    "outer_tolerance": None,
}


def foam_num(v: Any) -> str:
    """A time as OpenFOAM reads it back: plain up to 8 significant digits, else an exponent."""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "0"
    if not math.isfinite(n) or n == 0:
        return "0"
    if 1e-3 <= abs(n) < 1e6:
        return f"{float(f'{n:.8g}'):.15g}"
    mant, exp = f"{n:.6e}".split("e")
    mant = mant.rstrip("0").rstrip(".")
    return f"{mant}e{int(exp):+d}"


def _num(v: Any, fallback: float) -> float:
    if isinstance(v, bool):
        return fallback
    try:
        n = float(v)
    except (TypeError, ValueError):
        return fallback
    return n if math.isfinite(n) else fallback


def _pos_or_none(v: Any) -> float | None:
    if v is None or v == "" or v == "auto" or isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) and n > 0 else None


def normalize_transient(partial: dict | None, edited: Any = None) -> dict[str, Any]:
    """A transient block as it is stored: every key, each in range (a bad value keeps the default).

    RH3's run keys (outer relaxation, outer tolerance) are kept as stored, even outside their
    range (a stored value is used as saved); only the keys in ``edited`` (an edit's changed
    keys) are held to their bounds.
    """
    d = TRANSIENT_DEFAULTS
    p = partial if isinstance(partial, dict) else {}
    out = dict(d)
    end = _num(p.get("end_time"), float(d["end_time"]))
    out["end_time"] = end if end > 0 else float(d["end_time"])
    frames = int(round(_num(p.get("write_count"), float(d["write_count"]))))
    out["write_count"] = min(max(frames, 1), 5000)
    mode = str(p.get("time_step_mode") or d["time_step_mode"]).lower()
    out["time_step_mode"] = "fixed" if "fixed" in mode else "adjustable"
    co = _num(p.get("max_co"), float(d["max_co"]))
    out["max_co"] = co if co > 0 else float(d["max_co"])
    out["delta_t"] = _pos_or_none(p.get("delta_t"))
    out["max_delta_t"] = _pos_or_none(p.get("max_delta_t"))
    scheme = str(p.get("time_scheme") or d["time_scheme"]).lower()
    out["time_scheme"] = "backward" if "backward" in scheme else "Euler"
    outer = int(round(_num(p.get("n_outer_correctors"), float(d["n_outer_correctors"]))))
    out["n_outer_correctors"] = min(max(outer, 1), 50)
    corr = int(round(_num(p.get("n_correctors"), float(d["n_correctors"]))))
    out["n_correctors"] = min(max(corr, 1), 10)
    interval = out["end_time"] / out["write_count"]
    if out["max_delta_t"] is not None and out["max_delta_t"] > interval:
        out["max_delta_t"] = interval
    changed = set(edited) if edited is not None else set()
    for key in RUN_KEYS:
        kept = run_value(key, p.get(key))
        out[key] = clamp_edit(key, kept) if key in changed else kept
    return out


@dataclass(frozen=True)
class TransientControl:
    end_time: float
    delta_t: float
    write_interval: float
    adjust_time_step: bool
    max_co: float
    max_delta_t: float
    time_scheme: str
    n_outer_correctors: int
    n_correctors: int
    write_count: int
    time_step_mode: str
    source: dict[str, str]
    # RH3 (None = as today; only with 2 or more outer correctors).
    outer_relax_p: float | None = None
    outer_relax_eq: float | None = None
    outer_tolerance: float | None = None


def resolve_transient(settings: dict | None, *, h_m: float | None = None, speed: float | None = None) -> TransientControl:
    """The numbers controlDict gets. A blank first time step is ``max_co`` x the mean
    cell size over the case's speed (``h_m``, ``speed``), else 1/1000 of a frame."""
    t = normalize_transient(settings)
    end = float(t["end_time"])
    frames = int(t["write_count"])
    interval = end / frames
    source: dict[str, str] = {}
    dt = t["delta_t"]
    if dt is None:
        if h_m and speed and h_m > 0 and speed > 0:
            dt = float(t["max_co"]) * h_m / speed
        else:
            dt = interval / 1000.0
        source["delta_t"] = "auto"
    else:
        source["delta_t"] = "user"
    dt = min(float(dt), interval)
    mdt = t["max_delta_t"]
    if mdt is None:
        mdt = interval
        source["max_delta_t"] = "auto"
    else:
        source["max_delta_t"] = "user"
    return TransientControl(
        end_time=end,
        delta_t=float(f"{dt:.6g}"),
        write_interval=interval,
        adjust_time_step=t["time_step_mode"] != "fixed",
        max_co=float(t["max_co"]),
        max_delta_t=float(mdt),
        time_scheme=str(t["time_scheme"]),
        n_outer_correctors=int(t["n_outer_correctors"]),
        n_correctors=int(t["n_correctors"]),
        write_count=frames,
        time_step_mode=str(t["time_step_mode"]),
        source=source,
        outer_relax_p=t.get("outer_relax_p"),
        outer_relax_eq=t.get("outer_relax_eq"),
        outer_tolerance=t.get("outer_tolerance"),
    )


def control_to_web(tc: TransientControl, settings: dict | None = None) -> dict[str, Any]:
    """The resolved control as the run record and the Run panel keep it."""
    return {
        **normalize_transient(settings),
        "end_time": tc.end_time,
        "write_count": tc.write_count,
        "write_interval": tc.write_interval,
        "delta_t": tc.delta_t,
        "max_delta_t": tc.max_delta_t,
        "adjust_time_step": tc.adjust_time_step,
        "max_co": tc.max_co,
        "source": dict(tc.source),
    }


def describe_transient(ctrl: dict[str, Any] | None) -> str:
    """The run note's summary: "10 s · 20 frames · Co ≤ 0.8" (or "· fixed Δt 0.001 s")."""
    c = ctrl or {}
    bits: list[str] = []
    if c.get("end_time") is not None:
        bits.append(f"{foam_num(c['end_time'])} s")
    if c.get("write_count") is not None:
        bits.append(f"{c['write_count']} frames")
    if c.get("adjust_time_step") is False:
        bits.append(f"fixed Δt {foam_num(c.get('delta_t'))} s")
    elif c.get("max_co") is not None:
        bits.append(f"Co ≤ {foam_num(c['max_co'])}")
    return " · ".join(bits)
