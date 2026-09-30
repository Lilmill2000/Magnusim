"""H0 scope keys, sibling migration, and study-owned trees."""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.project import scope as scope_mod
from cfddesk.project import web_writes as ww
from cfddesk.project.paths import create_geometry_folder, create_study_folder
from cfddesk.project.scope import ScopeId, build_project_tree, migrate_root_siblings
from cfddesk.worker.methods import project_hydrate, project_write_project
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


def _marker(project: Path):
    return json.loads((project / "project.json").read_text(encoding="utf-8")).get("siblings_migrated")


def _record_writes(monkeypatch) -> list[str]:
    """Names of the files scope.py and web_writes.py write, still writing them."""
    names: list[str] = []
    real = ww.atomic_write

    def spy(path, doc):
        names.append(Path(path).name)
        real(path, doc)

    monkeypatch.setattr(scope_mod, "atomic_write", spy, raising=False)
    monkeypatch.setattr(ww, "atomic_write", spy)
    return names


def test_migration_writes_project_json_atomically(tmp_path: Path, monkeypatch):
    """Node reads project.json on every request; a truncate-then-write lets it parse half a file."""
    project = _project(tmp_path)
    _study(project, "geo", "study", "Only")
    (project / "mesh.json").write_text(
        json.dumps({"meshes": [{"id": "mesh1", "name": "Mesh 1"}]}) + "\n",
        encoding="utf-8",
    )
    real_write_text = Path.write_text

    def no_truncating_write(self: Path, *args, **kwargs):
        assert self.name != "project.json", f"project.json written in place: {self}"
        return real_write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", no_truncating_write)
    writes = _record_writes(monkeypatch)
    assert migrate_root_siblings(project) is True
    assert "project.json" in writes
    assert "mesh.json" in writes
    assert _marker(project) is True


def test_write_project_without_the_marker_keeps_it(tmp_path: Path, monkeypatch):
    """Node writes project.json back from a copy it read before the migration marked it."""
    project = _project(tmp_path)
    _study(project, "geo", "study", "Only")
    stale = json.loads((project / "project.json").read_text(encoding="utf-8"))
    migrate_root_siblings(project)
    assert _marker(project) is True

    written = ww.write_project(project, {**stale, "name": "Renamed"})
    assert "siblings_migrated" not in stale
    assert written["siblings_migrated"] is True
    on_disk = json.loads((project / "project.json").read_text(encoding="utf-8"))
    assert on_disk["name"] == "Renamed"
    assert on_disk["siblings_migrated"] is True

    writes = _record_writes(monkeypatch)
    migrate_root_siblings(project)
    assert writes == []


def test_write_project_keeps_the_marker_on_disk_over_an_older_one(tmp_path: Path):
    project = _project(tmp_path)
    create_geometry_folder(project, {"id": "geo", "name": "Part", "original_filename": "Part"})
    create_study_folder(project, "geo", {"id": "a", "name": "A"})
    create_study_folder(project, "geo", {"id": "b", "name": "B"})
    migrate_root_siblings(project)
    assert _marker(project) == "skipped-multi"
    ww.write_project(project, {"id": "proj", "name": "proj", "siblings_migrated": True})
    assert _marker(project) == "skipped-multi"


def test_hydrate_after_a_stale_project_write_leaves_project_json_alone(tmp_path: Path, monkeypatch):
    """The ping-pong: every project.tree / project.hydrate after such a write rewrote project.json."""
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    project = _project(tmp_path, "p1")
    _study(project, "geo", "study", "Only")
    stale = json.loads((project / "project.json").read_text(encoding="utf-8"))
    project_hydrate(id="p1")
    assert _marker(project) is True

    project_write_project(project_dir=str(project), doc={**stale, "name": "Renamed"})
    assert _marker(project) is True
    writes = _record_writes(monkeypatch)
    project_hydrate(id="p1")
    project_hydrate(id="p1")
    assert "project.json" not in writes
