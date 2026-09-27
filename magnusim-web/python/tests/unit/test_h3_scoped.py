"""Two studies in one project: a write on study A leaves study B's tree and hydrate alone."""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.project.paths import create_geometry_folder, create_study_folder, find_study
from cfddesk.project.scope import build_project_tree
from cfddesk.worker.methods import (
    bcs_set,
    materials_set,
    mesh_set,
    project_hydrate,
    sim_catalog_set,
)


def _project(root: Path, pid: str = "p1") -> Path:
    dest = root / pid
    dest.mkdir()
    (dest / "project.json").write_text(json.dumps({"id": pid, "name": pid}) + "\n", encoding="utf-8")
    return dest


def _study_bytes(project: Path, sim_id: str) -> dict[str, bytes]:
    study = find_study(project, sim_id)
    assert study
    root = Path(study["dir"])
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


def _study_node(project: Path, sim_id: str) -> dict:
    tree = build_project_tree(project, project.name)
    for geom in tree["geometries"]:
        for study in geom["studies"]:
            if study["id"] == sim_id:
                return study
    raise AssertionError(sim_id)


def test_gate_h3_two_studies_stay_isolated(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path))
    project = _project(tmp_path, "p1")
    create_geometry_folder(project, {"id": "geo", "name": "Part", "original_filename": "Part"})
    create_study_folder(project, "geo", {"id": "a", "name": "A"})
    create_study_folder(project, "geo", {"id": "b", "name": "B"})

    materials_set(
        project_id="p1",
        sim_id="b",
        body={
            "simulation_id": "b",
            "materials": [{"id": "air", "name": "Air", "assigned_volumes": ["BodyB"]}],
        },
    )
    bcs_set(
        project_id="p1",
        sim_id="b",
        body={
            "simulation_id": "b",
            "boundary_conditions": [
                {
                    "id": "bc-b",
                    "name": "inlet-b",
                    "bc_type": "Velocity inlet",
                    "faces": ["face 9@Body1"],
                    "simulation_id": "b",
                }
            ],
        },
    )
    mesh_set(
        project_id="p1",
        sim_id="b",
        body={
            "simulation_id": "b",
            "id": "mesh-b",
            "active_id": "mesh-b",
            "meshes": [
                {
                    "id": "mesh-b",
                    "name": "Mesh B",
                    "settings": {"fineness": 4},
                    "simulation_id": "b",
                }
            ],
        },
    )
    catalog = {
        "active_id": "b",
        "simulations": [
            {"id": "a", "name": "A", "geometry_id": "geo", "turbulence_model": "kEpsilon"},
            {"id": "b", "name": "B", "geometry_id": "geo", "turbulence_model": "kEpsilon"},
        ],
    }
    sim_catalog_set(project_id="p1", body=catalog)
    project_hydrate(id="p1", simulation_id="b")

    before_bytes = _study_bytes(project, "b")
    before_node = _study_node(project, "b")
    before = project_hydrate(id="p1", simulation_id="b")

    materials_set(
        project_id="p1",
        sim_id="a",
        body={
            "simulation_id": "a",
            "materials": [{"id": "air", "name": "Air", "assigned_volumes": ["BodyA"]}],
        },
    )
    bcs_set(
        project_id="p1",
        sim_id="a",
        body={
            "simulation_id": "a",
            "boundary_conditions": [
                {
                    "id": "bc-a",
                    "name": "inlet-a",
                    "bc_type": "Velocity inlet",
                    "faces": ["face 1@Body1"],
                    "simulation_id": "a",
                }
            ],
        },
    )
    mesh_set(
        project_id="p1",
        sim_id="a",
        body={
            "simulation_id": "a",
            "id": "mesh-a",
            "active_id": "mesh-a",
            "meshes": [
                {
                    "id": "mesh-a",
                    "name": "Mesh A",
                    "settings": {"fineness": 1},
                    "simulation_id": "a",
                }
            ],
        },
    )
    patched = {
        "active_id": "b",
        "simulations": [
            {"id": "a", "name": "A", "geometry_id": "geo", "turbulence_model": "kOmegaSST"},
            {"id": "b", "name": "B", "geometry_id": "geo", "turbulence_model": "kEpsilon"},
        ],
    }
    sim_catalog_set(project_id="p1", sim_id="a", body=patched)

    assert _study_bytes(project, "b") == before_bytes
    assert _study_node(project, "b") == before_node
    after = project_hydrate(id="p1", simulation_id="b")
    assert after["materials"] == before["materials"]
    assert after["bcs"] == before["bcs"]
    # Hydrate stamps updated_at when it reads (the files above are byte-identical);
    # a second boundary between the two reads is not a change to study b.
    def unstamped(doc):
        if not isinstance(doc, dict):
            return doc
        out = {k: v for k, v in doc.items() if k != "updated_at"}
        if isinstance(out.get("meshes"), list):
            out["meshes"] = [{k: v for k, v in m.items() if k != "updated_at"} for m in out["meshes"]]
        return out

    assert unstamped(after["mesh"]) == unstamped(before["mesh"])
    saved = [row for row in after["simulation"]["simulations"] if row["id"] == "b"]
    assert saved == [row for row in before["simulation"]["simulations"] if row["id"] == "b"]
    changed = [row for row in after["simulation"]["simulations"] if row["id"] == "a"]
    assert changed[0]["turbulence_model"] == "kOmegaSST"
