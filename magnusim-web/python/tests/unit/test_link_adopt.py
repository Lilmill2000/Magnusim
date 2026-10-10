"""The adoption (host API 1.7): a study that edits a plain geometry takes it over with its first link.

- ``geometry.link_check`` answers the plain geometry as the study's, at a rev 0 of its own
  (``adopt``), or refuses ``adopted`` when another study took it over meanwhile; a removed
  geometry makes the link a create.
- ``geometry.plan`` (``adopt``) maps the records from the named original table to the new
  shape: a boundary condition follows its face by name; the geometry keeps its id and name.
- ``geometry.apply`` writes ``link/original/original.json``, then ``id.json``'s source
  (``adopted``), then ``state.json`` (the commit point, with ``adopted``); a second apply
  (the recovery's replay) gives the same files.
- After it: the stamp check refuses a save drawn on the plain geometry; "Save as new"
  starts at v2 and leaves the plain geometry plain.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from cfddesk.project import geometry_actions as ga
from cfddesk.project import link
from tests.conftest import FIXTURES

EDIT_DEMO = FIXTURES / "edit-plugins" / "edit-demo"
FX = EDIT_DEMO / "workspace" / "fixtures"


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.registry import load_all, reset_for_tests

    plugins = tmp_path / "plugins"
    shutil.copytree(EDIT_DEMO, plugins / "edit-demo")
    projects = tmp_path / "projects"
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(projects))
    reset_for_tests()
    load_all(force=True)
    yield projects
    reset_for_tests()


SIDES = ["-x", "+x", "-y", "+y", "-z", "+z"]
NORMALS = {"-x": [-1, 0, 0], "+x": [1, 0, 0], "-y": [0, -1, 0], "+y": [0, 1, 0], "-z": [0, 0, -1], "+z": [0, 0, 1]}


def _rows(height: float, names: bool) -> list[dict]:
    cent = {"-x": [0, 10, height / 2], "+x": [20, 10, height / 2], "-y": [10, 0, height / 2], "+y": [10, 20, height / 2], "-z": [10, 10, 0], "+z": [10, 10, height]}
    area = {"-x": 20 * height, "+x": 20 * height, "-y": 20 * height, "+y": 20 * height, "-z": 400.0, "+z": 400.0}
    out = []
    for i, s in enumerate(SIDES, start=1):
        row = {"id": i, "body": 1, "area": float(area[s]), "centroid": [float(c) for c in cent[s]], "normal": NORMALS[s], "surface_type": "Plane"}
        if names:
            row["name"] = f"F:box:{s}"
            row["label"] = f"Box {s}"
        out.append(row)
    return out


def _setup(env: Path) -> tuple[Path, Path, str, Path]:
    from cfddesk.worker import link_methods

    root = env / "p1"
    root.mkdir(parents=True)
    (root / "project.json").write_text(json.dumps({"id": "p1", "title": "p1", "geometries": [{"id": "geom-box", "name": "box", "original_filename": "box.step", "source_kind": "step"}]}), encoding="utf-8")
    gdir = root / "geometries" / "Geometry_box"
    (gdir / "simulations").mkdir(parents=True)
    (gdir / "id.json").write_text(json.dumps({"id": "geom-box", "name": "box", "original_filename": "box.step", "kind": "geometry"}), encoding="utf-8")
    shutil.copyfile(FX / "box.step", gdir / "source.step")
    bounds = {"xmin": 0, "xmax": 20, "ymin": 0, "ymax": 20, "zmin": 0, "zmax": 20}
    (gdir / "cad_preview.json").write_text(json.dumps({"n_solids": 1, "faces": _rows(20, False), "bounds": bounds}), encoding="utf-8")
    sid = link_methods.geometry_actions_open("p1", "geom-box", "edit-demo", "demo")["study_id"]
    sdir = gdir / "simulations" / "Study_1"
    sdir.mkdir()
    (sdir / "id.json").write_text(json.dumps({"id": "sim-1", "name": "Study 1", "geometry_id": "geom-box"}), encoding="utf-8")
    for name, face in (("Inlet", "face 6@Body1"), ("Wall", "face 5@Body1")):
        (sdir / "boundary_conditions" / f"BC_{name}").mkdir(parents=True)
        (sdir / "boundary_conditions" / f"BC_{name}" / "bc.json").write_text(
            json.dumps({"id": f"bc-{name.lower()}", "name": name, "bc_type": "Velocity inlet", "faces": [face]}), encoding="utf-8"
        )
    return root, gdir, sid, sdir


def _stage(root: Path, gid: str, sid: str, names: bool | str = True, top_inside: bool = False) -> str:
    """The link job's staging of an adoption: job.json, the preview of the pulled box, the names, the map."""
    import sys

    stage = root / ".magnusim-staging" / "link-gl-1"
    (stage / "in").mkdir(parents=True)
    (stage / "new").mkdir()
    (stage / "job.json").write_text(
        json.dumps({"job": "gl-1", "op": "update", "plugin": "edit-demo", "study_id": sid, "workspace": "demo", "source_version": 2, "name": "box", "shape_sha256": "b" * 64, "names_file_sha256": None, "adopt": True}),
        encoding="utf-8",
    )
    (stage / "preview.json").write_text(json.dumps({"ok": True, "n_solids": 1, "n_faces": 6, "bodies": [{"index": 1, "ref": "Body1", "id": "b1", "name": "Box"}], "names_sha256": "c" * 64}), encoding="utf-8")
    bounds = {"xmin": 0, "xmax": 20, "ymin": 0, "ymax": 20, "zmin": 0, "zmax": 30}
    new_rows = _rows(30, True)
    if top_inside:
        # The new top is shared with another body (a fluid enclosure kept the tool): inside the part.
        new_rows[5]["shared_with"] = 12
    (stage / "new" / "cad_preview.json").write_text(json.dumps({"n_solids": 1, "faces": new_rows, "bounds": bounds, "body_info": [{"ref": "Body1", "id": "b1", "name": "Box"}]}), encoding="utf-8")
    if names:
        shutil.copyfile(FX / (names if isinstance(names, str) else "box.original_names.json"), stage / "in" / "original_names")
    rel = ".magnusim-staging/link-gl-1"
    ga.adopt_names(root, gid, rel)
    # The link job's journal makes the geometry's link/ folder before the apply.
    (root / "geometries" / "Geometry_box" / "link").mkdir(exist_ok=True)
    # The map the link job makes (scripts/geometry-face-match.js linkFaceMap): by name, then by shape.
    old = json.loads((stage / "old_named.json").read_text(encoding="utf-8"))
    new = json.loads((stage / "new" / "cad_preview.json").read_text(encoding="utf-8"))
    faces = {}
    for o in old["faces"]:
        hit = [n for n in new["faces"] if o.get("name") and n.get("name") == o.get("name")]
        if not hit:
            hit = [n for n in new["faces"] if n["centroid"] == o["centroid"] and n["area"] == o["area"]]
        if hit:
            faces[str(o["id"])] = [f"face {hit[0]['id']}@Body1"]
    (stage / "map.json").write_text(json.dumps({"faces": faces, "groups": {}, "body_map": {"Body1": "Body1"}, "report": {}}), encoding="utf-8")
    assert sys
    return rel


