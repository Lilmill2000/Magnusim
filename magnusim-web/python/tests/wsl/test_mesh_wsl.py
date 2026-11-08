"""Mesh goldens, WSL half: each mesher's full run, checked on the mesh OpenFOAM reads.

``tests/unit/test_mesh_goldens.py`` pins what each mesher writes before WSL.
These run the same command lines to the end (``pytest -m wsl``, minutes each):

- W1 Standard, one thread, layers off: the cell count is exactly the host
  mesh's, each boundary face is one golden triangle, checkMesh passes.
- W2 Hex-dominant: ok, feature refinement marked, its patches, the cell count
  near the recorded one, and checkMesh run here too (its own pipeline runs it as well
  and fails Generate on a check it does not accept).
- W3 cfMesh: checkMesh passes, patch types, the cell count near the recorded one.
- W4 Standard with production threads: within 1 % of the one-thread golden
  (threads make gmsh differ run to run, so this one cannot be byte-exact).
- W5 Standard on a plate whose tabs sit 0.188 mm off its slots (small feature
  suppression at 1.5 mm used to open its surface): meshes with its hex core and
  layers, and checkMesh passes. Its walls are meshed finer than h around the
  tabs, so their layers are sized in bands (patches of their own for the
  layers pass): after the mesh they are one ``walls`` patch again.
- W6 Hex-dominant on a long pipe (55 D, fineness 6): its background cells along the
  pipe were six to ten times their size across it, and snappyHexMesh left cells of
  negative volume (Generate failed, naming the check: Daniel's D1). With the cells kept
  within 3 times as long as the longer side across (F2) the block has more cells along
  the pipe, and the mesh passes checkMesh. It is the part's shape too (``_pipe_shape``):
  its inlet and outlet flat on their planes, they, the wall and the pipe's cross-section
  within 0.5 % of the CAD faces' areas (2026-11-08: its caps had a chamfer at the rim,
  312.41 mm² for the disc's 314.16).
- W7 Hex-dominant on a flat plate (100 x 100 x 2 mm, fineness 4, the box of Heat
  Transfer's cavity-slab.step): the rule is for needles only, so the plate keeps the
  block it had before F2 (30 30 12; F2's first rule gave it 200 200 12, and its
  refinement reached snappyHexMesh's cell limit), and Generate ends done.
- W8 Hex-dominant on validation case 2's pipe (20 mm across, 600 mm long, 30 D, fineness
  6): the 80 cells along it that the cap gives left its inlet's and outlet's centres 1.26 mm
  inside the pipe, and the slanted ring round each made them 344.3 mm² for 314.16 (+9.6 %,
  the extra flow of a Normal to face inlet; 2026-11-08). With the block's ends just outside
  the pipe's two planes (``snappy_hexdominant.aligned_span``) it is the part's shape, as W6.
- W9 Hex-dominant on pipes whose block the cap leaves alone but whose cells are still long
  against their side across: the 20 mm pipe 500 mm long (25 D) at fineness 6 with
  physics-based meshing off (67 8 12, the walls' level 1) kept its inlet's centre 1.87 mm
  inside the pipe and its ends 334.7 mm² for 314.16 (+6.5 %), and case 1's 300 mm pipe at
  fineness 4 (42 8 12) points up to 0.63 mm inside and its ends 0.6 % small (6c515bc6, which
  aligned only the cap's axis; 2026-11-08). With every such axis aligned
  (``snappy_hexdominant.end_plane_axes``) both are the part's shape, as W6.

Each run has its own WSL case id and removes it when done. Record the cell
counts after a deliberate change with ``CFDDESK_UPDATE_GOLDEN=1``. snappyHexMesh runs on
at most 8 ranks here (``MAGNUSIM_TEST_MESH_RANKS``, set unless the caller sets it), not on
every physical core as in the app: the PC's WSL may be running other work.
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


def _results(argv: list[str], *, timeout: float = 3600) -> tuple[int, list[dict[str, Any]], str]:
    """The generator's exit code, its result lines and the end of its stderr. Its output is
    UTF-8, as the app runs it (scripts/job-runner.js): a reason can say "90°"."""
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(PY), str(PY / "sdk")]), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    env.pop("CFDDESK_UPDATE_GOLDEN", None)
    env.setdefault("MAGNUSIM_TEST_MESH_RANKS", "8")
    r = subprocess.run(
        [sys.executable, *argv], cwd=str(PY), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout
    )
    events = [json.loads(line.split(" ", 1)[1]) for line in r.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    return r.returncode, [e for e in events if e.get("event") == "result"], r.stderr[-2000:]


def _run(argv: list[str], *, timeout: float = 3600) -> dict[str, Any]:
    rc, results, err = _results(argv, timeout=timeout)
    assert rc == 0 and results and results[-1].get("ok"), (rc, results[-1:], err)
    return results[-1]


def _case_id(tag: str) -> str:
    return f"cfddesk-golden-{tag}-{uuid.uuid4().hex[:8]}"


def _patches(case: Path) -> dict[str, tuple[str, int]]:
    text = (case / "constant" / "polyMesh" / "boundary").read_text(encoding="utf-8")
    return {name: (kind, int(n)) for name, kind, n in _PATCH.findall(text)}


_BAND = re.compile(r"_bl\d+_*$")


def _merged_groups(groups: dict[str, int]) -> dict[str, int]:
    """Triangle groups with the layer bands (``walls_bl3``) counted in their patch,
    as the mesh has them after the layers pass merges them back."""
    out: dict[str, int] = {}
    for name, n in groups.items():
        base = _BAND.sub("", name)
        out[base] = out.get(base, 0) + int(n)
    return out


def _golden_types(name: str) -> dict[str, str]:
    lines = (GOLDEN / name / "constant" / "triSurface" / "patch_types.txt").read_text(encoding="utf-8").split("\n")
    return {k: v for k, v in (ln.split() for ln in lines if ln.strip()) if not _BAND.search(k)}


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
        assert {k: v[1] for k, v in patches.items()} == _merged_groups(msh["triangles_per_group"])


def _body1(proj: Path) -> None:
    """The project's Body1.stl at CAD quality, as the server builds it before a Hex-dominant Generate."""
    step = next(proj.rglob("source.step"))
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step), "--out", str(step.with_name("Body1.stl")), "--cad-quality"],
        cwd=str(PY), capture_output=True, text=True, timeout=600,
        env={**os.environ, "PYTHONPATH": os.pathsep.join([str(PY), str(PY / "sdk")])},
    )
    assert r.returncode == 0, r.stderr[-2000:]


