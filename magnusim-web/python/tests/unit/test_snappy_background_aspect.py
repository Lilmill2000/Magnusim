"""Hex-dominant's background cells on a long thin part (F2, 2026-11-07).

The background block keeps at least 8, 8 and 12 cells across, and its cell along the part comes
from the part's diagonal, so on a long thin part the cells were needles: a 55 D pipe at fineness
6 had them 6.5 times as long as their side across y (9.7 times their side across z), and
snappyHexMesh snapped them into cells of negative volume (W6; Daniel's D1 now fails such a
Generate). Now no background cell is more than 3 times as long as the longer of its other two
sides: an axis whose cells would be longer gets the fewest more cells that bring them within it
(in 2D the one-cell axis is left out). The rule is for needles only: a flat part (a plate, a thin
gap, a fin) is long against its thin side alone and keeps its block. A part already within the
rule keeps its block, so its dictionaries are byte for byte what they were (the elbow's goldens,
the 10 D pipe here).

When the capped block alone would have more cells than snappyHexMesh's limit
(``maxGlobalCells``), Generate refuses before the run, at any fineness, and names the Standard
mesher. A mesh whose refinement reaches the limit is judged by checkMesh alone, as before F2.

Fails on the code before F2: ``background_counts`` did not exist, and the 55 D pipe's block was
``(68 8 12)``. Fails on F2's first rule (every axis held to the shortest side): the plate's block
was ``(200 200 12)``.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from cfddesk.mesh import two_d
from cfddesk.mesh.snappy_hexdominant import (
    _PAD,
    MAX_BACKGROUND_ASPECT,
    MAX_GLOBAL_CELLS,
    background_counts,
    background_of,
    base_cell_size,
    block_from_fineness,
    cell_limit_refusal,
    write_hexdominant_dicts,
)
from tests.conftest import FIXTURES
from tests.unit.test_mesh_goldens import PY, TOOLS, _env, _project, _ScriptRun

CELL_LIMIT_LOG = FIXTURES / "mesh-facts" / "snappy" / "pipe-400d-cell-limit.log"
WEB = PY.parent


def _pipe(d_mm: float, l_mm: float) -> dict[str, float]:
    """A pipe's box (metres) along +x."""
    r = d_mm / 2000.0
    return {"xmin": 0.0, "xmax": l_mm / 1000.0, "ymin": -r, "ymax": r, "zmin": -r, "zmax": r}


def _box(x_mm: float, y_mm: float, z_mm: float) -> dict[str, float]:
    return {"xmin": 0.0, "xmax": x_mm / 1000.0, "ymin": 0.0, "ymax": y_mm / 1000.0, "zmin": 0.0, "zmax": z_mm / 1000.0}


def _sides(bounds: dict[str, float], counts: list[int], skip: int | None = None) -> list[float]:
    """The block's cell sides, shortest first (an axis of no extent, or ``skip``, left out)."""
    ext = [bounds[f"{c}max"] - bounds[f"{c}min"] for c in "xyz"]
    return sorted(ext[k] * _PAD / counts[k] for k in range(3) if k != skip and ext[k] > 0)


def _needle(bounds: dict[str, float], counts: list[int], skip: int | None = None) -> float:
    """How many times its longest cell side is the next-longest: what the rule holds to 3."""
    s = _sides(bounds, counts, skip)
    return s[-1] / s[-2]


def _counts(block: str) -> list[int]:
    return [int(v) for v in block.strip("()").split()]


# ---------------------------------------------------------------- the block


@pytest.mark.parametrize(
    ("bounds", "fineness", "block"),
    [
        (_pipe(20.0, 200.0), 5, "(53 8 12)"),  # the 10 D pipe: 1.51
        (_pipe(20.0, 200.0), 6, "(67 8 12)"),
        (_pipe(20.0, 300.0), 4, "(42 8 12)"),  # validation case 1's pipe (15 D), its coarse mesh: 2.86
        (_pipe(20.0, 1100.0), 10, "(170 8 12)"),  # the 55 D pipe at fineness 10: 2.59
        (_box(500.0, 20.0, 20.0), 6, "(67 8 12)"),  # a 500 x 20 x 20 duct: 2.99
        (_box(100.0, 100.0, 200.0), 5, "(22 22 44)"),
        # The elbow's box (the Hex-dominant goldens): cells 22.5, 22.5 and 23.0 mm.
        ({"xmin": -0.1524, "xmax": 0.1524, "ymin": -0.1524, "ymax": 0.1524, "zmin": -0.508, "zmax": 0.3048}, 5, "(18 18 47)"),
    ],
)
def test_a_part_within_3_to_1_keeps_its_block(bounds: dict[str, float], fineness: int, block: str):
    assert block_from_fineness(fineness, bounds) == block
    assert background_of(fineness, bounds) == background_of(fineness, bounds, aspect_cap=False)
    assert _needle(bounds, _counts(block)) <= MAX_BACKGROUND_ASPECT