def test_link_check_answers_the_plain_geometry_for_its_first_link(env: Path):
    from cfddesk.worker import link_methods

    root, gdir, sid, _sdir = _setup(env)
    got = link_methods.geometry_link_check("p1", "edit-demo", sid)
    geom = got["geometry"]
    assert (got["ok"], geom["id"], geom["adopt"], geom["state"]["rev"], geom["state"]["n_faces"]) == (True, "geom-box", True, 0, 6)
    assert geom["state"]["shape_sha256"] == json.loads((FX / "box.original_names.json").read_text())["shape_sha256"]
    assert got["adopt_refused"] is None
    # Another study took it over meanwhile: refused.
    ident = json.loads((gdir / "id.json").read_text(encoding="utf-8"))
    ident["source"] = {"type": "plugin_study", "plugin": "edit-demo", "study_id": "st-other", "workspace": "demo"}
    (gdir / "id.json").write_text(json.dumps(ident), encoding="utf-8")
    (gdir / "link").mkdir(exist_ok=True)
    (gdir / "source.bbrep").write_bytes(b"x")
    (gdir / "link" / "state.json").write_text(json.dumps({"rev": 1, "name": "box"}), encoding="utf-8")
    got = link_methods.geometry_link_check("p1", "edit-demo", sid)
    assert got["geometry"] is None and got["adopt_refused"]["code"] == "adopted"
    assert got["adopt_refused"]["error"] == "box is already edited in another study."
    # Removed: the link is a create.
    shutil.rmtree(gdir)
    got = link_methods.geometry_link_check("p1", "edit-demo", sid)
    assert got["geometry"] is None and got["adopt_refused"] is None


