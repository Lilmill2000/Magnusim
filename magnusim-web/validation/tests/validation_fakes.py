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


# ---------------------------------------------------------------- case 3: a synthetic cavity flow

def cavity_flow(a: float) -> tuple:
    """psi = a sin²(pi x) sin²(pi y) over U L (x, y over L): zero on the walls, its lowest value a
    at the centre. u = d psi / d y, v = -d psi / d x."""
    import numpy as np

    def u(x, y):
        return a * np.pi * np.sin(np.pi * x) ** 2 * np.sin(2 * np.pi * y)

    def v(x, y):
        return -a * np.pi * np.sin(2 * np.pi * x) * np.sin(np.pi * y) ** 2

    return u, v


def _sampled(points: list, u, v, length: float) -> dict:
    import numpy as np

    pts = np.asarray(points, dtype=float)
    x, y = pts[:, 0] / length, pts[:, 1] / length
    return {"source": "app_sampling", "n_valid": len(points), "sample_points": pts.tolist(),
            "distances": np.hypot(pts[:, 0] - pts[0, 0], pts[:, 1] - pts[0, 1]).tolist(),
            "U_x": u(x, y).tolist(), "U_y": v(x, y).tolist(), "U_z": [0.0] * len(points),
            "p": (0.01 * x + y * y).tolist()}


def _line_points(a: list, b: list, n: int) -> list:
    return [[a[k] + (b[k] - a[k]) * i / (n - 1) for k in range(3)] for i in range(n)]


def fake_cavity_run(run_dir: Path, psi_min: float) -> None:
    """A case 3 run's raw answers for the synthetic flow of ``cavity_flow(psi_min)``."""
    from magnusim_validation.cases import c3_lid_cavity as c3

    fake_run(run_dir, lines=False, samples=False)
    raw = run_dir / "raw"
    # A 2D mesh one cell deep along z, no wall layers.
    _write(raw, "mesh-facts", {"n_cells": 34580, "quality": {"known": True, "ok": True, "max_non_orthogonality": 38.5},
                               "layers": {"asked": False, "applied": False, "walls": []},
                               "two_d": {"axis": "z", "depth_m": 0.01, "cells_across": 1}})
    u, v = cavity_flow(psi_min)
    plan = json.loads((run_dir / "plan.json").read_text(encoding="utf-8"))
    ex = {e["key"]: e for e in plan["extract"]}
    n = ex["u_vertical"]["subdivisions"] + 2
    vert = _sampled(_line_points(*ex["u_vertical"]["points_m"], n), u, v, c3.L)
    _write(raw, "sample_u_vertical", vert)
    _write(raw, "sample_v_horizontal", _sampled(_line_points(*ex["v_horizontal"]["points_m"], n), u, v, c3.L))
    _write(raw, "sample_psi_lines", {"source": "app_sampling", "paths": [
        _sampled(_line_points(*p, n), u, v, c3.L) for p in ex["psi_lines"]["paths_m"]]})
    _write(raw, "line_p_vertical", {"status": 200, "n_valid": n, "values": vert["p"], "sample_points": vert["sample_points"]})
    rows = []
    for rc in plan["run"]["result_controls"]:
        slug = rc["name"].lower().replace(" ", "_")
        for i, pt in enumerate(rc["points"]):
            x, y = pt[0] / c3.L, pt[1] / c3.L
            vec = [float(u(x, y)), float(v(x, y)), 0.0]
            rows.append({"key": f"probes_{slug}_{i + 1}", "point": pt, "last": {"U": vec},
                         "series": [{"t": k, "U": vec} for k in range(1, 181)]})
    _write(raw, "monitors", {"monitors": [], "custom": rows})


# ------------------------------------------------------- case 4: a synthetic backward-step flow