def test_the_10d_pipe_writes_the_same_dictionaries(tmp_path: Path):
    """Byte for byte: the block it had before the cap is the block it gets."""
    bounds = _pipe(20.0, 200.0)
    for name, block in (("capped", block_from_fineness(5, bounds)), ("before", "(53 8 12)")):
        write_hexdominant_dicts(tmp_path / name, block=block, feature_level=3, walls_level=2, add_layers=False, snap={}, bounds_m=bounds)
    for dict_name in ("blockMeshDict", "snappyHexMeshDict"):
        assert (tmp_path / "capped" / "system" / dict_name).read_bytes() == (tmp_path / "before" / "system" / dict_name).read_bytes()
    assert "    maxGlobalCells 4000000;" in (tmp_path / "capped" / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("l_mm", "fineness", "before", "after"),
    [
        (600.0, 6, "(67 8 12)", "(80 8 12)"),  # 30 D: 3.58 (5.37 across z), passed checkMesh (worst face 65°)
        (800.0, 6, "(68 8 12)", "(107 8 12)"),  # 40 D: 4.70
        (800.0, 7, "(85 8 12)", "(107 8 12)"),  # 40 D: 3.76, lost its layers and failed checkMesh
        (1100.0, 6, "(68 8 12)", "(147 8 12)"),  # 55 D: 6.47, cells of negative volume (W6)
        (1100.0, 8, "(107 8 12)", "(147 8 12)"),
    ],
)
def test_a_long_pipe_gets_cells_within_3_to_1(l_mm: float, fineness: int, before: str, after: str):
    bounds = _pipe(20.0, l_mm)
    old = background_of(fineness, bounds, aspect_cap=False)
    assert old == _counts(before) and _needle(bounds, old) > MAX_BACKGROUND_ASPECT
    got = _counts(block_from_fineness(fineness, bounds))
    assert got == _counts(after)
    assert _needle(bounds, got) <= MAX_BACKGROUND_ASPECT + 1e-9
    # The fewest that do: one cell fewer along the pipe and they are longer than 3:1 again.
    assert _needle(bounds, [got[0] - 1, *got[1:]]) > MAX_BACKGROUND_ASPECT
    # Across the pipe nothing changes: its 3.33 mm cells across y (8) are the next-longest side.
    assert got[1:] == old[1:]
    # A needle's capped block is the same at every lower fineness (its sides across are held at
    # their minimum counts), so no fineness gives fewer background cells.
    assert all(background_of(g, bounds) == got for g in range(1, fineness))


@pytest.mark.parametrize(
    ("name", "bounds", "fineness", "block"),
    [
        # Heat Transfer's cavity-slab.step (a new Heat Transfer study meshes on Hex-dominant). F2's
        # first rule gave it (200 200 12), 27.7 times the cells; this 100 x 100 x 2 mm plate at
        # fineness 4 passed checkMesh with its (30 30 12) (only skewed faces, which the rule accepts).
        ("plate 100 x 100 x 2", _box(100.0, 100.0, 2.0), 4, "(30 30 12)"),
        ("plate 100 x 100 x 2", _box(100.0, 100.0, 2.0), 5, "(38 38 12)"),
        ("plate 100 x 100 x 2", _box(100.0, 100.0, 2.0), 8, "(76 76 12)"),
        ("plate 200 x 200 x 5", _box(200.0, 200.0, 5.0), 5, "(38 38 12)"),
        ("gap 200 x 200 x 1", _box(200.0, 200.0, 1.0), 5, "(38 38 12)"),  # F2's first rule refused it
        ("fin 50 x 20 x 1", _box(50.0, 20.0, 1.0), 5, "(50 20 12)"),
        ("duct 1000 x 100 x 10", _box(1000.0, 100.0, 10.0), 5, "(53 8 12)"),
        ("transient-test.step's box", _box(50.0, 1500.0, 500.0), 5, "(8 51 17)"),
        ("Heat Transfer's 3D slab", _box(100.0, 50.0, 10.0), 3, "(30 15 12)"),
    ],
)
def test_a_flat_part_keeps_its_block(name: str, bounds: dict[str, float], fineness: int, block: str):
    """Long against its thin side only, never against both others: the rule leaves it alone."""
    assert block_from_fineness(fineness, bounds) == block, name
    assert background_of(fineness, bounds) == background_of(fineness, bounds, aspect_cap=False), name
    assert cell_limit_refusal(fineness, bounds) is None


