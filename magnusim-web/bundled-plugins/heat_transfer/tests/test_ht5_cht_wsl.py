"""HT5 WSL proofs: conjugate heat transfer cases set up as a study, meshed by the app's
mesher and run the way Start runs them (the runner's relay: this plugin's prepare job
writes the case, the WSL pre-step ``splitMeshRegions`` splits it, solve.sh runs
chtMultiRegionSimpleFoam / chtMultiRegionFoam), then read back through the
analysis's own ``run_monitors`` (OpenFOAM v2606).

1. A composite wall: two solids side by side (steel 10 mm, stainless steel 20 mm),
   their outer faces at 100 °C and 20 °C, every other face adiabatic. The heat
   through it and the temperature profile match the 1D solution
   q = ΔT / (L1/k1 + L2/k2), within 1 %.
2. A heated block (stainless steel 40 x 40 x 10 mm) with a 10 W heat source, cooled
   through its bottom face by h = 500 W/(m²·K) to 20 °C, every other face adiabatic:
   the heat out is 10 W within 1 %, and its highest temperature is the 1D estimate
   T_a + Q/(h A) + q''' L² / (2 k) within 5 % of its rise. The same block with the
   source given per volume (625 000 W/m³) gives the same 10 W.
3. A heat sink in a channel: an aluminium sink (base and fins) on the floor of an
   air channel, 10 W in the sink, air at 20 °C and 0.5 m/s, gravity. The source's
   power equals m·cp·ΔT_bulk of the air within 2 % (the energy balance) averaged over
   the run's last third (the steady solve swings about it: the test says why), gauge
   pressure throughout. Built as CAD's Enclosure + Combine leave such a part: the
   sink and the channel's box minus the sink, sharing the sink's faces (OCP here:
   the CAD workspace runs in the browser and is not scripted).
   Its highest temperature against the same sink on a finer mesh (the reference).
4. The same sink, transient, on 2 ranks: 20 time steps that write per-region
   frames, then continued 10 steps more.
5. Two separate aluminium blocks (one material) in an air channel, 1 W in the
   material (forced convection): one region of two pieces (splitMeshRegions -cellZonesOnly), every cell
   in a region, the interfaces named as ever, both blocks heated, the heat carried
   out.
6. A closed box of air with a heated block inside (natural convection, no
   opening, the box's walls at 20 °C): it solves, and the heat out through the walls
   is the source.
7. The composite wall on a Standard mesh (tetrahedra), with the default numerics
   and with corrected schemes: the error the study panel's note states.

Heat sources are set on the solid's material record (``heat_source_W``,
``heat_source_W_m3``), as the Materials panel saves them.

``pytest -m wsl bundled-plugins/heat_transfer/tests/test_ht5_cht_wsl.py -s``; minutes each.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

pytestmark = [pytest.mark.wsl, pytest.mark.occt, pytest.mark.slow]

STEEL = {"name": "Steel (plain carbon, AISI 1010)", "material_model": "thermo_solid", "preset": "steel", "density": 7832.0,
         "specific_heat": 434.0, "thermal_conductivity": 63.9}
STAINLESS = {"name": "Stainless steel 304", "material_model": "thermo_solid", "preset": "stainless_304", "density": 7900.0,
             "specific_heat": 477.0, "thermal_conductivity": 14.9}
ALUMINIUM = {"name": "Aluminium 6061", "material_model": "thermo_solid", "preset": "aluminium_6061", "density": 2700.0,
             "specific_heat": 896.0, "thermal_conductivity": 167.0}
AIR = {"name": "Air", "material_model": "thermo_fluid", "preset": "air", "library": "HT_AIR", "density": 1.204,
       "dynamic_viscosity": 1.825e-5, "specific_heat": 1007.0, "thermal_conductivity": 0.02514, "thermal_expansion": 3.411e-3,
       "molar_mass": 28.97}
OUT = Path(os.environ.get("HT5_PROOF_DIR", "")) if os.environ.get("HT5_PROOF_DIR") else None


def _note(name: str, line: str) -> None:
    print(line)
    if OUT is not None:
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{name}.txt").write_text(line + "\n", encoding="utf-8")


@pytest.fixture
def wsl():
    from ht_cht_wsl import drop_root, wsl_root

    root, base = wsl_root()
    try:
        yield root
    finally:
        drop_root(base)


def _frames(case: Path) -> list[float]:
    return sorted(float(d.name) for d in case.iterdir() if d.is_dir() and d.name.replace(".", "").replace("e-", "").isdigit()
                  and float(d.name) > 0)


def _row(answer: dict[str, Any], name: str) -> dict[str, Any]:
    return next(r for r in [*answer["custom"], *answer["monitors"]] if r["name"] == name)


# ---------------------------------------------------------------------------
# 1. Composite wall
# ---------------------------------------------------------------------------


def test_composite_wall_matches_the_1d_solution(tmp_path: Path, wsl: str) -> None:
    line, err_in, err_out, worst, _info = _composite_wall(tmp_path, wsl, mesher=os.environ.get("HT5_WALL_MESHER", "snappy"))
    _note("ht5-composite-wall", line)
    assert err_in < 0.01 and err_out < 0.01, line
    assert worst < 0.01, line


@pytest.mark.parametrize("numerics", ["robust", "accurate"])
def test_composite_wall_on_a_standard_mesh_reads_the_heat_the_note_says(tmp_path: Path, wsl: str, numerics: str) -> None:
    """Tetrahedra: the temperatures are right, the wall heat reads high (the boundary
    gradient of a tet next to a wall); "accurate" numerics are the corrected schemes
    (Gauss linear corrected, snGrad corrected) for the solids too."""
    import re

    ui = (Path(__file__).resolve().parents[1] / "ui" / "StudySettings.tsx").read_text(encoding="utf-8")
    note_pct = float(re.search(r"STANDARD_HEAT_HIGH_PCT = (\d+(?:\.\d+)?)", ui).group(1))  # type: ignore[union-attr]
    line, err_in, err_out, worst, _info = _composite_wall(tmp_path, wsl, mesher="standard", numerics=numerics)
    _note(f"ht5-composite-wall-standard-{numerics}", line)
    assert worst < 0.02, line
    # The note's number ("about N % high") is what the default numerics read.
    if numerics == "robust":
        assert abs(100 * err_in - note_pct) < 2.0, line


def _composite_wall(
    tmp_path: Path, wsl: str, *, mesher: str, numerics: str = "robust"
) -> tuple[str, float, float, float, dict[str, Any]]:
    """The wall solved: (line, |heat in error|, |heat out error|, worst cell off the 1D
    profile as a share of ΔT, the numbers: analytic and measured heat, cells, iterations)."""
    import numpy as np
    from ht_cht_wsl import (
        box,
        cell_centres,
        face_at,
        faces_of,
        internal_values,
        mesh,
        ok,
        ready,
        solve,
        step_of,
        study,
    )

    from heat_transfer.results import run_monitors

    step = step_of(tmp_path / "wall.step", [box(0, 0, 0, 10, 10, 10), box(10, 0, 0, 20, 10, 10)])
    rows = faces_of(step)
    hot, cold = face_at(rows, 0, 0.0, -1, body=1), face_at(rows, 0, 30.0, 1, body=2)
    t1, t2 = 373.15, 293.15
    bcs = [
        {"id": "bc-hot", "name": "hot", "bc_type": "Solid wall", "faces": [hot], "thermal_condition": "temperature",
         "wall_temperature": t1},
        {"id": "bc-cold", "name": "cold", "bc_type": "Solid wall", "faces": [cold], "thermal_condition": "temperature",
         "wall_temperature": t2},
    ]
    mats = [{"id": "m-steel", **STEEL, "assigned_volumes": ["Body1"]}, {"id": "m-ss", **STAINLESS, "assigned_volumes": ["Body2"]}]
    iterations = int(os.environ.get("HT5_WALL_ITERATIONS", "600"))
    proj = study(tmp_path, step, materials=mats, bcs=bcs,
                 settings={"gravity": "off", "turbulence_model": "laminar", "numerics_preset": numerics},
                 control={"endTime": iterations, "writeInterval": iterations})
    res = mesh(proj, mesher=mesher, fineness=int(os.environ.get("HT5_WALL_FINENESS", "3")))
    assert [r["role"] for r in res["regions"]] == ["solid", "solid"], res["regions"]
    assert ready(proj) == []
    run = {"result_controls": [
        {"id": "mon-hot", "name": "Hot face", "monitor_type": "ht_wall_heat_flux", "boundaries": ["bc-hot"]},
        {"id": "mon-cold", "name": "Cold face", "monitor_type": "ht_wall_heat_flux", "boundaries": ["bc-cold"]},
    ]}
    code, events, case, _rid = solve(proj, wsl, run=run)
    ok(code, events, case)
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    names = [r["name"] for r in side["regions"]]
    assert [r["role"] for r in side["regions"]] == ["solid", "solid"] and side["pre_steps"][0]["tool"] == "splitMeshRegions"
    answer = run_monitors(case)
    k1, k2, l1, l2, area = 63.9, 14.9, 0.01, 0.02, 1e-4
    q = (t1 - t2) / (l1 / k1 + l2 / k2)
    q_hot = _row(answer, "Hot face")["last"]["Q_W"]
    q_cold = _row(answer, "Cold face")["last"]["Q_W"]
    err_in = (q_hot - q * area) / (q * area)
    err_out = (-q_cold - q * area) / (q * area)
    # The profile: T(x) in each solid against the 1D line through the interface temperature.
    t_iface = t1 - q * l1 / k1
    last = max(_frames(case))
    worst = 0.0
    for name in names:
        tf = case / f"{last:g}" / name / "T"
        vals = internal_values(tf)
        xs = cell_centres(case / "constant" / name / "polyMesh")[:, 0]
        exact = np.where(xs <= l1, t1 - (t1 - t_iface) * xs / l1, t_iface - (t_iface - t2) * (xs - l1) / l2)
        worst = max(worst, float(np.max(np.abs(vals - exact))) / (t1 - t2))
    schemes = (case / "system" / names[0] / "fvSchemes").read_text(encoding="utf-8")
    lap = schemes.split("laplacianSchemes", 1)[1].split(";", 1)[0].replace("{", "").replace("default", "").strip()
    line = (f"composite wall (steel 10 mm | stainless 20 mm, 100 °C | 20 °C), {mesher} mesh, {numerics} numerics (solids: "
            f"laplacian {lap}): analytic {q * area:.5f} W, heat in {q_hot:.5f} W ({100 * err_in:+.3f} %), out {-q_cold:.5f} W "
            f"({100 * err_out:+.3f} %), interface T {t_iface:.3f} K, worst cell T off the 1D profile {100 * worst:.3f} % of ΔT, "
            f"{res.get('n_cells')} cells, {iterations} iterations, balance {answer['summary']}")
    info = {"q_analytic_W": q * area, "q_in_W": q_hot, "q_out_W": -q_cold, "worst_share": worst, "t_iface_K": t_iface,
            "cells": res.get("n_cells"), "iterations": int(last), "mesher": mesher, "case": case}
    return line, abs(err_in), abs(err_out), worst, info


# ---------------------------------------------------------------------------
# 2. Heated block
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["power", "density"])
def test_heated_block_gives_its_source_out_and_its_1d_temperature(tmp_path: Path, wsl: str, mode: str) -> None:
    line, info = _heated_block(tmp_path, wsl, mode)
    _note(f"ht5-heated-block-{mode}", line)
    power = info["power_W"]
    assert abs(info["source_W"] - power) / power < 0.01, line
    assert abs(info["out_W"] - power) / power < 0.01, line
    assert info["rise_error"] < 0.05, line


def _heated_block(tmp_path: Path, wsl: str, mode: str) -> tuple[str, dict[str, Any]]:
    """The block solved: (line, its numbers: source, heat out, T_max and its 1D estimate,
    cells, iterations)."""
    from ht_cht_wsl import box, face_at, faces_of, mesh, ok, ready, solve, step_of, study

    from heat_transfer.results import run_monitors

    step = step_of(tmp_path / "block.step", [box(0, 0, 0, 40, 40, 10)])
    rows = faces_of(step)
    bottom = face_at(rows, 2, 0.0, -1)
    h, ta, power, k = 500.0, 293.15, 10.0, 14.9
    area, thick = 0.04 * 0.04, 0.01
    q_vol = power / (area * thick)
    bcs = [{"id": "bc-cool", "name": "cooled", "bc_type": "Solid wall", "faces": [bottom],
            "thermal_condition": "heat_transfer_coefficient", "wall_htc": h, "ambient_temperature": ta}]
    source = {"heat_source_W": power} if mode == "power" else {"heat_source_W_m3": q_vol}
    mats = [{"id": "m-ss", **STAINLESS, "assigned_volumes": ["Body1"], **source}]
    iterations = int(os.environ.get("HT5_BLOCK_ITERATIONS", "800"))
    proj = study(tmp_path, step, materials=mats, bcs=bcs, settings={"gravity": "off", "turbulence_model": "laminar"},
                 control={"endTime": iterations, "writeInterval": iterations})
    res = mesh(proj, mesher="snappy", fineness=int(os.environ.get("HT5_BLOCK_FINENESS", "3")))
    assert not res.get("regions"), res.get("regions")
    assert ready(proj) == []
    run = {"result_controls": [{"id": "mon-cool", "name": "Cooled face", "monitor_type": "ht_wall_heat_flux",
                                "boundaries": ["bc-cool"]}]}
    code, events, case, _rid = solve(proj, wsl, run=run)
    ok(code, events, case)
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert len(side["regions"]) == 1 and "pre_steps" not in side and side["sources_W"] > 0
    answer = run_monitors(case)
    out = -_row(answer, "Cooled face")["last"]["Q_W"]
    body = next(r for r in answer["monitors"] if r.get("region"))
    t_max = body["last"]["T_max_K"]
    t_est = ta + power / (h * area) + q_vol * thick**2 / (2 * k)
    rise_err = abs((t_max - ta) - (t_est - ta)) / (t_est - ta)
    line = (f"heated block (stainless 40x40x10 mm, {mode}: {source}, h {h:g} to {ta - 273.15:g} °C): source in the case "
            f"{side['sources_W']:.5f} W, heat out {out:.5f} W ({100 * abs(out - power) / power:.3f} %), T_max {t_max:.3f} K vs 1D "
            f"{t_est:.3f} K (rise {100 * rise_err:.2f} % off), {res.get('n_cells')} cells, balance {answer['summary']}")
    times = [float(d.name) for d in case.iterdir() if d.is_dir() and d.name.replace(".", "").isdigit()]
    info = {"power_W": power, "source_W": side["sources_W"], "out_W": out, "t_max_K": t_max, "t_est_K": t_est,
            "rise_error": rise_err, "cells": res.get("n_cells"), "iterations": int(max(times)), "case": case}
    return line, info


# ---------------------------------------------------------------------------
# 3 and 4. A heat sink in a channel
# ---------------------------------------------------------------------------

U_IN = float(os.environ.get("HT5_SINK_SPEED", "0.5"))
T_IN = 293.15


def sink_part(path: Path) -> Path:
    """The channel (200 x 50 x 50 mm, flow along +X) with an aluminium sink on its floor: a
    40 x 5 x 40 mm base and 4 fins 4 mm thick, 20 mm tall, along the flow. Body1 is the air
    (the channel's box minus the sink), Body2 the sink; they share the sink's faces."""
    from ht_cht_wsl import box, cut, fuse_all, step_of

    base = box(80, 0, 5, 40, 5, 40)
    fins = [box(80, 5, z, 40, 20, 4) for z in (5, 17, 29, 41)]
    sink = fuse_all([base, *fins])
    air = cut(box(0, 0, 0, 200, 50, 50), sink)
    return step_of(path, [air, sink])


def _sink_project(tmp: Path, fineness: int, *, gravity: str = "-y", iterations: int | None = None) -> tuple[Path, dict[str, Any]]:
    from ht_cht_wsl import face_at, faces_of, mesh, study

    step = sink_part(tmp / "sink.step")
    rows = faces_of(step)
    inlet, outlet = face_at(rows, 0, 0.0, -1, body=1), face_at(rows, 0, 200.0, 1, body=1)
    bcs = [
        {"id": "bc-in", "name": "inlet", "bc_type": "Velocity inlet", "value": U_IN, "unit": "m/s", "faces": [inlet],
         "inlet_temperature": T_IN},
        {"id": "bc-out", "name": "outlet", "bc_type": "Pressure", "value": 0, "unit": "Pa", "faces": [outlet],
         "backflow_temperature": T_IN},
    ]
    mats = [{"id": "m-air", **AIR, "assigned_volumes": ["Body1"]},
            {"id": "m-al", **ALUMINIUM, "assigned_volumes": ["Body2"], "heat_source_W": 10.0}]
    iterations = iterations or int(os.environ.get("HT5_SINK_ITERATIONS", "3000"))
    proj = study(tmp, step, materials=mats, bcs=bcs,
                 settings={"gravity": gravity, "turbulence_model": "laminar", "reference_temperature": T_IN},
                 control={"endTime": iterations, "writeInterval": iterations})
    res = mesh(proj, mesher="snappy", fineness=fineness, threads=8)
    return proj, res


@pytest.fixture(scope="module")
def sink_study(tmp_path_factory: pytest.TempPathFactory):
    """The heat sink study, meshed (Hex-dominant): (project, mesh result)."""
    return _sink_project(tmp_path_factory.mktemp("sink"), int(os.environ.get("HT5_SINK_FINENESS", "4")))


def _sink_solve(proj: Path, res: dict[str, Any], wsl: str) -> tuple[dict[str, Any], dict[str, Any], Path]:
    from ht_cht_wsl import ok, ready, solve

    from heat_transfer.results import run_monitors

    assert sorted(r["role"] for r in res["regions"]) == ["fluid", "solid"], res["regions"]
    assert ready(proj) == []
    run = {"result_controls": [{"id": "mon-tc", "name": "Sink base", "monitor_type": "ht_thermocouple",
                                "points": [[0.1, 0.0025, 0.025]]}]}
    code, events, case, _rid = solve(proj, wsl, run=run, n_procs=int(os.environ.get("HT5_SINK_PROCS", "4")))
    ok(code, events, case)
    return json.loads((case / "w27-case.json").read_text(encoding="utf-8")), run_monitors(case), case


def test_heat_sink_in_a_channel_carries_its_source_out(sink_study, wsl: str) -> None:
    """The energy balance: the heat the air carries out (m·cp·ΔT_bulk, the enthalpy flow
    through the openings), averaged over the run's last third (iterations 2001 to 3000), is
    the source's 10 W within 2 %.

    The average, not the last iteration: with gravity the steady solver never stops at one
    answer here. From about iteration 1500 it repeats a cycle of about 80 iterations in which
    the heat carried out swings 2 to 3 % either side of 10 W (9.71 to 10.34 W measured), so
    one iteration reads anywhere in that band. The sink is settled (it gives the air its
    10 W through their shared faces within 0.01 %); the swing is the air's.

    Where iteration 3000 falls in the cycle changes from run to run, because the mesh and the
    solve's split into ranks change: scotch 7 partitions on several threads and splits the
    same mesh differently each time. A Hex-dominant Generate (snappyHexMesh on 16 ranks)
    gives the same 95,902 cells with a third of them up to 0.13 mm apart, and one mesh split
    4 ways for the solve takes another path from the first iteration. A landing run read
    10.28 W at its last iteration (2.8 % off) where others read 9.96 to 10.12 W. With
    SCOTCH_PTHREAD_NUMBER=1 both repeat exactly; the test keeps the app's own runs.

    Over whole cycles what the iterations store and give back cancels, so the average is the
    balance: 10.002 to 10.014 W (0.02 to 0.14 % off) in all nine runs measured. Nothing
    wrong hides in it: the source in the case must be the 10 W set, the window's two halves
    must agree within 0.5 % (a run still drifting fails) and the swing must stay under 10 %
    of the source. With gravity off (the finer-mesh test below) the swing is about 1 %."""
    from heat_transfer.cht_results import balance_series, region_wall_heat_flux

    proj, res = sink_study
    side, answer, case = _sink_solve(proj, res, wsl)
    power = 10.0
    rho_in = 101325 * 28.97 / (8314.462618 * T_IN)
    mdot = rho_in * U_IN * 0.05 * 0.05
    regions = [str(r["name"]) for r in side["region_rows"]]
    series = balance_series(case, side, {r: region_wall_heat_flux(case, r) for r in regions})
    end = series[-1]["t"]
    window = [s for s in series if s["t"] > end * 2 / 3]
    q = [s["carried_out_W"] for s in window]
    half = len(q) // 2
    carried = sum(q) / len(q)
    halves = (sum(q[:half]) / half, sum(q[half:]) / (len(q) - half))
    swing = (max(q) - min(q)) / power
    drift = abs(halves[1] - halves[0]) / power
    imbalance = sum(s["imbalance"] or 0.0 for s in window) / len(window)
    dt_bulk = carried / (mdot * 1007.0)
    err = abs(carried - power) / power
    last = answer["balance"]
    tc = next(r for r in answer["custom"] if r["name"] == "Sink base")
    body = next(r for r in answer["monitors"] if r.get("region"))
    iface = answer.get("interfaces") or []
    line = (f"heat sink in a channel (air {U_IN} m/s at 20 °C, aluminium sink, 10 W, gravity, laminar): source "
            f"{side['sources_W']:.4f} W, m·cp·ΔT_bulk over iterations {window[0]['t']:g}-{end:g} {carried:.5f} W "
            f"({100 * err:.3f} % off; ΔT_bulk {dt_bulk:.4f} K at m {mdot:.4e} kg/s), halves {halves[0]:.5f} / {halves[1]:.5f} W, "
            f"swing {min(q):.4f} to {max(q):.4f} W ({100 * swing:.2f} % of the source), mean imbalance {100 * imbalance:+.4f} %, "
            f"last iteration {last['carried_out_W']:.5f} W (imbalance {100 * abs(last['imbalance'] or 0):.4f} %), interface heat "
            f"{iface}, sink T_max {body['last']['T_max_K']:.3f} K, thermocouple in the sink ({tc.get('region')}) "
            f"{tc['last']['T_K']:.3f} K, {res.get('n_cells')} cells, regions {[(r['name'], r['cells']) for r in res['regions']]}")
    _note("ht5-heat-sink", line)
    assert tc.get("region") == next(r["name"] for r in res["regions"] if r["role"] == "solid"), line
    assert abs(side["sources_W"] - power) < 1e-6, line
    assert drift < 0.005 and swing < 0.10, line
    assert err < 0.02, line



def test_heat_sink_highest_temperature_against_a_finer_mesh(tmp_path: Path, wsl: str) -> None:
    """The reference for the sink's highest temperature: the same sink (forced convection, so
    the steady solve settles on both meshes; with gravity the finer mesh resolves an unsteady
    plume and a steady solve swings) on the proof's mesh and on a finer one."""
    rows = []
    for fineness in (int(os.environ.get("HT5_SINK_FINENESS", "4")), int(os.environ.get("HT5_SINK_REF_FINENESS", "5"))):
        proj, res = _sink_project(tmp_path / f"f{fineness}", fineness, gravity="off",
                                  iterations=int(os.environ.get("HT5_SINK_REF_ITERATIONS", "3000")))
        _side, answer, _case = _sink_solve(proj, res, wsl)
        body = next(r for r in answer["monitors"] if r.get("region"))
        rows.append((fineness, res.get("n_cells"), body["last"]["T_max_K"] - T_IN, abs(answer["balance"]["imbalance"] or 0)))
    (f1, n1, rise1, imb1), (f2, n2, rise2, imb2) = rows
    line = (f"heat sink T_max (forced convection, 10 W, air 0.5 m/s): fineness {f1} ({n1} cells) rise {rise1:.3f} K "
            f"(imbalance {100 * imb1:.3f} %), fineness {f2} ({n2} cells) rise {rise2:.3f} K (imbalance {100 * imb2:.3f} %): "
            f"{100 * (rise1 - rise2) / rise2:+.2f} %")
    _note("ht5-heat-sink-tmax", line)
    assert imb1 < 0.01 and imb2 < 0.01, line
    assert abs(rise1 - rise2) / rise2 < 0.05, line


