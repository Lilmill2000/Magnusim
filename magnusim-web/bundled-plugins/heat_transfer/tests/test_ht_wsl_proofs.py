"""HT4 WSL proofs: real solves of cases set up as a study, meshed by the app's Standard
mesher and written by the app's run path (``run_case.write_case``: this plugin's writer
inside the case.write hooks, the case stamped for results), then solved with OpenFOAM
v2606 in WSL and read back through the analysis's own ``run_monitors``.

(a) The de Vahl Davis cavity at Ra = 1e5 (Pr = 0.71): a square 0.1 m slab 2 mm thick, one hot and
    one cold wall 10 K apart, adiabatic top and bottom, symmetry front and back, laminar
    Boussinesq, buoyantSimpleFoam. The hot wall's average Nusselt number,
    Nu = q L / (k ΔT), against the benchmark 4.519 (de Vahl Davis 1983).
(b) Forced convection in a pipe: air at 1 m/s and 20 °C into a 20 mm pipe 200 mm long
    whose wall puts in 500 W/m², gravity off. The heat in through the wall equals the
    heat the flow carries out, m cp ΔT (the energy balance), within 1 %.

``pytest -m wsl bundled-plugins/heat_transfer/tests/test_ht_wsl_proofs.py``; minutes each.
The numbers are printed (``-s``) and kept in the test report.
"""

from __future__ import annotations

import dataclasses
import json
import math
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest

pytestmark = [pytest.mark.wsl, pytest.mark.occt, pytest.mark.slow]

WEB = Path(__file__).resolve().parents[3]
PY = WEB / "python"
TOOLS = PY / "tools"
SLAB = Path(__file__).resolve().parents[1] / "e2e" / "fixtures" / "cavity-slab.step"

# Ra = g β ΔT L³ / (ν α) = 1e5 with L = 0.1 m, ΔT = 10 K, β = 1e-3 1/K, Pr = 0.71.
CAVITY_FLUID = {
    "id": "m-cavity",
    "name": "Cavity fluid",
    "material_model": "thermo_fluid",
    "preset": "custom",
    "density": 1.0,
    "dynamic_viscosity": 2.639e-5,
    "specific_heat": 1000.0,
    "thermal_conductivity": 0.03717,
    "thermal_expansion": 1e-3,
    "molar_mass": 28.97,
    "assigned_volumes": ["Body1"],
}
NU_REFERENCE = 4.519


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    return env


def _faces(step: Path) -> list[dict[str, Any]]:
    from cfddesk.cad.io import load_cad
    from cfddesk.cad.preview import face_properties

    return face_properties(load_cad(step).shape)


def _face(rows: list[dict[str, Any]], axis: int, value_mm: float, sign: int) -> str:
    hit = next(r for r in rows if abs(r["centroid"][axis] - value_mm) < 0.5 and math.copysign(1, r["normal"][axis]) == sign)
    return f"face {hit['id']}@Body1"