def fake_step_run(run_dir: Path, *, xr_s: float, corner_s: float | None = None, top: tuple[float, float] | None = None,
                  line_shift_s: float = 0.0, reattaches: bool = True) -> None:
    """A case 4 run's raw answers for a synthetic flow along the walls: the floor's flow reversed
    from the step (or from ``corner_s``, a corner eddy's end) to ``xr_s`` and forward after it;
    on the top wall reversed between ``top`` (x_s, x_r2) when given, else forward everywhere; all
    in step heights. The wall shear stress carries OpenFOAM's sign (forward flow negative); U_x
    0.02 S from each wall crosses zero ``line_shift_s`` further on. ``reattaches=False``: the floor
    is reversed all the way to the outlet."""
    import numpy as np
    from magnusim_validation.cases import c4_backward_step as c4

    fake_run(run_dir, lines=False, samples=False)
    raw = run_dir / "raw"
    plan = json.loads((run_dir / "plan.json").read_text(encoding="utf-8"))
    g = c4.GEOM[plan["variant"]]
    s, h, big_h, up, down = (g[k] / 1000.0 for k in ("S", "h", "H", "up", "down"))
    depth = c4.DEPTH_MM / 1000.0
    _write(raw, "mesh-facts", {"n_cells": 170000, "quality": {"known": True, "ok": True, "max_non_orthogonality": 30.0},
                               "layers": {"asked": False, "applied": False, "walls": []},
                               "two_d": {"axis": "z", "depth_m": depth, "cells_across": 1}})
    a = (corner_s if corner_s is not None else -0.1) * s

    def floor_fwd(x):
        if not reattaches:
            return -(1.0 + x)
        return (x - a) * (x - xr_s * s) / s**2

    def top_fwd(x):
        if top is None:
            return 1.0 + 0.0 * x
        return (x - top[0] * s) * (x - top[1] * s) / s**2

    def shear(x, fwd, patch):
        n = x.size
        return {"source": "case_file:4000/wallShearStress", "patch": patch, "n": n, "x": x.tolist(),
                "area": [1e-7] * n, "wallShearStress_x": (-1e-3 * fwd).tolist(), "wallShearStress_y": [0.0] * n,
                "wallShearStress_z": [0.0] * n}

    xf = np.linspace(0.0, down, 1501)[1:] - 0.5 * down / 1500
    _write(raw, "sample_floor_shear", shear(xf, floor_fwd(xf), "floor"))
    xt = np.concatenate([np.linspace(-up, 0.0, 201)[:-1], xf])
    _write(raw, "sample_top_shear", shear(xt, np.where(xt < 0, 1.0, top_fwd(xt)), "top"))

    def line(y, fwd, shift):
        x = np.linspace(0.0, down, 2001)
        pts = [[float(v), y, c4.ZM] for v in x]
        ux = 0.2 * fwd(x - shift * s)
        return {"source": "app_sampling", "n_valid": x.size, "sample_points": pts, "distances": x.tolist(),
                "U_x": ux.tolist(), "U_y": [0.0] * x.size, "U_z": [0.0] * x.size, "p": (1.0 - x / down).tolist()}

    gap = c4.LINE_GAP_S * s
    floor_line = line(gap, floor_fwd, line_shift_s)
    _write(raw, "sample_floor_line", floor_line)
    _write(raw, "sample_top_line", line(big_h - gap, top_fwd, line_shift_s))
    _write(raw, "line_p_floor_line", {"status": 200, "n_valid": floor_line["n_valid"], "values": floor_line["p"],
                                      "sample_points": floor_line["sample_points"]})
    ys = np.linspace(s, big_h, 101)
    eta = (ys - s) / h
    _write(raw, "sample_inlet_profile", {"source": "app_sampling", "n_valid": ys.size,
                                         "sample_points": [[-h, float(y), c4.ZM] for y in ys],
                                         "U_x": (6.0 * eta * (1.0 - eta)).tolist(), "U_y": [0.0] * ys.size,
                                         "U_z": [0.0] * ys.size})
    area = h * depth
    _write(raw, "monitors", {"monitors": [
        {"key": "mon_inlet", "patch": "inlet", "area_m2": area, "last": {"Q_m3s": -area, "p_Pa": 0.4},
         "series": [{"t": i, "p_Pa": 0.4, "Q_m3s": -area} for i in range(1, 181)]},
        {"key": "mon_outlet", "patch": "outlet", "area_m2": big_h * depth, "last": {"Q_m3s": area}},
    ], "balance": {"in_m3s": area, "out_m3s": area * (1 + 1e-6), "imbalance": 1e-6}, "custom": [{"key": "probes_bubble_1", "point": [3 * s, 0.1 * s, c4.ZM], "last": {"U": [-0.1, 0.0, 0.0]},
                   "series": [{"t": k, "U": [-0.1, 0.0, 0.0]} for k in range(1, 181)]}]})


# ------------------------------------------------------------ case 5: a synthetic cylinder flow