def test_heat_sink_transient_on_two_ranks_writes_region_frames_and_continues(sink_study, wsl: str) -> None:
    from ht_cht_wsl import ok, solve

    from heat_transfer.parser import HeatParser

    proj, res = sink_study
    names = [r["name"] for r in res["regions"]]
    tr = {"end_time": 0.04, "write_count": 4, "time_step_mode": "fixed", "delta_t": 0.002}
    code, events, case, rid = solve(proj, wsl, transient=tr, n_procs=2)
    ok(code, events, case)
    frames = _frames(case)
    assert [round(t, 6) for t in frames] == [0.01, 0.02, 0.03, 0.04], frames
    for t in frames:
        for n in names:
            assert (case / f"{t:g}" / n / "T").is_file(), (t, n)
    log = (case / "log.chtMultiRegionFoam").read_text(encoding="utf-8", errors="replace")
    parser = HeatParser()
    for raw in log.splitlines():
        parser.feed(raw)
    steps = parser.snapshot()["residuals"]
    assert len(steps) == 20 and all(any(k.startswith(f"{n}:") for k in steps[-1]) for n in names), steps[-1]
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["transient"]["max_di"] == 10 and side["solver"] == "chtMultiRegionFoam"
    # Continue to 0.06 s: no split again, the saved times and the region meshes kept.
    code, events, case2, _ = solve(proj, wsl, transient=tr, n_procs=2, rid=rid, restart_end=0.06)
    ok(code, events, case2)
    assert not any(e.get("event") == "pre" for e in events), [e for e in events if e.get("event") == "pre"]
    frames2 = _frames(case2)
    assert [round(t, 6) for t in frames2][-2:] == [0.05, 0.06], frames2
    assert all((case2 / "0.06" / n / "T").is_file() for n in names)
    assert (case2 / "log.chtMultiRegionFoam.1").is_file()
    _note("ht5-sink-transient", f"heat sink transient on 2 ranks: 20 steps of 2 ms, frames {frames}, continued to {frames2[-1]} s "
          f"(frames {frames2}), regions {names}, last residuals {steps[-1]}")


