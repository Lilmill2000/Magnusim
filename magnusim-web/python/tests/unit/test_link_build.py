"""Linked geometries (host API 1.5), L2 step 3 "build stamps and starts", Python side.

- gate:l2-build: the mesh writers (persist_mesh_doc, mesh_result) keep a mesh's
  ``live_mesh_result.built_from_rev`` from disk; only a generator's result sets it. The run
  writer (run_upsert) keeps a run's ``built_from`` (only Start, in Node, sets it). The tree
  marks a generated mesh of a linked geometry "out of date" when its stamp is missing or
  older than the geometry's rev, and a started run "older geometry" (D26); a geometry no
  link made gets neither field.
- load_face_props reads the study's own geometry's face table (LINK proposal 5.7), not the
  first geometry's.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cfddesk.project import web_writes
from cfddesk.project.paths import (
    create_geometry_folder,
    create_mesh_folder,
    create_run_folder,
    create_study_folder,
    find_mesh,
    find_run,
)
from cfddesk.project.run_inputs import _study_geometry_id, gather_run_inputs
from cfddesk.project.scope import build_project_tree
from cfddesk.project.web_adapter import load_face_props


def _write(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def _project(tmp_path: Path, rev: int | None = 2) -> dict[str, Any]:
    """Base plate (plain; its folder sorts first) and Demo 1 (a link made it, at ``rev``)."""
    root = tmp_path / "p1"
    root.mkdir()
    plate = create_geometry_folder(root, {"id": "g-plate", "name": "Base plate"})
    demo = create_geometry_folder(root, {"id": "g-demo", "name": "Demo 1"})
    _write(Path(plate["dir"]) / "cad_preview.json", {"faces": [{"id": 1, "area": 4.0, "centroid": [1, 1, 1]}], "bodies": ["Body1"], "faces_length_unit": "m"})
    _write(
        Path(demo["dir"]) / "cad_preview.json",
        {"faces": [{"id": 1, "area": 9.0, "centroid": [3, 3, 3]}, {"id": 2, "area": 1.0}], "bodies": ["Body1"], "faces_length_unit": "m"},
    )
    if rev is not None:
        _write(Path(demo["dir"]) / "link" / "state.json", {"rev": rev, "name": "Demo 1"})
    create_study_folder(root, "g-plate", {"id": "s-plate", "name": "Plate study"})
    create_study_folder(root, "g-demo", {"id": "s-demo", "name": "Demo study"})
    _write(root / "project.json", {"id": "p1", "title": "p1"})
    _write(root / "simulations.json", {"active_id": "s-demo", "simulations": [{"id": "s-demo"}, {"id": "s-plate"}]})
    return {"root": root, "plate": plate, "demo": demo}


def _mesh(root: Path, sid: str, mid: str, live: dict[str, Any] | None) -> Path:
    folder = create_mesh_folder(root, sid, {"id": mid, "name": "Mesh 1"})
    doc: dict[str, Any] = {"id": mid, "name": "Mesh 1", "simulation_id": sid, "generated": bool(live and live.get("status") == "done")}
    if live is not None:
        doc["live_mesh_result"] = live
    _write(Path(folder["dir"]) / "mesh.json", doc)
    return Path(folder["dir"]) / "mesh.json"


def _read(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_mesh_writers_keep_the_build_stamp_on_disk(tmp_path: Path) -> None:
    p = _project(tmp_path)
    path = _mesh(p["root"], "s-demo", "m1", {"status": "done", "generate_id": "g1", "built_from_rev": 2})
    # A settings save with a stamp of its own, then one with none: the disk's stays.
    rec = {"id": "m1", "name": "Renamed", "simulation_id": "s-demo", "live_mesh_result": {"status": "done", "generate_id": "g1", "built_from_rev": 7}}
    web_writes.persist_mesh_doc(p["root"], "s-demo", {"meshes": [rec]})
    assert _read(path)["live_mesh_result"]["built_from_rev"] == 2
    assert _read(path)["name"] == "Renamed"
    rec["live_mesh_result"] = {"status": "done", "generate_id": "g1"}
    web_writes.persist_mesh_doc(p["root"], "s-demo", {"meshes": [rec]})
    assert _read(path)["live_mesh_result"]["built_from_rev"] == 2
    # A new mesh never gets one from its body.
    web_writes.persist_mesh_doc(
        p["root"], "s-demo", {"meshes": [{"id": "m2", "name": "Mesh 2", "live_mesh_result": {"status": "done", "built_from_rev": 5}}]}
    )
    m2 = find_mesh(p["root"], "m2", "s-demo")
    assert m2 is not None
    assert "built_from_rev" not in _read(Path(m2["dir"]) / "mesh.json")["live_mesh_result"]


def test_a_generators_result_sets_the_stamp_and_others_keep_it(tmp_path: Path) -> None:
    p = _project(tmp_path)
    path = _mesh(p["root"], "s-demo", "m1", {"status": "running", "generate_id": "g1", "built_from_rev": 2})
    # A generator's result carries its stamp.
    web_writes.mesh_result(p["root"], {"mesh_id": "m1", "live_mesh_result": {"status": "done", "generate_id": "g1", "built_from_rev": 3}}, sim_id="s-demo")
    assert _read(path)["live_mesh_result"]["built_from_rev"] == 3
    # A result without one keeps the disk's.
    web_writes.mesh_result(p["root"], {"mesh_id": "m1", "live_mesh_result": {"status": "done", "generate_id": "g1", "n_cells": 9}}, sim_id="s-demo")
    assert _read(path)["live_mesh_result"]["built_from_rev"] == 3


def test_run_upsert_keeps_built_from(tmp_path: Path) -> None:
    p = _project(tmp_path)
    folder = create_run_folder(p["root"], "s-demo", {"id": "r1", "name": "Run 1", "mesh_id": "m1"})
    stamp = {"mesh_id": "m1", "generate_id": "g1", "geometry_rev": 2}
    _write(Path(folder["dir"]) / "run.json", {"id": "r1", "name": "Run 1", "status": "done", "built_from": stamp})
    web_writes.run_upsert(p["root"], {"id": "r1", "status": "done", "built_from": {"geometry_rev": 9}, "name": "Run 1b"}, sim_id="s-demo")
    assert _read(Path(folder["dir"]) / "run.json")["built_from"] == stamp
    web_writes.run_upsert(p["root"], {"id": "r1", "name": "Run 1c"}, sim_id="s-demo")
    assert _read(Path(folder["dir"]) / "run.json")["built_from"] == stamp
    # A new run never takes one from its body.
    web_writes.run_upsert(p["root"], {"id": "r2", "name": "Run 2", "built_from": stamp}, sim_id="s-demo")
    r2 = find_run(p["root"], "r2", "s-demo")
    assert r2 is not None
    assert "built_from" not in _read(Path(r2["dir"]) / "run.json")


def _tree_nodes(root: Path, gid: str) -> dict[str, Any]:
    tree = build_project_tree(root, "p1")
    geom = next(g for g in tree["geometries"] if g["id"] == gid)
    study = geom["studies"][0]
    return {"meshes": {m["id"]: m for m in study["meshes"]}, "runs": {r["id"]: r for r in study["runs"]}}


def test_the_tree_marks_out_of_date_meshes_and_runs_on_an_older_geometry(tmp_path: Path) -> None:
    p = _project(tmp_path, rev=3)
    root = p["root"]
    _mesh(root, "s-demo", "m-old", {"status": "done", "built_from_rev": 2})
    _mesh(root, "s-demo", "m-new", {"status": "done", "built_from_rev": 3})
    _mesh(root, "s-demo", "m-unknown", {"status": "done"})
    _mesh(root, "s-demo", "m-not-generated", {"status": "failed", "built_from_rev": 1})
    for rid, status, built in [
        ("r-old", "done", {"geometry_rev": 2}),
        ("r-new", "done", {"geometry_rev": 3}),
        ("r-unknown", "stopped", None),
        ("r-draft", "draft", None),
    ]:
        f = create_run_folder(root, "s-demo", {"id": rid, "name": rid})
        _write(Path(f["dir"]) / "run.json", {"id": rid, "name": rid, "status": status, **({"built_from": built} if built else {})})
    nodes = _tree_nodes(root, "g-demo")
    assert {k: (m["out_of_date"], m["built_from_rev"]) for k, m in nodes["meshes"].items()} == {
        "m-old": (True, 2),
        "m-new": (False, 3),
        "m-unknown": (True, None),
        "m-not-generated": (False, 1),
    }
    assert {k: r.get("older_geometry") for k, r in nodes["runs"].items()} == {
        "r-old": True,
        "r-new": False,
        "r-unknown": True,
        "r-draft": None,
    }
    # A geometry no link made: no fields at all.
    _mesh(root, "s-plate", "m-plate", {"status": "done"})
    f = create_run_folder(root, "s-plate", {"id": "r-plate", "name": "r"})
    _write(Path(f["dir"]) / "run.json", {"id": "r-plate", "status": "done"})
    plain = _tree_nodes(root, "g-plate")
    assert "out_of_date" not in plain["meshes"]["m-plate"]
    assert "older_geometry" not in plain["runs"]["r-plate"]


def test_face_properties_come_from_the_studys_own_geometry(tmp_path: Path) -> None:
    p = _project(tmp_path)
    root = p["root"]
    assert _study_geometry_id(root, "s-demo") == "g-demo"
    demo = load_face_props(root, _study_geometry_id(root, "s-demo"))
    assert demo["face 1@Body1"]["area_m2"] == 9.0
    assert demo["face 1@Body1"]["centroid"] == (3.0, 3.0, 3.0)
    assert set(demo) == {"face 1@Body1", "face 2@Body1"}
    plate = load_face_props(root, "g-plate")
    assert plate["face 1@Body1"]["area_m2"] == 4.0
    # A run's inputs (the case writer's face areas) take the study's own geometry.
    ri = gather_run_inputs(root, run_id="r1", simulation_id="s-demo", require_mesh=False)
    assert ri.face_props["face 1@Body1"]["area_m2"] == 9.0
    # Without an id (as before): the first geometry with a face table, the plain one.
    assert set(load_face_props(root)) == {"face 1@Body1"}
