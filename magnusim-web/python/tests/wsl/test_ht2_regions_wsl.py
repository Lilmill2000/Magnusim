"""HT2, WSL half: a study of two materials (Air on Body1, Aluminium 6061 on Body2 of the
two-box part) meshed to the end by Standard and Hex-dominant.

Each mesh has one cellZone per region and passes checkMesh, and it splits into its
regions the way a conjugate heat transfer case is set up (``splitMeshRegions
-cellZones``): an ``air`` and an ``aluminium_6061`` region, each passing checkMesh,
with the interface patches between them. ``pytest -m wsl``, about a minute each.
"""

from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from cfddesk.mesh.zones import cell_zone_sizes
from cfddesk.registry import reset_for_tests
from cfddesk.runner.cleanup import remove_wsl_case
from cfddesk.wsl.mesh_run import _checkmesh_ok, windows_to_wsl_path
from cfddesk.wsl.openfoam import OPENFOAM_WRAPPER, run_wsl_bash
from tests.unit.test_ht2_regions_mesh import HEAT, TWO, _heat_project
from tests.wsl.test_mesh_wsl import PY, TOOLS, _patches, _run

pytestmark = [pytest.mark.wsl, pytest.mark.occt, pytest.mark.slow]


@pytest.fixture(autouse=True)
def _heat_plugins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(HEAT))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _split_and_check(case: Path) -> str:
    """A copy of the mesh in WSL split into its regions; checkMesh on every region. Its log."""
    tmp = f"/tmp/ht2-split-{uuid.uuid4().hex[:8]}"
    src = windows_to_wsl_path(case)
    r = run_wsl_bash(
        f"mkdir -p {tmp} && cp -r '{src}/constant' '{src}/system' {tmp}/ && cd {tmp} && "
        # A CHT case names its regions (the case writer writes it; checkMesh -allRegions reads it).
        "printf 'FoamFile { version 2.0; format ascii; class dictionary; object regionProperties; }\n"
        "regions ( fluid (air) solid (aluminium_6061) );\n' > constant/regionProperties && "
        f"{OPENFOAM_WRAPPER} bash -c 'splitMeshRegions -cellZones -overwrite > log.split 2>&1 && "
        "checkMesh -allRegions -noFunctionObjects > log.check 2>&1'; rc=$?; "
        f"cat {tmp}/log.split {tmp}/log.check; for r in air aluminium_6061; do echo \"== $r\"; "
        f"grep -E '^ *[a-z_0-9]+$' {tmp}/constant/$r/polyMesh/boundary | head -20; done; rm -rf {tmp}; exit $rc",
        timeout=900,
    )
    assert r.returncode == 0, (r.stdout[-4000:], r.stderr[-2000:])
    return r.stdout


def _assert_two_regions(case: Path, res: dict) -> None:
    zones = cell_zone_sizes(case / "constant" / "polyMesh")
    assert set(zones) == {"air", "aluminium_6061"} and min(zones.values()) > 0, zones
    rows = {r["name"]: r for r in res["regions"]}
    assert {n: r["cells"] for n, r in rows.items()} == zones
    assert (rows["air"]["role"], rows["aluminium_6061"]["role"]) == ("fluid", "solid")
    assert "aluminium_6061_walls" in _patches(case)
    check = run_wsl_bash(
        f"cd '{windows_to_wsl_path(case)}' && {OPENFOAM_WRAPPER} bash -c 'checkMesh -noFunctionObjects'",
        timeout=900,
    )
    assert check.returncode == 0 and _checkmesh_ok(check.stdout, allow_skew=True), check.stdout[-3000:]
    log = _split_and_check(case)
    assert "air_to_aluminium_6061" in log and "aluminium_6061_to_air" in log, log[-3000:]
    assert "Number of regions: 1 (OK)." in log and "Failed" not in log, log[-3000:]
    assert log.count("Mesh OK.") == 2, log[-3000:]