@pytest.mark.occt
@pytest.mark.parametrize(
    ("step", "fineness"),
    [
        (WEB / "bundled-plugins" / "heat_transfer" / "e2e" / "fixtures" / "cavity-slab.step", 4),
        (WEB / "bundled-plugins" / "heat_transfer" / "e2e" / "fixtures" / "cavity-slab.step", 8),
        (FIXTURES / "geometry" / "transient-test.step", 5),
    ],
)
def test_the_flat_fixtures_keep_their_block(step: Path, fineness: int):
    """The real STEPs' boxes (as the generator's Body1.stl spans them), at every fineness."""
    from cfddesk.cad.io import load_cad
    from cfddesk.cad.preview import shape_bounds

    box, _ = shape_bounds(load_cad(step).shape)
    bounds = {k: v / 1000.0 for k, v in box.items()}
    for f in (1, fineness, 10):
        assert background_of(f, bounds) == background_of(f, bounds, aspect_cap=False), (step.name, f)


def test_an_axis_of_no_extent_is_left_out():
    """A flat surface (no extent along z) keeps its block: no cell of zero size sets the rule."""
    bounds = {"xmin": 0.0, "xmax": 0.01, "ymin": 0.0, "ymax": 0.01, "zmin": 0.0, "zmax": 0.0}
    assert background_of(3, bounds) == background_of(3, bounds, aspect_cap=False) == [24, 24, 12]


def test_counts_stay_as_they_were_within_the_cap():
    """The rule only adds cells, and only to the axis over 3 times the next-longest side."""
    # 8 cells of 37.5 mm along x against 12.5 mm across: exactly 3:1, left as it is.
    assert background_counts([0.3, 0.1, 0.1], 1.0, 0.0375, (8, 8, 8)) == [8, 8, 8]
    # 38.75 mm: over it, so 9 cells (34.4 mm), the fewest within it.
    assert background_counts([0.31, 0.1, 0.1], 1.0, 0.0375, (8, 8, 8)) == [9, 8, 8]
    # A thin third axis (1.25 mm cells) does not set it: x is within 3 times y's 12.5 mm.
    assert background_counts([0.3, 0.1, 0.01], 1.0, 0.0375, (8, 8, 8)) == [8, 8, 8]


# ---------------------------------------------------------------- one cell across (2D)


def test_2d_leaves_the_one_cell_axis_out():
    """A channel 400 x 10 mm in the section, 50 mm deep along z: the section's cells are held to
    3:1 (its 8 cells across the 10 mm), the depth stays one cell, however deep."""
    for depth in (0.05, 5.0):
        bounds = {"xmin": 0.0, "xmax": 0.4, "ymin": 0.0, "ymax": 0.01, "zmin": 0.0, "zmax": depth}
        base = base_cell_size(5, bounds, two_d_axis=2)
        assert base is not None
        before = background_counts([0.4, 0.01, depth], _PAD, base, (8, 8, 8), one_cell_axis=2, aspect_cap=False)
        _verts, block, _boundary = two_d.background(bounds, base, 2, 0.0, depth, _PAD)
        got = _counts(block)
        assert before == [54, 8, 1]
        assert got == [107, 8, 1], (depth, got)
        assert got == background_of(5, bounds, two_d={"axis": 2, "base_m": base})
        assert _needle(bounds, got, skip=2) <= MAX_BACKGROUND_ASPECT + 1e-9


