"""A reopened project's refinements: hydrate (the page's one read when a project opens or a
study is switched to) gives the study's refinements as GET /api/mesh/refinements does, from
each mesh folder's Ref_* records and the rows of its leftover refinements.json. It read only
the study's mesh_refinements.json, which the refinements route no longer writes, so the tree
and the refinement editor showed none after a reload (the mesher still used them). The page:
e2e/mesh-refine-reach.spec.js (the editor and the tree after a reload).
"""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.project.paths import create_geometry_folder, create_mesh_folder, create_study_folder
from cfddesk.worker.methods import project_hydrate
from cfddesk.worker.rpc import dispatch


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc) + "\n", encoding="utf-8")


def _project(root: Path) -> tuple[Path, Path, Path, Path]:
    project = root / "p1"
    project.mkdir()
    _write(project / "project.json", {"id": "p1", "name": "p1"})
    create_geometry_folder(project, {"id": "geo", "name": "Part", "original_filename": "Part"})
    create_study_folder(project, "geo", {"id": "a", "name": "Baseline"})
    create_study_folder(project, "geo", {"id": "b", "name": "Other"})
    row = {"analysis": "Incompressible", "time_dependency": "Steady-state", "geometry_id": "geo"}
    _write(project / "simulations.json", {"active_id": "a", "simulations": [{"id": "a", "name": "Baseline", **row}, {"id": "b", "name": "Other", **row}]})
    m1 = Path(create_mesh_folder(project, "a", {"id": "m1", "name": "Mesh 1"})["dir"])
    m2 = Path(create_mesh_folder(project, "a", {"id": "m2", "name": "Mesh 2"})["dir"])
    other = Path(create_mesh_folder(project, "b", {"id": "m3", "name": "Mesh 1"})["dir"])
    return project, m1, m2, other


def test_hydrate_gives_each_mesh_folders_refinements(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    _project_dir, m1, m2, other = _project(tmp_path)
    hole = {"id": "ref-1", "name": "Hole", "type": "Surface custom sizing", "faces": ["face 7@Body1"], "default_size": 1.2, "reach": 15, "reach_unit": "mm", "rev": 2}
    _write(m1 / "refinements" / "Hole" / "refinement.json", hole)
    # A leftover row a folder holds too is the folder's; one no folder holds is kept.
    _write(m1 / "refinements.json", {"refinements": [{**hole, "default_size": 9}, {"id": "ref-2", "name": "Old", "type": "Inflate boundary layer"}]})
    _write(m2 / "refinements" / "Wall" / "refinement.json", {"id": "ref-3", "name": "Wall", "type": "Inflate boundary layer", "mesh_id": "m2"})
    _write(other / "refinements" / "Else" / "refinement.json", {"id": "ref-4", "name": "Else", "type": "Surface custom sizing"})

    out = project_hydrate(id="p1")
    # The page's call reaches it as the worker's project.hydrate.
    assert dispatch("project.hydrate", {"project_id": "p1"})["refinements"] == out["refinements"]

    refs = out["refinements"]
    assert refs["simulation_id"] == "a"
    rows = {r["id"]: r for r in refs["refinements"]}
    assert sorted(rows) == ["ref-1", "ref-2", "ref-3"]
    assert {k: rows["ref-1"][k] for k in ("mesh_id", "simulation_id", "default_size", "reach", "reach_unit", "rev")} == {
        "mesh_id": "m1", "simulation_id": "a", "default_size": 1.2, "reach": 15, "reach_unit": "mm", "rev": 2,
    }
    assert "dir" not in rows["ref-1"] and "folder" not in rows["ref-1"]
    assert (rows["ref-2"]["mesh_id"], rows["ref-3"]["mesh_id"]) == ("m1", "m2")
    # The other study's, when it is the one opened.
    assert [r["id"] for r in project_hydrate(id="p1", simulation_id="b")["refinements"]["refinements"]] == ["ref-4"]


def test_hydrate_keeps_a_studys_old_refinements_file_when_no_mesh_holds_any(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    project, _m1, _m2, _other = _project(tmp_path)
    study = next(p for p in (project / "geometries").rglob("*") if p.is_dir() and p.name == "Baseline")
    old = {"refinements": [{"id": "ref-old", "name": "Old", "mesh_id": "m1"}], "simulation_id": "a"}
    _write(study / "mesh_refinements.json", old)
    assert project_hydrate(id="p1")["refinements"] == old
    # A study with none at all: none, as before.
    assert project_hydrate(id="p1", simulation_id="b")["refinements"] is None
