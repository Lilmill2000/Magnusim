"""A project.json save never makes a deleted project again.

The worker answers one request at a time, so a save can wait behind earlier ones and run
after its project was deleted. atomic_write made the folder it wrote to, so that save
brought the deleted project back: its folder, a project.json, a card on Home.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from cfddesk.project import link, scope
from cfddesk.project import web_writes as ww
from cfddesk.worker.methods import project_create, project_write_project


def _project(root: Path, pid: str = "proj") -> Path:
    dest = root / pid
    (dest / "geometry").mkdir(parents=True)
    (dest / "project.json").write_text(json.dumps({"id": pid, "title": "Plate"}) + "\n", encoding="utf-8")
    return dest


def _title(project: Path) -> str:
    return json.loads((project / "project.json").read_text(encoding="utf-8"))["title"]


def test_a_save_of_a_deleted_project_is_refused_and_makes_nothing(tmp_path: Path):
    project = _project(tmp_path)
    written = ww.write_project(project, {"id": "proj", "title": "Renamed"})
    assert written["title"] == "Renamed"
    assert _title(project) == "Renamed"
    shutil.rmtree(project)
    with pytest.raises(FileNotFoundError, match="project not found: proj"):
        ww.write_project(project, {"id": "proj", "title": "Plate"})
    assert not project.exists()


def test_the_worker_method_refuses_it_too(tmp_path: Path):
    project = _project(tmp_path)
    shutil.rmtree(project)
    with pytest.raises(FileNotFoundError, match="project not found: proj"):
        project_write_project(project_dir=str(project), doc={"id": "proj", "title": "Plate"})
    assert not project.exists()


def test_a_folder_whose_project_json_is_gone_gets_none(tmp_path: Path):
    """A delete that removed project.json but not yet the folder (Windows: a file held open)."""
    project = _project(tmp_path)
    (project / "project.json").unlink()
    with pytest.raises(FileNotFoundError, match="project not found: proj"):
        ww.write_project(project, {"id": "proj", "title": "Plate"})
    assert not (project / "project.json").exists()


def test_a_folder_deleted_between_the_check_and_the_write_is_not_made_again(tmp_path: Path, monkeypatch):
    project = _project(tmp_path)
    real_is_file = Path.is_file

    def deleted_after_the_check(self: Path) -> bool:
        there = real_is_file(self)
        if self == project / "project.json" and project.exists():
            shutil.rmtree(project)
        return there

    monkeypatch.setattr(Path, "is_file", deleted_after_the_check)
    with pytest.raises(FileNotFoundError):
        ww.write_project(project, {"id": "proj", "title": "Plate"})
    assert not project.exists()


def test_a_new_project_is_written_only_into_its_own_folder(tmp_path: Path, monkeypatch):
    fresh = tmp_path / "fresh"
    with pytest.raises(FileNotFoundError, match="project not found: fresh"):
        ww.write_project(fresh, {"id": "fresh", "title": "Fresh"}, create=True)
    assert not fresh.exists()
    fresh.mkdir()
    ww.write_project(fresh, {"id": "fresh", "title": "Fresh"}, create=True)
    assert _title(fresh) == "Fresh"

    # The worker's own create (project.create) makes its folder first.
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    made = project_create(title="Made")
    assert _title(tmp_path / made["id"]) == "Made"


def _linked_geometry(project: Path) -> None:
    gdir = project / "geometries" / "Geometry_g1"
    (gdir / "link").mkdir(parents=True)
    source = {"type": "plugin_study", "plugin": "link-demo", "study_id": "st-1", "linked_at": "2026-10-01T00:00:00Z"}
    ident = {"id": "g1", "name": "Plate", "kind": "geometry", "source": source}
    state = {"rev": 1, "version": 1, "shape_sha256": "a" * 64}
    (gdir / "id.json").write_text(json.dumps(ident) + "\n", encoding="utf-8")
    (gdir / "source.bbrep").write_bytes(b"x")
    (gdir / "link" / "state.json").write_text(json.dumps(state) + "\n", encoding="utf-8")


def _left(project: Path) -> list[str]:
    return sorted(str(p.relative_to(project)) for p in project.rglob("*")) if project.exists() else []


# Other worker calls that save into the project's own folder: project.json (a run's stamp,
# the migration marker, a linked geometry's record and their repair, the study settings'
# summaries) and the study catalog. A project deleted between their read and their save is
# not made again either. It is deleted as the save is about to write its file, and each test
# checks the save got that far: one that stopped earlier would pass and prove nothing.
_MATERIALS = {"materials": [{"id": "m1", "name": "Air"}]}
_BCS = {"boundary_conditions": [{"id": "bc1", "name": "Inlet", "bc_type": "Velocity inlet"}]}
_MESH = {"settings": {"algorithm": "standard"}}
_STUDY = {"id": "sim-1", "name": "Study 1"}
_CATALOG = {"active_id": "sim-1", "simulations": [_STUDY]}
_SID = "sim-1"
_OTHER_WRITERS = [
    ("a run's stamp", ww, "project.json", lambda p: ww.stamp_run_on_project(p, {"id": "run-1", "status": "done"})),
    ("the migration marker", scope, "project.json", lambda p: scope._mark_migration(p, True)),
    ("a linked geometry's record", link, "project.json", lambda p: link.upsert_geometry(p, {"id": "g1", "name": "Plate"})),
    ("the linked geometries' repair", link, "project.json", link.repair_project),
    ("the materials' summary", ww, "project.json", lambda p: ww.set_materials(p, _MATERIALS, sim_id=_SID)),
    ("the boundary conditions' summary", ww, "project.json", lambda p: ww.set_bcs(p, _BCS, sim_id=_SID)),
    ("the mesh settings' summary", ww, "project.json", lambda p: ww.set_mesh_settings(p, _MESH, sim_id=_SID)),
    ("the refinements' summary", ww, "project.json", lambda p: ww.set_refinements(p, {"refinements": []}, sim_id=_SID)),
    ("the result controls' summary", ww, "project.json", lambda p: ww.set_result_controls(p, {}, sim_id=_SID)),
    ("the study catalog", ww, "simulations.json", lambda p: ww.save_sim_catalog(p, _CATALOG)),
    ("the study catalog's active study", ww, "simulation.json", lambda p: ww.save_sim_catalog(p, _CATALOG)),
    ("the active study", ww, "simulation.json", lambda p: ww.write_simulation(p, _STUDY)),
]


@pytest.mark.parametrize(("what", "module", "name", "save"), _OTHER_WRITERS, ids=[w[0] for w in _OTHER_WRITERS])
def test_a_project_deleted_while_another_save_of_it_runs_is_not_made_again(
    tmp_path: Path, monkeypatch, what, module, name, save
):
    project = _project(tmp_path)
    _linked_geometry(project)
    real_write = module.atomic_write
    reached: list[str] = []

    def deleted_as_it_saves(path, doc, **kwargs):
        if Path(path) == project / name and project.exists():
            reached.append(name)
            shutil.rmtree(project)
        return real_write(path, doc, **kwargs)

    monkeypatch.setattr(module, "atomic_write", deleted_as_it_saves)
    try:
        save(project)
    except FileNotFoundError:
        pass
    assert reached == [name], f"{what}: the save never got to {name}"
    assert not project.exists(), f"{what}: {_left(project)}"