# ---------------------------------------------------------------------------
# 5. Two separate blocks of one material
# ---------------------------------------------------------------------------


def test_two_separate_blocks_of_one_material_are_one_region(tmp_path: Path, wsl: str) -> None:
    """splitMeshRegions -cellZonesOnly: the aluminium's two blocks stay one region (with
    -cellZones it walked the mesh and named the pieces domain0 / domain1)."""
    from ht_cht_wsl import box, cut, face_at, faces_of, mesh, ok, ready, solve, step_of, study

    from heat_transfer.polymesh import read_polymesh
    from heat_transfer.results import run_monitors

    power = 1.0
    a, b = box(60, 0, 15, 20, 10, 20), box(120, 0, 15, 20, 10, 20)
    air = cut(cut(box(0, 0, 0, 200, 50, 50), a), b)
    step = step_of(tmp_path / "blocks.step", [air, a, b])
    rows = faces_of(step)
    inlet, outlet = face_at(rows, 0, 0.0, -1, body=1), face_at(rows, 0, 200.0, 1, body=1)
    bcs = [
        {"id": "bc-in", "name": "inlet", "bc_type": "Velocity inlet", "value": 0.5, "unit": "m/s", "faces": [inlet],
         "inlet_temperature": T_IN},
        {"id": "bc-out", "name": "outlet", "bc_type": "Pressure", "value": 0, "unit": "Pa", "faces": [outlet],
         "backflow_temperature": T_IN},
    ]
    mats = [{"id": "m-air", **AIR, "assigned_volumes": ["Body1"]},
            {"id": "m-al", **ALUMINIUM, "assigned_volumes": ["Body2", "Body3"], "heat_source_W": power}]
    iterations = int(os.environ.get("HT5_BLOCKS_ITERATIONS", "2000"))
    proj = study(tmp_path, step, materials=mats, bcs=bcs,
                 settings={"gravity": "off", "turbulence_model": "laminar", "reference_temperature": T_IN},
                 control={"endTime": iterations, "writeInterval": iterations})
    res = mesh(proj, mesher="snappy", fineness=int(os.environ.get("HT5_BLOCKS_FINENESS", "4")), threads=8)
    assert [(r["name"], r["role"], sorted(r["bodies"])) for r in res["regions"]] == [
        ("air", "fluid", ["Body1"]), ("aluminium_6061", "solid", ["Body2", "Body3"])], res["regions"]
    assert ready(proj) == []
    run = {"result_controls": [{"id": "mon-tc", "name": "Blocks", "monitor_type": "ht_thermocouple",
                                "points": [[0.07, 0.005, 0.025], [0.13, 0.005, 0.025]]}]}
    code, events, case, _rid = solve(proj, wsl, run=run, n_procs=4)
    ok(code, events, case)
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["pre_steps"] == [{"tool": "splitMeshRegions", "args": ["-cellZonesOnly", "-overwrite"]}]
    # The regions the split made: exactly the study's, every cell in one, the interfaces as named.
    regions = sorted(p.name for p in (case / "constant").iterdir() if (p / "polyMesh" / "owner").is_file())
    assert regions == ["air", "aluminium_6061"], regions
    whole = read_polymesh(case / "constant" / "polyMesh")
    parts = {r: read_polymesh(case / "constant" / r / "polyMesh") for r in regions}
    assert sum(m.n_cells for m in parts.values()) == whole.n_cells
    assert {p.name for p in parts["air"].patches} >= {"air_to_aluminium_6061"}
    assert {p.name for p in parts["aluminium_6061"].patches} >= {"aluminium_6061_to_air"}
    assert not [p.name for m in parts.values() for p in m.patches if p.name.startswith("domain")]
    answer = run_monitors(case)
    carried = answer["balance"]["carried_out_W"]
    tcs = [r for r in answer["custom"] if r["name"].startswith("Blocks")]
    temps = [r["last"]["T_K"] for r in tcs]
    line = (f"two separate aluminium blocks, one material ({power:g} W in it), air 0.5 m/s, gravity off: regions {regions} "
            f"({[(r, parts[r].n_cells) for r in regions]} of {whole.n_cells} cells), source {side['sources_W']:.4f} W, "
            f"carried out {carried:.5f} W ({100 * abs(carried - power) / power:.3f} % off), thermocouples "
            f"{[(r.get('region'), round(t - 273.15, 3)) for r, t in zip(tcs, temps, strict=True)]} °C, balance {answer['summary']}")
    _note("ht5-two-blocks", line)
    assert all(r.get("region") == "aluminium_6061" for r in tcs) and all(t > T_IN + 0.5 for t in temps), line
    assert abs(carried - power) / power < 0.02, line


