"""Tests for generate_* --legacy-markers / emit() job protocol (Step 7 remainder)."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from cfddesk.jobs import legacy_markers as legacy
from cfddesk.jobs.events import EVENT_PREFIX, parse_line

TOOLS = Path(__file__).resolve().parents[2] / "tools"


def _load_tool(name: str):
    path = TOOLS / name
    spec = importlib.util.spec_from_file_location(name.replace(".py", ""), path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("tool", ["generate_standard.py", "generate_cfmesh_standard.py"])
def test_progress_emits_magnusim_without_legacy(tool, capsys):
    mod = _load_tool(tool)
    legacy.set_legacy_markers(False)
    mod._progress("gmsh", msg="hi")
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1
    assert out[0].startswith(EVENT_PREFIX)
    ev = parse_line(out[0])
    assert ev is not None
    assert ev.event == "progress"
    assert ev.fields["stage"] == "gmsh"
    assert "CFMESH_PROGRESS" not in out[0]


@pytest.mark.parametrize("tool", ["generate_standard.py", "generate_cfmesh_standard.py"])
def test_progress_dual_with_legacy_markers(tool, capsys):
    mod = _load_tool(tool)
    legacy.set_legacy_markers(True)
    mod._progress("gmshToFoam")
    lines = [ln for ln in capsys.readouterr().out.strip().splitlines() if ln]
    assert len(lines) == 2
    assert lines[0].startswith(EVENT_PREFIX)
    assert lines[1].startswith("CFMESH_PROGRESS ")
    legacy_payload = json.loads(lines[1][len("CFMESH_PROGRESS ") :])
    assert legacy_payload["stage"] == "gmshToFoam"
    legacy.set_legacy_markers(False)


@pytest.mark.parametrize("tool", ["generate_standard.py", "generate_cfmesh_standard.py"])
def test_result_dual_with_legacy_markers(tool, capsys):
    mod = _load_tool(tool)
    legacy.set_legacy_markers(True)
    rc = mod._result(True, n_cells=12)
    assert rc == 0
    lines = [ln for ln in capsys.readouterr().out.strip().splitlines() if ln]
    assert len(lines) == 2
    assert lines[0].startswith(EVENT_PREFIX)
    assert lines[1].startswith("CFMESH_RESULT ")
    legacy_payload = json.loads(lines[1][len("CFMESH_RESULT ") :])
    assert legacy_payload["ok"] is True
    assert legacy_payload["n_cells"] == 12
    legacy.set_legacy_markers(False)


@pytest.mark.parametrize("tool", ["generate_standard.py", "generate_cfmesh_standard.py", "generate_snappy.py"])
def test_legacy_markers_cli_flag_exists(tool):
    src = (TOOLS / tool).read_text(encoding="utf-8")
    assert "--legacy-markers" in src
    assert "set_legacy_markers" in src
    assert "legacy_markers" in src