def test_w2_hex_dominant(tmp_path: Path):
    proj, mesh = _project(tmp_path)
    _body1(proj)
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


def test_w5_standard_tabs_part(tmp_path: Path):
    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step
    from tests.unit.test_standard_small_features import _tabs_fluid

    step = tmp_path / "tabs.step"
    write_step(_tabs_fluid(), step)
    # Inlet and outlet: the box's bottom (z = -40 mm) and top (z = +40 mm) faces
    # (labels are 1-based).
    solid = load_step(step)
    ends = sorted((f.centroid[2], f.face_id) for f in solid.faces if abs(abs(f.centroid[2]) - 40.0) < 1e-6)
    assert len(ends) == 2
    proj, mesh = _project(tmp_path / "p", step=step, faces=(ends[0][1] + 1, ends[1][1] + 1))
    case = mesh / "case"
    wsl_case = _case_id("w5")
    try:
        res = _run(
            [
                str(TOOLS / "generate_standard.py"),
                "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case,
                "--generate-id", "golden", "--fineness", "1", "--hex-core", "1", "--add-layers", "1",
                "--small-feature", "0.0015", "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
            ]
        )
    finally:
        remove_wsl_case(wsl_case)
    meta = json.loads((case / "standard-meta.json").read_text(encoding="utf-8"))
    assert meta["hex_core_applied"] is True and meta["host_mesh"]["n_hex"] > 0
    assert res["layers_applied"] is True
    assert _checkmesh_ok((case / "log.standard_generate.txt").read_text(encoding="utf-8"), allow_skew=True)
    host = (case / "log.gmsh_host.txt").read_text(encoding="utf-8")
    assert "small feature suppression: faces below 0.0015 m suppressed" in host
    # Layer bands were used and merged back: the mesh has the study's patches only.
    bands = meta["sizing"]["layers"]["bands"]
    assert bands.get("walls"), bands
    patches = _patches(case)
    assert sorted(patches) == ["pressure_1", "velocity_inlet_1", "walls"], sorted(patches)
    assert patches["walls"][0] == "wall"


