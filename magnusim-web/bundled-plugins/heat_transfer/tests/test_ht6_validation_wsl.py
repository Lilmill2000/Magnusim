"""The validation set (HT6): textbook heat transfer cases against published values,
each set up as a study, meshed by the app's mesher and run the way Start runs it (the
runner's relay: this plugin's prepare job, solve.sh), then measured from its monitors
and its saved fields. Report-only: a case passes when it ran and produced its numbers;
the rows go to ``validation/results.json`` (``HT_VALIDATION_OUT``), and
``validation/report.py`` writes VALIDATION.md from them.

Hex-dominant for every case; the pipes on Standard as well.

1. de Vahl Davis's square cavity (1983), Ra = 1e3, 1e4, 1e5, 1e6, Pr = 0.71: the hot
   wall's average and highest Nusselt numbers (a slab with symmetry on both sides). The
   slab is 40 mm deep (0.4 L): Hex-dominant's background cells are cubes only when the
   part is about that deep; a 3 mm slab gets cells ten times flatter than wide, and its
   steady solve was still creeping after 6000 iterations (Ra 1e5) where the 40 mm slab
   settled in about 1000.
2. A laminar pipe, fully developed: Nu = 4.364 with a fixed wall heat flux, 3.657 with a
   fixed wall temperature (Shah & London 1978).
3. A turbulent pipe (Re = 50 000, k-omega SST, wall functions) with a fixed wall heat
   flux, against Gnielinski's correlation (1976).
4. The composite wall and the heated block of the HT5 proofs (analytic 1D solutions).

Only selected with ``-m validation`` (or ``HT_VALIDATION=1``): ``pytest -m validation
../bundled-plugins/heat_transfer/tests -s`` from ``python/``: about two hours one case after
another (each solve on 8 cores, ``HT6_PROCS``).
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any

import pytest

pytestmark = [pytest.mark.wsl, pytest.mark.occt, pytest.mark.slow, pytest.mark.validation]

PROCS = int(os.environ.get("HT6_PROCS", "8"))
G = 9.80665

DE_VAHL_DAVIS = "G. de Vahl Davis, Natural convection of air in a square cavity: a bench mark numerical solution, Int. J. Numer. Methods Fluids 3 (1983) 249-264, Table IV"
SHAH_LONDON = "R. K. Shah and A. L. London, Laminar Flow Forced Convection in Ducts, Academic Press (1978), circular duct, fully developed"
GNIELINSKI = "V. Gnielinski, New equations for heat and mass transfer in turbulent pipe and channel flow, Int. Chem. Eng. 16 (1976) 359-368, with Petukhov's friction factor"


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


@pytest.fixture
def wsl():
    from ht_cht_wsl import drop_root, wsl_root

    root, base = wsl_root()
    try:
        yield root
    finally:
        drop_root(base)


def _custom_fluid(*, rho: float, mu: float, cp: float, k: float, beta: float, body: str = "Body1") -> dict[str, Any]:
    return {"id": "m-fluid", "name": "Test fluid", "material_model": "thermo_fluid", "preset": "custom", "density": rho,
            "dynamic_viscosity": mu, "specific_heat": cp, "thermal_conductivity": k, "thermal_expansion": beta,
            "molar_mass": 28.97, "assigned_volumes": [body]}


def _inflate(proj: Path, groups: list[list[str]], *, n_layers: int, growth: float = 1.2, relative: float = 1.0) -> None:
    """An Inflate boundary layer on each group of faces (each a BC's own faces, so its patch
    stays that BC's), saved in the mesh's folder as the Mesh panel saves it
    (``Ref_*/refinement.json``, which Generate reads)."""
    from cfddesk.project.paths import find_mesh, persist_child_item

    folder = Path(find_mesh(proj, "mesh_1", "sim_1")["dir"]) / "refinements"  # type: ignore[index]
    for n, faces in enumerate(groups, start=1):
        rec = {"id": f"ref-layers-{n}", "name": f"Wall layers {n}", "type": "Inflate boundary layer", "mesh_id": "mesh_1",
               "simulation_id": "sim_1", "faces": faces, "n_layers": n_layers, "gradation": "growth_rate",
               "growth_rate": growth, "overall_relative_thickness": relative}
        persist_child_item(folder, "refinement", rec)


def _patch_like(case: Path, word: str) -> str:
    from ht_validation import patch_names

    names = patch_names(case / "constant" / "polyMesh")
    hits = [n for n in names if n == word] or [n for n in names if word in n]
    assert len(hits) == 1, (word, names)
    return hits[0]


def _iterations(case: Path) -> int:
    from ht_validation import last_time

    return int(round(float(last_time(case).name)))


def _mesh_notes(res: dict[str, Any], mesher: str, case: Path | None = None) -> dict[str, Any]:
    from ht_validation import snappy_layers

    out: dict[str, Any] = {"cells": res.get("n_cells")}
    if mesher == "standard":
        out["layers_applied"] = res.get("layers_applied")
    elif case is not None:
        cover = snappy_layers(case)
        if cover:
            out["layers"] = cover
    return out


def _mesh_case(proj: Path) -> Path:
    from cfddesk.project.paths import find_mesh

    return Path(find_mesh(proj, "mesh_1", "sim_1")["dir"]) / "case"  # type: ignore[index]


# ---------------------------------------------------------------------------
# 1. de Vahl Davis cavity
# ---------------------------------------------------------------------------

# Ra: (Nu-bar, the cavity's mean Nusselt number; Nu_max on the hot wall and its height y/L)
# (de Vahl Davis 1983, Table IV). His hot-wall value Nu_0 is noted beside it.
CAVITY_REFERENCE = {1e3: (1.118, 1.505, 0.092), 1e4: (2.243, 3.528, 0.143), 1e5: (4.519, 7.717, 0.081),
                    1e6: (8.800, 17.925, 0.0378)}
CAVITY_NU0 = {1e3: 1.117, 1e4: 2.238, 1e5: 4.509, 1e6: 8.817}
# Nu_max is read on faces between these heights (y/L): the corner faces, where the hot wall
# meets the floor and the roof, are the snapped mesh's and are left out.
PEAK_BAND = (0.01, 0.99)
# A peak further than this from the reference's height (y/L) is flagged in the report.
PEAK_TOLERANCE = 0.03
# Ra: (fineness, iterations, layers on the hot and cold walls).
CAVITY_MESH = {1e3: (4, 1500, 4), 1e4: (4, 2000, 4), 1e5: (4, 2500, 4), 1e6: (5, 4000, 5)}


@pytest.mark.parametrize("ra", sorted(CAVITY_REFERENCE), ids=lambda r: f"Ra{r:.0e}".replace("+0", ""))
def test_de_vahl_davis_cavity(tmp_path: Path, wsl: str, ra: float) -> None:
    import numpy as np
    from ht_cht_wsl import box, face_at, faces_of, mesh, ok, ready, solve, step_of, study
    from ht_foam_fields import patch_values
    from ht_validation import last_time, patch_faces, record, say

    from heat_transfer.results import run_monitors

    tag = f"{ra:.0e}".replace("+0", "")
    length, dt, beta, pr, cp, rho = 0.1, 10.0, 1e-3, 0.71, 1000.0, 1.0
    # Ra = g β ΔT L³ Pr / ν²: the viscosity (and with Pr the conductivity) sets Ra, so
    # β ΔT stays 0.01 in every case (Boussinesq's density barely moves).
    nu = math.sqrt(G * beta * dt * length**3 * pr / ra)
    mu, k = rho * nu, rho * nu * cp / pr
    fineness, iterations, layers = CAVITY_MESH[ra]
    fineness = _env_int(f"HT6_CAVITY_{tag}_FINENESS", fineness)
    iterations = _env_int(f"HT6_CAVITY_{tag}_ITERATIONS", iterations)
    layers = _env_int(f"HT6_CAVITY_{tag}_LAYERS", layers)
    depth = float(os.environ.get("HT6_CAVITY_DEPTH_MM", "40"))
    step = step_of(tmp_path / "cavity.step", [box(0, 0, 0, 100, 100, depth)])
    rows = faces_of(step)
    hot, cold = face_at(rows, 0, 0.0, -1), face_at(rows, 0, 100.0, 1)
    front, back = face_at(rows, 2, 0.0, -1), face_at(rows, 2, depth, 1)
    t_hot, t_cold = 303.15, 293.15
    bcs = [
        {"id": "bc-hot", "name": "hot", "bc_type": "Wall", "wall_type": "No-slip", "faces": [hot],
         "thermal_condition": "temperature", "wall_temperature": t_hot},
        {"id": "bc-cold", "name": "cold", "bc_type": "Wall", "wall_type": "No-slip", "faces": [cold],
         "thermal_condition": "temperature", "wall_temperature": t_cold},
        {"id": "bc-sym", "name": "sym", "bc_type": "Symmetry", "faces": [front, back]},
    ]
    proj = study(tmp_path, step, materials=[_custom_fluid(rho=rho, mu=mu, cp=cp, k=k, beta=beta)], bcs=bcs,
                 settings={"gravity": "-y", "density_model": "boussinesq", "reference_temperature": 0.5 * (t_hot + t_cold),
                           "turbulence_model": "laminar", "numerics_preset": "accurate", "residual_target": 1e-9,
                           "n_non_orthogonal": 1, "relax_h": 0.9},
                 control={"endTime": iterations, "writeInterval": iterations})
    if layers:
        _inflate(proj, [[hot], [cold]], n_layers=layers)
    res = mesh(proj, mesher="snappy", fineness=fineness, threads=8)
    assert ready(proj) == []
    run = {"result_controls": [
        {"id": "mon-hot", "name": "Hot wall", "monitor_type": "ht_wall_heat_flux", "boundaries": ["bc-hot"]},
        {"id": "mon-cold", "name": "Cold wall", "monitor_type": "ht_wall_heat_flux", "boundaries": ["bc-cold"]},
    ]}
    code, events, case, _rid = solve(proj, wsl, run=run, n_procs=PROCS)
    ok(code, events, case)
    answer = run_monitors(case)
    scale = length / (k * dt)
    hot_row = next(r for r in answer["custom"] if r["name"] == "Hot wall")
    cold_row = next(r for r in answer["custom"] if r["name"] == "Cold wall")
    nu_hot = hot_row["last"]["q_avg_W_m2"] * scale
    nu_cold = -cold_row["last"]["q_avg_W_m2"] * scale
    # The cavity's mean Nusselt number (de Vahl Davis's Nu-bar): the two walls' mean; how far
    # they are apart is the number's uncertainty (a settled, conserving solve has them equal).
    nu_mean = 0.5 * (nu_hot + nu_cold)
    walls_apart = 100.0 * abs(nu_hot - nu_cold) / nu_mean
    # Settled: the mean's spread over the last fifth of the iterations.
    cold_by_t = {s["t"]: -s["q_avg_W_m2"] * scale for s in cold_row["series"]}
    history = [(s["t"], 0.5 * (s["q_avg_W_m2"] * scale + cold_by_t.get(s["t"], s["q_avg_W_m2"] * scale))) for s in hot_row["series"]]
    tail = [n for t, n in history if t >= history[-1][0] * 0.8]
    spread = 100.0 * (max(tail) - min(tail)) / nu_mean
    # The local Nusselt number along the hot wall, from the last saved wall heat flux, on the
    # faces of the slab's middle half (the 2D section: the faces along the edges where the
    # wall meets a symmetry plane are the snapped mesh's) and between PEAK_BAND's heights
    # (not the corner faces at the floor and the roof).
    hot_patch = _patch_like(case, "hot")
    centres, areas = patch_faces(case / "constant" / "polyMesh", hot_patch)
    q = np.broadcast_to(np.asarray(patch_values(last_time(case) / "wallHeatFlux", hot_patch)), areas.shape)
    local = q * scale
    y_rel = centres[:, 1] / length
    mid = (np.abs(centres[:, 2] - depth / 2000) <= depth / 4000) & (y_rel >= PEAK_BAND[0]) & (y_rel <= PEAK_BAND[1])
    at = int(np.flatnonzero(mid)[np.argmax(local[mid])])
    nu_max, y_max = float(local[at]), float(y_rel[at])
    ref_avg, ref_max, ref_y = CAVITY_REFERENCE[ra]
    peak_off = abs(y_max - ref_y)
    its = _iterations(case)
    notes = _mesh_notes(res, "snappy", _mesh_case(proj))
    setup = (f"square cavity L = 0.1 m as a {depth:g} mm slab (symmetry on both faces), ΔT = 10 K, Pr = 0.71, "
             f"β ΔT = 0.01 (Boussinesq), laminar, buoyantSimpleFoam, Accurate numerics")
    mesh_text = f"Hex-dominant fineness {fineness}" + (f", {layers} layers on the hot and cold walls" if layers else "")
    common = {"case": f"de Vahl Davis cavity, Ra = {tag}", "group": "Natural convection", "mesher": "Hex-dominant",
              "iterations": its, "source": DE_VAHL_DAVIS, "setup": setup, "mesh": mesh_text, **notes}
    line = (f"cavity Ra {tag}: Nu mean {nu_mean:.4f} vs {ref_avg} ({100 * (nu_mean / ref_avg - 1):+.2f} %), hot {nu_hot:.4f}, "
            f"cold {nu_cold:.4f} ({walls_apart:.2f} % apart); Nu_max {nu_max:.3f} at y/L {y_max:.4f} vs {ref_max} at {ref_y} "
            f"({100 * (nu_max / ref_max - 1):+.2f} %); spread over the last fifth {spread:.3f} %; {notes}, {its} iterations")
    say(line)
    record([
        {**common, "quantity": "Nu-bar (mean of the hot and cold walls)", "reference": ref_avg, "value": round(nu_mean, 4),
         "uncertainty_pct": round(0.5 * walls_apart, 3), "nu_hot": round(nu_hot, 4), "nu_cold": round(nu_cold, 4),
         "detail": (f"hot wall {nu_hot:.4f} (de Vahl Davis's hot-wall Nu_0 {CAVITY_NU0[ra]}), cold wall {nu_cold:.4f}: "
                    f"{walls_apart:.2f} % apart, half of it the ± here; the mean moved {spread:.3f} % over the last "
                    "fifth of the iterations")},
        {**common, "quantity": "Nu_max (hot wall)", "reference": ref_max, "value": round(nu_max, 4),
         "peak_y": round(y_max, 4), "peak_y_ref": ref_y, "peak_y_off": round(peak_off, 4),
         "peak_y_flag": bool(peak_off > PEAK_TOLERANCE),
         "detail": (f"at y/L = {y_max:.4f} (reference {ref_y}, {peak_off:.4f} off), read on the faces of the slab's "
                    f"middle half between y/L {PEAK_BAND[0]} and {PEAK_BAND[1]} (not the corner faces)")},
    ], case=case)
    assert math.isfinite(nu_mean) and math.isfinite(nu_max), line


# ---------------------------------------------------------------------------
# 2 and 3. Pipes
# ---------------------------------------------------------------------------

D = 0.02
AIR_CONST = {"rho": 1.204, "mu": 1.825e-5, "cp": 1007.0, "k": 0.02514}


def _pipe_step(path: Path, length_mm: float) -> Path:
    from ht_cht_wsl import step_of
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), 1000 * D / 2, length_mm).Shape()
    return step_of(path, [cyl])


def _slices(case: Path, wall_patch: str, start_mm: float, end_mm: float, width_mm: float) -> list[dict[str, float]]:
    """Slices of the pipe between ``start_mm`` and ``end_mm`` along x, each ``width_mm``
    wide: per slice its wall temperature and heat flux (the wall faces' area-weighted
    means), the bulk (mixing-cup) temperature of its cells (sum of u T V over sum of u V),
    and Nu = q D / (k (T_wall − T_bulk))."""
    import numpy as np
    from ht_foam_fields import patch_values
    from ht_validation import cell_geometry, internal_values, last_time, patch_faces

    t = last_time(case)
    poly = case / "constant" / "polyMesh"
    centres, vols = cell_geometry(poly)
    temp = internal_values(t / "T")
    vel = internal_values(t / "U", width=3)
    fc, fa = patch_faces(poly, wall_patch)
    # A uniform patch value is one number for every face.
    tw = np.broadcast_to(np.asarray(patch_values(t / "T", wall_patch)), fa.shape)
    qw = np.broadcast_to(np.asarray(patch_values(t / "wallHeatFlux", wall_patch)), fa.shape)
    out = []
    lo = start_mm / 1000
    while lo < end_mm / 1000 - 1e-9:
        hi = lo + width_mm / 1000
        band = (centres[:, 0] >= lo) & (centres[:, 0] < hi)
        wb = (fc[:, 0] >= lo) & (fc[:, 0] < hi)
        flux = vel[band, 0] * vols[band]
        t_bulk = float(np.sum(flux * temp[band]) / np.sum(flux))
        t_wall = float(np.sum(tw[wb] * fa[wb]) / np.sum(fa[wb]))
        q = float(np.sum(qw[wb] * fa[wb]) / np.sum(fa[wb]))
        nu = q * D / (AIR_CONST["k"] * (t_wall - t_bulk))
        out.append({"x_mm": round(500 * (lo + hi), 3), "t_wall": t_wall, "t_bulk": t_bulk, "q": q, "nu": nu,
                    "cells": int(np.count_nonzero(band))})
        lo = hi
    return out


def _pipe(tmp: Path, wsl: str, *, mesher: str, length_mm: float, re_d: float, thermal: dict[str, Any],
          turbulence: str, fineness: int, iterations: int, layers: int) -> tuple[Path, dict[str, Any], int, float]:
    """A heated pipe (air, constant properties, gravity off) solved: (its case, mesh notes,
    iterations, inlet speed)."""
    from ht_cht_wsl import face_at, faces_of, mesh, ok, ready, solve, study

    step = _pipe_step(tmp / "pipe.step", length_mm)
    rows = faces_of(step)
    inlet, outlet = face_at(rows, 0, 0.0, -1), face_at(rows, 0, length_mm, 1)
    walls = [f"face {r['id']}@Body1" for r in rows if f"face {r['id']}@Body1" not in (inlet, outlet)]
    a = AIR_CONST
    speed = re_d * a["mu"] / (a["rho"] * D)
    bcs = [
        {"id": "bc-in", "name": "inlet", "bc_type": "Velocity inlet", "value": round(speed, 6), "unit": "m/s",
         "faces": [inlet], "inlet_temperature": 293.15},
        {"id": "bc-out", "name": "outlet", "bc_type": "Pressure", "value": 0, "unit": "Pa", "faces": [outlet],
         "backflow_temperature": 293.15},
        {"id": "bc-wall", "name": "heated", "bc_type": "Wall", "wall_type": "No-slip", "faces": walls, **thermal},
    ]
    fluid = _custom_fluid(rho=a["rho"], mu=a["mu"], cp=a["cp"], k=a["k"], beta=3.411e-3)
    proj = study(tmp, step, materials=[fluid], bcs=bcs,
                 settings={"gravity": "off", "density_model": "constant", "reference_temperature": 293.15,
                           "turbulence_model": turbulence, "numerics_preset": "robust", "residual_target": 1e-7},
                 control={"endTime": iterations, "writeInterval": iterations})
    if mesher == "snappy":
        if layers:
            _inflate(proj, [walls], n_layers=layers)
        res = mesh(proj, mesher="snappy", fineness=fineness, threads=8)
    else:
        res = mesh(proj, mesher="standard", fineness=fineness, threads=8,
                   extra=["--hex-core", "1", "--add-layers", "1" if layers else "0"])
    assert ready(proj) == []
    run = {"result_controls": [{"id": "mon-wall", "name": "Wall", "monitor_type": "ht_wall_heat_flux",
                                "boundaries": ["bc-wall"]}]}
    code, events, case, _rid = solve(proj, wsl, run=run, n_procs=PROCS)
    ok(code, events, case)
    return case, _mesh_notes(res, mesher, _mesh_case(proj) if mesher == "snappy" else None), _iterations(case), speed


def _slice_summary(rows: list[dict[str, float]]) -> tuple[float, float, str]:
    """The slices' mean Nu, its uncertainty (the standard error of the mean, % of it) and a
    line of each slice's Nu."""
    nus = [r["nu"] for r in rows]
    mean = sum(nus) / len(nus)
    sd = math.sqrt(sum((n - mean) ** 2 for n in nus) / max(1, len(nus) - 1))
    sem_pct = 100.0 * sd / math.sqrt(len(nus)) / mean
    text = ", ".join(f"{r['x_mm']:g} mm: {r['nu']:.3f}" for r in rows)
    return mean, sem_pct, f"slices {text} (lowest {min(nus):.3f}, highest {max(nus):.3f})"


def _y_plus(case: Path, wall_patch: str, start_mm: float, end_mm: float) -> dict[str, float]:
    """The wall's y+ (OpenFOAM's yPlus function object, run on the solved case's latest
    time: ``buoyantSimpleFoam -postProcess -func yPlus -latestTime`` in a copy of it): its
    lowest, mean and highest over the wall faces between ``start_mm`` and ``end_mm``."""
    import shutil

    import numpy as np
    from ht_foam_fields import patch_values
    from ht_validation import last_time, patch_faces
    from ht_wsl_case import log, run_steps

    work = case.parent / "yplus"
    shutil.copytree(case, work, ignore=shutil.ignore_patterns("processor*", "log.*", "postProcessing"))
    assert run_steps(work, ["buoyantSimpleFoam -postProcess -func yPlus -latestTime"], timeout=1800) == 0, log(
        work, "buoyantSimpleFoam")[-3000:]
    fc, fa = patch_faces(work / "constant" / "polyMesh", wall_patch)
    yp = np.broadcast_to(np.asarray(patch_values(last_time(work) / "yPlus", wall_patch)), fa.shape)
    band = (fc[:, 0] >= start_mm / 1000) & (fc[:, 0] < end_mm / 1000)
    return {"min": round(float(yp[band].min()), 2), "mean": round(float(np.sum(yp[band] * fa[band]) / np.sum(fa[band])), 2),
            "max": round(float(yp[band].max()), 2)}


MESHERS = {"snappy": "Hex-dominant", "standard": "Standard"}
# mesher: (fineness, layers) for the laminar pipes; the turbulent pipe has no layers (wall
# functions; its y+ is measured and recorded).
LAMINAR_MESH = {"snappy": (6, 4), "standard": (6, 1)}
TURBULENT_MESH = {"snappy": 6, "standard": 6}


@pytest.mark.parametrize("mesher", ["snappy", "standard"])
@pytest.mark.parametrize("bc", ["flux", "temperature"])
def test_laminar_pipe_fully_developed_nusselt(tmp_path: Path, wsl: str, mesher: str, bc: str) -> None:
    """Re = 100, Pr = 0.73, a 20 mm pipe 300 mm long; Nu = q D / (k (T_wall − T_bulk)) as the
    mean of ten 10 mm slices from x = 150 to 250 mm (7.5 to 12.5 D: x / (D Re Pr) from 0.10,
    past both entry lengths; the outlet 2.5 D further on)."""
    from ht_validation import record, say

    a = AIR_CONST
    pr = a["mu"] * a["cp"] / a["k"]
    fineness, layers = LAMINAR_MESH[mesher]
    fineness = _env_int(f"HT6_LAMINAR_{mesher.upper()}_FINENESS", fineness)
    layers = _env_int(f"HT6_LAMINAR_{mesher.upper()}_LAYERS", layers)
    iterations = _env_int("HT6_LAMINAR_ITERATIONS", 3000)
    thermal = ({"thermal_condition": "heat_flux", "wall_heat_flux": 10.0} if bc == "flux"
               else {"thermal_condition": "temperature", "wall_temperature": 303.15})
    case, notes, its, speed = _pipe(tmp_path, wsl, mesher=mesher, length_mm=300.0, re_d=100.0, thermal=thermal,
                                    turbulence="laminar", fineness=fineness, iterations=iterations, layers=layers)
    rows = _slices(case, _patch_like(case, "heated"), 150.0, 250.0, 10.0)
    nu, sem_pct, spread = _slice_summary(rows)
    ref = 4.364 if bc == "flux" else 3.657
    label = "fixed wall heat flux (10 W/m²)" if bc == "flux" else "fixed wall temperature (30 °C, inlet 20 °C)"
    line = (f"laminar pipe, {label}, {MESHERS[mesher]}: Nu {nu:.4f} ± {sem_pct:.2f} % vs {ref} ({100 * (nu / ref - 1):+.2f} %), "
            f"{spread}, {notes}, {its} iterations")
    say(line)
    mid = rows[len(rows) // 2]
    mesh_text = f"{MESHERS[mesher]} fineness {fineness}" + (
        f", {layers} layers on the wall" if layers and mesher == "snappy" else (", layers on" if layers else ""))
    record([{
        "case": f"Laminar pipe, {label}", "group": "Forced convection", "quantity": "Nu (fully developed)",
        "reference": ref, "value": round(nu, 4), "uncertainty_pct": round(sem_pct, 3), "mesher": MESHERS[mesher],
        "iterations": its, "source": SHAH_LONDON,
        "setup": (f"pipe D = 20 mm, L = 300 mm, air with constant properties (Pr = {pr:.3f}), Re = 100 "
                  f"(uniform inlet {speed:.4f} m/s at 20 °C), gravity off, laminar, buoyantSimpleFoam; Nu the mean of ten "
                  f"10 mm slices from x = 150 to 250 mm (x / (D Re Pr) from {0.15 / (D * 100 * pr):.2f}), its ± the "
                  "standard error of that mean"),
        "mesh": mesh_text,
        "detail": (f"{spread}; at {mid['x_mm']:g} mm T_wall {mid['t_wall']:.3f} K, T_bulk {mid['t_bulk']:.3f} K (mixing cup), "
                   f"q {mid['q']:.3f} W/m²"),
        **notes,
    }], case=case)
    assert math.isfinite(nu), line


def gnielinski(re_d: float, pr: float) -> float:
    f = (0.79 * math.log(re_d) - 1.64) ** -2
    return (f / 8) * (re_d - 1000) * pr / (1 + 12.7 * math.sqrt(f / 8) * (pr ** (2 / 3) - 1))


@pytest.mark.parametrize("mesher", ["snappy", "standard"])
def test_turbulent_pipe_against_gnielinski(tmp_path: Path, wsl: str, mesher: str) -> None:
    """Re = 50 000, k-omega SST with wall functions, 1000 W/m² on the wall of a 20 mm pipe
    500 mm long; Nu the mean of slices from x = 350 to 450 mm (17.5 to 22.5 D)."""
    from ht_validation import record, say

    a = AIR_CONST
    pr = a["mu"] * a["cp"] / a["k"]
    re_d = 50000.0
    fineness = _env_int(f"HT6_TURBULENT_{mesher.upper()}_FINENESS", TURBULENT_MESH[mesher])
    iterations = _env_int("HT6_TURBULENT_ITERATIONS", 2000)
    case, notes, its, speed = _pipe(tmp_path, wsl, mesher=mesher, length_mm=500.0, re_d=re_d,
                                    thermal={"thermal_condition": "heat_flux", "wall_heat_flux": 1000.0},
                                    turbulence="kOmegaSST", fineness=fineness, iterations=iterations, layers=0)
    patch = _patch_like(case, "heated")
    rows = _slices(case, patch, 350.0, 450.0, 20.0)
    nu, sem_pct, spread = _slice_summary(rows)
    y_plus = _y_plus(case, patch, 350.0, 450.0)
    ref = gnielinski(re_d, pr)
    line = (f"turbulent pipe, {MESHERS[mesher]}: Nu {nu:.3f} vs Gnielinski {ref:.3f} ({100 * (nu / ref - 1):+.2f} %), "
            f"y+ {y_plus}, {spread}, {notes}, {its} iterations")
    say(line)
    mid = rows[len(rows) // 2]
    record([{
        "case": "Turbulent pipe, fixed wall heat flux (1000 W/m²)", "group": "Forced convection",
        "quantity": "Nu (17.5 to 22.5 D from the inlet)", "reference": round(ref, 3), "value": round(nu, 3),
        "uncertainty_pct": round(sem_pct, 3), "mesher": MESHERS[mesher], "iterations": its, "source": GNIELINSKI,
        "y_plus": y_plus, "x_over_d": [17.5, 22.5],
        "setup": (f"pipe D = 20 mm, L = 500 mm, air with constant properties (Pr = {pr:.3f}), Re = 50 000 (uniform inlet "
                  f"{speed:.2f} m/s at 20 °C, the inlet's default turbulence), gravity off, k-omega SST with wall functions "
                  f"(no layers), buoyantSimpleFoam; Nu the mean of five 20 mm slices from x = 350 to 450 mm "
                  "(17.5 to 22.5 D after the uniform inlet: the flow is still developing there, and a developing flow's Nu "
                  "is above the developed one, so the developed value would read lower still)"),
        "mesh": f"{MESHERS[mesher]} fineness {fineness}, no layers",
        "detail": (f"wall y+ in the slices {y_plus['min']} to {y_plus['max']} (mean {y_plus['mean']}); {spread}; at "
                   f"{mid['x_mm']:g} mm T_wall {mid['t_wall']:.3f} K, T_bulk {mid['t_bulk']:.3f} K, q {mid['q']:.2f} W/m². "
                   "An under-prediction not explained yet (Gnielinski's own scatter is about ±10 %)"),
        **notes,
    }], case=case)
    assert math.isfinite(nu), line


# ---------------------------------------------------------------------------
# 4. The HT5 conduction cases
# ---------------------------------------------------------------------------


def test_composite_wall(tmp_path: Path, wsl: str) -> None:
    from ht_validation import record, say
    from test_ht5_cht_wsl import _composite_wall

    line, _ein, _eout, worst, info = _composite_wall(tmp_path, wsl, mesher="snappy")
    say(line)
    record([{
        "case": "Composite wall (steel 10 mm, stainless steel 20 mm)", "group": "Conduction (CHT)",
        "quantity": "Heat through the wall (W)", "reference": round(info["q_analytic_W"], 5), "value": round(info["q_in_W"], 5),
        "mesher": "Hex-dominant", "cells": info["cells"], "iterations": info["iterations"],
        "source": "1D conduction through two layers in series, q = ΔT / (L1/k1 + L2/k2)",
        "setup": ("two solids 10 x 10 mm across, steel (k 63.9) 10 mm and stainless steel 304 (k 14.9) 20 mm, 100 °C and 20 °C on "
                  "their outer faces, every other face adiabatic; chtMultiRegionSimpleFoam"),
        "mesh": "Hex-dominant fineness 3",
        "detail": f"heat out {info['q_out_W']:.5f} W; every cell within {100 * worst:.2f} % of ΔT of the 1D profile",
    }], case=info["case"])


def test_heated_block(tmp_path: Path, wsl: str) -> None:
    from ht_validation import record, say
    from test_ht5_cht_wsl import _heated_block

    line, info = _heated_block(tmp_path, wsl, "power")
    say(line)
    common = {"case": "Heated block (stainless steel, 10 W, h = 500 W/(m²·K))", "group": "Conduction (CHT)",
              "mesher": "Hex-dominant", "cells": info["cells"], "iterations": info["iterations"],
              "setup": ("stainless steel 304 block 40 x 40 x 10 mm, 10 W spread evenly, its bottom cooled by h = 500 W/(m²·K) "
                        "to 20 °C, every other face adiabatic; chtMultiRegionSimpleFoam (one region)"),
              "mesh": "Hex-dominant fineness 3"}
    record([
        {**common, "quantity": "Heat out (W)", "reference": 10.0, "value": round(info["out_W"], 5),
         "source": "energy balance: the source's power"},
        {**common, "quantity": "Highest temperature rise (K)", "reference": round(info["t_est_K"] - 293.15, 4),
         "value": round(info["t_max_K"] - 293.15, 4),
         "source": "1D conduction with a uniform source: Q / (h A) + q''' L² / (2 k)"},
    ], case=info["case"])
