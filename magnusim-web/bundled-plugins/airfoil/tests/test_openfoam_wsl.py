"""The OpenFOAM 2D case in real OpenFOAM (WSL), without the app: the local tier.

The case the openfoam_2d job writes (NACA 2412, Re 1e6, α 4°, medium mesh) is copied
to a folder of this test's own in WSL and run as the host runs it: each WSL step of
foamcase.PRE_STEPS as ``openfoam2606 <tool> <args>`` in the case, then simpleFoam on
4 ranks. Checked: the steps leave the four patches (the wall ``airfoil``, ``farfield``,
and ``front``/``back`` empty, the raw ``wing`` gone), the solver ends cleanly, Cl
settles (steady), and Cl at 4° is within 10 % of the shipped XFOIL with transition
forced at 5 % of the chord (gate:h17-openfoam-2d, here without the app; the e2e checks
it through the workspace).

It needs WSL with OpenFOAM v2606 (``openfoam2606``) and takes about a minute, so it
runs only with MAGNUSIM_E2E_WSL=1 (the local tier, as the WSL e2e specs); the core's
pytest also deselects it (``-m "not wsl"``).
"""

from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

from airfoil import cmesh, foamcase, naca, settings, xfoil

PLUGIN_DIR = Path(__file__).resolve().parents[1]
WSL = os.environ.get("MAGNUSIM_E2E_WSL") == "1"

pytestmark = [
    pytest.mark.wsl,
    pytest.mark.skipif(not WSL, reason="needs WSL with OpenFOAM v2606: set MAGNUSIM_E2E_WSL=1 (the local tier)"),
    pytest.mark.skipif(importlib.util.find_spec("gmsh") is None, reason="Gmsh is not installed in this Python"),
    pytest.mark.skipif(sys.platform != "win32", reason="runs the case through wsl.exe"),
]


def _wsl_path(path: Path) -> str:
    p = path.resolve()
    return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}"


def _bash(script: str, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["wsl", "-e", "bash", "-c", script],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def test_the_case_runs_in_openfoam_and_lands_near_xfoil_with_forced_transition(project):
    data, _scope, sid = project
    spec = importlib.util.spec_from_file_location("openfoam_2d_job", PLUGIN_DIR / "jobs" / "openfoam_2d.py")
    job = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(job)
    events: list = []
    assert job.run_job(sid, 4.0, "medium", data, emit_fn=lambda ev, **kw: events.append((ev, kw))) == 0, events
    case = data.path("studies", sid, "openfoam", "run-1-a4")
    wsl_case = f"/tmp/magnusim-pytest-airfoil-{uuid.uuid4().hex[:8]}/case"
    steps = []
    for i, step in enumerate(foamcase.PRE_STEPS, start=1):
        words = " ".join([step["tool"], *step.get("args", [])])
        steps.append(f'( cd "$D" && openfoam2606 {words} ) > log.{step["tool"]}.{i} 2>&1 || {{ echo "STEP {step["tool"]} failed"; exit 3; }}')
    script = "\n".join(
        [
            "set -u",
            f'D="{wsl_case}"',
            'mkdir -p "$D"',
            f'cp -r "{_wsl_path(case)}/." "$D/"',
            'cd "$D"',
            *steps,
            "sed -n '/^(/,$p' constant/polyMesh/boundary",
            "printf 'FoamFile\\n{\\n    version 2.0;\\n    format ascii;\\n    class dictionary;\\n    object decomposeParDict;\\n}\\nnumberOfSubdomains 4;\\nmethod scotch;\\n' > system/decomposeParDict",
            "openfoam2606 decomposePar -force > log.decomposePar 2>&1 || { echo 'decomposePar failed'; exit 4; }",
            "openfoam2606 mpirun --oversubscribe -np 4 simpleFoam -parallel > log.simpleFoam 2>&1; echo \"SOLVER $?\"",
            "grep -q '^End' log.simpleFoam && echo SOLVER_ENDED",
            "echo COEFFICIENTS",
            "cat postProcessing/forceCoeffs/0/coefficient.dat",
            "echo SOLVER_LOG",
            "tail -n 60 log.simpleFoam",
            "echo CHECKMESH",
            "grep -E 'non-orthogonality Max|severely non-orthogonal' log.checkMesh.4 || true",
        ]
    )
    try:
        done = _bash(script, timeout=900)
    finally:
        _bash(f'rm -rf "{os.path.dirname(wsl_case)}"', timeout=120)
    out = done.stdout
    assert done.returncode == 0, out[-3000:] + done.stderr[-2000:]
    boundary = out.split("COEFFICIENTS")[0]
    types = dict(re.findall(r"^\s{4}(\w+)\s*\n\s*\{\s*\n\s*type\s+(\w+);", boundary, re.M))
    assert types == {"farfield": "patch", "airfoil": "wall", "front": "empty", "back": "empty"}
    assert "SOLVER 0" in out and "SOLVER_ENDED" in out
    coefficients, rest = out.split("COEFFICIENTS", 1)[1].split("SOLVER_LOG", 1)
    log, checkmesh = rest.split("CHECKMESH", 1)
    rows = foamcase.parse_coefficients(coefficients)
    result = foamcase.summarize(rows, log)
    assert result["iterations"] == cmesh.LEVELS["medium"].iterations and result["steady"], result
    # How far the solver got: p levels off near 6e-4 at 4° (no residual targets); U, k and ω
    # far below. A worse mesh shows here first (an opened wake layer gave 2.8e-3).
    res = result["residuals"]
    assert res is not None and res["p"] < 2e-3 and res["U"] < 1e-4 and res["k"] < 1e-4 and res["omega"] < 1e-6, res
    # checkMesh on the case: no face 70° or more off orthogonal (the wake cut once had 10 at 87°).
    worst = float(re.search(r"Mesh non-orthogonality Max: ([0-9.]+)", checkmesh).group(1))
    assert worst < 65.0 and "severely non-orthogonal" not in checkmesh, checkmesh

    # XFOIL, the shipped program, with transition forced at 5 % on both surfaces.
    reason = xfoil.unavailable_reason()
    if reason:
        pytest.skip(reason)
    sec = naca.generate("2412", 81)
    conditions = {**settings.DEFAULT_CONDITIONS, "alpha_start": 4.0, "alpha_end": 4.0, "xtr_top": 0.05, "xtr_bottom": 0.05}
    with tempfile.TemporaryDirectory() as tmp:
        polar = xfoil.run(sec.name, sec.x, sec.y, [4.0], conditions, Path(tmp))
    [row] = polar.rows
    assert abs(result["cl"] - row["cl"]) / row["cl"] < 0.10, (result["cl"], row["cl"])
    assert result["cm"] < 0 and row["cm"] < 0
