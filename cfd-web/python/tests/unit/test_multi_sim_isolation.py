"""Studies stay isolated: each study folder is the only place its data lives."""
from __future__ import annotations

import json
from pathlib import Path

from cfddesk.project.paths import (
    create_geometry_folder,
    create_mesh_folder,
    create_study_folder,
    find_study,
    resolve_step_for_study,
    study_json_path,
    walk_meshes,
)
from cfddesk.project.web_mirrors.mesh import from_web_mesh
from cfddesk.project.web_writes import set_bcs, write_json


def _tree(root: Path, sim_ids: list[str]) -> dict[str, Path]:
    root.mkdir(parents=True, exist_ok=True)
    (root / "project.json").write_text(json.dumps({"id": root.name, "name": "P"}), encoding="utf-8")
    (root / "simulations.json").write_text(
        json.dumps(
            {
                "active_id": sim_ids[-1],
                "simulations": [{"id": sid, "name": f"Study {sid}"} for sid in sim_ids],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    geom = create_geometry_folder(root, {"id": "geom-1", "name": "part.step", "original_filename": "part.step"})
    dirs = {}
    for sid in sim_ids:
        study = create_study_folder(root, "geom-1", {"id": sid, "name": f"Study {sid}"})
        dirs[sid] = Path(study["dir"])
    dirs["geom"] = Path(geom["dir"])
    return dirs


def _bc(sid: str, name: str) -> dict:
    return {
        "id": f"bc-{sid}-{name.replace(' ', '-').lower()}",
        "name": name,
        "bc_type": "Velocity inlet" if "inlet" in name.lower() else "Pressure",
        "faces": ["face 1@Body1"],
        "simulation_id": sid,
    }


def _read_study_bcs(root: Path, sid: str) -> dict:
    path = study_json_path(root, sid, "boundary_conditions.json")
    assert path is not None and path.is_file()
    return json.loads(path.read_text(encoding="utf-8"))


def test_resolve_step_for_study_uses_that_geometry(tmp_path: Path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "project.json").write_text("{}", encoding="utf-8")
    first = create_geometry_folder(root, {"id": "geom-a", "name": "A", "original_filename": "A.step"})
    second = create_geometry_folder(root, {"id": "geom-b", "name": "B", "original_filename": "B.step"})
    (Path(first["dir"]) / "source.step").write_text("STEP-A", encoding="utf-8")
    (Path(second["dir"]) / "source.step").write_text("STEP-B", encoding="utf-8")
    create_study_folder(root, "geom-b", {"id": "sim-b", "name": "Study B"})
    step = resolve_step_for_study(root, "sim-b")
    assert step == Path(second["dir"]) / "source.step"
    assert step.read_text(encoding="utf-8") == "STEP-B"


def test_write_json_does_not_enter_other_study_folder(tmp_path: Path):
    root = tmp_path / "proj"
    _tree(root, ["sim-a", "sim-b"])
    write_json(
        root,
        "boundary_conditions.json",
        {"simulation_id": "sim-a", "boundary_conditions": [_bc("sim-a", "Pressure 1")]},
        sim_id="sim-a",
    )
    write_json(
        root,
        "boundary_conditions.json",
        {"simulation_id": "sim-b", "boundary_conditions": [_bc("sim-b", "Velocity inlet 1")]},
        sim_id="sim-b",
    )
    a = _read_study_bcs(root, "sim-a")
    b = _read_study_bcs(root, "sim-b")
    assert {x.get("simulation_id") for x in a["boundary_conditions"]} == {"sim-a"}
    assert {x.get("simulation_id") for x in b["boundary_conditions"]} == {"sim-b"}
    assert a["boundary_conditions"][0]["name"] == "Pressure 1"
    assert b["boundary_conditions"][0]["name"] == "Velocity inlet 1"
    assert not (root / "boundary_conditions.json").exists()


def test_set_bcs_on_second_sim_does_not_drop_first(tmp_path: Path):
    root = tmp_path / "proj"
    _tree(root, ["sim-a", "sim-b"])
    write_json(
        root,
        "boundary_conditions.json",
        {"simulation_id": "sim-a", "boundary_conditions": [_bc("sim-a", "Pressure 1")]},
        sim_id="sim-a",
    )
    set_bcs(
        root,
        {"simulation_id": "sim-b", "boundary_conditions": [_bc("sim-b", "Velocity inlet 1")]},
        sim_id="sim-b",
    )
    a = _read_study_bcs(root, "sim-a")
    b = _read_study_bcs(root, "sim-b")
    assert a["boundary_conditions"][0]["name"] == "Pressure 1"
    assert b["boundary_conditions"][0]["name"] == "Velocity inlet 1"


def test_clear_faces_does_not_steal_other_study(tmp_path: Path):
    root = tmp_path / "proj"
    _tree(root, ["sim-a", "sim-b"])
    write_json(
        root,
        "boundary_conditions.json",
        {"simulation_id": "sim-a", "boundary_conditions": [_bc("sim-a", "Pressure 1")]},
        sim_id="sim-a",
    )
    write_json(
        root,
        "boundary_conditions.json",
        {"simulation_id": "sim-b", "boundary_conditions": [_bc("sim-b", "Pressure 1")]},
        sim_id="sim-b",
    )
    cleared = _bc("sim-b", "Pressure 1")
    cleared["faces"] = []
    write_json(
        root,
        "boundary_conditions.json",
        {"simulation_id": "sim-b", "boundary_conditions": [cleared]},
        sim_id="sim-b",
    )
    a = _read_study_bcs(root, "sim-a")
    b = _read_study_bcs(root, "sim-b")
    assert a["boundary_conditions"][0]["faces"] == ["face 1@Body1"]
    assert b["boundary_conditions"][0]["faces"] == []


def test_from_web_mesh_does_not_inherit_toplevel_live():
    nodes, _active = from_web_mesh(
        {
            "live_mesh_result": {
                "status": "done",
                "n_cells": 677246,
                "case_dir": "/tmp/run-a",
            },
            "meshes": [
                {
                    "id": "m1",
                    "name": "Mesh 1",
                    "simulation_id": "sim-a",
                    "generated": True,
                    "live_mesh_result": {
                        "status": "done",
                        "n_cells": 677246,
                        "case_dir": "/tmp/run-a",
                    },
                    "settings": {},
                },
                {
                    "id": "m2",
                    "name": "Mesh 1",
                    "simulation_id": "sim-b",
                    "generated": False,
                    "settings": {},
                },
            ],
        }
    )
    by = {n.id: n for n in nodes}
    meta_b = getattr(by["m2"], "web_meta", None) or {}
    assert meta_b.get("live_mesh_result") in (None, {})
    assert by["m2"].n_cells is None


def test_write_json_mesh_stays_in_own_folder(tmp_path: Path):
    root = tmp_path / "proj"
    _tree(root, ["sim-a", "sim-b"])
    create_mesh_folder(root, "sim-a", {"id": "m1", "name": "Mesh 1"})
    create_mesh_folder(root, "sim-b", {"id": "m2", "name": "Mesh 1"})
    write_json(
        root,
        "mesh.json",
        {
            "simulation_id": "sim-a",
            "active_id": "m1",
            "generated": True,
            "meshes": [
                {
                    "id": "m1",
                    "name": "Mesh 1",
                    "simulation_id": "sim-a",
                    "generated": True,
                    "live_mesh_result": {
                        "status": "done",
                        "n_cells": 677246,
                        "case_dir": "/tmp/run-a",
                    },
                }
            ],
        },
        sim_id="sim-a",
    )
    write_json(
        root,
        "mesh.json",
        {
            "simulation_id": "sim-b",
            "active_id": "m2",
            "generated": False,
            "live_mesh_result": None,
            "meshes": [
                {
                    "id": "m2",
                    "name": "Mesh 1",
                    "simulation_id": "sim-b",
                    "generated": False,
                    "settings": {"fineness": 5},
                }
            ],
        },
        sim_id="sim-b",
    )
    a = walk_meshes(root, "sim-a")
    b = walk_meshes(root, "sim-b")
    assert len(a) == 1 and a[0]["generated"] is True
    assert (a[0].get("live_mesh_result") or {}).get("n_cells") == 677246
    assert str(a[0]["case_dir"]).endswith("case")
    assert "sim-a" in str(Path(a[0]["dir"])).replace("\\", "/")
    assert len(b) == 1 and b[0].get("generated") in (False, None)
    assert not b[0].get("live_mesh_result")
    assert "sim-b" in str(Path(b[0]["dir"])).replace("\\", "/") or find_study(root, "sim-b")
    assert not (root / "mesh.json").exists()


def test_walk_runs_remaps_stale_case_dir(tmp_path: Path):
    from cfddesk.project.paths import create_run_folder, walk_runs

    root = tmp_path / "proj"
    _tree(root, ["sim-a"])
    run = create_run_folder(root, "sim-a", {"id": "r1", "name": "Run 1"})
    folder = Path(run["dir"])
    stale = tmp_path / "Incompressible_Steady-state" / "simulation_runs" / "Run_1" / "case"
    (folder / "run.json").write_text(
        json.dumps({"id": "r1", "name": "Run 1", "case_dir": str(stale)}),
        encoding="utf-8",
    )
    walked = walk_runs(root, "sim-a")
    assert walked and Path(walked[0]["case_dir"]) == folder / "case"


def test_resolve_study_id_uses_mesh_folder_not_root_mesh_json(tmp_path: Path):
    from cfddesk.project.web_adapter import resolve_study_id

    root = tmp_path / "proj"
    _tree(root, ["sim-a", "sim-b"])
    create_mesh_folder(root, "sim-b", {"id": "m-b", "name": "Mesh 1"})
    assert resolve_study_id(root, mesh_id="m-b") == "sim-b"
    assert not (root / "mesh.json").exists()


def test_stale_mesh_path_resolves_to_this_study_folder(tmp_path: Path):
    from cfddesk.project.web_adapter import resolve_mesh

    root = tmp_path / "proj"
    _tree(root, ["sim-a"])
    mesh = create_mesh_folder(root, "sim-a", {"id": "m1", "name": "Mesh 1"})
    folder = Path(mesh["dir"])
    poly = folder / "case" / "constant" / "polyMesh"
    poly.mkdir(parents=True)
    (poly / "owner").write_text("ok", encoding="utf-8")
    (poly / "points").write_text("ok", encoding="utf-8")
    stale = tmp_path / "Incompressible_Steady-state" / "meshes" / "Mesh_1" / "case" / "constant" / "polyMesh"
    write_json(
        root,
        "mesh.json",
        {
            "simulation_id": "sim-a",
            "active_id": "m1",
            "generated": True,
            "meshes": [
                {
                    "id": "m1",
                    "name": "Mesh 1",
                    "simulation_id": "sim-a",
                    "generated": True,
                    "live_mesh_result": {
                        "status": "done",
                        "n_cells": 12,
                        "case_dir": str(stale.parent.parent),
                        "mesh_path": str(stale),
                    },
                }
            ],
        },
        sim_id="sim-a",
    )
    walked = walk_meshes(root, "sim-a")
    assert walked and "sim-a" in str(walked[0]["live_mesh_result"]["mesh_path"]).replace("\\", "/")
    assert str(stale) not in str(walked[0]["live_mesh_result"]["mesh_path"])
    resolved = resolve_mesh(root, mesh_id="m1", simulation_id="sim-a")
    assert resolved.get("ok") is True
    assert (Path(resolved["mesh_path"]) / "owner").is_file()
    assert "sim-a" in str(Path(resolved["case_dir"])).replace("\\", "/") or folder.as_posix() in str(
        Path(resolved["case_dir"])
    ).replace("\\", "/")


def test_materials_do_not_union_across_studies(tmp_path: Path):
    root = tmp_path / "proj"
    _tree(root, ["sim-a", "sim-b"])
    write_json(
        root,
        "materials.json",
        {
            "simulation_id": "sim-a",
            "materials": [{"id": "mat-a", "name": "Air", "simulation_id": "sim-a", "nu": 1.5e-5}],
        },
        sim_id="sim-a",
    )
    write_json(
        root,
        "materials.json",
        {
            "simulation_id": "sim-b",
            "materials": [{"id": "mat-b", "name": "Air", "simulation_id": "sim-b", "nu": 1.6e-5}],
        },
        sim_id="sim-b",
    )
    a = json.loads(study_json_path(root, "sim-a", "materials.json").read_text(encoding="utf-8"))
    b = json.loads(study_json_path(root, "sim-b", "materials.json").read_text(encoding="utf-8"))
    assert {m["id"] for m in a["materials"]} == {"mat-a"}
    assert {m["id"] for m in b["materials"]} == {"mat-b"}
    assert not (root / "materials.json").exists()
