"""A study the index still lists after its folder is gone is not hydrated.

Projects saved before a study delete dropped the study from simulations.json kept a
row for it (the delete saved the index while the folder was still on disk), and
activating that row made it active_id. Hydrate listed it: the workbench counted it,
offered it under Start from and opened it with an empty setup.
"""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.project.paths import create_geometry_folder, create_study_folder, drop_missing_studies
from cfddesk.project.scope import build_project_tree
from cfddesk.worker.methods import project_hydrate, sim_get

ROW = {"analysis": "Incompressible", "time_dependency": "Steady-state", "geometry_id": "geo"}


def _project_with_missing_study(root: Path, pid: str = "p1") -> Path:
    project = root / pid
    project.mkdir()
    (project / "project.json").write_text(json.dumps({"id": pid, "name": pid}) + "\n", encoding="utf-8")
    create_geometry_folder(project, {"id": "geo", "name": "Part", "original_filename": "Part"})
    study = create_study_folder(project, "geo", {"id": "a", "name": "Baseline"})
    (Path(study["dir"]) / "boundary_conditions.json").write_text(
        json.dumps({"boundary_conditions": [{"id": "bc-in", "name": "Inlet", "simulation_id": "a"}]}) + "\n",
        encoding="utf-8",
    )
    catalog = {
        "active_id": "gone",
        "simulations": [{"id": "a", "name": "Baseline", **ROW}, {"id": "gone", "name": "Deleted", **ROW}],
        "updated_at": "2026-09-01T00:00:00.000Z",
    }
    (project / "simulations.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    (project / "simulation.json").write_text(json.dumps({"id": "gone", "name": "Deleted", **ROW}) + "\n", encoding="utf-8")
    return project


def test_hydrate_lists_and_opens_only_studies_with_a_folder(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    project = _project_with_missing_study(tmp_path)
    before = (project / "simulations.json").read_bytes()

    out = project_hydrate(id="p1")

    catalog = out["simulation"]
    assert [s["id"] for s in catalog["simulations"]] == ["a"]
    assert catalog["active_id"] == "a"
    # The setup is the study that is left, not the empty one of the missing study.
    assert out["bcs"]["simulation_id"] == "a"
    assert [b["name"] for b in out["bcs"]["boundary_conditions"]] == ["Inlet"]
    # The worker only filters: Node writes simulations.json (and fixes it on its next read).
    assert (project / "simulations.json").read_bytes() == before


def test_tree_and_sim_get_agree_with_hydrate(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    project = _project_with_missing_study(tmp_path)

    tree = build_project_tree(project, "p1")
    studies = tree["geometries"][0]["studies"]
    assert [(s["id"], s["active"]) for s in studies] == [("a", True)]

    got = sim_get(id="p1")
    assert [s["id"] for s in got["simulations"]] == ["a"]
    assert got["active_id"] == "a"


def test_only_missing_rows_go():
    studies = [{"id": "a"}, {"id": "b"}]
    whole = {"active_id": "b", "simulations": [{"id": "a"}, {"id": "b"}]}
    assert drop_missing_studies(whole, studies) is whole
    listed = drop_missing_studies({"active_id": "b", "simulations": [{"id": "a"}, {"id": "x"}, {"id": "b"}]}, studies)
    assert listed == {"active_id": "b", "simulations": [{"id": "a"}, {"id": "b"}]}
    # Every row gone: no active study, and the caller does not fall back to simulation.json.
    assert drop_missing_studies({"active_id": "x", "simulations": [{"id": "x"}]}, []) == {
        "active_id": None,
        "simulations": [],
    }
    assert drop_missing_studies(None, studies) is None