def test_w6_standard_two_materials(tmp_path: Path) -> None:
    proj = _heat_project(tmp_path, TWO)
    case = tmp_path / "case"
    wsl_case = f"cfddesk-golden-w6-{uuid.uuid4().hex[:8]}"
    try:
        res = _run(
            [
                str(TOOLS / "generate_standard.py"),
                "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case,
                "--generate-id", "golden", "--fineness", "3", "--hex-core", "1", "--add-layers", "1",
                "--threads", "4", "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
            ]
        )
    finally:
        remove_wsl_case(wsl_case)
    assert res["hex_core"] is False
    # The layers pass ran on the zoned mesh (fluid walls only) and stayed.
    assert res["layers_applied"] is True
    _assert_two_regions(case, res)


def test_w7_hex_dominant_two_materials(tmp_path: Path) -> None:
    proj = _heat_project(tmp_path, TWO)
    step = next(proj.rglob("source.step"))
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step), "--out", str(step.with_name("Body1.stl")), "--cad-quality"],
        cwd=str(PY), capture_output=True, text=True, timeout=600,
        env={**os.environ, "PYTHONPATH": os.pathsep.join([str(PY), str(PY / "sdk")])},
    )
    assert r.returncode == 0, r.stderr[-2000:]
    case = tmp_path / "case"
    wsl_case = f"cfddesk-golden-w7-{uuid.uuid4().hex[:8]}"
    try:
        res = _run(
            [
                str(TOOLS / "generate_snappy.py"),
                "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case,
                "--generate-id", "golden", "--fineness", "3", "--add-layers", "1",
                "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
            ]
        )
    finally:
        remove_wsl_case(wsl_case)
    _assert_two_regions(case, res)


ONE = [{"id": "m-air", "name": "Air", "material_model": "example_heat_fluid", "assigned_volumes": ["Body1"], "simulation_id": "sim_1"}]


@pytest.mark.parametrize("mesher", ["standard", "hex_dominant"])
def test_w8_a_body_with_no_material_is_left_out(tmp_path: Path, mesher: str) -> None:
    """Air on Body1 only: box 2 is left out; the mesh is box 1 alone, the face it shared a wall."""
    proj = _heat_project(tmp_path, ONE, "face 1@Body1", "face 3@Body1")
    case = tmp_path / "case"
    wsl_case = f"cfddesk-golden-w8-{uuid.uuid4().hex[:8]}"
    argv = ["--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case, "--generate-id", "golden",
            "--fineness", "3", "--add-layers", "1", "--mesh-id", "mesh_1", "--simulation-id", "sim_1"]
    if mesher == "standard":
        tool = "generate_standard.py"
        argv += ["--hex-core", "1", "--threads", "4"]
    else:
        tool = "generate_snappy.py"
        step = next(proj.rglob("source.step"))
        r = subprocess.run(
            [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step), "--out", str(step.with_name("Body1.stl")), "--cad-quality"],
            cwd=str(PY), capture_output=True, text=True, timeout=600,
            env={**os.environ, "PYTHONPATH": os.pathsep.join([str(PY), str(PY / "sdk")])},
        )
        assert r.returncode == 0, r.stderr[-2000:]
    try:
        res = _run([str(TOOLS / tool), *argv])
    finally:
        remove_wsl_case(wsl_case)
    assert res["left_out"] == ["Body2"]
    assert [r["name"] for r in res["regions"]] == ["air"]
    assert set(cell_zone_sizes(case / "constant" / "polyMesh")) == {"air"}
    check = run_wsl_bash(
        f"cd '{windows_to_wsl_path(case)}' && {OPENFOAM_WRAPPER} bash -c 'checkMesh -noFunctionObjects'",
        timeout=900,
    )
    assert check.returncode == 0 and _checkmesh_ok(check.stdout, allow_skew=True), check.stdout[-3000:]
    # Box 1 alone: the mesh ends at x = 10 mm.
    pts = run_wsl_bash(
        f"cd '{windows_to_wsl_path(case)}' && {OPENFOAM_WRAPPER} bash -c 'checkMesh -noFunctionObjects' | grep -i 'bounding box'",
        timeout=900,
    )
    assert "(0.01 " in pts.stdout or "0.0100" in pts.stdout or "(0.01" in pts.stdout, pts.stdout
