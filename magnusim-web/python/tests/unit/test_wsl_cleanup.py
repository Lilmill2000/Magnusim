"""WSL scratch-case cleanup: a finished job removes its own copy, the sweep the rest.

The sweep itself runs against a real WSL root in tests/wsl/test_prune_cases.py.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from cfddesk.runner import cleanup
from cfddesk.runner.case_id import InvalidWslCaseId
from cfddesk.wsl.openfoam import WslCommandResult
from cfddesk.wsl.solve_run import render_solve_script

TOOLS = Path(__file__).resolve().parents[2] / "tools"


def _solve_body() -> str:
    return render_solve_script(
        dst="/home/cfddesk/cases/cfddesk-w27-run-1",
        win_out="/mnt/c/proj/run-1",
        n_procs=4,
        app="simpleFoam",
        run_id="run-1",
        frame_fields=("U", "p"),
    )


def test_solve_removes_its_case_only_after_a_clean_copy_back():
    body = _solve_body()
    guard = 'if [ "$EC" -eq 0 ] && [ "$COPY_OK" -eq 1 ]; then'
    assert guard in body
    block = body[body.index(guard) :]
    assert 'rm -rf -- "$DST"' in block.split("\nfi\n", 1)[0]
    # After every copy back to Windows, before the result the app waits for.
    assert body.index('copy_saved_time "$LATEST"') < body.index(guard)
    assert body.index(guard) < body.index('"event\\":\\"result\\",\\"ok\\":true')
    # The only rm of the whole case besides the fresh copy at the start.
    assert body.count('rm -rf "$DST"') == 1
    assert body.count('rm -rf -- "$DST"') == 1


def test_solve_copy_failures_keep_the_case():
    body = _solve_body()
    copy_stage = body[body.index('"stage\\":\\"copy\\"') : body.index("COPY_OK\" -eq 1")]
    assert "COPY_OK=1" in copy_stage
    # Each copy back records a failure instead of ignoring it.
    assert copy_stage.count("|| COPY_OK=0") == 3
    assert "|| true" not in copy_stage.split("COPY_OK=1", 1)[1].split('if [ "$KEEP_FRAMES"', 1)[0]


def test_prune_script_is_lf_without_bom():
    text = cleanup.prune_script_text()
    assert "\r" not in text
    assert not text.startswith("\ufeff")
    assert text.startswith("#!/usr/bin/env bash\n")


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ('noise\nPRUNE_RESULT {"ok":true,"removed":2,"freed_kb":10}\n', {"ok": True, "removed": 2, "freed_kb": 10}),
        ('PRUNE_RESULT {"ok":false,"error":"bad root"}', {"ok": False, "error": "bad root"}),
    ],
)
def test_parse_prune_output(output, expected):
    assert cleanup.parse_prune_output(output) == expected


@pytest.mark.parametrize("output", ["", "PRUNE_RESULT {not json", "some bash error\n"])
def test_parse_prune_output_without_a_result_is_a_failure(output):
    doc = cleanup.parse_prune_output(output)
    assert doc["ok"] is False
    assert doc["error"]


def test_prune_refuses_a_negative_age():
    with pytest.raises(ValueError):
        cleanup.prune_wsl_cases(max_age_hours=-1)


def test_remove_wsl_case_targets_one_case_folder(monkeypatch):
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", "/home/u/cases")
    seen: list[str] = []

    def fake(inner, *, timeout=120.0):
        seen.append(inner)
        return WslCommandResult(returncode=0, stdout="", stderr="", argv=[])

    monkeypatch.setattr(cleanup, "run_wsl_bash", fake)
    assert cleanup.remove_wsl_case("cfddesk-w27-abc123") is True
    assert seen == ["rm -rf -- /home/u/cases/cfddesk-w27-abc123"]


@pytest.mark.parametrize("bad", ["", "  ", "../x", "cfddesk-w27-a/b", "Cfddesk-w27", "cfddesk-", "zz-exp-base"])
def test_remove_wsl_case_refuses_anything_but_a_case_id(monkeypatch, bad):
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", "/home/u/cases")
    monkeypatch.setattr(cleanup, "run_wsl_bash", lambda *a, **k: pytest.fail("must not run"))
    with pytest.raises(InvalidWslCaseId):
        cleanup.remove_wsl_case(bad)


def test_remove_wsl_case_reports_failure(monkeypatch):
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", "/home/u/cases")

    def boom(inner, *, timeout=120.0):
        raise OSError("wsl.exe missing")

    monkeypatch.setattr(cleanup, "run_wsl_bash", boom)
    assert cleanup.remove_wsl_case("cfddesk-w27-abc123") is False


@pytest.mark.parametrize(
    ("tool", "after"),
    [
        ("generate_standard.py", "copy_back_mesh(wsl_case, case_dir)"),
        ("generate_cfmesh_standard.py", "copy_back_mesh(wsl_case, case_dir)"),
        ("generate_snappy.py", "ok = rc == 0 and"),
    ],
)
def test_mesh_tools_remove_their_case_after_a_successful_copy_back(tool, after):
    src = (TOOLS / tool).read_text(encoding="utf-8")
    assert src.count("remove_wsl_case(wsl_case)") == 1
    call = src.index("remove_wsl_case(wsl_case)")
    assert src.index(after) < call
    # Nothing between the removal and the success result may fail the job.
    tail = src[call : src.index("return _result(", call)]
    assert tail.strip().splitlines()[0] == "remove_wsl_case(wsl_case)"
    success = src.index("return _result(", call)
    assert src[success : success + 60].replace(" ", "").replace("\n", "").startswith(
        "return_result(True," if tool != "generate_snappy.py" else "return_result(ok,"
    )
