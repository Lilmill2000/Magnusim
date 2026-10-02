"""Mesh goldens, WSL half: each mesher's full run, checked on the mesh OpenFOAM reads.

``tests/unit/test_mesh_goldens.py`` pins what each mesher writes before WSL.
These run the same command lines to the end (``pytest -m wsl``, minutes each):

- W1 Standard, one thread, layers off: the cell count is exactly the host
  mesh's, each boundary face is one golden triangle, checkMesh passes.
- W2 Hex-dominant: ok, feature refinement marked, its patches, the cell count
  near the recorded one, and checkMesh run here (its own pipeline has none).
- W3 cfMesh: checkMesh passes, patch types, the cell count near the recorded one.
- W4 Standard with production threads: within 1 % of the one-thread golden
  (threads make gmsh differ run to run, so this one cannot be byte-exact).

Each run has its own WSL case id and removes it when done. Record the cell
counts after a deliberate change with ``CFDDESK_UPDATE_GOLDEN=1``.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest

from cfddesk.runner.cleanup import remove_wsl_case
from cfddesk.wsl.mesh_run import _checkmesh_ok, windows_to_wsl_path
from cfddesk.wsl.openfoam import OPENFOAM_WRAPPER, run_wsl_bash
from tests.unit.test_mesh_goldens import GOLDEN, PLATFORM, PY, TOOLS, UPDATE, _project

pytestmark = [pytest.mark.wsl, pytest.mark.occt, pytest.mark.slow]

_PATCH = re.compile(r"^\s*(\w+)\s*\{[^}]*?\btype\s+(\w+);[^}]*?\bnFaces\s+(\d+);", re.M | re.S)


def _run(argv: list[str], *, timeout: float = 3600) -> dict[str, Any]:
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(PY), str(PY / "sdk")])}
    env.pop("CFDDESK_UPDATE_GOLDEN", None)
    r = subprocess.run(
        [sys.executable, *argv], cwd=str(PY), env=env, capture_output=True, text=True, timeout=timeout
    )
    events = [json.loads(line.split(" ", 1)[1]) for line in r.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    results = [e for e in events if e.get("event") == "result"]
    assert r.returncode == 0 and results and results[-1].get("ok"), (r.returncode, results[-1:], r.stderr[-2000:])
    return results[-1]


def _case_id(tag: str) -> str:
    return f"cfddesk-golden-{tag}-{uuid.uuid4().hex[:8]}"


def _patches(case: Path) -> dict[str, tuple[str, int]]:
    text = (case / "constant" / "polyMesh" / "boundary").read_text(encoding="utf-8")
    return {name: (kind, int(n)) for name, kind, n in _PATCH.findall(text)}


def _golden_types(name: str) -> dict[str, str]:
    lines = (GOLDEN / name / "constant" / "triSurface" / "patch_types.txt").read_text(encoding="utf-8").split("\n")
    return dict(ln.split() for ln in lines if ln.strip())


def _host_record(name: str) -> dict[str, Any] | None:
    p = GOLDEN / name / f"{PLATFORM}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def _near_recorded(name: str, n_cells: int, rel: float) -> None:
    """n_cells within ``rel`` of the count recorded in <golden>/wsl.json."""
    p = GOLDEN / name / "wsl.json"
    if UPDATE:
        p.write_text(json.dumps({"n_cells": n_cells}, indent=1) + "\n", encoding="utf-8", newline="\n")
        return
    want = json.loads(p.read_text(encoding="utf-8"))["n_cells"]
    assert abs(n_cells - want) <= rel * want, f"{n_cells} cells, recorded {want} (allowed {rel:.0%})"


def _standard(tmp: Path, wsl_case: str, *, threads: int | None) -> tuple[dict[str, Any], Path]:
    proj, mesh = _project(tmp)
    case = mesh / "case"
    argv = [
        str(TOOLS / "generate_standard.py"),
        "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case,
        "--generate-id", "golden", "--fineness", "2", "--hex-core", "1", "--add-layers", "0",
        "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
    ]
    if threads is not None:
        argv += ["--threads", str(threads)]
    return _run(argv), case


def test_w1_standard(tmp_path: Path):
    wsl_case = _case_id("w1")
    try:
        res, case = _standard(tmp_path, wsl_case, threads=1)
    finally:
        remove_wsl_case(wsl_case)
    host = json.loads((case / "standard-meta.json").read_text(encoding="utf-8"))["host_mesh"]
    host_cells = host["n_tets"] + host["n_hex"] + host["n_pyr"] + host["n_prism"]
    assert res["layers_applied"] is False
    assert res["n_cells"] == host_cells, (res["n_cells"], host)
    assert _checkmesh_ok((case / "log.standard_generate.txt").read_text(encoding="utf-8"))
    types = _golden_types("standard-hexcore-f2")
    record = _host_record("standard-hexcore-f2")
    patches = _patches(case)
    assert {k: v[0] for k, v in patches.items()} == types
    if record:
        # One thread is repeatable: the same cells and boundary as the golden msh.
        msh = record["files"]["constant/triSurface/geometry.msh"]["mesh"]
        assert res["n_cells"] == sum(n for kind, n in msh["elements"].items() if kind != "tri")
        assert {k: v[1] for k, v in patches.items()} == msh["triangles_per_group"]


def test_w2_hex_dominant(tmp_path: Path):
    proj, mesh = _project(tmp_path)
    step = next(proj.rglob("source.step"))
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step), "--out", str(step.with_name("Body1.stl")), "--cad-quality"],
        cwd=str(PY), capture_output=True, text=True, timeout=600,
        env={**os.environ, "PYTHONPATH": os.pathsep.join([str(PY), str(PY / "sdk")])},
    )
    assert r.returncode == 0, r.stderr[-2000:]
    case = mesh / "case"
    wsl_case = _case_id("w2")
    try:
        res = _run(
            [
                str(TOOLS / "generate_snappy.py"),
                "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case,
                "--generate-id", "golden", "--fineness", "5", "--add-layers", "1",
                "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
            ]
        )
    finally:
        remove_wsl_case(wsl_case)
    assert res["feature_marks_total"] >= 1
    assert sorted(_patches(case)) == ["pressure_1", "velocity_inlet_1", "walls"]
    _near_recorded("hexdominant-layers-f5", res["n_cells"], 0.03)
    check = run_wsl_bash(
        f"cd '{windows_to_wsl_path(case)}' && {OPENFOAM_WRAPPER} bash -c 'checkMesh -noFunctionObjects'",
        timeout=900,
    )
    assert check.returncode == 0, check.stderr[-2000:]
    assert _checkmesh_ok(check.stdout, allow_skew=True), check.stdout[-3000:]


def test_w3_cfmesh(tmp_path: Path):
    proj, mesh = _project(tmp_path)
    case = mesh / "case"
    wsl_case = _case_id("w3")
    try:
        res = _run(
            [
                str(TOOLS / "generate_cfmesh_standard.py"),
                "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case,
                "--generate-id", "golden", "--fineness", "1", "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
            ]
        )
    finally:
        remove_wsl_case(wsl_case)
    assert _checkmesh_ok((case / "log.cfmesh_generate.txt").read_text(encoding="utf-8"), allow_skew=True)
    assert {k: v[0] for k, v in _patches(case).items()} == _golden_types("cfmesh-f1")
    _near_recorded("cfmesh-f1", res["n_cells"], 0.02)


def test_w4_standard_production_threads(tmp_path: Path):
    record = _host_record("standard-hexcore-f2")
    if not record:
        pytest.skip(f"no {PLATFORM} record for standard-hexcore-f2")
    wsl_case = _case_id("w4")
    try:
        res, _case = _standard(tmp_path, wsl_case, threads=None)
    finally:
        remove_wsl_case(wsl_case)
    msh = record["files"]["constant/triSurface/geometry.msh"]["mesh"]
    golden = sum(n for kind, n in msh["elements"].items() if kind != "tri")
    assert abs(res["n_cells"] - golden) <= 0.01 * golden, (res["n_cells"], golden)
