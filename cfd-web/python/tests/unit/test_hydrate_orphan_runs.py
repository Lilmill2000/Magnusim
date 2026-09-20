"""project.hydrate adopts orphan run folders via reconcile_runs_from_disk."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import cfddesk.worker.methods  # noqa: F401
from cfddesk.registry import reset_for_tests
from cfddesk.worker.rpc import dispatch

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
        mid = str((meshes[0] or {}).get("id") or "mesh_1")

    orphan = proj / "results" / f"mesh-{mid}" / "run-orphan99"
    (orphan / "constant" / "polyMesh").mkdir(parents=True)
    (orphan / "constant" / "polyMesh" / "points").write_text("x\n", encoding="utf-8")

    second = dispatch("project.hydrate", {"id": "orphan-proj"})
    assert second["ok"] is True
    runs = second.get("runs") or {}
    ids = [str(r.get("id")) for r in (runs.get("runs") or []) if isinstance(r, dict)]
    assert "orphan99" in ids, f"orphan run missing from catalog: {runs}"
