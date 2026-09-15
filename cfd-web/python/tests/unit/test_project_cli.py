"""Unit tests for tools/project_cli.py (Step 9)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[2] / "tools"
CLI = TOOLS / "project_cli.py"


def _run(args, stdin_obj, cwd=None):
    proc = subprocess.run(
        [sys.executable, str(CLI), *args],
        input=json.dumps(stdin_obj),
        text=True,
        capture_output=True,
        cwd=cwd,
    )
    return proc


def test_set_materials_writes_atomic(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    (proj / "project.json").write_text(json.dumps({"id": "proj1"}), encoding="utf-8")
    body = {
        "materials": [
            {
                "id": "mat-1",
                "name": "Air",
                "assigned_volumes": ["Body1"],
                "kinematic_viscosity": 1.5e-5,
                "density": 1.2,
            }
        ],
        "air": {
            "id": "mat-1",
            "name": "Air",
            "assigned_volumes": ["Body1"],
        },
    }
    proc = _run(
        ["set-materials", "--project-dir", str(proj), "--sim-id", "sim-1"],
        body,
    )
    assert proc.returncode == 0, proc.stderr
    doc = json.loads(proc.stdout.strip().splitlines()[-1])
    assert doc["simulation_id"] == "sim-1"
    assert (proj / "materials.json").is_file()
    stamped = json.loads((proj / "project.json").read_text(encoding="utf-8"))
    assert stamped["materials"]["count"] == 1


def test_run_upsert_and_delete(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    proc = _run(
        ["run-upsert", "--project-dir", str(proj), "--run-id", "run-1"],
        {"id": "run-1", "status": "idle"},
    )
    assert proc.returncode == 0, proc.stderr
    assert (proj / "runs" / "run-1.json").is_file()
    catalog = json.loads((proj / "runs" / "catalog.json").read_text(encoding="utf-8"))
    assert catalog["runs"][0]["id"] == "run-1"
    proc2 = _run(
        ["run-delete", "--project-dir", str(proj), "--run-id", "run-1"],
        {},
    )
    assert proc2.returncode == 0, proc2.stderr
    assert not (proj / "runs" / "run-1.json").is_file()


def test_cli_subcommands_listed():
    src = CLI.read_text(encoding="utf-8")
    for name in (
        "set-materials",
        "set-bcs",
        "set-mesh-settings",
        "set-refinements",
        "set-result-controls",
        "set-sim-control",
        "run-upsert",
        "run-delete",
        "mesh-result",
    ):
        assert name in src
