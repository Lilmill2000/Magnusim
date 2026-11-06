"""The quick physics checks (``npm run test:physics``; the full e2e tier runs them first): the
case a run writes (Incompressible Flow's own ``write_solve_case``, from a project's saved
study, boundary conditions and fluid, and a run's monitors) on a blockMesh grid, solved in WSL (OpenFOAM
v2606), read with the run's own monitor reader (``results.run_monitors``) and held to published
values with bands wide enough to stand without a mesh study. They check the case writer, its
schemes and its monitors in under a minute, not the meshers: the validation set does that, through
the app's routes (``validation/README.md``).

1. Lid-driven cavity, Re 100: 49 x 49 cells, one cell across (its two ends empty, as One cell
   across solves them; an odd count puts a cell column on x = L/2), a Moving lid, laminar,
   Accurate. u / U_lid on the vertical centre line at Ghia et al.'s 15 interior stations (Point
   probes): RMS within 0.02 and the largest difference within 0.05; the flow moves (u near the
   lid above 0.5, the vortex's u below -0.15).
2. Laminar pipe, Re 100: a 5-block O-grid, D 20 mm, 15 D long, 22 cells across and 150 along
   (51 000 cells), a uniform 1 m/s inlet, on 2 cores. f Re = 64 within 2 % (the axis pressure's
   slope over x/D 10 to 13, Point probes) and U_cl / U_b = 2 within 2 % there; U_b and D from
   the inlet's own monitor (its flow and meshed area), as the validation set's pipe reads them.
3. Circular cylinder, Re 20: one cell across, a ring of cells 20 D out with one Freestream round
   it, the study's reference values and a Forces monitor. Cd within 10 % of 2.02 (Fornberg 1980
   and Dennis & Chang 1970, SECONDARY: ``validation/refs/cylinder_re20_re40.csv``), a wide band:
   the ring's 2.5 % blockage and its coarse grid raise it a little.

Each run must stop on its residual targets (``SIMPLE solution converged``). The cavity's and the
pipe's bands are the design's (validation set design 1.12), not fitted to these runs; the
cylinder's ±10 % is this check's own (the reference data give ±5 %), widened for the ring's
blockage and its coarse grid. The first run's numbers are in docs/TESTING.md.
"""

from __future__ import annotations

import csv
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.results import run_monitors
from incompressible_flow.writer import write_solve_case

pytestmark = [pytest.mark.wsl, pytest.mark.physics]

WEB = Path(__file__).resolve().parents[3]
REFS = WEB / "validation" / "refs"

# Run in a fresh /tmp folder in WSL (as the app's runs are): the case is copied in, each step
# runs there with its output in log.<name>, and the logs, postProcessing (the monitors) and the
# mesh (after blockMesh) come back beside the case.
SCRIPT = """#!/usr/bin/env bash
set -u
SRC="{src}"
D=$(mktemp -d /tmp/iff-quick-XXXXXX)
cp -a "$SRC/." "$D/"
cd "$D" || exit 47
EC=0
{steps}
cp -f "$D"/log.* "$SRC/" 2>/dev/null
if [ -d "$D/postProcessing" ]; then rm -rf "$SRC/postProcessing"; cp -a "$D/postProcessing" "$SRC/postProcessing"; fi
if [ -d "$D/constant/polyMesh" ]; then rm -rf "$SRC/constant/polyMesh"; mkdir -p "$SRC/constant"; cp -a "$D/constant/polyMesh" "$SRC/constant/polyMesh"; fi
cd / && rm -rf "$D"
exit $EC
"""
STEP = """if [ "$EC" -eq 0 ]; then
  openfoam2606 {cmd} > log.{name} 2>&1
  EC=$?
fi"""

CONTROL_STUB = """FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }
application blockMesh; startFrom startTime; startTime 0; stopAt endTime; endTime 1; deltaT 1;
writeControl timeStep; writeInterval 1;
"""