def _project(tmp: Path, step: Path, bcs: list[dict[str, Any]], materials: list[dict[str, Any]], key: str) -> Path:
    """A project laid out the way the app stores it: the part, one study of ``key`` with
    these BCs and materials, and an empty mesh record."""
    from cfddesk.project import web_writes as ww
    from cfddesk.project.paths import (
        create_geometry_folder,
        create_mesh_folder,
        create_study_folder,
        find_study,
    )

    proj = tmp / "proj"
    proj.mkdir(parents=True)
    for f in (WEB / "e2e" / "fixtures" / "sample-project-steady-state").glob("*.json"):
        shutil.copy(f, proj / f.name)
    doc = {"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{**b, "simulation_id": "sim_1"} for b in bcs]}
    (proj / "boundary_conditions.json").write_text(json.dumps(doc), encoding="utf-8")
    geom = create_geometry_folder(proj, {"id": "geom-ht", "name": step.stem, "original_filename": step.name})
    shutil.copy(step, Path(geom["dir"]) / "source.step")
    create_study_folder(proj, "geom-ht", {"id": "sim_1", "name": "Heat transfer"})
    ident = Path(find_study(proj, "sim_1")["dir"]) / "id.json"  # type: ignore[index]
    ident.write_text(json.dumps({**json.loads(ident.read_text(encoding="utf-8")), "analysis_type": key}) + "\n", encoding="utf-8")
    create_mesh_folder(proj, "sim_1", {"id": "mesh_1", "name": "Mesh 1"})
    mats = [{**m, "simulation_id": "sim_1"} for m in materials]
    ww.set_materials(proj, {"simulation_id": "sim_1", "materials": mats, "only_ids": [m["id"] for m in mats]}, sim_id="sim_1")
    return proj


def _mesh(proj: Path, case: Path, *, fineness: int, threads: int = 4) -> dict[str, Any]:
    from cfddesk.runner.cleanup import remove_wsl_case

    wsl_case = f"cfddesk-ht4-{uuid.uuid4().hex[:8]}"
    argv = [
        sys.executable, str(TOOLS / "generate_standard.py"), "--project-dir", str(proj), "--case-dir", str(case),
        "--wsl-case", wsl_case, "--generate-id", "ht4", "--fineness", str(fineness), "--hex-core", "1",
        "--add-layers", "1", "--threads", str(threads), "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
    ]
    try:
        r = subprocess.run(argv, cwd=str(PY), env=_env(), capture_output=True, text=True, timeout=3600)
    finally:
        remove_wsl_case(wsl_case)
    events = [json.loads(line.split(" ", 1)[1]) for line in r.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    results = [e for e in events if e.get("event") == "result"]
    assert r.returncode == 0 and results and results[-1].get("ok"), (r.returncode, results[-1:], r.stderr[-3000:])
    return results[-1]


def _write_and_solve(proj: Path, mesh_case: Path, out: Path, *, key: str, study: dict[str, Any], run: dict[str, Any],
                     end_time: int, n_procs: int = 1, timeout: float = 3600) -> dict[str, Any]:
    """The run's case as the app writes it, solved in WSL; the analysis's run_monitors answer."""
    from cfddesk.project.run_inputs import gather_run_inputs
    from cfddesk.registry import load_all, reset_for_tests, run_case
    from cfddesk.registry.contract import ReadyContext
    from ht_wsl_case import log, run_steps
    from magnusim_sdk.foam import boundary_patch_names

    from heat_transfer.contract import validate_ready
    from heat_transfer.results import run_monitors

    reset_for_tests()
    load_all()
    inputs = gather_run_inputs(proj, run_id="run_1", mesh_id="mesh_1", simulation_id="sim_1", require_mesh=False,
                               time_dependency="steady", n_procs=n_procs)
    patches = boundary_patch_names(mesh_case / "constant" / "polyMesh" / "boundary")
    inputs = dataclasses.replace(
        inputs,
        analysis_key=key,
        require_mesh=True,
        mesh={"ok": True, "case_dir": str(mesh_case), "patches": patches, "mesh_id": "mesh_1"},
        study={**inputs.study, **study},
        run={**inputs.run, **run},
        simulation_control={"endTime": end_time, "writeInterval": end_time},
    )
    ctx = ReadyContext(
        project_dir=proj, simulation_id="sim_1", run_id="run_1", mesh_id="mesh_1", mesh_case_dir=mesh_case,
        patches=tuple(patches), study=inputs.study, read_study=lambda _n: None,
        materials=tuple(inputs.materials.get("materials") or []), bcs=tuple(inputs.bcs_doc.get("boundary_conditions") or []),
    )
    assert validate_ready(ctx) == []
    report = run_case.write_case(inputs, out, analysis_key=key)
    assert report["ok"], report
    sidecar = json.loads((out / "w27-case.json").read_text(encoding="utf-8"))
    assert sidecar["analysis_key"] == key and sidecar["frame_fields"] == ["T", "U"]
    app = report["solver"]
    if n_procs > 1:
        # As solve.sh runs a parallel case: decompose, every rank, the latest time back.
        steps = ["decomposePar -force", f"mpirun --oversubscribe -np {n_procs} {app} -parallel", "reconstructPar -latestTime"]
        rc = run_steps(out, steps, timeout=timeout)
        text = log(out, "mpirun")
    else:
        rc = run_steps(out, [app], timeout=timeout)
        text = log(out, app)
    assert rc == 0 and "End" in text, text[-3000:]
    return run_monitors(out)


def test_de_vahl_davis_cavity_ra_1e5(tmp_path: Path) -> None:
    rows = _faces(SLAB)
    hot, cold = _face(rows, 0, 0.0, -1), _face(rows, 0, 100.0, 1)
    front, back = _face(rows, 2, 0.0, -1), _face(rows, 2, 2.0, 1)
    bcs = [
        {"id": "bc-hot", "name": "hot", "bc_type": "Wall", "wall_type": "No-slip", "faces": [hot],
         "thermal_condition": "temperature", "wall_temperature": 303.15},
        {"id": "bc-cold", "name": "cold", "bc_type": "Wall", "wall_type": "No-slip", "faces": [cold],
         "thermal_condition": "temperature", "wall_temperature": 293.15},
        {"id": "bc-sym", "name": "sym", "bc_type": "Symmetry", "faces": [front, back]},
    ]
    key = "heat_transfer_steady"
    proj = _project(tmp_path, SLAB, bcs, [CAVITY_FLUID], key)
    mesh_case = tmp_path / "mesh"
    fineness = int(os.environ.get("HT4_CAVITY_FINENESS", "4"))
    res = _mesh(proj, mesh_case, fineness=fineness)
    answer = _write_and_solve(
        proj, mesh_case, tmp_path / "case", key=key,
        study={"gravity": "-y", "density_model": "boussinesq", "reference_temperature": 298.15,
               "turbulence_model": "laminar", "numerics_preset": "accurate", "residual_target": 1e-6,
               "n_non_orthogonal": 1, "relax_h": 0.9},
        run={"result_controls": [{"id": "mon-hot", "name": "Hot wall", "monitor_type": "ht_wall_heat_flux",
                                  "boundaries": ["bc-hot"]}]},
        end_time=int(os.environ.get("HT4_CAVITY_ITERATIONS", "6000")),
        n_procs=int(os.environ.get("HT4_PROCS", "8")),
    )
    row = next(r for r in answer["custom"] if r["name"] == "Hot wall")
    q = row["last"]
    nu = q["q_avg_W_m2"] * 0.1 / (0.03717 * 10.0)
    err = 100.0 * (nu - NU_REFERENCE) / NU_REFERENCE
    imbalance = answer["summary"][2]["value"]
    # Settled: the Nusselt number over the last 1000 iterations stays within 1 % of its end.
    history = [(s["t"], s["q_avg_W_m2"] * 0.1 / (0.03717 * 10.0)) for s in row["series"]]
    tail = [n for t, n in history if t > history[-1][0] - 1000]
    drift = 100.0 * (max(tail) - min(tail)) / nu
    marks = ", ".join(f"{int(t)}: {n:.3f}" for t, n in history if int(t) % 1000 == 0)
    line = (f"de Vahl Davis Ra 1e5: Nu_avg = {nu:.4f} vs {NU_REFERENCE} ({err:+.2f} %), {res.get('n_cells')} cells "
            f"(Standard fineness {fineness}, layers {res.get('layers_applied')}), walls' energy imbalance "
            f"{imbalance:.4f} %, Nu spread over the last 1000 iterations {drift:.3f} % (Nu by iteration: {marks})")
    print(line)
    (tmp_path.parent / "ht4-cavity.txt").write_text(line + "\n", encoding="utf-8")
    assert drift < 1.0, line
    assert abs(err) < 5.0, line
    assert imbalance < 0.5, line


def _pipe_step(path: Path) -> Path:
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    # Along +X from the origin: radius 10 mm, length 200 mm.
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), 10.0, 200.0).Shape()
    w = STEPControl_Writer()
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    w.Transfer(cyl, STEPControl_AsIs)
    w.Write(str(path))
    return path