def _wake_ux(x, x0: float, d: float):
    """U_x on the wake axis: reversed from the cylinder's back (x = d/2) to ``x0``, forward after."""
    import numpy as np

    return np.tanh((np.asarray(x, dtype=float) - 0.5 * d) * (np.asarray(x, dtype=float) - x0) / d**2)


def fake_cylinder_run(run_dir: Path, *, cd: float = 2.0, ld: float = 0.95, theta_s: float = 44.0,
                      st: float = 0.165, cd_mean: float = 1.34, cl_amp: float = 0.33, ld_mean: float = 1.42,
                      t_on: float = 0.6, tau: float = 0.12, t_end: float = 3.0) -> None:
    """A case 5 run's raw answers. Steady: a drag coefficient settling on ``cd``, U_x on the wake
    axis closing the bubble at L/D = ``ld``, the wall shear stress along the cylinder turning at
    ``theta_s`` degrees from the rear. Transient: a lift coefficient of amplitude ``cl_amp`` at
    St = ``st`` growing in from ``t_on`` (``tau`` its growth's scale), the drag about ``cd_mean``
    at twice the frequency, the wake-axis probes' mean closing at L/D = ``ld_mean``."""
    import numpy as np
    from magnusim_validation.cases import c5_cylinder as c5

    fake_run(run_dir, lines=False, samples=False)
    raw = run_dir / "raw"
    plan = json.loads((run_dir / "plan.json").read_text(encoding="utf-8"))
    transient = c5.TRANSIENT[plan["variant"]]
    d, q_a = c5.D, c5.Q_A
    _write(raw, "mesh-facts", {"n_cells": 76000, "quality": {"known": True, "ok": True, "max_non_orthogonality": 35.0},
                               "layers": {"asked": False, "applied": False, "walls": []},
                               "two_d": {"axis": "z", "depth_m": c5.DEPTH, "cells_across": 1}})
    ex = {e["key"]: e for e in plan["extract"]}
    a, b = ex["wake_line"]["points_m"]
    xs = np.linspace(a[0], b[0], ex["wake_line"]["subdivisions"] + 1)
    pts = [[float(x), 0.0, c5.ZM] for x in xs]
    p_line = (0.5 * np.exp(-(xs - 0.5 * d) / d) - 0.1).tolist()
    probes = c5.wake_probe_points()
    far = {"key": "mon_far_field", "patch": "far_field", "area_m2": 0.017, "last": {"Q_m3s": 0.0, "p_Pa": 0.0}}
    balance = {"in_m3s": 2e-3, "out_m3s": 2e-3, "imbalance": 2e-7}
    if not transient:
        x0 = (0.5 + ld) * d
        ux = _wake_ux(xs, x0, d)
        line = {"source": "app_sampling", "n_valid": xs.size, "sample_points": pts, "distances": (xs - xs[0]).tolist(),
                "U_x": ux.tolist(), "U_y": [0.0] * xs.size, "U_z": [0.0] * xs.size, "p": p_line}
        _write(raw, "sample_wake_line", line)
        _write(raw, "line_p_wake_line", {"status": 200, "n_valid": xs.size, "values": p_line, "sample_points": pts})
        phi = np.linspace(-np.pi, np.pi, 340, endpoint=False) + np.pi / 340
        r = 0.5 * d
        g = np.radians(np.abs(np.degrees(phi)) - theta_s)
        tx, ty = -g * np.sin(phi) * np.sign(phi), g * np.cos(phi) * np.sign(phi)
        _write(raw, "sample_cylinder_shear", {"source": "case_file:900/wallShearStress", "patch": "cylinder",
                                              "n": phi.size, "x": (r * np.cos(phi)).tolist(), "y": (r * np.sin(phi)).tolist(),
                                              "z": [c5.ZM] * phi.size, "area": [1e-7] * phi.size,
                                              "wallShearStress_x": tx.tolist(), "wallShearStress_y": ty.tolist(),
                                              "wallShearStress_z": [0.0] * phi.size})
        n_it = 900
        hist = [{"t": i, "Cd": cd * (1 + 0.5 * math.exp(-i / 60)), "Cl": 1e-6, "Fd_N": cd * (1 + 0.5 * math.exp(-i / 60)) * q_a,
                 "Fl_N": 1e-6 * q_a, "Fdp_N": 0.6 * cd * q_a, "Fdv_N": 0.4 * cd * q_a * (1 + 0.5 * math.exp(-i / 60)) / 1}
                for i in range(1, n_it + 1)]
        # The last step's parts add up to the drag.
        hist[-1]["Fdv_N"] = hist[-1]["Fd_N"] - hist[-1]["Fdp_N"]
        custom = [{"key": "forces_cylinder", "name": "Cylinder", "type": "forces", "series": hist, "last": hist[-1]}]
        custom += [{"key": f"probes_wake_axis_{i + 1}", "point": p, "last": {"U": [float(_wake_ux(p[0], x0, d)), 0.0, 0.0]},
                    "series": [{"t": n_it, "U": [float(_wake_ux(p[0], x0, d)), 0.0, 0.0]}]} for i, p in enumerate(probes)]
        _write(raw, "monitors", {"monitors": [far], "custom": custom, "balance": balance})
        return
    rng = np.random.default_rng(11)
    dt = 0.0012
    base = np.arange(dt, t_end, dt)
    t = np.unique(np.clip(base + rng.uniform(0.0, 0.2 * dt, base.size), 0, t_end))
    f = st / d
    grow = 1.0 / (1.0 + np.exp(-(t - t_on) / tau))
    cl = cl_amp * grow * np.sin(2 * np.pi * f * t)
    cdt = cd_mean + 0.01 * grow * np.cos(4 * np.pi * f * t) + 0.05 * (1 - grow)
    x0 = (0.5 + ld_mean) * d
    series = [{"t": float(t[i]), "Cd": float(cdt[i]), "Cl": float(cl[i]), "Fd_N": float(cdt[i] * q_a),
               "Fl_N": float(cl[i] * q_a), "Fdp_N": float(0.75 * cdt[i] * q_a), "Fdv_N": float(0.25 * cdt[i] * q_a)}
              for i in range(t.size)]
    custom = [{"key": "forces_cylinder", "name": "Cylinder", "type": "forces", "series": series, "last": series[-1]}]
    wave = 0.3 * np.sin(2 * np.pi * f * t)
    for i, p in enumerate(probes):
        u0 = float(_wake_ux(p[0], x0, d))
        rows = [{"t": float(t[k]), "U": [u0 + float(wave[k]), 0.1, 0.0]} for k in range(t.size)]
        custom.append({"key": f"probes_wake_axis_{i + 1}", "point": p, "last": rows[-1], "series": rows})
    sh = [{"t": float(t[k]), "U": [1.0, 0.5 * float(np.sin(2 * np.pi * f * t[k])), 0.0]} for k in range(t.size)]
    custom.append({"key": "probes_shedding_1", "point": [0.02, 0.005, c5.ZM], "last": sh[-1], "series": sh})
    _write(raw, "monitors", {"monitors": [far], "custom": custom, "balance": balance})
    um = _wake_ux(xs, x0 + 0.02 * d, d)
    _write(raw, "sample_umean_line", {"source": "app_sampling", "n_valid": xs.size, "sample_points": pts,
                                      "UMean_x": um.tolist(), "UMean_y": [0.0] * xs.size, "UMean_z": [0.0] * xs.size})
    _write(raw, "sample_wake_line", {"source": "app_sampling", "n_valid": xs.size, "sample_points": pts,
                                     "U_x": um.tolist(), "U_y": [0.1] * xs.size, "U_z": [0.0] * xs.size, "p": p_line})
    _write(raw, "line_p_wake_line", {"status": 200, "n_valid": xs.size, "values": p_line, "sample_points": pts})
    _write(raw, "run-status", {"run": {"run_id": "r1", "status": "done", "iteration": float(t_end), "n_procs": 4,
                                       "started_at": "2026-11-06T10:01:00Z", "finished_at": "2026-11-06T10:11:00Z",
                                       "residuals": [{"t": float(t[k]), "Ux": 1e-6, "p": 1e-5} for k in range(0, t.size, 50)]}})