def _run(case: Path, steps: list[tuple[str, str]], *, timeout: float = 900.0) -> None:
    """Run ``steps`` ((log name, OpenFOAM command) each) on a /tmp copy of ``case`` in WSL."""
    from cfddesk.wsl.mesh_run import windows_to_wsl_path
    from cfddesk.wsl.openfoam import run_wsl_bash

    script = case / "run-quick.sh"
    body = SCRIPT.format(src=windows_to_wsl_path(case), steps="\n".join(STEP.format(cmd=c, name=n) for n, c in steps))
    script.write_bytes(body.encode("utf-8"))
    result = run_wsl_bash(f"bash '{windows_to_wsl_path(script)}'", timeout=timeout)
    logs = "\n".join(f"--- {p.name}\n" + p.read_text(encoding="utf-8", errors="replace")[-2500:] for p in sorted(case.glob("log.*")))
    assert result.returncode == 0, result.stderr + logs
    assert "FOAM FATAL" not in logs, logs


def _mesh(tmp: Path, block_mesh_dict: str, *, two_d: dict[str, Any] | None = None) -> Path:
    """A blockMesh grid in ``tmp/mesh`` with its mesh facts, as a mesher leaves them (``two_d``:
    one cell across, its two ends a Symmetry patch the solve makes empty)."""
    from magnusim_sdk.mesh_facts import FACTS_FILE, write_mesh_facts

    mesh = tmp / "mesh"
    (mesh / "system").mkdir(parents=True)
    (mesh / "constant").mkdir()
    (mesh / "system" / "blockMeshDict").write_text(block_mesh_dict, encoding="ascii")
    (mesh / "system" / "controlDict").write_text(CONTROL_STUB, encoding="ascii")
    _run(mesh, [("blockMesh", "blockMesh")])
    facts = write_mesh_facts(mesh, rates=False)
    if two_d:
        # What One cell across adds (the mesher's own facts carry its cell count too).
        owner = (mesh / "constant" / "polyMesh" / "owner").read_text(encoding="utf-8", errors="replace")[:2000]
        cells = re.search(r"nCells:\s*(\d+)", owner)
        assert cells, owner
        facts.update({"n_cells": int(cells.group(1)), "two_d": {"cells_across": 1, **two_d}})
        (mesh / FACTS_FILE).write_text(json.dumps(facts, indent=1) + "\n", encoding="utf-8")
    return mesh