def test_pipe_with_wall_heat_flux_balances_its_energy(tmp_path: Path) -> None:
    step = _pipe_step(tmp_path / "pipe.step")
    rows = _faces(step)
    inlet, outlet = _face(rows, 0, 0.0, -1), _face(rows, 0, 200.0, 1)
    wall = next(f"face {r['id']}@Body1" for r in rows if f"face {r['id']}@Body1" not in (inlet, outlet))
    q_wall = 500.0
    bcs = [
        {"id": "bc-in", "name": "inlet", "bc_type": "Velocity inlet", "value": 1.0, "unit": "m/s", "faces": [inlet],
         "inlet_temperature": 293.15},
        {"id": "bc-out", "name": "outlet", "bc_type": "Pressure", "value": 0, "unit": "Pa", "faces": [outlet],
         "backflow_temperature": 293.15},
        {"id": "bc-wall", "name": "heated", "bc_type": "Wall", "wall_type": "No-slip", "faces": [wall],
         "thermal_condition": "heat_flux", "wall_heat_flux": q_wall},
    ]
    air = {"id": "m-air", "name": "Air", "material_model": "thermo_fluid", "preset": "air", "library": "HT_AIR",
           "density": 1.204, "dynamic_viscosity": 1.825e-5, "specific_heat": 1007.0, "thermal_conductivity": 0.02514,
           "thermal_expansion": 3.411e-3, "molar_mass": 28.97, "assigned_volumes": ["Body1"]}
    key = "heat_transfer_steady"
    proj = _project(tmp_path, step, bcs, [air], key)
    mesh_case = tmp_path / "mesh"
    fineness = int(os.environ.get("HT4_PIPE_FINENESS", "6"))
    res = _mesh(proj, mesh_case, fineness=fineness)
    answer = _write_and_solve(
        proj, mesh_case, tmp_path / "case", key=key,
        study={"gravity": "off", "reference_temperature": 293.15, "turbulence_model": "laminar",
               "numerics_preset": "robust", "residual_target": 1e-6},
        run={"result_controls": [{"id": "mon-wall", "name": "Heated wall", "monitor_type": "ht_wall_heat_flux",
                                  "boundaries": ["bc-wall"]}]},
        end_time=int(os.environ.get("HT4_PIPE_ITERATIONS", "1500")),
        n_procs=int(os.environ.get("HT4_PROCS", "8")),
    )
    b = answer["balance"]
    q_in = next(r for r in answer["custom"] if r["name"] == "Heated wall")["last"]
    area = q_in["Q_W"] / q_in["q_avg_W_m2"]
    carried = b["carried_out_W"]
    imbalance = 100.0 * abs(b["heat_in_W"] - b["heat_out_W"]) / max(b["heat_in_W"], b["heat_out_W"])
    rho_in = 101325 * 28.97 / (8314.462618 * 293.15)
    mdot = rho_in * 1.0 * math.pi * 0.01**2
    dt_bulk = carried / (mdot * 1007.0)
    line = (f"pipe, 500 W/m² wall: heat in through the wall {q_in['Q_W']:.5f} W (q x mesh wall area {q_wall * area:.5f} W, "
            f"analytic wall area {2 * math.pi * 0.01 * 0.2:.6f} m² vs mesh {area:.6f} m²), carried out m cp dT "
            f"{carried:.5f} W (bulk dT {dt_bulk:.3f} K at m = {mdot:.4e} kg/s), imbalance {imbalance:.4f} %, "
            f"{res.get('n_cells')} cells (Standard fineness {fineness})")
    print(line)
    (tmp_path.parent / "ht4-pipe.txt").write_text(line + "\n", encoding="utf-8")
    assert imbalance < 1.0, line
    assert abs(q_in["Q_W"] - q_wall * area) / (q_wall * area) < 0.01, line


