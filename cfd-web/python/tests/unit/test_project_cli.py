"""Unit tests for tools/project_cli.py (Step 9)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

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
    from cfddesk.project.paths import study_json_path

    assert study_json_path(proj, "sim-1", "materials.json").is_file()
    stamped = json.loads((proj / "project.json").read_text(encoding="utf-8"))
    assert stamped["materials"]["count"] == 1


def test_run_upsert_and_delete(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    proc = _run(
        ["run-upsert", "--project-dir", str(proj), "--run-id", "run-1", "--sim-id", "sim-1"],
        {"id": "run-1", "status": "idle", "simulation_id": "sim-1"},
    )
    assert proc.returncode == 0, proc.stderr
    from cfddesk.project.paths import find_run

    folder = find_run(proj, "run-1", "sim-1")
    assert folder and (Path(folder["dir"]) / "run.json").is_file()
    proc2 = _run(
        ["run-delete", "--project-dir", str(proj), "--run-id", "run-1", "--sim-id", "sim-1"],
        {},
    )
    assert proc2.returncode == 0, proc2.stderr
    assert find_run(proj, "run-1", "sim-1") is None


def test_run_upsert_keeps_mesh_and_results(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    _run(
        ["run-upsert", "--project-dir", str(proj), "--run-id", "run-1", "--sim-id", "sim-1"],
        {
            "id": "run-1",
            "status": "stopped",
            "simulation_id": "sim-1",
            "mesh_id": "mesh-assigned",
            "mesh_name": "Mesh 1",
            "has_results": True,
            "n_saved_times": 9,
            "last_saved_iteration": 0.28,
        },
    )
    proc = _run(
        ["run-upsert", "--project-dir", str(proj), "--run-id", "run-1", "--sim-id", "sim-1"],
        {"id": "run-1", "simulation_id": "sim-1", "transient": {"max_co": 10}},
    )
    assert proc.returncode == 0, proc.stderr
    from cfddesk.project.paths import find_run

    folder = find_run(proj, "run-1", "sim-1")
    rec = json.loads((Path(folder["dir"]) / "run.json").read_text(encoding="utf-8"))
    assert rec["mesh_id"] == "mesh-assigned"
    assert rec["has_results"] is True
    assert rec["n_saved_times"] == 9
    assert rec["status"] == "stopped"


def test_run_upsert_promotes_starting_when_frames_exist(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    _run(
        ["run-upsert", "--project-dir", str(proj), "--run-id", "run-1", "--sim-id", "sim-1"],
        {
            "id": "run-1",
            "status": "running",
            "simulation_id": "sim-1",
            "stage": "starting",
            "has_results": True,
            "n_saved_times": 8,
            "last_saved_iteration": 0.26,
            "sim_time": 0.015,
        },
    )
    from cfddesk.project.paths import find_run

    folder = find_run(proj, "run-1", "sim-1")
    rec = json.loads((Path(folder["dir"]) / "run.json").read_text(encoding="utf-8"))
    assert rec["stage"] == "solve"
    assert rec["status"] == "running"


def test_run_upsert_start_clears_stop_requested(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    _run(
        ["run-upsert", "--project-dir", str(proj), "--run-id", "run-1", "--sim-id", "sim-1"],
        {
            "id": "run-1",
            "status": "stopped",
            "simulation_id": "sim-1",
            "mesh_id": "mesh-1",
            "stop_requested": True,
            "stage": "copy",
            "has_results": True,
        },
    )
    proc = _run(
        ["run-upsert", "--project-dir", str(proj), "--run-id", "run-1", "--sim-id", "sim-1"],
        {
            "id": "run-1",
            "simulation_id": "sim-1",
            "status": "running",
            "has_results": False,
            "stop_requested": False,
            "stage": "starting",
        },
    )
    assert proc.returncode == 0, proc.stderr
    from cfddesk.project.paths import find_run

    folder = find_run(proj, "run-1", "sim-1")
    rec = json.loads((Path(folder["dir"]) / "run.json").read_text(encoding="utf-8"))
    assert rec["stop_requested"] is False
    assert rec["status"] == "running"
    assert rec["stage"] == "starting"
    assert rec["mesh_id"] == "mesh-1"


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
        "write-simulation",
        "save-sim-catalog",
        "write-json",
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
        ["run-upsert", "--project-dir", str(proj), "--run-id", "abcd1234", "--sim-id", "sim-1", "--stamp-project"],
        {"id": "abcd1234", "status": "draft", "name": "Run 1", "simulation_id": "sim-1"},
    )
    assert proc.returncode == 0, proc.stderr
    from cfddesk.project.paths import find_run

    folder = find_run(proj, "abcd1234", "sim-1")
    assert folder and (Path(folder["dir"]) / "run.json").is_file()
    stamped = json.loads((proj / "project.json").read_text(encoding="utf-8"))
    assert stamped["run_1"]["run_id"] == "abcd1234"


def test_save_sim_catalog_and_write_simulation(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    sim = {
        "id": "sim-1",
        "name": "Incompressible Steady-state",
        "time_dependency": "Steady-state",
    }
    proc = _run(
        ["save-sim-catalog", "--project-dir", str(proj), "--sim-id", "sim-1"],
        {"active_id": "sim-1", "simulations": [sim]},
    )
    assert proc.returncode == 0, proc.stderr
    cat = json.loads((proj / "simulations.json").read_text(encoding="utf-8"))
    assert cat["active_id"] == "sim-1"
    mirror = json.loads((proj / "simulation.json").read_text(encoding="utf-8"))
    assert mirror["id"] == "sim-1"
    assert "simulation_json" in mirror
    proc2 = _run(
        ["write-simulation", "--project-dir", str(proj), "--sim-id", "sim-1"],
        {**sim, "increment": "W18", "materials": {"count": 1}},
    )
    assert proc2.returncode == 0, proc2.stderr
    mirror2 = json.loads((proj / "simulation.json").read_text(encoding="utf-8"))
    assert mirror2.get("increment") == "W18"
    # empty catalog clears mirror
    proc3 = _run(
        ["save-sim-catalog", "--project-dir", str(proj)],
        {"active_id": None, "simulations": []},
    )
    assert proc3.returncode == 0, proc3.stderr
    assert not (proj / "simulation.json").exists()


def test_write_json_allowlisted(tmp_path: Path):
    proj = tmp_path / "proj1"
    proj.mkdir()
    body = {"materials": [{"id": "m1", "name": "Air"}], "simulation_id": "sim-1"}
    proc = _run(
        ["write-json", "--project-dir", str(proj), "--rel", "materials.json"],
        body,
    )
    assert proc.returncode == 0, proc.stderr
    from cfddesk.project.paths import study_json_path

    mat_path = study_json_path(proj, "sim-1", "materials.json") or (proj / "materials.json")
    doc = json.loads(mat_path.read_text(encoding="utf-8"))
    assert doc["materials"][0]["name"] == "Air"
    assert doc.get("persistence") == "filesystem"
    # Write-through regenerates the sibling from Project (v15 mirror), not a raw dump.
    assert "updated_at" in doc
    bad = _run(
        ["write-json", "--project-dir", str(proj), "--rel", "evil.json"],
        {"x": 1},
    )
    assert bad.returncode != 0


def test_cli_lists_write_json():
    src = CLI.read_text(encoding="utf-8")
    assert "write-json" in src


def test_atomic_write_retries_windows_lock(tmp_path: Path, monkeypatch):
    from cfddesk.project import web_writes as ww

    dest = tmp_path / "mesh.json"
    dest.write_text("{}\n", encoding="utf-8")
    calls = {"n": 0}
    real_replace = ww.os.replace

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] < 3:
            err = PermissionError(13, "Access is denied")
            err.winerror = 5
            raise err
        return real_replace(src, dst)

    monkeypatch.setattr(ww.os, "replace", flaky)
    monkeypatch.setattr(ww.time, "sleep", lambda _s: None)
    ww.atomic_write(dest, {"ok": True})
    assert calls["n"] == 3
    assert json.loads(dest.read_text(encoding="utf-8"))["ok"] is True
