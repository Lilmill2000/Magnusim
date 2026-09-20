"""Phase 2 closeout: write_run_case, sibling write-through, example plugin."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.registry import get_hub, get_registry, load_all, reset_for_tests, write_run_case
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY

WEB_ROOT = Path(__file__).resolve().parents[3]
TOOLS = WEB_ROOT / "python" / "tools"
CLI = TOOLS / "project_cli.py"
EXAMPLE_KEY = "example_passthrough"
FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_example_folder_plugin_registers_analysis():
    load_all(force=True)
    keys = set(get_registry("analysis").keys())
    assert {DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY} <= keys
    spec = get_registry("analysis").get(EXAMPLE_KEY)
    assert spec.label.startswith("Example")
    assert spec.write_case is not None
    assert get_hub().manifests["example"].key == "example"


def test_write_run_case_uses_registry_write_case(tmp_path):
    if not (FIX / "boundary_conditions.json").is_file():
        pytest.skip("js-project fixture missing")
    from cfddesk.project.web_adapter import load_run_spec

    spec = load_run_spec(FIX, run_id="run-closeout-steady", require_mesh=False, n_procs=1)
    assert spec.ok, spec.error
    out = tmp_path / "case"
    result = write_run_case(spec, out)
    assert result.get("ok") is True
    assert (out / "system" / "controlDict").is_file()
    assert (out / "constant" / "transportProperties").is_file()


def test_write_json_applies_through_project(tmp_path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    body = {"materials": [{"id": "m1", "name": "Air"}], "simulation_id": "sim-1"}
    proc = subprocess.run(
        [sys.executable, str(CLI), "write-json", "--project-dir", str(proj), "--rel", "materials.json"],
        input=json.dumps(body),
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    from cfddesk.project.paths import study_json_path

    mat_path = study_json_path(proj, "sim-1", "materials.json") or (proj / "materials.json")
    doc = json.loads(mat_path.read_text(encoding="utf-8"))
    assert doc["materials"][0]["name"] == "Air"
    assert doc["simulation_id"] == "sim-1"
    assert any(m.get("name") == "Air" for m in doc.get("materials") or [])
