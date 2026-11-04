"""What a transient run will take, before it starts (run health, RH2): its time step at
a Max Courant, its steps, a flow-through time and its wall time on this PC.

- :func:`estimate_run`: ``Δt = maxCo / (U · 1.5 · rate)``, where ``rate`` is the mesh's
  99.9th-percentile Courant rate along the inflow direction
  (:func:`magnusim_sdk.courant_rates.rate_along`) and 1.5 allows for the flow speeding up
  past the inflow speed in the smallest cells; then the steps to the end time, one
  flow-through time (the mesh's length along the flow over the speed) and the wall time
  from this PC's solve rate.
- :func:`courant_at`: the Courant number a fixed time step gives in the smallest cells.
- :func:`pc_solve_rate`: this PC's solve rate, seconds per cell-per-rank per step and
  outer loop: the median over its finished runs (kept in the app's machine settings,
  ``solve_rate.samples``), else Run_2's 1.4e-5 s.
- :func:`solve_rate_sample`: one finished run's rate.

It is an estimate for what the person reads and for the pre-run checks: no case is
written from it (the time step a case is written with keeps its own estimate).

Standard library only.
"""

from __future__ import annotations

import math
import statistics
from typing import Any

from .courant_rates import rate_along

# The speed in the smallest cells over the inflow speed the estimate allows for.
SPEED_FACTOR = 1.5
# Seconds per cell-per-rank per time step and outer loop with no finished run on this PC:
# Run_2's (0.6 s per step, 625,000 cells on 15 ranks, 1 outer loop).
DEFAULT_S_PER_CELL_STEP = 1.4e-5
# The finished runs a PC's rate is the median of (the newest kept).
RATE_SAMPLES_MAX = 20


def _pos(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and v > 0 else None


def _length_along(bbox_m: dict[str, Any] | None, direction: Any) -> float | None:
    """The box's length along a direction (the projection of its size)."""
    if not isinstance(bbox_m, dict):
        return None
    size = bbox_m.get("size")
    if not isinstance(size, list) or len(size) != 3:
        return None
    try:
        d = [float(v) for v in direction]
        s = [abs(float(v)) for v in size]
    except (TypeError, ValueError):
        return None
    n = math.sqrt(sum(v * v for v in d))
    if not n:
        return None
    length = sum(abs(d[i]) / n * s[i] for i in range(3))
    return length if length > 0 else None


def courant_at(rates: dict[str, Any] | None, *, speed: float, direction: Any, delta_t: float) -> float | None:
    """The Courant number a fixed time step ``delta_t`` (s) gives in the smallest cells at
    ``speed`` (m/s) along ``direction``, as the estimate counts it (1.5 × the speed)."""
    rate = rate_along(rates, direction)
    u, dt = _pos(speed), _pos(delta_t)
    if rate is None or u is None or dt is None:
        return None
    return u * SPEED_FACTOR * rate * dt


def estimate_run(
    rates: dict[str, Any] | None,
    *,
    max_co: float,
    speed: float,
    direction: Any = (1.0, 0.0, 0.0),
    end_time: float | None = None,
    cells: int | None = None,
    ranks: int = 1,
    n_outer: int = 1,
    s_per_cell_step: float | None = None,
    bbox_m: dict[str, Any] | None = None,
    delta_t: float | None = None,
) -> dict[str, Any] | None:
    """A transient run's estimate, or None without a Courant-rate table or a speed.

    ``rates`` is the mesh's table (``courant-rates.json``), ``speed`` the inflow speed (m/s)
    along ``direction``; ``max_co`` the run's Max Courant; ``delta_t`` a fixed time step
    (then the steps follow from it and ``co`` is the Courant number it gives). ``cells``,
    ``ranks`` and ``n_outer`` (outer loops per step) with ``s_per_cell_step``
    (:func:`pc_solve_rate`; Run_2's rate when None) give the wall time; ``bbox_m`` (the
    mesh's box, ``mesh-facts.json``) the flow-through time.

    Returns ``{delta_t_s, co, steps, wall_s, flow_through_s, rate_per_m, speed_factor}``;
    each is None when its inputs are missing.
    """
    u = _pos(speed)
    rate = rate_along(rates, direction)
    if u is None or rate is None or rate <= 0:
        return None
    fixed = _pos(delta_t)
    co = _pos(max_co)
    if fixed is not None:
        dt: float | None = fixed
        co = u * SPEED_FACTOR * rate * fixed
    else:
        dt = co / (u * SPEED_FACTOR * rate) if co is not None else None
    end = _pos(end_time)
    steps = int(math.ceil(end / dt)) if end is not None and dt is not None else None
    per = _pos(s_per_cell_step) or DEFAULT_S_PER_CELL_STEP
    n_cells = _pos(cells)
    n_ranks = max(1, int(ranks or 1))
    outer = max(1, int(n_outer or 1))
    wall = steps * per * (n_cells / n_ranks) * outer if steps is not None and n_cells is not None else None
    length = _length_along(bbox_m, direction)
    return {
        "delta_t_s": dt,
        "co": co,
        "steps": steps,
        "wall_s": wall,
        "flow_through_s": length / u if length is not None else None,
        "rate_per_m": rate,
        "speed_factor": SPEED_FACTOR,
    }


def solve_rate_sample(*, solve_s: Any, steps: Any, cells: Any, ranks: Any = 1, n_outer: Any = 1) -> float | None:
    """One finished run's rate: solve seconds / (steps · cells per rank · outer loops), or
    None when an input is missing or not positive."""
    s, n, c = _pos(solve_s), _pos(steps), _pos(cells)
    r = _pos(ranks) or 1.0
    o = _pos(n_outer) or 1.0
    if s is None or n is None or c is None:
        return None
    return s / (n * (c / max(1.0, r)) * max(1.0, o))


def pc_solve_rate(local_doc: dict[str, Any] | None) -> dict[str, Any]:
    """This PC's solve rate from its machine settings (``.magnusim-local.json``):
    ``{s_per_cell_step, runs, source}``, the median of the finished runs' rates kept in
    ``solve_rate.samples`` (``source`` ``measured``), else Run_2's rate (``source``
    ``default``, ``runs`` 0)."""
    doc: dict[str, Any] = local_doc if isinstance(local_doc, dict) else {}
    raw_block = doc.get("solve_rate")
    block: dict[str, Any] = raw_block if isinstance(raw_block, dict) else {}
    raw_samples = block.get("samples")
    samples: list[Any] = raw_samples if isinstance(raw_samples, list) else []
    vals = [v for s in samples[-RATE_SAMPLES_MAX:] if isinstance(s, dict) and (v := _pos(s.get("s_per_cell_step"))) is not None]
    if not vals:
        return {"s_per_cell_step": DEFAULT_S_PER_CELL_STEP, "runs": 0, "source": "default"}
    return {"s_per_cell_step": float(statistics.median(vals)), "runs": len(vals), "source": "measured"}
