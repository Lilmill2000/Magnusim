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
        "write-project",
        "save-catalog",
    ):
        assert name in src


def test_write_project_and_set_bcs_stamp(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    (proj / "project.json").write_text(json.dumps({"id": "proj1", "name": "P"}), encoding="utf-8")
    proc = _run(
        ["set-bcs", "--project-dir", str(proj), "--sim-id", "sim-1"],
        {"boundary_conditions": [{"id": "bc1", "name": "Velocity inlet 1", "bc_type": "Velocity inlet"}]},
    )
    assert proc.returncode == 0, proc.stderr
    stamped = json.loads((proj / "project.json").read_text(encoding="utf-8"))
    assert stamped["boundary_conditions"]["count"] == 1
    proc2 = _run(
        ["write-project", "--project-dir", str(proj)],
        {"id": "proj1", "name": "P2", "active_simulation_id": "sim-1"},
    )
    assert proc2.returncode == 0, proc2.stderr
    doc = json.loads((proj / "project.json").read_text(encoding="utf-8"))
    assert doc["name"] == "P2"


def test_run_upsert_sidecar_naming(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    (proj / "project.json").write_text(json.dumps({"id": "proj1"}), encoding="utf-8")
    proc = _run(
        ["run-upsert", "--project-dir", str(proj), "--run-id", "abcd1234", "--stamp-project"],
        {"id": "abcd1234", "status": "draft", "name": "Run 1"},
    )
    assert proc.returncode == 0, proc.stderr
    assert (proj / "runs" / "run-abcd1234.json").is_file()
    stamped = json.loads((proj / "project.json").read_text(encoding="utf-8"))
    assert stamped["run_1"]["run_id"] == "abcd1234"