def test_plan_and_apply_adopt_the_geometry_and_carry_the_bcs_by_name(env: Path):
    root, gdir, sid, sdir = _setup(env)
    rel = _stage(root, "geom-box", sid)
    planned = link.plan(root, "geom-box", rel, 0, False, adopt=True)
    assert (planned["change"], planned["rev"], planned["from_rev"]) == ("shape", 1, 0)
    # The swap of the link job keeps the source files in link/original/.
    (gdir / "link" / "original").mkdir(parents=True)
    shutil.move(str(gdir / "source.step"), str(gdir / "link" / "original" / "source.step"))
    (gdir / "source.bbrep").write_bytes(b"new shape")
    applied = link.apply(root, "geom-box", rel)
    assert applied["rev"] == 1
    state = link.read_state(gdir)
    assert (state["rev"], state["name"], state["version"], state["source_version"], state["job_id"]) == (1, "box", 1, 2, "gl-1")
    assert state["adopted"]["from"]["file_name"] == "box.step" and state["adopted"]["from"]["format"] == "step"
    assert "adopt" not in state and "source_ready" not in state
    ident = json.loads((gdir / "id.json").read_text(encoding="utf-8"))
    assert ident["source"]["plugin"] == "edit-demo" and ident["source"]["study_id"] == sid and ident["source"]["adopted"] is True
    assert ident["original_filename"] == "box.step" and ident["id"] == "geom-box"
    orig = json.loads((gdir / "link" / "original" / "original.json").read_text(encoding="utf-8"))
    assert (orig["file_name"], orig["format"], orig["faces"], orig["bodies"]) == ("box.step", "step", 6, 1)
    assert orig["sha256"] == state["adopted"]["from"]["sha256"]
    # Inlet followed the top by name (face 6), the wall stayed on the bottom; both stamped rev 1.
    inlet = json.loads((sdir / "boundary_conditions" / "BC_Inlet" / "bc.json").read_text(encoding="utf-8"))
    wall = json.loads((sdir / "boundary_conditions" / "BC_Wall" / "bc.json").read_text(encoding="utf-8"))
    assert (inlet["faces"], inlet["geometry_rev"], inlet.get("lost_faces")) == (["face 6@Body1"], 1, [])
    assert (wall["faces"], wall["geometry_rev"]) == (["face 5@Body1"], 1)
    # It is now this study's linked geometry.
    assert link.find_linked(root, "edit-demo", sid)["id"] == "geom-box"
    target = ga.edit_target(root, "edit-demo", sid)["row"]
    assert (target["linked"], target["format"], target["rev"], target["fileName"]) == (True, "brep", 1, "box.step")
    src = ga.source_info(root, "edit-demo", sid)
    assert src["adopted"] is True and Path(src["path"]) == gdir / "link" / "original" / "source.step"
    # The recovery's replay gives the same files.
    before = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in (gdir / "link").glob("*.json")}
    link.apply(root, "geom-box", rel)
    after = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in (gdir / "link").glob("*.json")}
    assert before.keys() == after.keys()
    assert json.loads((gdir / "link" / "original" / "original.json").read_text(encoding="utf-8")) == orig
    # A save drawn on the plain geometry (no stamp, or rev 0) is refused now.
    with pytest.raises(link.LinkError) as err:
        link.check_save(root, "sim-1", [{"id": "bc-x", "faces": ["face 1@Body1"]}])
    assert err.value.code == "geometry_changed"
    assert link.check_save(root, "sim-1", [{"geometry_rev": 1}]) == 1


def test_without_original_names_a_moved_face_is_lost(env: Path):
    root, gdir, sid, sdir = _setup(env)
    rel = _stage(root, "geom-box", sid, names=False)
    link.plan(root, "geom-box", rel, 0, False, adopt=True)
    link.apply(root, "geom-box", rel)
    inlet = json.loads((sdir / "boundary_conditions" / "BC_Inlet" / "bc.json").read_text(encoding="utf-8"))
    wall = json.loads((sdir / "boundary_conditions" / "BC_Wall" / "bc.json").read_text(encoding="utf-8"))
    assert inlet["faces"] == [] and inlet["lost_faces"][0]["old"] == "face 6@Body1"
    assert wall["faces"] == ["face 5@Body1"]


