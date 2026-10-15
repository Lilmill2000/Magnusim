"""Force result controls solved in WSL (OpenFOAM v2606): a laminar channel between
two plates, its bottom wall picked as two faces (the entrance and the developed
part) and its top wall as a third.

- The developed part's viscous drag is the plane Poiseuille wall shear,
  tau = 6 mu U / H, times its area.
- The faces' forces and moments add up to the whole-wall Forces monitor's.
- The same on two cores, and a continued run keeps measuring them.

The CAD classification is stood in by the channel's geometry (the core's own is
tested in python/tests/unit/test_nearest_face.py).
"""

from __future__ import annotations

import copy
import json
import re
import shutil
from pathlib import Path

import numpy as np
import pytest
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.results import run_monitors
from incompressible_flow.writer import write_solve_case

L, H, W = 0.5, 0.01, 0.002
U_IN = 0.05
X_DEVELOPED = 0.2

BLOCK_MESH = f"""FoamFile {{ version 2.0; format ascii; class dictionary; object blockMeshDict; }}
convertToMeters 1;
vertices ( (0 0 0) ({L} 0 0) ({L} {H} 0) (0 {H} 0) (0 0 {W}) ({L} 0 {W}) ({L} {H} {W}) (0 {H} {W}) );
blocks ( hex (0 1 2 3 4 5 6 7) (125 20 1) simpleGrading (1 1 1) );
edges ();
boundary
(
    velocity_inlet_1 {{ type patch; faces ( (0 4 7 3) ); }}
    pressure_1 {{ type patch; faces ( (1 2 6 5) ); }}
    walls {{ type wall; faces ( (0 1 5 4) (3 7 6 2) ); }}
    sides {{ type patch; faces ( (0 3 2 1) (4 5 6 7) ); }}
);
"""
CONTROL_STUB = """FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }
application blockMesh; startFrom startTime; startTime 0; stopAt endTime; endTime 1; deltaT 1;
writeControl timeStep; writeInterval 1;
"""


class ChannelFaces:
    """The channel's CAD faces: 11 the bottom entrance (x < 0.2), 12 the developed
    bottom, 13 the top; anything else 0."""

    def face_bounds(self, numbers):
        return np.array([0.0, 0.0, 0.0]), np.array([L, H, W])

    def nearest_face_numbers(self, centres):
        out = []
        for x, y, _z in np.asarray(centres):
            if y < 1e-9:
                out.append(11 if x < X_DEVELOPED else 12)
            elif y > H - 1e-9:
                out.append(13)
            else:
                out.append(0)
        return out


def _wsl(case: Path, script: str, timeout: int = 900) -> None:
    from cfddesk.wsl.mesh_run import windows_to_wsl_path
    from cfddesk.wsl.openfoam import OPENFOAM_WRAPPER, run_wsl_bash

    result = run_wsl_bash(f"cd '{windows_to_wsl_path(case)}' && {OPENFOAM_WRAPPER} bash -c '{script}'", timeout=timeout)
    logs = "\n".join(p.read_text(encoding="utf-8", errors="replace")[-3000:] for p in sorted(case.glob("log.*")))
    assert result.returncode == 0, result.stderr + logs
    assert "FOAM FATAL" not in logs, logs


@pytest.fixture(scope="module")
def plates_mesh(tmp_path_factory):
    mesh = tmp_path_factory.mktemp("plates")
    (mesh / "system").mkdir()
    (mesh / "constant").mkdir()
    (mesh / "system" / "blockMeshDict").write_text(BLOCK_MESH, encoding="ascii")
    (mesh / "system" / "controlDict").write_text(CONTROL_STUB, encoding="ascii")
    _wsl(mesh, "blockMesh > log.blockMesh 2>&1")
    return mesh


def _spec(tmp_path: Path, mesh: Path, *, end: int, n_procs: int = 1):
    root = tmp_path / "project"
    shutil.copytree(JS_PROJECT, root)
    rec = {"id": "sim_1", "name": "Plates", "time_dependency": "Steady-state", "turbulence_model": "laminar"}
    rec.update({"residual_u": 1e-9, "residual_p": 1e-9})
    (root / "simulation.json").write_text(json.dumps(rec), encoding="utf-8")
    (root / "simulations.json").write_text(json.dumps({"active_id": "sim_1", "simulations": [rec]}), encoding="utf-8")
    spec = load_run_spec(root, run_id="run-force", require_mesh=False, n_procs=n_procs)
    assert spec.ok, spec.error
    spec.mesh_case_dir = mesh
    spec.end_time = end
    spec.write_interval = end
    mapped = copy.deepcopy(list(spec.mapped))
    for m in mapped:
        if m["patch"] == "velocity_inlet_1":
            m["bc"]["value"] = U_IN
    mapped.append({"patch": "sides", "bc": {"name": "sides", "bc_type": "Symmetry", "faces": ["face 20@Body1"]}})
    spec.mapped = mapped
    # On the bottom wall: the top wall's drag then has a moment arm (mid-channel, they cancel).
    spec.reference = {"ref_cofr": [0.25, 0.0, 0.001]}
    spec.result_controls = [
        {"id": "entrance", "monitor_type": "force", "name": "Entrance", "faces": ["face 11@Body1"]},
        {"id": "developed", "monitor_type": "force", "name": "Developed", "faces": ["face 12@Body1"]},
        {"id": "top", "monitor_type": "force", "name": "Top", "faces": ["face 13@Body1"]},
        {"id": "walls", "monitor_type": "forces", "name": "Walls", "boundaries": ["@walls"]},
    ]
    spec.forces_monitors = [{"id": "walls", "name": "Walls", "boundaries": ["@walls"]}]
    return spec


