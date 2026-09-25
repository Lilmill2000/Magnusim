"""Legacy root boundary_conditions.json rows survive the first study-level bcs.set.

Pairs with scripts/__tests__/bcs-legacy-root-adopt.test.mjs (POST /api/bcs).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import cfddesk.worker.methods  # noqa: F401
from cfddesk.project.paths import assemble_study_bcs, create_geometry_folder, create_study_folder
from cfddesk.project.scope import build_project_tree
from cfddesk.registry import reset_for_tests
from cfddesk.worker.rpc import dispatch

WEB_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = WEB_ROOT / "e2e" / "fixtures" / "sample-project-steady-state"


@pytest.fixture(autouse=True)
def _clean():
    reset_for_tests()
    yield
    reset_for_tests()


def _seed(tmp_path: Path, monkeypatch, *, copy_into_study: bool) -> tuple[Path, Path]:
    root = tmp_path / "legacy"
    root.mkdir()
    for name in ("project.json", "simulations.json", "boundary_conditions.json"):
        shutil.copy(FIXTURE / name, root / name)
    proj = json.loads((root / "project.json").read_text(encoding="utf-8"))
    sim = json.loads((root / "simulations.json").read_text(encoding="utf-8"))["simulations"][0]
    geom = create_geometry_folder(root, {**proj["geometries"][0], "original_filename": "elbow.step"})
    study = create_study_folder(root, geom["id"], sim)
    study_dir = Path(study["dir"])
    if copy_into_study:
        shutil.copy(root / "boundary_conditions.json", study_dir / "boundary_conditions.json")
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(WEB_ROOT))
    monkeypatch.setenv("MAGNUSIM_WEB_ROOT", str(WEB_ROOT))
    return root, study_dir


def _tree_bcs(root: Path) -> list[tuple[str, str]]:
    tree = build_project_tree(root, root.name)
    return sorted(
        (b["id"], b["name"]) for g in tree["geometries"] for s in g["studies"] for b in s["bcs"]
    )


@pytest.mark.parametrize("copy_into_study", [True, False])
def test_bcs_set_keeps_legacy_root_bcs(tmp_path, monkeypatch, copy_into_study):
    root, study_dir = _seed(tmp_path, monkeypatch, copy_into_study=copy_into_study)
    legacy = [("bc-legacy-1", "velocity_inlet_1"), ("bc-legacy-2", "pressure_1")]
    assert sorted((b["id"], b["name"]) for b in assemble_study_bcs(root, "sim_1")) == sorted(legacy)
    assert _tree_bcs(root) == sorted(legacy)

    new = {"id": "bc-new", "name": "Wall 1", "bc_type": "Wall", "faces": ["face 3@Body1"]}
    dispatch(
        "bcs.set",
        {"project_id": root.name, "sim_id": "sim_1", "body": {"boundary_conditions": [new], "simulation_id": "sim_1"}},
    )

    want = sorted([*legacy, ("bc-new", "Wall 1")])
    assert sorted((b["id"], b["name"]) for b in assemble_study_bcs(root, "sim_1")) == want
    assert _tree_bcs(root) == want
    aggregate = json.loads((study_dir / "boundary_conditions.json").read_text(encoding="utf-8"))
    assert sorted((b["id"], b["name"]) for b in aggregate["boundary_conditions"]) == want
    folders = sorted(p.name for p in (study_dir / "boundary_conditions").iterdir() if p.is_dir())
    assert folders == ["BC_Wall_1", "BC_pressure_1", "BC_velocity_inlet_1"]

    hydrated = dispatch("project.hydrate", {"id": root.name, "simulation_id": "sim_1"})
    assert sorted((b["id"], b["name"]) for b in hydrated["bcs"]["boundary_conditions"]) == want