def test_a_row_naming_the_wrong_face_never_moves_its_bc_onto_that_face(env: Path):
    """The top's row names the -x face: that name is dropped, the top follows by shape (it moved: lost)."""
    root, gdir, sid, sdir = _setup(env)
    rel = _stage(root, "geom-box", sid, names="box.one_wrong_names.json")
    link.plan(root, "geom-box", rel, 0, False, adopt=True)
    link.apply(root, "geom-box", rel)
    inlet = json.loads((sdir / "boundary_conditions" / "BC_Inlet" / "bc.json").read_text(encoding="utf-8"))
    wall = json.loads((sdir / "boundary_conditions" / "BC_Wall" / "bc.json").read_text(encoding="utf-8"))
    # Not on face 1 (the -x face the wrong row named): lost, and listed with its old label.
    assert inlet["faces"] == [] and [e["old"] for e in inlet["lost_faces"]] == ["face 6@Body1"]
    assert wall["faces"] == ["face 5@Body1"]


def test_a_bc_now_on_an_inside_face_is_reported(env: Path):
    root, gdir, sid, sdir = _setup(env)
    rel = _stage(root, "geom-box", sid, top_inside=True)
    planned = link.plan(root, "geom-box", rel, 0, False, adopt=True)
    inside = planned["report"]["setup"]["inside"]
    assert inside == [{"studyId": "sim-1", "studyTitle": "Study 1", "kind": "bc", "item": "Inlet", "faces": ["face 6@Body1"], "bodies": 2}]


def test_plan_refuses_an_adoption_of_a_geometry_taken_over_or_with_no_named_table(env: Path):
    root, gdir, sid, _sdir = _setup(env)
    rel = _stage(root, "geom-box", sid)
    (root / rel / "old_named.json").unlink()
    with pytest.raises(link.LinkError) as err:
        link.plan(root, "geom-box", rel, 0, False, adopt=True)
    assert err.value.code == "failed"
    (gdir / "link").mkdir(exist_ok=True)
    (gdir / "link" / "state.json").write_text(json.dumps({"rev": 1}), encoding="utf-8")
    with pytest.raises(link.LinkError) as err:
        link.plan(root, "geom-box", rel, 0, False, adopt=True)
    assert err.value.code == "stale"


def test_save_as_new_of_an_adoption_starts_at_v2_and_leaves_the_original_plain(env: Path):
    root, gdir, sid, _sdir = _setup(env)
    assert link.next_version(root, "edit-demo", sid, "box", 2) == {"version": 2, "name": "box v2"}
    assert link.next_version(root, "edit-demo", sid, "box") == {"version": 1, "name": "box"}
    # link_commit of the new geometry never marks the plain one (even with a link/ folder of hashes).
    new = root / "geometries" / "Geometry_box_v2"
    (new / "link").mkdir(parents=True)
    (new / "id.json").write_text(json.dumps({"id": "geom-new", "name": "box v2", "source": {"type": "plugin_study", "plugin": "edit-demo", "study_id": sid}}), encoding="utf-8")
    (new / "source.bbrep").write_bytes(b"x")
    (new / "link" / "state.json").write_text(json.dumps({"rev": 1, "version": 2, "name": "box v2"}), encoding="utf-8")
    (new / "link" / "pending.json").write_text(json.dumps({"job_id": "gl-1"}), encoding="utf-8")
    ga.file_sha256(gdir / "source.step", gdir)
    assert (gdir / ".source-sha256.json").is_file()
    (gdir / "link").mkdir(exist_ok=True)
    link.link_commit(root, "geom-new", "geom-box", "gl-1")
    assert not (gdir / "link" / "unlinked.json").exists()
    assert ga.linked_state(next(g for g in __import__("cfddesk.project.paths", fromlist=["walk_geometries"]).walk_geometries(root) if g["id"] == "geom-box")) is None


def test_the_repair_record_of_an_adopted_geometry_keeps_its_file_name(env: Path):
    root, gdir, sid, _sdir = _setup(env)
    rel = _stage(root, "geom-box", sid)
    link.plan(root, "geom-box", rel, 0, False, adopt=True)
    link.apply(root, "geom-box", rel)
    geom = link.find_linked(root, "edit-demo", sid)
    rec = link.geometry_record("p1", geom, geom["state"])
    assert (rec["original_filename"], rec["source_kind"], rec["note"]) == ("box.step", "plugin", "Edited in a plugin study.")