# --------------------------------------------------------------- case 6: a synthetic sphere flow

def fake_sphere_run(run_dir: Path, *, cd: float = 1.10, ld: float = 0.89, theta_s: float = 53.0,
                    layers: float = 3.6, cross: float = 1e-4) -> None:
    """A case 6 run's raw answers: a drag coefficient settling on ``cd``, U_x on the axis behind
    the sphere closing the bubble at L/D = ``ld``, the wall shear stress along the sphere's
    meridians (OpenFOAM's sign: attached flow against the meridian's direction) turning at
    ``theta_s`` degrees from the rear on faces spread over the sphere, ``layers`` of the 4 wall
    layers on average, a force across the stream of ``cross`` times the drag."""
    import numpy as np
    from magnusim_validation.cases import c6_sphere as c6

    fake_run(run_dir, lines=False, samples=False)
    raw = run_dir / "raw"
    plan = json.loads((run_dir / "plan.json").read_text(encoding="utf-8"))
    d, q_a = c6.D, c6.Q_A
    _write(raw, "mesh-facts", {"n_cells": 260000, "quality": {"known": True, "ok": True, "max_non_orthogonality": 55.0},
                               "layers": {"asked": True, "applied": layers >= 0.5, "first_m": 9e-5,
                                          "walls": [{"patch": "sphere", "layers_asked": 4, "layers": layers,
                                                     "faces": 3500, "first_m": 9e-5}]}})
    ex = {e["key"]: e for e in plan["extract"]}
    a, b = ex["wake_line"]["points_m"]
    xs = np.linspace(a[0], b[0], ex["wake_line"]["subdivisions"] + 1)
    pts = [[float(x), 0.0, 0.0] for x in xs]
    x0 = (0.5 + ld) * d
    ux = _wake_ux(xs, x0, d)
    p_line = (0.3 * np.exp(-(xs - 0.5 * d) / d) - 0.05).tolist()
    _write(raw, "sample_wake_line", {"source": "app_sampling", "n_valid": xs.size, "sample_points": pts,
                                     "distances": (xs - xs[0]).tolist(), "U_x": ux.tolist(), "U_y": [0.0] * xs.size,
                                     "U_z": [0.0] * xs.size, "p": p_line})
    _write(raw, "line_p_wake_line", {"status": 200, "n_valid": xs.size, "values": p_line, "sample_points": pts})
    # Faces spread evenly over the sphere (a Fibonacci lattice), each the same area.
    n = 3000
    k = np.arange(n) + 0.5
    phi = np.arccos(1.0 - 2.0 * k / n)  # from the front stagnation point (x = -r)
    az = np.pi * (1.0 + 5**0.5) * k
    r = 0.5 * d
    x, y, z = -r * np.cos(phi), r * np.sin(phi) * np.cos(az), r * np.sin(phi) * np.sin(az)
    phi_s = np.radians(180.0 - theta_s)
    tang = -np.sin(phi) * (phi_s - phi)  # attached (phi < phi_s): along the meridian, OpenFOAM's sign negative
    e = np.stack([np.sin(phi), np.cos(phi) * np.cos(az), np.cos(phi) * np.sin(az)])
    tau = tang * e
    _write(raw, "sample_sphere_shear", {"source": "case_file:900/wallShearStress", "patch": "sphere", "n": n,
                                        "x": x.tolist(), "y": y.tolist(), "z": z.tolist(),
                                        "area": [math.pi * d * d / n] * n, "wallShearStress_x": tau[0].tolist(),
                                        "wallShearStress_y": tau[1].tolist(), "wallShearStress_z": tau[2].tolist()})
    n_it = 900

    def cd_at(i: int) -> float:
        return cd * (1 + 0.5 * math.exp(-i / 60))

    hist = [{"t": i, "Cd": cd_at(i), "Cl": 1e-5, "Fd_N": cd_at(i) * q_a, "Fl_N": 1e-5 * q_a,
             "Fdp_N": 0.55 * cd * q_a, "Fdv_N": cd_at(i) * q_a - 0.55 * cd * q_a,
             "F_N": [cd_at(i) * q_a, cross * cd_at(i) * q_a, 0.0]} for i in range(1, n_it + 1)]
    custom = [{"key": "forces_sphere", "name": "Sphere", "type": "forces", "series": hist, "last": hist[-1]}]
    custom += [{"key": f"probes_wake_axis_{i + 1}", "point": p, "last": {"U": [float(_wake_ux(p[0], x0, d)), 0.0, 0.0]},
                "series": [{"t": n_it, "U": [float(_wake_ux(p[0], x0, d)), 0.0, 0.0]}]}
               for i, p in enumerate(c6.wake_probe_points())]
    far = {"key": "mon_far_field", "patch": "far_field", "area_m2": 0.45, "last": {"Q_m3s": 0.0, "p_Pa": 0.0}}
    _write(raw, "monitors", {"monitors": [far], "custom": custom})