# ---------------------------------------------------------------------------
# 6. A closed box with a heated block (natural convection, no opening)
# ---------------------------------------------------------------------------


def test_a_closed_box_with_a_heated_block_solves(tmp_path: Path, wsl: str) -> None:
    from ht_cht_wsl import box, cut, faces_of, mesh, ok, ready, solve, step_of, study

    from heat_transfer.results import run_monitors

    block = box(40, 10, 40, 20, 10, 20)
    air = cut(box(0, 0, 0, 100, 100, 100), block)
    step = step_of(tmp_path / "closed.step", [air, block])
    rows = faces_of(step)
    outer = [f"face {r['id']}@Body1" for r in rows if int(r["body"]) == 1 and not r.get("shared_with")
             and any(abs(c) < 0.05 or abs(c - 100.0) < 0.05 for c in r["centroid"])]
    assert len(outer) == 6, outer
    bcs = [{"id": "bc-box", "name": "box", "bc_type": "Wall", "wall_type": "No-slip", "faces": outer,
            "thermal_condition": "temperature", "wall_temperature": T_IN}]
    mats = [{"id": "m-air", **AIR, "assigned_volumes": ["Body1"]},
            {"id": "m-al", **ALUMINIUM, "assigned_volumes": ["Body2"], "heat_source_W": 2.0}]
    iterations = int(os.environ.get("HT5_CLOSED_ITERATIONS", "2000"))
    proj = study(tmp_path, step, materials=mats, bcs=bcs,
                 settings={"gravity": "-y", "turbulence_model": "laminar", "reference_temperature": T_IN,
                           "density_model": "perfect_gas"},
                 control={"endTime": iterations, "writeInterval": iterations})
    res = mesh(proj, mesher="snappy", fineness=int(os.environ.get("HT5_CLOSED_FINENESS", "3")), threads=8)
    assert ready(proj) == []
    run = {"result_controls": [
        {"id": "mon-box", "name": "Box walls", "monitor_type": "ht_wall_heat_flux", "boundaries": ["bc-box"]},
        {"id": "mon-tc", "name": "Block", "monitor_type": "ht_thermocouple", "points": [[0.05, 0.015, 0.05]]},
    ]}
    code, events, case, _rid = solve(proj, wsl, run=run, n_procs=4)
    ok(code, events, case)
    answer = run_monitors(case)
    out = -_row(answer, "Box walls")["last"]["Q_W"]
    tc = _row(answer, "Block")
    line = (f"closed box of air (100 mm, walls 20 °C) with a 2 W aluminium block, gravity -Y, perfect gas: heat out through "
            f"the walls {out:.5f} W ({100 * abs(out - 2.0) / 2.0:.3f} % off), block {tc['last']['T_K'] - 273.15:.3f} °C, "
            f"{res.get('n_cells')} cells, {iterations} iterations, balance {answer['summary']}")
    _note("ht5-closed-box", line)
    assert tc["last"]["T_K"] > T_IN + 1.0, line
    assert abs(out - 2.0) / 2.0 < 0.02, line


