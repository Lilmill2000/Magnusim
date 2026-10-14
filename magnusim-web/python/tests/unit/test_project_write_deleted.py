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