def test_2d_within_3_to_1_keeps_its_block():
    """The slab of the 2D e2e (100 x 50 mm, 10 mm deep): its 2D block as before."""
    bounds = {"xmin": 0.0, "xmax": 0.1, "ymin": 0.0, "ymax": 0.05, "zmin": 0.0, "zmax": 0.01}
    base = base_cell_size(5, bounds, two_d_axis=2)
    assert base is not None
    _verts, block, _boundary = two_d.background(bounds, base, 2, 0.0, 0.01, _PAD)
    assert block == "(48 24 1)"
    plan = {"axis": 2, "base_m": base}
    assert background_of(5, bounds, two_d=plan) == background_of(5, bounds, two_d=plan, aspect_cap=False)


# ---------------------------------------------------------------- snappyHexMesh's cell limit


REFUSAL_20000D = (
    "Hex-dominant can't mesh this part at any fineness: it is so long and thin that its background block alone, "
    "with no cell more than 3 times as long as wide, would have 5,120,064 cells, over snappyHexMesh's limit of "
    "4,000,000. Try the Standard mesher: it has no background block."
)


def test_a_block_over_the_cell_limit_is_refused_before_the_run():
    """A pipe 1 mm across and 20 m long: 53,334 cells along it, 8 and 12 across."""
    bounds = _pipe(1.0, 20_000.0)
    assert background_of(6, bounds) == [53_334, 8, 12]
    assert cell_limit_refusal(6, bounds) == REFUSAL_20000D
    # The same block, and the same words, at every fineness: no fineness helps.
    assert all(background_of(g, bounds) == [53_334, 8, 12] for g in range(1, 11))
    assert all(cell_limit_refusal(g, bounds) == REFUSAL_20000D for g in range(1, 11))
    # Within the limit: no refusal (the 12,000 D pipe: 32,000 x 8 x 12 = 3,072,000 cells).
    assert math.prod(background_of(6, _pipe(1.0, 12_000.0)) or [0]) <= MAX_GLOBAL_CELLS
    assert cell_limit_refusal(6, _pipe(1.0, 12_000.0)) is None
    assert cell_limit_refusal(6, _pipe(20.0, 1100.0)) is None


def test_a_2d_block_over_the_cell_limit_is_refused_too():
    """A 2D channel 200 m long and 1 mm high, 10 mm deep along z: 533,334 x 8 x 1 cells. The
    Standard mesher has no One cell across: the words say it meshes in 3D."""
    bounds = {"xmin": 0.0, "xmax": 200.0, "ymin": 0.0, "ymax": 0.001, "zmin": 0.0, "zmax": 0.01}
    plan = {"axis": 2, "base_m": base_cell_size(6, bounds, two_d_axis=2)}
    assert background_of(6, bounds, two_d=plan) == [533_334, 8, 1]
    assert cell_limit_refusal(6, bounds, two_d=plan) == (
        "Hex-dominant can't mesh this part at any fineness: it is so long and thin that its background block alone, "
        "with no cell more than 3 times as long as wide, would have 4,266,672 cells, over snappyHexMesh's limit of "
        "4,000,000. Try the Standard mesher: it has no background block, but it meshes in 3D."
    )
    # 20 m long: 426,672 cells, within it.
    short = {**bounds, "xmax": 20.0}
    assert cell_limit_refusal(6, short, two_d={"axis": 2, "base_m": base_cell_size(6, short, two_d_axis=2)}) is None


# ---------------------------------------------------------------- Generate