# ---------------------------------------------------------------------------
# The e2e suite's finished CHT case (e2e/fixtures/cht-case)
# ---------------------------------------------------------------------------

FIXTURE_README = """# A finished conjugate heat transfer case (e2e fixture)

The two-box part (python/tests/fixtures/geometry/two-boxes-shared-face.brep: Body1 x 0..10 mm,
Body2 x 10..30 mm, 10 x 10 mm across): air in Body1 coming in at 0.2 m/s and 20 °C through
its x = 0 face and out through a pressure outlet on its y = 10 mm face, Body2 aluminium 6061 with a 0.05 W heat source, its
outer faces adiabatic, gravity -Z, laminar; Hex-dominant mesh, 800 iterations of
chtMultiRegionSimpleFoam (OpenFOAM v2606), written and run through the app's run path by
`test_the_e2e_fixture_cht_case` in tests/test_ht5_cht_wsl.py (HT5_WRITE_FIXTURE=1 rewrites it).
Monitors: a thermocouple with a point in each body, the outlet's surface temperature.
`ht5-cht.spec.js` copies it into a run's case folder to check the results and the Run panel
without WSL.
"""


def test_the_e2e_fixture_cht_case(tmp_path: Path, wsl: str) -> None:
    import shutil

    from cfddesk.cad.io import load_cad, write_geometry
    from ht_cht_wsl import face_at, faces_of, mesh, ok, ready, solve, study

    from heat_transfer.results import run_monitors

    step = tmp_path / "two.step"
    write_geometry(load_cad(Path(__file__).resolve().parents[3] / "python" / "tests" / "fixtures" / "geometry"
                            / "two-boxes-shared-face.brep"), step)
    rows = faces_of(step)
    inlet, outlet = face_at(rows, 0, 0.0, -1, body=1), face_at(rows, 1, 10.0, 1, body=1)
    bcs = [
        {"id": "bc-in", "name": "inlet", "bc_type": "Velocity inlet", "value": 0.2, "unit": "m/s", "faces": [inlet],
         "inlet_temperature": 293.15},
        {"id": "bc-out", "name": "outlet", "bc_type": "Pressure", "value": 0, "unit": "Pa", "faces": [outlet],
         "backflow_temperature": 293.15},
    ]
    mats = [{"id": "m-air", **AIR, "assigned_volumes": ["Body1"]},
            {"id": "m-al", **ALUMINIUM, "assigned_volumes": ["Body2"], "heat_source_W": 0.05}]
    proj = study(tmp_path, step, materials=mats, bcs=bcs,
                 settings={"gravity": "-z", "turbulence_model": "laminar", "reference_temperature": 293.15},
                 control={"endTime": 800, "writeInterval": 800})
    res = mesh(proj, mesher="snappy", fineness=1)
    assert ready(proj) == []
    run = {"result_controls": [
        {"id": "mon-tc", "name": "TC", "monitor_type": "ht_thermocouple", "points": [[0.005, 0.005, 0.005], [0.02, 0.005, 0.005]]},
        {"id": "mon-out", "name": "Outlet T", "monitor_type": "ht_surface_temperature", "boundaries": ["bc-out"]},
    ]}
    code, events, case, _rid = solve(proj, wsl, run=run)
    ok(code, events, case)
    answer = run_monitors(case)
    tcs = [r for r in answer["custom"] if r["name"].startswith("TC")]
    assert [r.get("region") for r in tcs] == ["air", "aluminium_6061"], tcs
    b = answer["balance"]
    _note("ht5-e2e-fixture", f"e2e fixture CHT case: {res.get('n_cells')} cells, balance {answer['summary']}, "
          f"TC {[r['last']['T_K'] for r in tcs]}")
    assert abs(b["heat_in_W"] - b["heat_out_W"]) / b["heat_in_W"] < 0.01
    if os.environ.get("HT5_WRITE_FIXTURE") == "1":
        dest = Path(__file__).resolve().parents[1] / "e2e" / "fixtures" / "cht-case"
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        for name in ("0", "800", "constant", "system", "postProcessing"):
            shutil.copytree(case / name, dest / name)
        for name in ("w27-case.json", "case.foam", "log.chtMultiRegionSimpleFoam"):
            if (case / name).exists():
                shutil.copy(case / name, dest / name)
        (dest / "README.md").write_bytes(FIXTURE_README.encode("utf-8"))


