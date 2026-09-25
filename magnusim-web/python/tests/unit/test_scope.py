"""H0 scope keys, sibling migration, and study-owned trees."""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.project.paths import create_geometry_folder, create_study_folder
from cfddesk.project.scope import ScopeId, build_project_tree, migrate_root_siblings
from cfddesk.worker.methods import project_hydrate
from cfddesk.worker.paths import read_sibling


def _project(root: Path, pid: str = "proj") -> Path:
    dest = root / pid
    dest.mkdir()
    (dest / "project.json").write_text(json.dumps({"id": pid, "name": pid}) + "\n", encoding="utf-8")
    return dest


def _study(project: Path, geom_id: str, sim_id: str, name: str) -> None:
    create_geometry_folder(project, {"id": geom_id, "name": name, "original_filename": name})
    create_study_folder(project, geom_id, {"id": sim_id, "name": name})


def test_scope_key_matches_typescript():
    key = ScopeId("proj", "geo", "study", "mesh1").key()
    assert key == "p:proj/g:geo/s:study/mesh:mesh1"


def test_gate_h0_one_study_migrates_root_mesh_into_the_study(tmp_path: Path):
    project = _project(tmp_path)
    _study(project, "geo", "study", "Only")
    (project / "mesh.json").write_text(
        json.dumps({"meshes": [{"id": "mesh1", "name": "Mesh 1", "generated": True}]}) + "\n",
        encoding="utf-8",
    )
    (project / "materials.json").write_text(
        json.dumps({"materials": [{"id": "air", "name": "Air", "assigned_volumes": ["Body1"]}]}) + "\n",
        encoding="utf-8",
    )
    assert migrate_root_siblings(project) is True
    tree = build_project_tree(project, "proj")
    study = tree["geometries"][0]["studies"][0]
    assert [m["id"] for m in study["meshes"]] == ["mesh1"]
    assert study["meshes"][0]["key"] == "p:proj/g:geo/s:study/mesh:mesh1"
    assert study["material_volumes"] == ["Body1"]
    assert (project / "project.json").read_text(encoding="utf-8").find('"siblings_migrated": true') >= 0


def test_gate_h0_two_studies_do_not_receive_the_root_file(tmp_path: Path):
    project = _project(tmp_path)
    create_geometry_folder(project, {"id": "geo", "name": "Part", "original_filename": "Part"})
    create_study_folder(project, "geo", {"id": "a", "name": "A"})
    create_study_folder(project, "geo", {"id": "b", "name": "B"})
    (project / "mesh.json").write_text(
        json.dumps({"meshes": [{"id": "shared", "name": "Shared"}]}) + "\n",
        encoding="utf-8",
    )
    assert migrate_root_siblings(project) is False
    tree = build_project_tree(project, "proj")
    studies = tree["geometries"][0]["studies"]
    assert studies[0]["meshes"] == []
    assert studies[1]["meshes"] == []
    assert json.loads((project / "project.json").read_text(encoding="utf-8"))["siblings_migrated"] == "skipped-multi"


def test_gate_h0_hydrate_does_not_fall_back_to_project_root(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    project = _project(tmp_path, "p1")
    create_geometry_folder(project, {"id": "geo", "name": "Part", "original_filename": "Part"})
    create_study_folder(project, "geo", {"id": "a", "name": "A"})
    create_study_folder(project, "geo", {"id": "b", "name": "B"})
    (project / "materials.json").write_text(
        json.dumps({"materials": [{"id": "air", "name": "RootAir", "assigned_volumes": ["Body1"]}]}) + "\n",
        encoding="utf-8",
    )
    out = project_hydrate(id="p1", simulation_id="b")
    assert out["materials"] is None
    assert read_sibling("p1", "materials.json", "b") is None
    assert read_sibling("p1", "materials.json", "missing-study") is None