def _pipe_step(tmp: Path, d_mm: float, l_mm: float) -> tuple[Path, tuple[int, int]]:
    """A pipe STEP along +x and its inlet and outlet face labels (1-based)."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step

    tmp.mkdir(parents=True, exist_ok=True)
    step = tmp / "pipe.step"
    write_step(BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), d_mm / 2.0, l_mm).Shape(), step)
    solid = load_step(step)
    inlet = [f.face_id for f in solid.faces if abs(f.centroid[0]) < 1e-6]
    outlet = [f.face_id for f in solid.faces if abs(f.centroid[0] - l_mm) < 1e-6]
    return step, (inlet[0] + 1, outlet[0] + 1)


def _generate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    *,
    fineness: int,
    pipe: tuple[float, float] | None = None,
    snappy_log: Path | None = None,
) -> tuple[int, dict[str, Any], list[Any]]:
    """``generate_snappy.main()`` on a pipe (or the elbow), its WSL script stood in for by what it
    copies back (``_ScriptRun``, a mesh that passes checkMesh) with ``snappy_log``'s lines added to
    its snappyHexMesh log; its exit code, its result line and the scripts it ran."""
    if pipe is not None:
        step, faces = _pipe_step(tmp_path / "step", *pipe)
        proj, mesh = _project(tmp_path, step=step, faces=faces)
    else:
        proj, mesh = _project(tmp_path)
    step_path = next(proj.rglob("source.step"))
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step_path), "--out", str(step_path.with_name("Body1.stl")), "--cad-quality"],
        cwd=str(PY), env=_env(), capture_output=True, text=True, timeout=600,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    case = mesh / "case"
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", "/home/golden/cases")
    monkeypatch.syspath_prepend(str(TOOLS))
    import generate_snappy as gs

    ran: list[Any] = []

    def script(argv: list[str], **_k: Any) -> _ScriptRun:
        ran.append(argv)
        run = _ScriptRun(case)
        if snappy_log is not None:
            with (case / "log.snappyHexMesh").open("a", encoding="utf-8") as f:
                f.write(snappy_log.read_text(encoding="utf-8"))
        return run

    monkeypatch.setattr(gs, "claim_generate_case", lambda *a, **k: [])
    monkeypatch.setattr(gs, "release_generate_case", lambda *a, **k: None)
    monkeypatch.setattr(gs, "sync_to_wsl", lambda *a, **k: ran.append("sync"))
    monkeypatch.setattr(gs, "remove_wsl_case", lambda *a, **k: None)
    monkeypatch.setattr(gs, "get_wsl_distro", lambda: "Ubuntu-24.04")
    monkeypatch.setattr(gs.subprocess, "Popen", script)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "generate_snappy.py", "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", "cfddesk-golden-snappy",
            "--generate-id", "golden", "--fineness", str(fineness), "--add-layers", "0", "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
        ],
    )
    capsys.readouterr()
    rc = gs.main()
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("MAGNUSIM_EVENT ")]
    results = [e for e in (json.loads(ln.split(" ", 1)[1]) for ln in lines) if e.get("event") == "result"]
    assert results, lines[-5:]
    return rc, results[-1], ran


def test_the_cell_limit_log_reached_the_limit():
    """snappyHexMesh's own log of a 400 D pipe at fineness 8 (10 mm across, 4 m long, WSL,
    2026-11-07, F2's first block 1600 x 8 x 12): its refinement reached maxGlobalCells."""
    log = CELL_LIMIT_LOG.read_text(encoding="utf-8")
    assert "No cells marked for refinement since reached limit 4000000." in log


@pytest.mark.occt
@pytest.mark.parametrize(("pipe", "fineness", "block"), [((20.0, 1100.0), 8, "(147 8 12)"), (None, 5, "(18 18 47)")])
def test_generate_keeps_a_mesh_whose_refinement_reached_the_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], pipe: tuple[float, float] | None, fineness: int, block: str
):
    """The 55 D pipe at fineness 8 (the cap gave it 147 cells along) and the elbow (the cap left
    it alone), each with a snappyHexMesh log that reached the limit and a mesh that passes
    checkMesh: Generate ends done for both, as before F2."""
    rc, res, ran = _generate(tmp_path, monkeypatch, capsys, fineness=fineness, pipe=pipe, snappy_log=CELL_LIMIT_LOG)
    assert len(ran) == 2  # it ran
    assert res["block"] == block
    assert rc == 0 and res["ok"] is True and "error" not in res, res
    assert res["quality"]["known"] is True


@pytest.mark.occt
def test_generate_refuses_a_part_over_the_limit_before_the_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    """The 20,000 D pipe: refused with the words before anything goes to WSL."""
    rc, res, ran = _generate(tmp_path, monkeypatch, capsys, fineness=6, pipe=(1.0, 20_000.0))
    assert ran == []
    assert rc == 1 and res["ok"] is False
    assert res["error"] == REFUSAL_20000D
    assert res["block"] == "(53334 8 12)"


def test_a_huge_part_is_not_called_long_and_thin():
    """A cube 300 m across: its base cell is held at 1 m, so its block (399 cells each way) is
    over the limit whatever the fineness, but the cap did not lengthen it."""
    bounds = _box(300_000.0, 300_000.0, 300_000.0)
    assert background_of(5, bounds) == background_of(5, bounds, aspect_cap=False) == [399, 399, 399]
    assert cell_limit_refusal(5, bounds) == (
        "Hex-dominant can't mesh this part at any fineness: its background block alone would have 63,521,199 cells, "
        "over snappyHexMesh's limit of 4,000,000. Try the Standard mesher: it has no background block."
    )
