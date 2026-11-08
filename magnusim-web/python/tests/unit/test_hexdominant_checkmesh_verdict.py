"""Hex-dominant's checkMesh verdict (Daniel's D1, 2026-11-07).

Since run health RH2 the Hex-dominant script runs checkMesh, but nothing read its verdict:
a 55 D pipe whose mesh had cells of negative volume ended "done", and its solve then failed.
Now ``generate_snappy.py`` applies the rule Standard and cfMesh are gated by
(``cfddesk.wsl.mesh_run._checkmesh_ok`` with skew allowed: "Mesh OK", or one or two failed
checks that are only skewed faces or up to 8 cells of high aspect ratio). A mesh that fails
it, or whose report has no verdict, ends Generate failed with the failed check named in the
Mesh panel's words, and its quality stays in the result for the panel's quality line.

The reports are OpenFOAM v2606's own (``tests/fixtures/mesh-facts/checkmesh``, its README).
Fails on the code before D1: ``checkmesh_failure`` did not exist, and ``main()`` ended ok.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from cfddesk.wsl.mesh_run import _checkmesh_ok, checkmesh_failure
from tests.conftest import FIXTURES
from tests.unit.test_mesh_goldens import PY, TOOLS, _env, _project, _ScriptRun

CHECKMESH = FIXTURES / "mesh-facts" / "checkmesh"


def _log(name: str) -> str:
    return (CHECKMESH / name).read_text(encoding="utf-8")


@pytest.mark.parametrize(
    "name",
    [
        "ok-hex-2d.log",  # Mesh OK
        "ok-snappy-layers.log",  # Mesh OK (snappyHexMesh with layers)
        "one-cell-across-2d.log",  # Mesh OK (Hex-dominant one cell across)
        "skewed.log",  # one failed check: skewed faces
        "skewed-few-thin.log",  # two: skewed faces and 4 cells of high aspect ratio
    ],
)
def test_a_report_the_meshers_keep_passes(name: str):
    assert _checkmesh_ok(_log(name), allow_skew=True)
    assert checkmesh_failure(_log(name)) is None


@pytest.mark.parametrize(
    ("name", "reason"),
    [
        # 36 cells of high aspect ratio: more than the 8 the meshers keep.
        ("high-aspect-ratio.log", "checkMesh failed 1 check: 36 cells with a high aspect ratio."),
        # A cell turned inside out.
        (
            "negative-volume.log",
            "checkMesh failed 4 checks: 1 edge out of line with the 2D directions, 1 cell with a negative volume, "
            "3 faces over 90° non-orthogonal, 4 wrongly oriented faces.",
        ),
        # The 55 D pipe at fineness 6 on Hex-dominant (W6, 2026-11-07).
        (
            "hexdominant-pipe-55d.log",
            "checkMesh failed 5 checks: 8 cells with a high aspect ratio, 8 cells with a negative volume, "
            "84 faces over 90° non-orthogonal, 644 wrongly oriented faces, 164 highly skewed faces.",
        ),
    ],
)
def test_a_report_with_a_check_the_meshers_do_not_keep_fails_and_names_it(name: str, reason: str):
    assert not _checkmesh_ok(_log(name), allow_skew=True)
    assert checkmesh_failure(_log(name)) == reason


def test_a_report_with_no_verdict_fails():
    """checkMesh stopped before its verdict (here the report cut before "Mesh OK."), or left none."""
    text = _log("ok-hex-2d.log")
    cut = text[: text.index("Mesh OK.")]
    assert checkmesh_failure(cut) == "checkMesh ended without a verdict on the mesh."
    assert checkmesh_failure("") == "checkMesh left no report on the mesh."
    assert checkmesh_failure(None) == "checkMesh left no report on the mesh."


def _generate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], checkmesh: str | None) -> tuple[int, dict[str, Any]]:
    """``generate_snappy.main()`` on the elbow (fineness 5, layers on), its WSL script stood in for
    by what it copies back (``_ScriptRun``) with ``checkmesh`` as the mesh's report; its exit code
    and result line."""
    proj, mesh = _project(tmp_path)
    step = next(proj.rglob("source.step"))
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step), "--out", str(step.with_name("Body1.stl")), "--cad-quality"],
        cwd=str(PY), env=_env(), capture_output=True, text=True, timeout=600,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    case = mesh / "case"
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", "/home/golden/cases")
    monkeypatch.syspath_prepend(str(TOOLS))
    import generate_snappy as gs

    monkeypatch.setattr(gs, "claim_generate_case", lambda *a, **k: [])
    monkeypatch.setattr(gs, "release_generate_case", lambda *a, **k: None)
    monkeypatch.setattr(gs, "sync_to_wsl", lambda *a, **k: None)
    monkeypatch.setattr(gs, "remove_wsl_case", lambda *a, **k: None)
    monkeypatch.setattr(gs, "get_wsl_distro", lambda: "Ubuntu-24.04")
    monkeypatch.setattr(gs.subprocess, "Popen", lambda argv, **k: _ScriptRun(case, checkmesh))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "generate_snappy.py", "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", "cfddesk-golden-snappy",
            "--generate-id", "golden", "--fineness", "5", "--add-layers", "1", "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
        ],
    )
    capsys.readouterr()
    rc = gs.main()
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("MAGNUSIM_EVENT ")]
    results = [e for e in (json.loads(ln.split(" ", 1)[1]) for ln in lines) if e.get("event") == "result"]
    assert results, lines[-5:]
    return rc, results[-1]


def test_generate_ends_failed_naming_the_check_and_keeps_the_quality(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    rc, res = _generate(tmp_path, monkeypatch, capsys, "negative-volume.log")
    assert rc == 1 and res["ok"] is False
    assert res["error"] == (
        "checkMesh failed 4 checks: 1 edge out of line with the 2D directions, 1 cell with a negative volume, "
        "3 faces over 90° non-orthogonal, 4 wrongly oriented faces."
    )
    # snappyHexMesh's script ended well; the verdict failed it. Its quality stays in the result, so
    # the Mesh panel's quality line shows the worst cells under the failure.
    assert res["exit_code"] == 0
    q = res["quality"]
    assert (q["known"], q["ok"], q["n_failed"]) == (True, False, 4)
    assert [f["check"] for f in q["failed"]] == ["non_aligned_edges", "negative_volume", "non_orthogonality", "face_pyramids"]


def test_generate_ends_failed_when_checkmesh_left_no_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    rc, res = _generate(tmp_path, monkeypatch, capsys, None)
    assert rc == 1 and res["ok"] is False
    assert res["error"] == "checkMesh left no report on the mesh."


def test_generate_keeps_a_mesh_with_only_checks_the_meshers_accept(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    rc, res = _generate(tmp_path, monkeypatch, capsys, "skewed-few-thin.log")
    assert rc == 0 and res["ok"] is True and "error" not in res
    assert (res["quality"]["ok"], res["quality"]["n_failed"]) == (False, 2)
