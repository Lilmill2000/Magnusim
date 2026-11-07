"""Synthetic steady solver logs for run health (simpleFoam, k-omega SST, the validation set's
turbulent pipe hints), shaped like that pipe's Hex-dominant log of 2026-11-07: its residual
floors, its bounding lines and its inlet and outlet monitors.

- ``c2_sst``: the pipe's pattern. omega and k are bounded in every iteration (omega from the
  first, k from the 4th) with that run's lows and means (omega -764.3 against 849.9, k -3.917e-4
  against 7.116e-3), and from iteration 26 omega's first residual alternates 1.06e-3 on odd and
  0.90e-3 on even iterations (the rest settle under 1e-3), 2,500 iterations. Its verdict turned
  "Watch closely" at iteration 551 with only info findings.
- ``c2_bounding_only``: the same bounding with omega flat at 9e-4: the bounding alone.
- ``stall_end``: omega flat at 2e-3 from iteration 26 (a real stall: Watch closely from 551),
  then 1e-5 from iteration 997; it ends at iteration 1,000, before the verdict can ease.

The e2e (run-health.spec.js) writes them into a run's case folder:

    python health_steady_logs.py <name> <case dir>

which writes ``log.simpleFoam`` and ``w27-case.json`` (its health hints) there.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HINTS = {
    "app": "simpleFoam",
    "mode": "SIMPLE",
    "n_outer": None,
    "n_correctors": None,
    "max_co": None,
    "end_time": 2500.0,
    "average_from": None,
    "uref": 1.0,
    "uref_source": "inlet",
    "fixed_inflow": True,
    "turbulence": "kOmegaSST",
    "limiter": {"name": "limitU", "cap": 50.0, "factor": 10, "floor": 50},
    "linsolve": {
        "p": {"max_iter": 200, "tol": 1e-07, "rel_tol": 0.01, "final_rel_tol": 0.01},
        "U": {"max_iter": 50, "tol": 1e-08, "rel_tol": 0.1, "final_rel_tol": 0.1},
        "k": {"max_iter": 50, "tol": 1e-08, "rel_tol": 0.1, "final_rel_tol": 0.1},
        "omega": {"max_iter": 50, "tol": 1e-08, "rel_tol": 0.1, "final_rel_tol": 0.1},
    },
    "monitors": {"inlet": "mon_inlet", "outlet": "mon_outlet"},
}

HEAD = [
    "/*---------------------------------------------------------------------------*\\",
    "| OpenFOAM: The Open Source CFD Toolbox           Version:  2606              |",
    "\\*---------------------------------------------------------------------------*/",
    "Exec   : simpleFoam -parallel",
    "Host   : cfdbox-17",
    "Selecting RAS turbulence model kOmegaSST",
    "",
    "Starting time loop",
    "",
]

NAMES = ("c2_sst", "c2_bounding_only", "stall_end")


def _decay(n: int, start: float, floor: float, rate: float = 0.01) -> float:
    return max(floor, start * (1.0 - rate) ** n)


def _block(n: int, *, u: float, p: float, om: float, k: float, bound_omega: bool, bound_k: bool) -> list[str]:
    out = [
        f"Time = {n}",
        "",
        f"smoothSolver:  Solving for Ux, Initial residual = {u * 0.1:.8g}, Final residual = {u * 0.01:.8g}, No Iterations 1",
        f"smoothSolver:  Solving for Uy, Initial residual = {u * 0.8:.8g}, Final residual = {u * 0.08:.8g}, No Iterations 2",
        f"smoothSolver:  Solving for Uz, Initial residual = {u:.8g}, Final residual = {u * 0.1:.8g}, No Iterations 2",
        "limitVelocity limitU Limited 0 (0%) of cells, 0 (0%) of faces, with max limit 50",
        f"GAMG:  Solving for p, Initial residual = {p:.8g}, Final residual = {p * 0.006:.8g}, No Iterations 5",
        f"GAMG:  Solving for p, Initial residual = {p * 0.23:.8g}, Final residual = {p * 0.002:.8g}, No Iterations 4",
        "time step continuity errors : sum local = 9.7692876e-07, global = -5.6e-08, cumulative = 0.015168888",
        "limitVelocity limitU Limited 0 (0%) of cells, 0 (0%) of faces, with max limit 50",
        f"smoothSolver:  Solving for omega, Initial residual = {om:.8g}, Final residual = {om * 0.09:.8g}, No Iterations 1",
    ]
    if bound_omega:
        out.append("bounding omega, min: -764.31963 max: 196545.16 average: 849.89667")
    out.append(f"smoothSolver:  Solving for k, Initial residual = {k:.8g}, Final residual = {k * 0.09:.8g}, No Iterations 1")
    if bound_k:
        out.append("bounding k, min: -0.00039173472 max: 0.024517968 average: 0.0071159317")
    out += [
        f"ExecutionTime = {n * 0.05:.2f} s  ClockTime = {int(n * 0.05)} s",
        "",
        "surfaceFieldValue mon_inlet write:",
        "    areaAverage(inlet) of U = (1 1.3573417e-14 -3.4444279e-14)",
        "    areaAverage(inlet) of p = 0.34341433",
        "",
        "surfaceFieldValue mon_outlet write:",
        "    areaAverage(outlet) of U = (0.99996375 -9.155256e-05 1.1102849e-05)",
        "    areaAverage(outlet) of p = 0",
        "",
    ]
    return out


def end_of(name: str) -> int:
    """The log's last iteration."""
    return 1000 if name == "stall_end" else 2500


def lines(name: str) -> list[str]:
    """The log's lines, as written (no LF)."""
    if name not in NAMES:
        raise ValueError(name)
    out = list(HEAD)
    for n in range(1, end_of(name) + 1):
        u = _decay(n, 0.64, 3.8e-4)
        p = _decay(n, 0.39, 2.2e-4)
        k = _decay(n, 0.22, 6.5e-4)
        om = _decay(n, 0.032, 9e-4, rate=0.1)
        bound = name != "stall_end"
        if name == "c2_sst" and n >= 26:
            om = 1.06e-3 if n % 2 else 0.90e-3
        if name == "stall_end" and n >= 26:
            om = 2e-3 if n < 997 else 1e-5
        out += _block(n, u=u, p=p, om=om, k=k, bound_omega=bound, bound_k=bound and n >= 4)
    out += ["End", ""]
    return out


def hints(name: str) -> dict:
    """The log's health hints (w27-case.json)."""
    return {**HINTS, "end_time": float(end_of(name))}


def write_case(name: str, case: Path) -> None:
    """``log.simpleFoam`` and ``w27-case.json`` in ``case``."""
    case.mkdir(parents=True, exist_ok=True)
    (case / "log.simpleFoam").write_text("\n".join(lines(name)), encoding="utf-8", newline="\n")
    (case / "w27-case.json").write_text(json.dumps({"health_hints": hints(name)}), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in NAMES:
        print(f"usage: python health_steady_logs.py {{{'|'.join(NAMES)}}} <case dir>", file=sys.stderr)
        raise SystemExit(2)
    write_case(sys.argv[1], Path(sys.argv[2]))