def test_a_cht_run_stops_when_its_monitor_settles(tmp_path: Path, wsl: str) -> None:
    """The settle stop in a case of several regions: its runTimeControl names a region (else it
    never checks), the run ends early, and the log parser says it converged on the monitor."""
    from ht_cht_wsl import box, face_at, faces_of, mesh, ok, solve, step_of, study

    from heat_transfer.parser import HeatParser

    step = step_of(tmp_path / "wall.step", [box(0, 0, 0, 10, 10, 10), box(10, 0, 0, 20, 10, 10)])
    rows = faces_of(step)
    hot, cold = face_at(rows, 0, 0.0, -1, body=1), face_at(rows, 0, 30.0, 1, body=2)
    bcs = [
        {"id": "bc-hot", "name": "hot", "bc_type": "Solid wall", "faces": [hot], "thermal_condition": "temperature",
         "wall_temperature": 373.15},
        {"id": "bc-cold", "name": "cold", "bc_type": "Solid wall", "faces": [cold], "thermal_condition": "temperature",
         "wall_temperature": 293.15},
    ]
    mats = [{"id": "m-steel", **STEEL, "assigned_volumes": ["Body1"]}, {"id": "m-ss", **STAINLESS, "assigned_volumes": ["Body2"]}]
    proj = study(tmp_path, step, materials=mats, bcs=bcs, settings={"gravity": "off", "turbulence_model": "laminar"},
                 control={"endTime": 2000, "writeInterval": 2000})
    mesh(proj, mesher="snappy", fineness=2)
    run = {
        "result_controls": [{"id": "mon-cold", "name": "Cold face", "monitor_type": "ht_wall_heat_flux", "boundaries": ["bc-cold"]}],
        "settle": {"id": "mon-cold", "quantity": "Q", "tolerance": 0.001, "window": 20},
    }
    code, events, case, _rid = solve(proj, wsl, run=run)
    ok(code, events, case)
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert "settleStop" in control and "region          " in control.split("settleStop", 1)[1][:400]
    log = (case / "log.chtMultiRegionSimpleFoam").read_text(encoding="utf-8", errors="replace")
    parser = HeatParser()
    for raw in log.splitlines():
        parser.feed(raw)
    snap = parser.snapshot()
    last = snap["residuals"][-1]["t"]
    _note("ht5-settle", f"CHT settle stop: ended at iteration {last:g} of 2000, parser {snap.get('converged')}")
    assert snap.get("converged", {}).get("by") == "monitor", snap.get("converged")
    assert last < 2000