def _project(tmp: Path, study: dict[str, Any], bcs: list[dict[str, Any]], nu: float) -> Path:
    """A project as the app saves it: the study, its boundary conditions and its fluid (density 1)."""
    root = tmp / "project"
    shutil.copytree(JS_PROJECT, root)
    rec = {"id": "sim_1", "name": "Quick check", "time_dependency": "Steady-state", **study}
    (root / "simulation.json").write_text(json.dumps(rec), encoding="utf-8")
    (root / "simulations.json").write_text(json.dumps({"active_id": "sim_1", "simulations": [rec]}), encoding="utf-8")
    (root / "boundary_conditions.json").write_text(
        json.dumps({"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{**b, "simulation_id": "sim_1"} for b in bcs]}),
        encoding="utf-8",
    )
    fluid = {"name": "Check fluid", "kinematic_viscosity": nu, "density": 1.0, "assigned_volumes": ["Body1"], "simulation_id": "sim_1"}
    (root / "materials.json").write_text(json.dumps({"materials": [fluid]}), encoding="utf-8")
    (root / "result_controls.json").write_text(json.dumps({"result_controls": []}), encoding="utf-8")
    return root


def _solve(tmp: Path, root: Path, mesh: Path, patches: list[str], controls: list[dict[str, Any]], *, end: int, cores: int = 1) -> Path:
    """Write the run's case from the project on ``mesh``, with the run's result controls
    (``controls``: its monitors, read as the run spec reads a run's), and solve it to its
    residual targets."""
    from incompressible_flow.monitors import forces_monitor_records, probe_monitor_records

    spec = load_run_spec(root, run_id="run-quick", require_mesh=False, n_procs=cores)
    assert spec.ok, spec.error
    assert sorted(str(m["patch"]) for m in spec.mapped) == sorted(patches), spec.mapped
    spec.result_controls = controls
    spec.probe_monitors = probe_monitor_records(controls)
    spec.forces_monitors = forces_monitor_records(controls)
    spec.mesh_case_dir = mesh
    spec.end_time = end
    spec.write_interval = end
    case = tmp / "case"
    report = write_solve_case(spec, case)
    assert report.get("ok", True) is not False, report
    if cores > 1:
        _run(case, [("decomposePar", "decomposePar -force"), ("simpleFoam", f"mpirun -np {cores} simpleFoam -parallel")], timeout=1200)
    else:
        _run(case, [("simpleFoam", "simpleFoam")])
    log = (case / "log.simpleFoam").read_text(encoding="utf-8", errors="replace")
    assert "SIMPLE solution converged" in log, log[-3000:]
    return case


def _table(name: str) -> list[dict[str, str]]:
    """A reference table's rows (validation/refs, its # header lines skipped)."""
    text = (REFS / name).read_text(encoding="utf-8")
    return list(csv.DictReader(line for line in text.splitlines() if not line.startswith("#")))


def _probes(case: Path) -> list[dict[str, Any]]:
    return [r for r in run_monitors(case)["custom"] if r.get("type") == "probe"]


# --- 1. Lid-driven cavity, Re 100 --------------------------------------------------------------

CAV_L, CAV_N = 0.1, 49
CAV_W = CAV_L / CAV_N
CAVITY_MESH = f"""FoamFile {{ version 2.0; format ascii; class dictionary; object blockMeshDict; }}
convertToMeters 1;
vertices ( (0 0 0) ({CAV_L} 0 0) ({CAV_L} {CAV_L} 0) (0 {CAV_L} 0) (0 0 {CAV_W}) ({CAV_L} 0 {CAV_W}) ({CAV_L} {CAV_L} {CAV_W}) (0 {CAV_L} {CAV_W}) );
blocks ( hex (0 1 2 3 4 5 6 7) ({CAV_N} {CAV_N} 1) simpleGrading (1 1 1) );
edges ();
boundary
(
    lid {{ type wall; faces ( (3 7 6 2) ); }}
    walls {{ type wall; faces ( (0 1 5 4) (0 4 7 3) (1 2 6 5) ); }}
    sides {{ type patch; faces ( (0 3 2 1) (4 5 6 7) ); }}
);
"""


def test_cavity_re100_matches_ghia_on_the_centre_line(tmp_path: Path):
    stations = [r for r in _table("ghia_1982_table1_u.csv") if 0.0 < float(r["y"]) < 1.0]
    assert len(stations) == 15
    points = [[CAV_L / 2, float(r["y"]) * CAV_L, CAV_W / 2] for r in stations]
    mesh = _mesh(tmp_path, CAVITY_MESH, two_d={"axis": "z", "depth_m": CAV_W, "front": {"patch": "sides"}, "back": {"patch": "sides"}})
    study = {"turbulence_model": "laminar", "numerics_preset": "accurate", "residual_u": 1e-6, "residual_p": 1e-6}
    bcs = [
        {"id": "bc_lid", "name": "Lid", "bc_type": "Wall", "wall_type": "Moving", "wall_velocity": [1.0, 0.0, 0.0], "faces": ["face 3@Body1"]},
        {"id": "bc_walls", "name": "Walls", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 4@Body1"]},
        {"id": "bc_sides", "name": "Sides", "bc_type": "Symmetry", "faces": ["face 5@Body1", "face 6@Body1"]},
    ]
    controls = [{"id": "centre", "monitor_type": "probe", "name": "Centre line", "points": points}]
    root = _project(tmp_path, study, bcs, nu=CAV_L * 1.0 / 100)
    case = _solve(tmp_path, root, mesh, ["lid", "walls", "sides"], controls, end=5000)
    # The ends were solved empty: the flow is in the plane only.
    assert "empty" in (case / "0" / "U").read_text(encoding="utf-8", errors="replace")
    rows = _probes(case)
    assert len(rows) == 15 and not any(r["outside"] for r in rows)
    u = np.array([r["last"]["U"][0] for r in rows])
    ref = np.array([float(r["u_re100"]) for r in stations])
    diff = u - ref
    rms, worst = float(np.sqrt(np.mean(diff**2))), float(np.max(np.abs(diff)))
    print(f"[quick cavity] RMS {rms:.4f}, largest {worst:.4f} (u/U at y/L {stations[int(np.argmax(np.abs(diff)))]['y']})")
    assert u.max() > 0.5 and u.min() < -0.15, u  # the lid drags the fluid round: the flow moves
    assert rms <= 0.02 and worst <= 0.05, (rms, worst, list(zip(ref, u, strict=True)))


# --- 2. Laminar pipe, Re 100 -------------------------------------------------------------------

PIPE_D, PIPE_LD = 0.02, 15
PIPE_U, PIPE_NU = 1.0, 2e-4  # Re = U D / nu = 100
PIPE_N, PIPE_M, PIPE_NX = 10, 6, 150


def _pipe_mesh() -> str:
    """A 5-block O-grid along x: a square core (half-width R/2) and four arc blocks to the wall."""
    r, length = PIPE_D / 2, PIPE_D * PIPE_LD
    s, c = r / 2, r / math.sqrt(2)
    section = [(-s, -s), (s, -s), (s, s), (-s, s), (-c, -c), (c, -c), (c, c), (-c, c)]
    verts = " ".join(f"({x:g} {y:.9g} {z:.9g})" for x in (0.0, length) for y, z in section)
    n, m, nx = PIPE_N, PIPE_M, PIPE_NX
    # Each block: local x1 along the arc (or the core's y), x2 inward (or the core's z), x3 along x.
    blocks = [
        f"hex (0 1 2 3 8 9 10 11) ({n} {n} {nx}) simpleGrading (1 1 1)",
        f"hex (4 5 1 0 12 13 9 8) ({n} {m} {nx}) simpleGrading (1 1 1)",
        f"hex (5 6 2 1 13 14 10 9) ({n} {m} {nx}) simpleGrading (1 1 1)",
        f"hex (6 7 3 2 14 15 11 10) ({n} {m} {nx}) simpleGrading (1 1 1)",
        f"hex (7 4 0 3 15 12 8 11) ({n} {m} {nx}) simpleGrading (1 1 1)",
    ]
    arcs = []
    for x, k in ((0.0, 0), (length, 8)):
        for (a, b), (y, z) in zip(((4, 5), (5, 6), (6, 7), (7, 4)), ((0.0, -r), (r, 0.0), (0.0, r), (-r, 0.0)), strict=True):
            arcs.append(f"arc {a + k} {b + k} ({x:g} {y:g} {z:g})")
    ring = ((0, 1, 2, 3), (4, 5, 1, 0), (5, 6, 2, 1), (6, 7, 3, 2), (7, 4, 0, 3))
    inlet = " ".join("(" + " ".join(str(v) for v in f) + ")" for f in ring)
    outlet = " ".join("(" + " ".join(str(v + 8) for v in f) + ")" for f in ring)
    wall = " ".join(f"({a} {b} {b + 8} {a + 8})" for a, b in ((4, 5), (5, 6), (6, 7), (7, 4)))
    return f"""FoamFile {{ version 2.0; format ascii; class dictionary; object blockMeshDict; }}
convertToMeters 1;
vertices ( {verts} );
blocks ( {' '.join(blocks)} );
edges ( {' '.join(arcs)} );
boundary
(
    inlet {{ type patch; faces ( {inlet} ); }}
    outlet {{ type patch; faces ( {outlet} ); }}
    wall {{ type wall; faces ( {wall} ); }}
);
"""


def test_laminar_pipe_re100_friction_and_centreline(tmp_path: Path):
    xs = [PIPE_D * (10 + 0.5 * i) for i in range(7)]  # x/D 10 to 13
    mesh = _mesh(tmp_path, _pipe_mesh())
    study = {"turbulence_model": "laminar", "numerics_preset": "accurate", "residual_u": 1e-6, "residual_p": 1e-6}
    bcs = [
        {"id": "bc_in", "name": "Inlet", "bc_type": "Velocity inlet", "velocity_type": "Fixed", "value": PIPE_U, "unit": "m/s", "direction": "Normal to face", "faces": ["face 1@Body1"]},
        {"id": "bc_out", "name": "Outlet", "bc_type": "Pressure", "pressure_type": "Fixed value", "value": 0, "unit": "Pa", "faces": ["face 2@Body1"]},
        {"id": "bc_wall", "name": "Wall", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 3@Body1"]},
    ]
    controls = [{"id": "axis", "monitor_type": "probe", "name": "Axis", "points": [[x, 0.0, 0.0] for x in xs]}]
    root = _project(tmp_path, study, bcs, nu=PIPE_NU)
    case = _solve(tmp_path, root, mesh, ["inlet", "outlet", "wall"], controls, end=4000, cores=2)
    out = run_monitors(case)
    inlet = next(m for m in out["monitors"] if m["patch"] == "inlet")
    area, q = float(inlet["area_m2"]), -float(inlet["last"]["Q_m3s"])
    u_b, d = q / area, math.sqrt(4 * area / math.pi)
    rows = _probes(case)
    assert len(rows) == len(xs) and not any(r["outside"] for r in rows)
    p = np.array([r["last"]["p_Pa"] for r in rows])  # density 1: kinematic
    slope = float(np.polyfit(np.array(xs), p, 1)[0])
    f = -slope * d / (0.5 * u_b**2)
    f_re = f * u_b * d / PIPE_NU
    u_cl = float(np.mean([r["last"]["U"][0] for r in rows])) / u_b
    print(f"[quick pipe] f Re {f_re:.3f} (64), U_cl/U_b {u_cl:.4f} (2), U_b {u_b:.4f} m/s, D {d * 1000:.3f} mm")
    assert f_re == pytest.approx(64.0, rel=0.02)
    assert u_cl == pytest.approx(2.0, rel=0.02)


# --- 3. Circular cylinder, Re 20 ---------------------------------------------------------------

CYL_D, CYL_OUT, CYL_W = 0.01, 20.0, 0.005  # D, the ring's outer radius in D, the depth
CYL_U, CYL_NU = 1.0, 5e-4  # Re = U D / nu = 20
CYL_NT, CYL_NR = 24, 60  # cells round a quarter, cells out


def _cylinder_mesh() -> str:
    """A ring of four blocks round the cylinder (along z, one cell deep) out to 20 D."""
    r0, r1 = CYL_D / 2, CYL_OUT * CYL_D
    a0, a1 = r0 / math.sqrt(2), r1 / math.sqrt(2)
    section = [(-a0, -a0), (a0, -a0), (a0, a0), (-a0, a0), (-a1, -a1), (a1, -a1), (a1, a1), (-a1, a1)]
    verts = " ".join(f"({x:.9g} {y:.9g} {z:g})" for z in (0.0, CYL_W) for x, y in section)
    # Radial cells about as long as wide at the cylinder, growing outwards: x2 runs inward, so
    # the grading (last cell over first) is below 1.
    first = math.pi * CYL_D / (4 * CYL_NT)
    lo, hi = 1.0 + 1e-9, 2.0  # the growth q with first * (q^n - 1) / (q - 1) = r1 - r0
    for _ in range(100):
        q = (lo + hi) / 2
        lo, hi = (q, hi) if first * (q**CYL_NR - 1) / (q - 1) < r1 - r0 else (lo, q)
    grade = 1 / q ** (CYL_NR - 1)
    nt, nr = CYL_NT, CYL_NR
    blocks = [f"hex ({a} {b} {c} {d} {a + 8} {b + 8} {c + 8} {d + 8}) ({nt} {nr} 1) simpleGrading (1 {grade:.6g} 1)" for a, b, c, d in ((4, 5, 1, 0), (5, 6, 2, 1), (6, 7, 3, 2), (7, 4, 0, 3))]
    arcs = []
    for z, k in ((0.0, 0), (CYL_W, 8)):
        for (a, b), (x, y) in zip(((0, 1), (1, 2), (2, 3), (3, 0)), ((0.0, -r0), (r0, 0.0), (0.0, r0), (-r0, 0.0)), strict=True):
            arcs.append(f"arc {a + k} {b + k} ({x:g} {y:g} {z:g})")
        for (a, b), (x, y) in zip(((4, 5), (5, 6), (6, 7), (7, 4)), ((0.0, -r1), (r1, 0.0), (0.0, r1), (-r1, 0.0)), strict=True):
            arcs.append(f"arc {a + k} {b + k} ({x:g} {y:g} {z:g})")
    pairs = ((0, 1), (1, 2), (2, 3), (3, 0))
    cylinder = " ".join(f"({a} {b} {b + 8} {a + 8})" for a, b in pairs)
    far = " ".join(f"({a + 4} {b + 4} {b + 12} {a + 12})" for a, b in pairs)
    quads = ((4, 5, 1, 0), (5, 6, 2, 1), (6, 7, 3, 2), (7, 4, 0, 3))
    sides = " ".join("(" + " ".join(str(v) for v in f) + ")" for f in quads) + " " + " ".join("(" + " ".join(str(v + 8) for v in f) + ")" for f in quads)
    return f"""FoamFile {{ version 2.0; format ascii; class dictionary; object blockMeshDict; }}
convertToMeters 1;
vertices ( {verts} );
blocks ( {' '.join(blocks)} );
edges ( {' '.join(arcs)} );
boundary
(
    cylinder {{ type wall; faces ( {cylinder} ); }}
    far {{ type patch; faces ( {far} ); }}
    sides {{ type patch; faces ( {sides} ); }}
);
"""


def test_cylinder_re20_drag_from_the_forces_monitor(tmp_path: Path):
    ref = next(r for r in _table("cylinder_re20_re40.csv") if r["re"] == "20" and r["quantity"] == "cd")
    cd_ref = float(ref["value"])
    mesh = _mesh(tmp_path, _cylinder_mesh(), two_d={"axis": "z", "depth_m": CYL_W, "front": {"patch": "sides"}, "back": {"patch": "sides"}})
    study = {
        "turbulence_model": "laminar",
        "numerics_preset": "accurate",
        "residual_u": 1e-6,
        "residual_p": 1e-6,
        "ref_speed": CYL_U,
        "ref_area": CYL_D * CYL_W,
        "ref_length": CYL_D,
        "ref_drag_dir": [1.0, 0.0, 0.0],
        "ref_lift_dir": [0.0, 1.0, 0.0],
        "ref_cofr": [0.0, 0.0, CYL_W / 2],
    }
    bcs = [
        {"id": "bc_cyl", "name": "Cylinder", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 3@Body1"]},
        {"id": "bc_far", "name": "Far", "bc_type": "Freestream", "velocity_input": "Speed and direction", "value": CYL_U, "unit": "m/s", "vector": [1, 0, 0], "freestream_pressure": 0, "faces": ["face 1@Body1"]},
        {"id": "bc_sides", "name": "Sides", "bc_type": "Symmetry", "faces": ["face 5@Body1", "face 6@Body1"]},
    ]
    controls = [{"id": "forces", "monitor_type": "forces", "name": "Cylinder forces", "boundaries": ["bc_cyl"]}]
    root = _project(tmp_path, study, bcs, nu=CYL_NU)
    case = _solve(tmp_path, root, mesh, ["cylinder", "far", "sides"], controls, end=4000)
    forces = next(r for r in run_monitors(case)["custom"] if r.get("type") == "forces")
    cd = float(forces["last"]["Cd"])
    print(f"[quick cylinder] Cd {cd:.4f} ({cd_ref:g}, {100 * (cd / cd_ref - 1):+.2f} %)")
    assert cd == pytest.approx(cd_ref, rel=0.10)
