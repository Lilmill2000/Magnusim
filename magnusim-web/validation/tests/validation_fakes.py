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


def fake_run(run_dir: Path, *, layers_applied: bool = True, driver: dict | None = None, lines: bool = True) -> None:
    """A run's raw answers as the driver saves them, for an exact developed pipe flow."""
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
    hist = [{"t": i, "U": 10 ** (-i / 30), "p": 10 ** (-i / 28)} for i in range(1, 181)]
    _write(raw, "run-status", {"run": {"run_id": "r1", "status": "done", "iteration": 180, "n_procs": 4,
                                       "started_at": "2026-11-04T10:01:00Z", "finished_at": "2026-11-04T10:03:00Z",
                                       "residuals": hist}})
    _write(raw, "health", {"health": {"verdict": "healthy", "findings": []}, "checking": False})
    _write(raw, "precheck", {"status": 200, "body": {"checks": [{"code": "still_start", "level": "info", "text": "From rest."}]}})
    _write(raw, "solver-log-start", {"lines": ["| Version:  2606 |", "Build  : _481094f-20260618 OPENFOAM=2606"]})
    _write(raw, "solver-log-end", {"lines": ["", "SIMPLE solution converged in 180 iterations", "End"]})
    q = AREA * 1.0
    _write(raw, "monitors", {"monitors": [
        {"key": "mon_inlet", "patch": "inlet", "area_m2": AREA, "last": {"Q_m3s": -q}},
        {"key": "mon_outlet", "patch": "outlet", "area_m2": AREA, "last": {"Q_m3s": q}},
    ], "custom": [
        {"key": f"probes_centreline_{i}", "point": [i * D, 0, 0], "last": {"U": [_centreline(i * D), 0.0, 0.0]}}
        for i in range(1, 15)
    ]})
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