def _pipe_project(tmp: Path, *, d_mm: float, l_mm: float) -> tuple[Path, Path]:
    """A pipe of diameter ``d_mm`` and length ``l_mm`` along +x (the fluid), its inlet the disc
    at x = 0 and its outlet the disc at x = L, in the sample project's study."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step

    step = tmp / "pipe.step"
    write_step(BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), d_mm / 2.0, l_mm).Shape(), step)
    solid = load_step(step)
    inlet = [f.face_id for f in solid.faces if abs(f.centroid[0]) < 1e-6]
    outlet = [f.face_id for f in solid.faces if abs(f.centroid[0] - l_mm) < 1e-6]
    assert len(inlet) == 1 and len(outlet) == 1, [(f.face_id, f.centroid) for f in solid.faces]
    # Face labels are 1-based.
    proj, mesh = _project(tmp / "p", step=step, faces=(inlet[0] + 1, outlet[0] + 1))
    _body1(proj)
    return proj, mesh


def _cad_areas(tmp: Path, l_mm: float) -> dict[str, float]:
    """The pipe's CAD faces' areas (mm²): its inlet and outlet discs and its wall."""
    from cfddesk.cad.step import load_step

    faces = load_step(tmp / "pipe.step").faces
    inlet = [f.area for f in faces if abs(f.centroid[0]) < 1e-6]
    outlet = [f.area for f in faces if abs(f.centroid[0] - l_mm) < 1e-6]
    wall = [f.area for f in faces if f.surface_type != "Plane"]
    assert len(inlet) == len(outlet) == len(wall) == 1
    return {"inlet": float(inlet[0]), "outlet": float(outlet[0]), "wall": float(wall[0])}


def _pipe_shape(case: Path, *, l_mm: float) -> dict[str, Any]:
    """The meshed pipe's shape as the app's reader (pyvista's OpenFOAM reader) reads its mesh:
    each patch's area (mm², the sum of its faces') and its points' span along the pipe (mm), and
    the pipe's cross-section (mm²) a quarter, half and three quarters along it."""
    import pyvista as pv

    foam = case / "case.foam"
    foam.write_text("", encoding="ascii")
    reader = pv.OpenFOAMReader(str(foam))
    reader.enable_all_patch_arrays()
    data = reader.read()
    patches: dict[str, dict[str, Any]] = {}
    boundary = data["boundary"]
    for name in boundary.keys():
        poly = boundary[name]
        if poly is None or poly.n_cells == 0:
            continue
        area = float(poly.compute_cell_sizes(length=False, area=True, volume=False)["Area"].sum()) * 1e6
        x = poly.points[:, 0] * 1e3
        patches[name] = {"area_mm2": area, "x_mm": [float(x.min()), float(x.max())]}
    internal = data["internalMesh"]
    sections: dict[float, float] = {}
    for frac in (0.25, 0.5, 0.75):
        # 0.137 mm off the plane, so the cut is not on a background cell's face.
        cut = internal.slice(normal=(1.0, 0.0, 0.0), origin=((frac * l_mm + 0.137) / 1e3, 0.0, 0.0))
        sections[frac] = float(cut.compute_cell_sizes(length=False, area=True, volume=False)["Area"].sum()) * 1e6
    return {"patches": patches, "sections": sections}