def _rows(case: Path) -> dict[str, dict]:
    return {str(r["id"]): r for r in run_monitors(case)["custom"]}


def _vec(row: dict, key: str) -> np.ndarray:
    return np.array(row["last"][key], dtype=float)


def _solve_serial(case: Path) -> None:
    _wsl(case, "simpleFoam > log.simpleFoam 2>&1")


def _check_physics(rows: dict[str, dict], rho: float, nu: float) -> None:
    mu = rho * nu
    tau = 6 * mu * U_IN / H
    area = (L - X_DEVELOPED) * W
    fv = _vec(rows["developed"], "Fv_N")
    # The flow drags the developed bottom wall downstream by tau * A.
    assert fv[0] == pytest.approx(tau * area, rel=0.03), (fv, tau * area)
    # Pressure pushes on the wall normal to it: no streamwise pressure force.
    assert abs(_vec(rows["developed"], "Fp_N")[0]) < 1e-3 * abs(fv[0])
    # The faces add up to the whole walls, force and moment.
    for key in ("F_N", "Fp_N", "Fv_N", "M_Nm"):
        parts = _vec(rows["entrance"], key) + _vec(rows["developed"], key) + _vec(rows["top"], key)
        whole = _vec(rows["walls"], key)
        assert np.allclose(parts, whole, rtol=1e-6, atol=1e-12 * max(1.0, np.abs(whole).max())), (key, parts, whole)


@pytest.mark.wsl
def test_force_on_picked_faces_matches_poiseuille_and_adds_up_to_the_walls(tmp_path, plates_mesh):
    spec = _spec(tmp_path, plates_mesh, end=600)
    case = tmp_path / "case"
    report = write_solve_case(spec, case, ChannelFaces())
    assert report.get("ok", True) is not False, report
    names = [p for p in (case / "w27-case.json").read_text(encoding="utf-8").split('"') if p.startswith("mgf_")]
    assert {"mgf_11__walls", "mgf_12__walls", "mgf_13__walls"} <= set(names)
    _wsl(case, "checkMesh > log.checkMesh 2>&1")
    assert "Mesh OK." in (case / "log.checkMesh").read_text(encoding="utf-8", errors="replace")
    _solve_serial(case)
    rows = _rows(case)
    assert rows["developed"]["type"] == "force" and rows["developed"]["faces"] == ["face 12@Body1"]
    _check_physics(rows, float(spec.rho), float(spec.nu))

    # Continued to 800: the same pieces (no new split), and the series goes on.
    before = len(rows["developed"]["series"])
    spec2 = _spec(tmp_path / "again", plates_mesh, end=800)
    spec2.restart = True
    report = write_solve_case(spec2, case, ChannelFaces())
    assert report.get("ok", True) is not False, report
    _solve_serial(case)
    rows = _rows(case)
    assert len(rows["developed"]["series"]) > before
    assert rows["developed"]["series"][-1]["t"] == 800
    _check_physics(rows, float(spec.rho), float(spec.nu))


@pytest.mark.wsl
def test_force_on_picked_faces_on_two_cores(tmp_path, plates_mesh):
    spec = _spec(tmp_path, plates_mesh, end=600, n_procs=2)
    case = tmp_path / "case"
    report = write_solve_case(spec, case, ChannelFaces())
    assert report.get("ok", True) is not False, report
    _wsl(
        case,
        "decomposePar -force > log.decomposePar 2>&1 && mpirun -np 2 simpleFoam -parallel > log.simpleFoam 2>&1 "
        "&& reconstructPar -latestTime > log.reconstructPar 2>&1",
        timeout=1200,
    )
    boundary = (case / "processor0" / "constant" / "polyMesh" / "boundary").read_text(encoding="utf-8", errors="replace")
    assert re.search(r"mgf_1[123]__walls", boundary)
    _check_physics(_rows(case), float(spec.rho), float(spec.nu))