# ---------------------------------------------------------------------------
# Quick solves on the committed cavity's mesh (e2e/fixtures/cavity-case: a 20 x 20
# blockMesh, one cell thick): the transient dictionaries, and the plain reason a
# Boussinesq run that drives the density to zero fails with.
# ---------------------------------------------------------------------------

CAVITY_MESH = Path(__file__).resolve().parents[1] / "e2e" / "fixtures" / "cavity-case"
CAVITY_BCS = [
    {"id": "b1", "name": "hot", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["f1"],
     "thermal_condition": "temperature", "wall_temperature": 303.15},
    {"id": "b2", "name": "cold", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["f2"],
     "thermal_condition": "temperature", "wall_temperature": 293.15},
    {"id": "b3", "name": "sym", "bc_type": "Symmetry", "faces": ["f3"]},
]


def _fixture_inputs(tmp: Path, *, fluid: dict[str, Any], bcs: list[dict[str, Any]], study: dict[str, Any],
                    transient: dict[str, Any] | None = None, run: dict[str, Any] | None = None):
    from cfddesk.project.run_inputs import RunInputs

    mesh = tmp / "mesh"
    shutil.copytree(CAVITY_MESH / "constant" / "polyMesh", mesh / "constant" / "polyMesh")
    return RunInputs(
        project_dir=tmp, run_id="r1", simulation_id="s1", mesh_id="m1", n_procs=1, require_mesh=True,
        time_dependency="transient" if transient else "steady",
        analysis_key="heat_transfer_transient" if transient else "heat_transfer_steady",
        solver_key="buoyantPimpleFoam" if transient else "buoyantSimpleFoam",
        materials={"materials": [{**fluid, "simulation_id": "s1"}]},
        bcs_doc={"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{**b, "simulation_id": "s1"} for b in bcs]},
        simulation_control={"endTime": 200, "writeInterval": 200},
        mesh={"ok": True, "case_dir": str(mesh), "patches": ["hot", "cold", "walls", "sym"], "n_cells": 400},
        study=study, run=run or {}, transient_override=transient,
    )


def test_transient_cavity_runs_with_adjustable_steps_and_writes_its_frames(tmp_path: Path) -> None:
    """buoyantPimpleFoam, air as an incompressible perfect gas (dpdt no), gravity, 4 s in 4 frames,
    a thermocouple: it runs to its end, writes every frame, and its monitors read back."""
    from ht_wsl_case import log, run_steps

    from heat_transfer.parser import HeatParser
    from heat_transfer.results import run_monitors
    from heat_transfer.runspec import load_spec
    from heat_transfer.writer import write_case

    air = {"id": "m-air", "name": "Air", "material_model": "thermo_fluid", "preset": "air", "assigned_volumes": ["Body1"]}
    inputs = _fixture_inputs(
        tmp_path, fluid=air, bcs=CAVITY_BCS,
        study={"gravity": "-y", "turbulence_model": "laminar", "reference_temperature": 298.15},
        transient={"end_time": 4, "write_count": 4, "max_co": 0.8},
        run={"result_controls": [{"id": "tc", "name": "TC", "monitor_type": "ht_thermocouple", "points": [[0.05, 0.05, 0.005]]}]},
    )
    case = tmp_path / "case"
    report = write_case(load_spec(inputs), case)
    assert report["ok"] and report["solver"] == "buoyantPimpleFoam"
    assert run_steps(case, ["buoyantPimpleFoam"], timeout=1800) == 0, log(case, "buoyantPimpleFoam")[-3000:]
    text = log(case, "buoyantPimpleFoam")
    assert "End" in text
    frames = sorted(float(d.name) for d in case.iterdir() if d.is_dir() and d.name.replace(".", "").isdigit() and float(d.name) > 0)
    assert frames == [1.0, 2.0, 3.0, 4.0], frames
    assert all((case / str(int(t)) / "T").is_file() and (case / str(int(t)) / "wallHeatFlux").is_file() for t in frames)
    parser = HeatParser()
    for line in text.splitlines():
        parser.feed(line)
    snap = parser.snapshot()
    steps = snap["residuals"]
    assert len(steps) > 20 and all("h" in s and "p_rgh" in s for s in steps)
    assert snap["delta_t"] is not None and snap["delta_t"] > 1e-4
    answer = run_monitors(case)
    tc = next(r for r in answer["custom"] if r["key"].startswith("ht_probe_tc"))
    assert 293.15 < tc["last"]["T_K"] < 303.15
    stored = answer["summary"][2]
    assert stored["label"] == "stored" and answer["summary_warn"] is False
    print(f"transient cavity: {len(steps)} time steps to t = 4 s, last dt {snap['delta_t']:.4g} s, TC {tc['last']['T_K']:.3f} K, "
          f"heat being stored {stored['value']:.4f} W (in minus out)")


def test_boussinesq_density_reaching_zero_fails_with_the_reason(tmp_path: Path) -> None:
    """Start refuses such a study (heat_transfer.contract's guard); written anyway, the solver
    dies and the parser names the cause the failed run then shows."""
    from ht_wsl_case import log, run_steps

    from heat_transfer.parser import DENSITY_ZERO_REASON, HeatParser
    from heat_transfer.runspec import load_spec
    from heat_transfer.writer import write_case

    liquid = {**CAVITY_FLUID, "thermal_expansion": 0.02}
    hot = [{**b, "wall_temperature": 400.0} if b["name"] == "hot" else b for b in CAVITY_BCS]
    inputs = _fixture_inputs(
        tmp_path, fluid=liquid, bcs=hot,
        study={"gravity": "-y", "density_model": "boussinesq", "turbulence_model": "laminar", "reference_temperature": 293.15},
    )
    case = tmp_path / "case"
    assert write_case(load_spec(inputs), case)["ok"]
    rc = run_steps(case, ["buoyantSimpleFoam"], timeout=1800)
    text = log(case, "buoyantSimpleFoam")
    parser = HeatParser()
    events = [e for line in text.splitlines() for e in parser.feed(line)]
    reasons = [e.fields["reason"] for e in events if e.event == "failed_reason"]
    print(f"Boussinesq beta dT = 2.1: solver exit {rc}, parser reason {reasons[:1]}")
    assert rc != 0, text[-2000:]
    assert reasons == [DENSITY_ZERO_REASON], text[-3000:]


# The e2e fixture's finished cavity (e2e/fixtures/cavity-case): the study the fixture's
# README describes, written by today's writer and solved 400 iterations. With
# HT4_WRITE_FIXTURE=1 the solved case replaces the committed one.
FIXTURE_STUDY = {"gravity": "-y", "density_model": "boussinesq", "reference_temperature": 298.15,
                 "turbulence_model": "laminar", "numerics_preset": "accurate", "residual_target": 1e-6,
                 "n_non_orthogonal": 0}
FIXTURE_MONITORS = [
    {"id": "mon1", "name": "Hot wall", "monitor_type": "ht_wall_heat_flux", "boundaries": ["b1"]},
    {"id": "mon2", "name": "Cold wall T", "monitor_type": "ht_surface_temperature", "boundaries": ["b2"]},
    {"id": "mon3", "name": "TC", "monitor_type": "ht_thermocouple", "points": [[0.05, 0.05, 0.005], [0.02, 0.08, 0.005]]},
]
FIXTURE_README = """# A finished Heat Transfer case (e2e fixture)

The heated cavity of `tests/test_ht_wsl_proofs.py` on a coarse 20 x 20 graded blockMesh
(one cell thick, symmetry front and back): hot wall 30 °C, cold wall 20 °C, Boussinesq,
laminar, 400 iterations of buoyantSimpleFoam (OpenFOAM v2606), written by the plugin's
own writer (`test_the_e2e_fixture_cavity_writes_a_positive_htc_and_the_density` with
HT4_WRITE_FIXTURE=1 rewrites it). `ht4-heat-transfer.spec.js` copies it into a run's case
folder to check the results legend in °C / °F and the monitors and energy balance without
WSL; `test_ht_results.py` reads its heat transfer coefficient.
"""


def test_the_e2e_fixture_cavity_writes_a_positive_htc_and_the_density(tmp_path: Path) -> None:
    """htc = q / (T_wall − T_ref) on both walls: positive on the hot wall (heat into the fluid,
    above the reference) and on the cold one (heat out, below it); the density field is written."""
    from ht_foam_fields import patch_values
    from ht_wsl_case import log, run_steps

    from heat_transfer.runspec import load_spec
    from heat_transfer.writer import write_case

    inputs = _fixture_inputs(tmp_path, fluid=CAVITY_FLUID, bcs=CAVITY_BCS, study=FIXTURE_STUDY,
                             run={"result_controls": FIXTURE_MONITORS})
    inputs.simulation_control.update({"endTime": 400, "writeInterval": 400})
    case = tmp_path / "case"
    assert write_case(load_spec(inputs), case)["ok"]
    assert run_steps(case, ["buoyantSimpleFoam"], timeout=1800) == 0, log(case, "buoyantSimpleFoam")[-3000:]
    t400 = case / "400"
    assert (t400 / "rho").is_file() and not (t400 / "htcRaw").exists()
    rho = patch_values(t400 / "rho", "hot")
    assert all(0.98 < r < 1.0 for r in rho), rho[:3]
    for wall, t_wall in (("hot", 303.15), ("cold", 293.15)):
        h = patch_values(t400 / "htc", wall)
        q = patch_values(t400 / "wallHeatFlux", wall)
        assert all(v > 0 for v in h), (wall, h[:3])
        assert all(abs(hv - qv / (t_wall - 298.15)) < 1e-6 * max(1.0, abs(hv)) for hv, qv in zip(h, q, strict=True)), wall
    mean = {w: sum(patch_values(t400 / "htc", w)) / 20 for w in ("hot", "cold")}
    print(f"fixture cavity, 400 iterations: htc hot {mean['hot']:.3f}, cold {mean['cold']:.3f} W/(m2 K) (both positive), "
          f"rho on the hot wall {min(rho):.4f} kg/m3")
    if os.environ.get("HT4_WRITE_FIXTURE") == "1":
        dest = CAVITY_MESH
        for name in ("0", "400", "constant", "system", "postProcessing"):
            if (dest / name).exists():
                shutil.rmtree(dest / name)
            shutil.copytree(case / name, dest / name)
        for name in ("w27-case.json", "case.foam"):
            if (case / name).exists():
                shutil.copy(case / name, dest / name)
        (dest / "README.md").write_bytes(FIXTURE_README.encode("utf-8"))


def _channel_mesh(tmp: Path) -> Path:
    """A blockMesh channel 0.4 x 0.1 x 0.01 m (40 x 30 x 1, graded to both walls): inlet,
    outlet, a heated floor, a roof, sym front and back."""
    from ht_wsl_case import log, run_steps

    mesh = tmp / "mesh"
    (mesh / "system").mkdir(parents=True)
    head = "FoamFile { version 2.0; format ascii; class dictionary; object %s; }\n"
    (mesh / "system" / "controlDict").write_text(
        head % "controlDict" + "application blockMesh; startFrom startTime; startTime 0; stopAt endTime; endTime 1; deltaT 1;"
        " writeControl timeStep; writeInterval 1;\n", encoding="utf-8")
    (mesh / "system" / "blockMeshDict").write_text(head % "blockMeshDict" + """
scale 1;
vertices ( (0 0 0) (0.4 0 0) (0.4 0.1 0) (0 0.1 0) (0 0 0.01) (0.4 0 0.01) (0.4 0.1 0.01) (0 0.1 0.01) );
blocks ( hex (0 1 2 3 4 5 6 7) (40 30 1) simpleGrading (1 ((0.5 0.5 4) (0.5 0.5 0.25)) 1) );
boundary
(
    inlet { type patch; faces ((0 4 7 3)); }
    outlet { type patch; faces ((1 2 6 5)); }
    floor { type wall; faces ((0 1 5 4)); }
    roof { type wall; faces ((3 7 6 2)); }
    sym { type patch; faces ((0 3 2 1) (4 5 6 7)); }
);
""", encoding="utf-8")
    assert run_steps(mesh, ["blockMesh"], timeout=600) == 0, log(mesh, "blockMesh")[-2000:]
    return mesh


def test_turbulent_buoyant_channel_with_an_htc_roof_runs(tmp_path: Path) -> None:
    """A smoke test of the turbulent dictionaries: k-omega SST, air as an incompressible perfect
    gas, gravity, an inlet at 20 °C and 0.5 m/s, a floor at 60 °C, a roof losing heat to 10 °C
    through h = 10 W/(m²·K), a pressure outlet: buoyantSimpleFoam runs 300 iterations with the
    wall functions; the floor heats the fluid (positive htc), the roof takes heat out."""
    from cfddesk.project.run_inputs import RunInputs
    from ht_foam_fields import patch_values
    from ht_wsl_case import log, run_steps

    from heat_transfer.parser import HeatParser
    from heat_transfer.results import run_monitors
    from heat_transfer.runspec import load_spec
    from heat_transfer.writer import write_case

    mesh = _channel_mesh(tmp_path)
    bcs = [
        {"id": "i", "name": "inlet", "bc_type": "Velocity inlet", "value": 0.5, "unit": "m/s", "faces": ["f1"],
         "inlet_temperature": 293.15},
        {"id": "o", "name": "outlet", "bc_type": "Pressure", "value": 0, "unit": "Pa", "faces": ["f2"],
         "backflow_temperature": 293.15},
        {"id": "f", "name": "floor", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["f3"],
         "thermal_condition": "temperature", "wall_temperature": 333.15},
        {"id": "r", "name": "roof", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["f4"],
         "thermal_condition": "heat_transfer_coefficient", "wall_htc": 10, "ambient_temperature": 283.15},
        {"id": "s", "name": "sym", "bc_type": "Symmetry", "faces": ["f5"]},
    ]
    air = {"id": "m-air", "name": "Air", "material_model": "thermo_fluid", "preset": "air", "assigned_volumes": ["Body1"],
           "simulation_id": "s1"}
    inputs = RunInputs(
        project_dir=tmp_path, run_id="r1", simulation_id="s1", mesh_id="m1", n_procs=1, require_mesh=True,
        time_dependency="steady", analysis_key="heat_transfer_steady", solver_key="buoyantSimpleFoam",
        materials={"materials": [air]},
        bcs_doc={"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{**b, "simulation_id": "s1"} for b in bcs]},
        simulation_control={"endTime": 300, "writeInterval": 300},
        mesh={"ok": True, "case_dir": str(mesh), "patches": ["inlet", "outlet", "floor", "roof", "sym"], "n_cells": 1200},
        study={"gravity": "-y", "turbulence_model": "kOmegaSST", "reference_temperature": 293.15},
        run={"result_controls": [{"id": "q", "name": "Roof", "monitor_type": "ht_wall_heat_flux", "boundaries": ["r"]}]},
    )
    case = tmp_path / "case"
    assert write_case(load_spec(inputs), case)["ok"]
    alphat = (case / "0" / "alphat").read_text(encoding="utf-8")
    assert "compressible::alphatJayatillekeWallFunction" in alphat
    roof_t = re.search(r"\n    roof\n    \{(.*?)\n    \}", (case / "0" / "T").read_text(encoding="utf-8"), re.S)
    assert roof_t and re.search(r"mode\s+coefficient;", roof_t.group(1)) and re.search(r"Ta\s+constant 283.15;", roof_t.group(1))
    rc = run_steps(case, ["buoyantSimpleFoam"], timeout=1800)
    text = log(case, "buoyantSimpleFoam")
    assert rc == 0 and "End" in text, text[-3000:]
    parser = HeatParser()
    for line in text.splitlines():
        parser.feed(line)
    rows = parser.snapshot()["residuals"]
    assert len(rows) >= 250 and all(k in rows[-1] for k in ("h", "p_rgh", "k", "omega"))
    t300 = case / "300"
    floor_h = patch_values(t300 / "htc", "floor")
    assert all(v > 0 for v in floor_h), floor_h[:3]
    for name in ("T", "U", "k", "omega", "nut", "alphat", "rho", "wallHeatFlux", "htc"):
        assert (t300 / name).is_file(), name
    answer = run_monitors(case)
    roof = next(r for r in answer["custom"] if r["name"] == "Roof")["last"]
    assert roof["Q_W"] < 0, roof
    b = answer["balance"]
    print(f"turbulent channel (kOmegaSST, perfect gas, gravity), 300 iterations: floor htc {sum(floor_h) / len(floor_h):.2f} "
          f"W/(m2 K), roof {roof['Q_W']:.4f} W (out), heat in {b['heat_in_W']:.4f} W, out {b['heat_out_W']:.4f} W, "
          f"last residuals h {rows[-1]['h']:.2e} k {rows[-1]['k']:.2e}")
