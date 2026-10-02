"""Job tool ``flood_demo_events``: the events of a fast solver run.

Standard library only. Each time step sends what the foam relay sent for one
step of the 20x20 cavity: two Courant events, the progress event (with ``step``,
its number), four residuals and two solver lines (``log``), one line each,
flushed as the relay does; every 100 steps a saved time. ``--steps N`` steps at
``--rate R`` steps a second (0: as fast as it can), then a ``result``.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

PREFIX = "MAGNUSIM_EVENT "


def emit(ev: dict) -> None:
    sys.stdout.write(PREFIX + json.dumps(ev, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=60000)
    ap.add_argument("--rate", type=float, default=2000.0)
    a = ap.parse_args()
    dt = 0.005
    emit({"event": "stage", "stage": "solve"})
    t0 = time.perf_counter()
    for i in range(1, a.steps + 1):
        t = round(i * dt, 6)
        r = 1.0 / (1.0 + i * 0.01)
        emit({"event": "courant", "mean": 0.12, "max": 0.5 + (i % 7) * 0.01})
        emit({"event": "courant", "delta_t": dt})
        emit({"event": "progress", "time": t, "sim_time": t, "step": i, "delta_t": dt, "co_max": 0.5, "co_mean": 0.12})
        for field, value in (("Ux", r * 1.1), ("Uy", r * 0.9), ("p", r * 2.0), ("p", r * 0.5)):
            emit({"event": "residual", "time": t, "field": field, "initial": value, "fields": {field: value}})
        emit({"event": "log", "line": "time step continuity errors : sum local = 1e-09, global = 1e-19, cumulative = 1e-18"})
        emit({"event": "log", "line": f"ExecutionTime = {i * 0.0005:.2f} s  ClockTime = {i // 2000} s"})
        if i % 100 == 0:
            emit({"event": "time_saved", "t": t})
        if a.rate > 0:
            wait = t0 + i / a.rate - time.perf_counter()
            if wait > 0:
                time.sleep(wait)
    emit({"event": "result", "ok": True, "steps": a.steps})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
