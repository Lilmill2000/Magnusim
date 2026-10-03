"""project.hydrate adopts orphan run folders via reconcile_runs_from_disk.

An adopted run is named "Run N": nothing on disk says what it solved. (It was
named after the old Project model's solver.turbulence: "laminar 1" in every
web project, whatever the run was.)
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import cfddesk.worker.methods  # noqa: F401
from cfddesk.registry import reset_for_tests
from cfddesk.worker.rpc import dispatch
from tests.conftest import PROJECTS

WEB_ROOT = Path(__file__).resolve().parents[3]
FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"


@pytest.fixture(autouse=True)
def _clean():
    reset_for_tests()
    yield
    reset_for_tests()


def test_hydrate_includes_reconciled_orphan_run(tmp_path, monkeypatch):
    proj = tmp_path / "orphan-proj"
    shutil.copytree(FIX, proj)
    (proj / "project.json").write_text(
        json.dumps({"id": "orphan-proj", "title": "Orphan", "increment": "W16"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(WEB_ROOT))
    monkeypatch.setenv("MAGNUSIM_WEB_ROOT", str(WEB_ROOT))

    first = dispatch("project.hydrate", {"id": "orphan-proj"})
    assert first["ok"] is True
    mesh = first.get("mesh") or {}
    mid = str(mesh.get("active_id") or "")
    if not mid:
        meshes = mesh.get("meshes") or []
        first_mesh = meshes[0] if meshes else {}
        mid = str((first_mesh or {}).get("id") or "mesh_1")

    orphan = proj / "results" / f"mesh-{mid}" / "run-orphan99"
    (orphan / "constant" / "polyMesh").mkdir(parents=True)
    (orphan / "constant" / "polyMesh" / "points").write_text("x\n", encoding="utf-8")

    second = dispatch("project.hydrate", {"id": "orphan-proj"})
    assert second["ok"] is True
    runs = second.get("runs") or {}
    ids = [str(r.get("id")) for r in (runs.get("runs") or []) if isinstance(r, dict)]
    assert "orphan99" in ids, f"orphan run missing from catalog: {runs}"
    [row] = [r for r in runs["runs"] if str(r.get("id")) == "orphan99"]
    assert row["name"] == "Run 1"


def _web_project(tmp_path, monkeypatch, pid: str) -> tuple[Path, str]:
    proj = tmp_path / pid
    shutil.copytree(FIX, proj)
    (proj / "project.json").write_text(
        json.dumps({"id": pid, "title": "Orphan", "increment": "W16"}), encoding="utf-8"
    )
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(WEB_ROOT))
    monkeypatch.setenv("MAGNUSIM_WEB_ROOT", str(WEB_ROOT))
    first = dispatch("project.hydrate", {"id": pid})
    mesh = first.get("mesh") or {}
    mid = str(mesh.get("active_id") or ((mesh.get("meshes") or [{}])[0] or {}).get("id") or "mesh_1")
    return proj, mid


def test_a_run_folder_with_any_field_file_is_adopted_and_made_active(tmp_path, monkeypatch):
    """A time folder counts as a solution when it holds any file, not only the
    incompressible-flow fields: here only an initial alpha.water."""
    proj, mid = _web_project(tmp_path, monkeypatch, "vof-proj")
    orphan = proj / "results" / f"mesh-{mid}" / "run-vof1"
    (orphan / "0").mkdir(parents=True)
    (orphan / "0" / "alpha.water").write_text("x\n", encoding="utf-8")

    hydrated = dispatch("project.hydrate", {"id": "vof-proj"})
    runs = hydrated.get("runs") or {}
    [row] = [r for r in runs.get("runs") or [] if str(r.get("id")) == "vof1"]
    assert row["name"] == "Run 1"
    assert runs.get("active_id") == "vof1"


def test_python_doc_project_keeps_its_old_blocks_when_hydrate_saves_it(tmp_path, monkeypatch):
    """An old desktop project.json (v13): the adopted run makes hydrate save it,
    with its solver / boundary / numerics / initial_conditions blocks as stored."""
    source = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = tmp_path / "desktop-proj"
    proj.mkdir()
    (proj / "project.json").write_text(json.dumps(source, indent=2), encoding="utf-8")
    [sim] = source["simulations"]
    orphan = proj / "results" / f"mesh-{sim['active_mesh_id']}" / "run-old1"
    (orphan / "constant" / "polyMesh").mkdir(parents=True)
    (orphan / "constant" / "polyMesh" / "points").write_text("x\n", encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(WEB_ROOT))
    monkeypatch.setenv("MAGNUSIM_WEB_ROOT", str(WEB_ROOT))

    assert dispatch("project.hydrate", {"id": "desktop-proj"})["ok"] is True
    saved = json.loads((proj / "project.json").read_text(encoding="utf-8"))
    assert saved["version"] == 15
    assert (proj / "project.json.v13.bak").is_file()
    [now] = saved["simulations"]
    for key in ("solver", "boundary", "numerics", "initial_conditions"):
        assert json.dumps(now[key]) == json.dumps(sim[key]), key
    assert sim["solver"]["turbulence"] == "kOmegaSST"
    [run] = [r for r in now["runs"] if r["id"] == "old1"]
    assert run["name"] == "Run 1"