def _assert_pipe_shape(shape: dict[str, Any], cad: dict[str, float], *, l_mm: float, section_rel: float = 0.005) -> None:
    """The pipe's mesh is the part's shape: its inlet and outlet flat on their planes (every point
    within 0.05 mm), and they, the wall and the cross-section within 0.5 % of the CAD faces (the
    cross-section within ``section_rel``)."""
    got = shape["patches"]
    for name, patch, plane in (("inlet", "velocity_inlet_1", 0.0), ("outlet", "pressure_1", l_mm)):
        span = got[patch]["x_mm"]
        assert abs(span[0] - plane) <= 0.05 and abs(span[1] - plane) <= 0.05, (name, span, shape)
        assert abs(got[patch]["area_mm2"] / cad[name] - 1.0) <= 0.005, (name, got[patch]["area_mm2"], cad[name], shape)
    assert abs(got["walls"]["area_mm2"] / cad["wall"] - 1.0) <= 0.005, (got["walls"]["area_mm2"], cad["wall"])
    for frac, area in shape["sections"].items():
        assert abs(area / cad["inlet"] - 1.0) <= section_rel, (frac, area, cad["inlet"], shape)


def _hex_dominant_pipe(
    tmp: Path, tag: str, *, l_mm: float, fineness: int = 6, physics: bool = True
) -> tuple[int, dict[str, Any], str, Path]:
    """A 20 mm pipe ``l_mm`` long meshed by Hex-dominant at ``fineness`` (physics-based meshing
    ``physics``), no layers: the generator's exit code, its result, the end of its stderr and the
    case folder."""
    proj, mesh = _pipe_project(tmp, d_mm=20.0, l_mm=l_mm)
    case = mesh / "case"
    wsl_case = _case_id(tag)
    try:
        rc, results, err = _results(
            [
                str(TOOLS / "generate_snappy.py"),
                "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case,
                "--generate-id", "golden", "--fineness", str(int(fineness)), "--add-layers", "0",
                "--physics-based", "1" if physics else "0",
                "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
            ]
        )
    finally:
        remove_wsl_case(wsl_case)
    assert results, (rc, err)
    return rc, results[-1], err, case


def _assert_passes_checkmesh(rc: int, res: dict[str, Any], err: str, case: Path) -> None:
    """Generate ends done and the mesh passes checkMesh, with no failed check at all."""
    from cfddesk.wsl.mesh_run import checkmesh_failure

    log = (case / "log.checkMesh").read_text(encoding="utf-8")
    assert rc == 0 and res["ok"] is True and "error" not in res, (rc, res, err, log[-3000:])
    assert checkmesh_failure(log) is None
    quality = res["quality"]
    assert quality["known"] is True and quality["ok"] is True and not quality.get("failed"), quality
    assert res["n_cells"] and res["n_cells"] > 0
    # snappyHexMesh ran on no more ranks than the cap.
    snappy = (case / "log.snappyHexMesh").read_text(encoding="utf-8", errors="replace")
    ranks = re.search(r"^nProcs\s*:\s*(\d+)", snappy, re.M)
    assert ranks is None or int(ranks.group(1)) <= int(os.environ.get("MAGNUSIM_TEST_MESH_RANKS", "8")), ranks


def test_w6_hex_dominant_long_pipe(tmp_path: Path):
    rc, res, err, case = _hex_dominant_pipe(tmp_path, "w6", l_mm=1100.0)
    # The cap: 147 cells along the 1463 mm (padded) pipe, 9.95 mm each, 3 times the 3.33 mm
    # across y (8 cells); it had 68, 21.5 mm each.
    assert res["block"] == "(147 8 12)", res
    _assert_passes_checkmesh(rc, res, err, case)
    shape = _pipe_shape(case, l_mm=1100.0)
    print(f"[w6] {res['n_cells']} cells, {json.dumps(shape)}")
    _assert_pipe_shape(shape, _cad_areas(tmp_path, 1100.0), l_mm=1100.0)


def test_w8_hex_dominant_case_2_pipe(tmp_path: Path):
    rc, res, err, case = _hex_dominant_pipe(tmp_path, "w8", l_mm=600.0)
    # The cap's block (67 cells along before it, 11.9 mm each).
    assert res["block"] == "(80 8 12)", res
    _assert_passes_checkmesh(rc, res, err, case)
    shape = _pipe_shape(case, l_mm=600.0)
    print(f"[w8] {res['n_cells']} cells, {json.dumps(shape)}")
    _assert_pipe_shape(shape, _cad_areas(tmp_path, 600.0), l_mm=600.0)


