"""Synthetic route answers of a case 1 run, as the driver saves them (an exact developed
pipe flow), for the evaluate and report tests."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from magnusim_validation import cases
from magnusim_validation.plan import make_plan

NU, D, L = 2e-4, 0.02, 0.3
AREA = math.pi * D * D / 4
LAMBDA = 0.012  # the synthetic centreline's development scale (m)


def _write(d: Path, name: str, doc: Any) -> None:
    (d / f"{name}.json").write_text(json.dumps(doc), encoding="utf-8")


def _line(xs: list[float], vals: list[float], axis: int = 0, fixed: tuple[float, float, float] = (0.0, 0.0, 0.0)) -> dict:
    pts = []
    for x in xs:
        p = list(fixed)
        p[axis] = x
        pts.append(p)
    return {"status": 200, "n_valid": len(vals), "values": vals, "sample_points": pts, "reason": "ok"}


def _centreline(x: float) -> float:
    return 2.0 - math.exp(-x / LAMBDA)


def _cells() -> dict:
    """The developed part's cells (x/D 10 to 13) of an exact pipe flow, as sampling.cells saves them."""
    xs, ys, zs, ux = [], [], [], []
    for i in range(7):
        x = 0.2 + 0.01 * i
        for r in (0.0012, 0.0025, 0.004, 0.0055, 0.007, 0.0085, 0.0097):
            for k in range(8):
                a = 2 * math.pi * (k + 0.5) / 8
                xs.append(x)
                ys.append(r * math.cos(a))
                zs.append(r * math.sin(a))
                ux.append(2.0 * (1 - (r / (D / 2)) ** 2))
    n = len(xs)
    return {"source": "app_sampling", "n": n, "x": xs, "y": ys, "z": zs, "vol": [1e-9] * n, "U_x": ux,
            "U_y": [0.0] * n, "U_z": [0.0] * n}


def _wall_shear() -> dict:
    """The wall's faces over the developed part: the exact (kinematic) 8 nu U / D, against the flow."""
    n = 40
    return {"source": "case_file:180/wallShearStress", "patch": "pipe_wall", "n": n,
            "x": [0.2 + 0.06 * i / (n - 1) for i in range(n)], "area": [1e-6] * n,
            "wallShearStress_x": [-8 * NU * 1.0 / D] * n, "wallShearStress_y": [0.0] * n, "wallShearStress_z": [0.0] * n}


def fake_run(run_dir: Path, *, layers_applied: bool = True, driver: dict | None = None, lines: bool = True,
             samples: bool = True, converged: bool = True, drift: float = 0.0) -> None:
    """A run's raw answers as the driver saves them, for an exact developed pipe flow. Not
    ``converged``: it stops at 3000 iterations, the inlet pressure moving by ``drift`` (relative)
    over its last 10 %."""
    raw = run_dir / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    drv = driver or {"outcome": "done", "failed_step": None, "error": None, "ids": {"run_id": "r1"},
                     "started_at": "2026-11-04T10:00:00Z", "finished_at": "2026-11-04T10:05:00Z",
                     "timings_s": {"mesh": 60.0, "solve": 120.0},
                     "app": {"commit": "abc", "dirty": False, "pc": {"cpus": 32}}}
    (run_dir / "driver.json").write_text(json.dumps(drv), encoding="utf-8")
    _write(raw, "mesh", {"mesh": {"live_mesh_result": {"status": "done", "n_cells": 120000, "n_points": 130000}}})
    _write(raw, "mesh-facts", {"n_cells": 120000, "quality": {"known": True, "ok": True, "max_non_orthogonality": 50.0},
                               "layers": {"asked": True, "applied": layers_applied, "first_m": 2e-4,
                                          "walls": [{"patch": "pipe_wall", "layers_asked": 4,
                                                     "layers": 3.8 if layers_applied else 0.0}]}})
    (raw / "blockMeshDict.txt").write_text("blocks ( hex (0 1 2 3 4 5 6 7) (67 8 12) simpleGrading (1 1 1) );")
    n_it = 180 if converged else 3000
    hist = [{"t": i, "U": 10 ** (-i / 30), "p": 10 ** (-i / 28)} for i in range(1, n_it + 1)]
    _write(raw, "run-status", {"run": {"run_id": "r1", "status": "done", "iteration": n_it, "n_procs": 4,
                                       "started_at": "2026-11-04T10:01:00Z", "finished_at": "2026-11-04T10:03:00Z",
                                       "residuals": hist}})
    _write(raw, "health", {"health": {"verdict": "healthy", "findings": []}, "checking": False})
    _write(raw, "precheck", {"status": 200, "body": {"checks": [{"code": "still_start", "level": "info", "text": "From rest."}]}})
    _write(raw, "solver-log-start", {"lines": ["| Version:  2606 |", "Build  : _481094f-20260618 OPENFOAM=2606"]})
    _write(raw, "solver-log-end", {"lines": ["", "SIMPLE solution converged in 180 iterations" if converged else "", "End"]})
    q = AREA * 1.0
    p_in = 32 * NU / D**2 * L
    # The inlet pressure's history: settled, or still moving by `drift` over the last 10 %.
    p_hist = [{"t": i, "p_Pa": p_in * (1 + drift * max(0.0, (i - 0.9 * n_it) / (0.1 * n_it)))} for i in range(1, n_it + 1)]
    _write(raw, "monitors", {"monitors": [
        {"key": "mon_inlet", "patch": "inlet", "area_m2": AREA, "last": {"Q_m3s": -q, "p_Pa": p_in}, "series": p_hist},
        {"key": "mon_outlet", "patch": "outlet", "area_m2": AREA, "last": {"Q_m3s": q}},
    ], "custom": [
        {"key": f"probes_centreline_{i}", "point": [i * D, 0, 0], "last": {"U": [_centreline(i * D), 0.0, 0.0]},
         "series": [{"t": k, "U": [_centreline(i * D), 0.0, 0.0]} for k in range(1, n_it + 1)]}
        for i in range(1, 15)
    ]})
    if samples:
        _write(raw, "sample_cells_window", _cells())
        _write(raw, "sample_wall_shear", _wall_shear())
    if lines:
        xs = [L * i / 300 for i in range(301)]
        # Developed: -dp/dx = 32 nu U / D² (rho = 1) after a short entrance.
        g = 32 * NU * 1.0 / D**2
        _write(raw, "line_p_axis", _line(xs, [g * (L - x) for x in xs]))
        _write(raw, "line_u_axis", _line(xs, [_centreline(x) for x in xs]))
        ys = [-D / 2 + D * i / 100 for i in range(101)]
        _write(raw, "line_u_radial", _line(ys, [2.0 * (1 - (y / (D / 2)) ** 2) for y in ys], axis=1, fixed=(0.24, 0, 0)))


def plan_run(tmp_path: Path) -> Path:
    run_dir = tmp_path / "run"
    make_plan(cases.get("c1"), "hexdominant", run_dir, cores=4)
    return run_dir