@pytest.mark.parametrize(
    ("l_mm", "fineness", "physics", "block", "section_rel"),
    [
        # Its walls' level 1 (physics-based meshing off): the 20 mm circle in cells 1.66 mm across
        # leaves the pipe's cross-section 0.53 % under the disc's, the inlet's and outlet's discs
        # (snapped on their planes) 0.05 %.
        (500.0, 6, False, "(67 8 12)", 0.01),
        (300.0, 4, True, "(42 8 12)", 0.005),
    ],
    ids=["25 D, physics-based off", "15 D at fineness 4"],
)
def test_w9_hex_dominant_pipe_of_long_cells_the_cap_leaves_alone(
    tmp_path: Path, l_mm: float, fineness: int, physics: bool, block: str, section_rel: float
):
    rc, res, err, case = _hex_dominant_pipe(tmp_path, "w9", l_mm=l_mm, fineness=fineness, physics=physics)
    # The block as before: the cap leaves it alone.
    assert res["block"] == block, res
    _assert_passes_checkmesh(rc, res, err, case)
    shape = _pipe_shape(case, l_mm=l_mm)
    print(f"[w9] {l_mm:g} mm at fineness {fineness}: {res['n_cells']} cells, {json.dumps(shape)}")
    _assert_pipe_shape(shape, _cad_areas(tmp_path, l_mm), l_mm=l_mm, section_rel=section_rel)


def _box_project(tmp: Path, *, x_mm: float, y_mm: float, z_mm: float) -> tuple[Path, Path]:
    """A box ``x_mm`` x ``y_mm`` x ``z_mm`` from the origin (the fluid), its inlet the face at
    x = 0 and its outlet the face at x = ``x_mm``, in the sample project's study."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step

    step = tmp / "box.step"
    write_step(BRepPrimAPI_MakeBox(x_mm, y_mm, z_mm).Shape(), step)
    solid = load_step(step)
    inlet = [f.face_id for f in solid.faces if abs(f.centroid[0]) < 1e-6]
    outlet = [f.face_id for f in solid.faces if abs(f.centroid[0] - x_mm) < 1e-6]
    assert len(inlet) == 1 and len(outlet) == 1, [(f.face_id, f.centroid) for f in solid.faces]
    proj, mesh = _project(tmp / "p", step=step, faces=(inlet[0] + 1, outlet[0] + 1))
    _body1(proj)
    return proj, mesh


def test_w7_hex_dominant_flat_plate(tmp_path: Path):
    from cfddesk.wsl.mesh_run import checkmesh_failure

    proj, mesh = _box_project(tmp_path, x_mm=100.0, y_mm=100.0, z_mm=2.0)
    case = mesh / "case"
    wsl_case = _case_id("w7")
    try:
        rc, results, err = _results(
            [
                str(TOOLS / "generate_snappy.py"),
                "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case,
                "--generate-id", "golden", "--fineness", "4", "--add-layers", "0",
                "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
            ]
        )
    finally:
        remove_wsl_case(wsl_case)
    assert results, (rc, err)
    res = results[-1]
    log = (case / "log.checkMesh").read_text(encoding="utf-8")
    # The block it had before F2: its cells 4.4 mm wide and 0.22 mm through, long against the
    # thin side only.
    assert res["block"] == "(30 30 12)", res
    # Its refinement stays well under snappyHexMesh's limit, and the mesh passes the rule.
    snappy = (case / "log.snappyHexMesh").read_text(encoding="utf-8", errors="replace")
    assert "reached limit" not in snappy
    assert rc == 0 and res["ok"] is True and "error" not in res, (rc, res, err, log[-3000:])
    assert checkmesh_failure(log) is None
    assert res["quality"]["known"] is True
    assert res["n_cells"] and 0 < res["n_cells"] < 400_000, res["n_cells"]
