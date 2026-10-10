"""Editing a project geometry (host API 1.7): the manifest key, who may edit what, the resolver.

- ``[[geometry_actions]]``: a kind with a workspace and ``links_geometry``, one action per
  kind, label, hint and icon rules; ``formats`` and ``places`` keep what the host knows
  (``mesh`` and unknown names are warned about and left out; none left is an error).
- The tree: each geometry's ``format``, ``edit_block`` and ``edit_actions`` with the reason
  an action is off (a mesh, a missing source, updating, another study's link).
- The resolver (``geometry_actions.open``): the study that links the geometry, else the
  newest study that edits it and links nothing, else a new study titled as the geometry
  (made unique), with the host-owned ``edits_geometry`` no page can change; two calls in a
  row make one study.
- The target, the source and the face table a workspace reads.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from cfddesk.project import geometry_actions as ga
from tests.conftest import FIXTURES

EDIT_DEMO = FIXTURES / "edit-plugins" / "edit-demo"
BOX_STEP = EDIT_DEMO / "workspace" / "fixtures" / "box.step"


def _kinds(links=True, workspace="demo"):
    from cfddesk.registry.manifest import StudyKind

    return [StudyKind("demo", "Demo", "", workspace, 1, links), StudyKind("other", "Other", "", "demo", 1, True)]


# ---- the manifest ------------------------------------------------------------------------


def test_a_geometry_action_needs_a_kind_with_a_workspace_that_links():
    from cfddesk.registry.discovery import geometry_actions_from_meta

    ok, warnings = geometry_actions_from_meta({"geometry_actions": [{"study_kind": "demo", "label": "Edit in Demo"}]}, _kinds())
    assert ok[0].formats == ("step", "iges", "brep") and ok[0].places == ("tree", "viewport", "panel") and warnings == []
    for meta, kinds, words in [
        ({"study_kind": "nope", "label": "x"}, _kinds(), "not declared"),
        ({"study_kind": "demo", "label": "x"}, _kinds(links=False), "links_geometry"),
        ({"study_kind": "demo", "label": "x"}, _kinds(workspace=""), "no workspace"),
        ({"study_kind": "demo"}, _kinds(), "needs a label"),
        ({"study_kind": "demo", "label": "x" * 41}, _kinds(), "at most 40"),
        ({"study_kind": "demo", "label": "x", "hint": "h" * 121}, _kinds(), "at most 120"),
        ({"study_kind": "demo", "label": "x", "icon": "<svg/>"}, _kinds(), "one SVG path"),
        ({"study_kind": "demo", "label": "x", "formats": []}, _kinds(), "names none"),
        ({"study_kind": "demo", "label": "x", "formats": ["mesh"]}, _kinds(), "names none"),
        ({"study_kind": "demo", "label": "x", "places": ["dock"]}, _kinds(), "names none"),
        ({"study_kind": "demo", "label": "x", "places": ["tree", "tree"]}, _kinds(), "twice"),
    ]:
        with pytest.raises(ValueError) as err:
            geometry_actions_from_meta({"geometry_actions": [meta]}, kinds)
        assert words in str(err.value), (meta, str(err.value))
    with pytest.raises(ValueError) as err:
        geometry_actions_from_meta({"geometry_actions": [{"study_kind": "demo", "label": "a"}, {"study_kind": "demo", "label": "b"}]}, _kinds())
    assert "at most one per kind" in str(err.value)


def test_mesh_and_unknown_names_are_left_out_with_a_warning():
    from cfddesk.registry.discovery import geometry_actions_from_meta

    got, warnings = geometry_actions_from_meta(
        {"geometry_actions": [{"study_kind": "demo", "label": "Edit", "formats": ["step", "mesh", "parasolid"], "places": ["panel", "dock"]}]}, _kinds()
    )
    assert got[0].formats == ("step",) and got[0].places == ("panel",)
    assert len(warnings) == 3 and any("'mesh'" in w and "STEP" in w for w in warnings) and any("'dock'" in w for w in warnings)


def test_the_schema_and_the_feature_version_know_the_key():
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
    import plugin_manifest_schema as schema

    assert schema.FEATURE_API["geometry_actions"] == "1.7"
    built = schema.build_schema()
    assert built["properties"]["geometry_actions"]["x-since"] == "1.7"
    props = built["$defs"]["GeometryAction"]["properties"]
    assert props["formats"]["default"] == ["step", "iges", "brep"] and props["places"]["default"] == ["tree", "viewport", "panel"]
    errors, unknown = schema.validate({"study_kind": "demo", "label": "Edit", "formats": ["step"]}, {"$ref": "#/$defs/GeometryAction"}, built)
    assert errors == [] and unknown == []


# ---- a project with plain geometries -----------------------------------------------------


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.registry import load_all, reset_for_tests

    plugins = tmp_path / "plugins"
    shutil.copytree(EDIT_DEMO, plugins / "edit-demo")
    shutil.copytree(FIXTURES / "link-plugins" / "link-demo", plugins / "link-demo")
    projects = tmp_path / "projects"
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(projects))
    reset_for_tests()
    load_all(force=True)
    yield projects
    reset_for_tests()


def _project(projects: Path, pid="p1") -> Path:
    root = projects / pid
    root.mkdir(parents=True)
    (root / "project.json").write_text(json.dumps({"id": pid, "title": pid, "geometries": []}), encoding="utf-8")
    return root


def _plain(root: Path, gid="geom-box", name="box", filename="box.step", kind="step", faces=6, with_step=True, sidecar=False) -> Path:
    gdir = root / "geometries" / f"Geometry_{name}"
    (gdir / "simulations").mkdir(parents=True)
    (gdir / "id.json").write_text(json.dumps({"id": gid, "name": name, "original_filename": filename, "kind": "geometry"}), encoding="utf-8")
    if with_step:
        shutil.copyfile(BOX_STEP, gdir / "source.step")
    if sidecar:
        (gdir / "source.bbrep").write_bytes(b"x" * 64)
    rows = [{"id": i, "body": 1, "area": 400.0, "centroid": [10.0, 10.0, float(i)], "normal": [0.0, 0.0, 1.0], "surface_type": "Plane"} for i in range(1, faces + 1)]
    (gdir / "cad_preview.json").write_text(json.dumps({"n_solids": 1, "faces": rows, "bounds": {"xmin": 0, "xmax": 20, "ymin": 0, "ymax": 20, "zmin": 0, "zmax": 20}}), encoding="utf-8")
    proj = json.loads((root / "project.json").read_text(encoding="utf-8"))
    proj["geometries"].append({"id": gid, "name": name, "original_filename": filename, "source_kind": kind})
    (root / "project.json").write_text(json.dumps(proj), encoding="utf-8")
    return gdir


def _act(node: dict, plugin: str = "edit-demo") -> dict:
    """The node's action of one plugin (bundled plugins may add their own)."""
    return next(a for a in node["edit_actions"] if a["plugin"] == plugin)


def _open(root: Path, gid: str, plugin: str = "edit-demo", kind: str = "demo") -> dict:
    from cfddesk.registry import load_all
    from cfddesk.worker.methods import _plugin_study_catalog

    studies, kinds = _plugin_study_catalog(root, root.name)
    return ga.open_action(root, gid, plugin, kind, studies, kinds, load_all().manifests.get(plugin))


def _node(pid: str, gid: str) -> dict:
    from cfddesk.worker import methods

    return next(g for g in methods.project_tree(project_id=pid)["geometries"] if g["id"] == gid)


def test_the_tree_says_what_may_be_edited_and_why_not(env: Path):
    root = _project(env)
    _plain(root)
    _plain(root, "geom-stl", "mesh", "part.stl", "mesh")
    _plain(root, "geom-gone", "lost", "lost.step", with_step=False)
    _plain(root, "geom-igs", "pipe", "pipe.igs", "iges", with_step=False, sidecar=True)
    box = _node("p1", "geom-box")
    assert (box["format"], box["edit_block"]) == ("step", "")
    act = next(a for a in box["edit_actions"] if a["plugin"] == "edit-demo")
    assert (act["enabled"], act["reason"], act["label"], act["places"]) == (True, "", "Edit in Demo", ["tree", "viewport", "panel"])
    # link-demo declares no geometry action: no entry.
    assert "link-demo" not in {a["plugin"] for a in box["edit_actions"]}
    stl = _act(_node("p1", "geom-stl"))
    assert stl["enabled"] is False
    assert stl["reason"] == "mesh is a mesh (STL); Edit in Demo needs a STEP, IGES or BREP part."
    gone = _node("p1", "geom-gone")
    assert gone["edit_block"] == "The source file of lost is missing." and _act(gone)["reason"] == gone["edit_block"]
    # An IGES with no STEP (only a mesh import defers its STEP): missing, blocked, never "wait".
    igs = _node("p1", "geom-igs")
    assert igs["edit_block"] == "The source file of pipe is missing." and _act(igs)["enabled"] is False
    (root / "geometries" / "Geometry_box" / "link").mkdir()
    (root / "geometries" / "Geometry_box" / "link" / "commit.json").write_text("{}", encoding="utf-8")
    assert _act(_node("p1", "geom-box"))["reason"] == "box is updating."


def test_a_geometry_another_plugin_links_is_edited_there(env: Path):
    from cfddesk.registry.plugin_data import PluginData

    root = _project(env)
    demo = PluginData(root, "link-demo").create_study("demo", "Design 1", plugin_name="Link demo", plugin_version="1.0.0", schema_version=1)
    gdir = root / "geometries" / "Geometry_linked"
    (gdir / "link").mkdir(parents=True)
    (gdir / "id.json").write_text(
        json.dumps({"id": "geom-l", "name": "Design 1", "kind": "geometry", "source": {"type": "plugin_study", "plugin": "link-demo", "study_id": demo["id"], "workspace": "demo"}}),
        encoding="utf-8",
    )
    (gdir / "source.bbrep").write_bytes(b"x")
    (gdir / "link" / "state.json").write_text(json.dumps({"rev": 1, "name": "Design 1", "shape_sha256": "a" * 64}), encoding="utf-8")
    node = _node("p1", "geom-l")
    assert node["format"] == "brep"
    assert _act(node)["reason"] == "Design 1 comes from Design 1 (Link demo). Edit it there."
    with pytest.raises(ga.ActionError) as err:
        _open(root, "geom-l")
    assert err.value.code == "not_editable"


def test_the_resolver_creates_once_then_opens_the_same_study(env: Path):
    from cfddesk.registry.plugin_data import PluginData
    from cfddesk.worker import link_methods

    root = _project(env)
    _plain(root)
    first = link_methods.geometry_actions_open("p1", "geom-box", "edit-demo", "demo")
    assert (first["ok"], first["created"], first["workspace"], first["title"]) == (True, True, "demo", "box")
    # Two calls in a row (two tabs, the main lane runs them one after the other): one study.
    again = link_methods.geometry_actions_open("p1", "geom-box", "edit-demo", "demo")
    assert (again["study_id"], again["created"]) == (first["study_id"], False)
    data = PluginData(root, "edit-demo")
    rec = data.study(first["study_id"])
    assert rec["edits_geometry"]["id"] == "geom-box" and rec["edits_geometry"]["name"] == "box" and rec["rev"] == 1
    assert len(data.studies()) == 1
    # A page cannot change edits_geometry.
    from cfddesk.worker import methods

    methods.plugin_studies_update("p1", "edit-demo", first["study_id"], 1, {"edits_geometry": {"id": "geom-other"}, "x": 1})
    assert data.study(first["study_id"])["edits_geometry"]["id"] == "geom-box"
    # A second geometry with the same name gets a unique study title.
    gdir2 = root / "geometries" / "Geometry_box_2"
    shutil.copytree(root / "geometries" / "Geometry_box", gdir2)
    (gdir2 / "id.json").write_text(json.dumps({"id": "geom-box2", "name": "box", "original_filename": "box.step", "kind": "geometry"}), encoding="utf-8")
    other = link_methods.geometry_actions_open("p1", "geom-box2", "edit-demo", "demo")
    assert (other["created"], other["title"]) == (True, "box (2)")


def test_the_resolver_prefers_the_study_that_links_then_the_newest_editor(env: Path):
    from cfddesk.registry.plugin_data import PluginData

    root = _project(env)
    gdir = _plain(root)
    data = PluginData(root, "edit-demo")
    old = data.create_study("demo", "Old", plugin_name="Edit demo", plugin_version="1.0.0", schema_version=1)
    old["edits_geometry"] = {"id": "geom-box", "name": "box", "at": "2026-10-01T00:00:00Z"}
    old["created_at"] = "2026-10-01T00:00:00Z"
    data.write_json(f"studies/{old['id']}/study.json", old)
    new = data.create_study("demo", "New", plugin_name="Edit demo", plugin_version="1.0.0", schema_version=1)
    new["edits_geometry"] = {"id": "geom-box", "name": "box", "at": "2026-10-02T00:00:00Z"}
    new["created_at"] = "2026-10-02T00:00:00Z"
    data.write_json(f"studies/{new['id']}/study.json", new)
    assert _open(root, "geom-box")["study_id"] == new["id"]
    # After the adoption the geometry is linked to Old: Old opens (rule 1).
    (gdir / "link").mkdir(exist_ok=True)
    ident = json.loads((gdir / "id.json").read_text(encoding="utf-8"))
    ident["source"] = {"type": "plugin_study", "plugin": "edit-demo", "study_id": old["id"], "workspace": "demo", "adopted": True}
    (gdir / "id.json").write_text(json.dumps(ident), encoding="utf-8")
    (gdir / "source.bbrep").write_bytes(b"x")
    (gdir / "link" / "state.json").write_text(json.dumps({"rev": 1, "name": "box", "shape_sha256": "a" * 64}), encoding="utf-8")
    assert _open(root, "geom-box")["study_id"] == old["id"]


def test_an_adopted_geometry_whose_study_was_deleted_points_to_its_original(env: Path):
    from cfddesk.registry.plugin_data import PluginData

    root = _project(env)
    gdir = _plain(root)
    gone = PluginData(root, "edit-demo").create_study("demo", "Gone", plugin_name="Edit demo", plugin_version="1.0.0", schema_version=1)
    ident = json.loads((gdir / "id.json").read_text(encoding="utf-8"))
    ident["source"] = {"type": "plugin_study", "plugin": "edit-demo", "study_id": gone["id"], "workspace": "demo", "adopted": True}
    (gdir / "id.json").write_text(json.dumps(ident), encoding="utf-8")
    (gdir / "link" / "original").mkdir(parents=True)
    (gdir / "source.step").rename(gdir / "link" / "original" / "source.step")
    (gdir / "source.bbrep").write_bytes(b"x")
    adopted = {"at": "x", "from": {"format": "step", "file_name": "box.step", "sha256": "a" * 64}}
    (gdir / "link" / "state.json").write_text(json.dumps({"rev": 1, "name": "box", "adopted": adopted}), encoding="utf-8")
    ga.write_original(gdir, adopted, 6, 1)
    shutil.rmtree(root / "plugins" / "edit-demo" / "studies" / gone["id"])
    reason = _act(_node("p1", "geom-box"))["reason"]
    assert reason == (
        "box came from a study that was deleted. To edit it again, add its original (box.step) as a new geometry: "
        "Geometry panel, Add the original as a new geometry."
    )
    # Without the kept original the reason says there is no STEP.
    (gdir / "link" / "original" / "source.step").unlink()
    assert _act(_node("p1", "geom-box"))["reason"] == "box came from a study that was deleted, and has no STEP file to open."


def test_a_study_editing_a_plain_geometry_shows_on_its_row_not_in_studies(env: Path):
    from cfddesk.worker import link_methods, methods

    root = _project(env)
    _plain(root)
    sid = link_methods.geometry_actions_open("p1", "geom-box", "edit-demo", "demo")["study_id"]
    tree = methods.project_tree(project_id="p1")
    node = next(g for g in tree["geometries"] if g["id"] == "geom-box")
    assert [(s["id"], s["title"], s["workspace"]) for s in node["edited_in"]] == [(sid, "box", "demo")]
    row = next(s for s in tree["plugin_studies"] if s["id"] == sid)
    assert (row["edits_geometry"], row["editing"]) == ("geom-box", "geom-box")


def test_refusals_of_the_resolver(env: Path):
    root = _project(env)
    _plain(root, "geom-stl", "mesh", "part.stl", "mesh")
    for gid, plugin, kind, code in [
        ("geom-nope", "edit-demo", "demo", "gone"),
        ("geom-stl", "edit-demo", "demo", "not_editable"),
        ("geom-stl", "link-demo", "demo", "plugin_off"),
        ("geom-stl", "edit-demo", "nope", "plugin_off"),
    ]:
        with pytest.raises(ga.ActionError) as err:
            _open(root, gid, plugin, kind)
        assert err.value.code == code, (gid, plugin, kind)


def test_the_target_the_source_and_the_faces_a_page_reads(env: Path):
    from cfddesk.worker import link_methods

    root = _project(env)
    gdir = _plain(root)
    sid = link_methods.geometry_actions_open("p1", "geom-box", "edit-demo", "demo")["study_id"]
    target = link_methods.geometry_edit_target("p1", "edit-demo", sid)["geometry"]
    assert target == {"id": "geom-box", "name": "box", "format": "step", "fileName": "box.step", "linked": False, "rev": 0, "bodies": 1, "faces": 6}
    src = link_methods.geometry_source_path("p1", "edit-demo", sid)
    import hashlib

    want = hashlib.sha256(BOX_STEP.read_bytes()).hexdigest()
    assert (src["ok"], src["sha256"], src["file_name"], src["adopted"], src["size"]) == (True, want, "box.step", False, BOX_STEP.stat().st_size)
    assert Path(src["path"]) == gdir / "source.step"
    # The hash is kept beside it, by size and mtime; a read makes no link/ folder.
    assert json.loads((gdir / ".source-sha256.json").read_text(encoding="utf-8"))["files"][0]["sha256"] == want
    assert not (gdir / "link").exists()
    # A BC on face 6 and a material on Body1 are the faces' uses.
    sdir = gdir / "simulations" / "Study_1"
    sdir.mkdir()
    (sdir / "id.json").write_text(json.dumps({"id": "sim-1", "name": "Study 1", "geometry_id": "geom-box"}), encoding="utf-8")
    (sdir / "boundary_conditions" / "BC_Inlet").mkdir(parents=True)
    (sdir / "boundary_conditions" / "BC_Inlet" / "bc.json").write_text(json.dumps({"id": "bc-1", "name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 6@Body1"]}), encoding="utf-8")
    faces = link_methods.geometry_faces_table("p1", "edit-demo", sid)
    assert (faces["ok"], faces["geometryId"], faces["rev"], faces["sourceSha256"], len(faces["faces"])) == (True, "geom-box", 0, want, 6)
    six = faces["faces"][5]
    assert (six["label"], six["body"], six["uses"]) == ("face 6@Body1", 1, [{"studyId": "sim-1", "studyTitle": "Study 1", "kind": "bc", "item": "Inlet"}])
    assert faces["bodies"] == [{"index": 1, "ref": "Body1", "id": None, "name": None}]
    # Refusals: a study that edits nothing; a source still being stored; a removed geometry.
    from cfddesk.registry.plugin_data import PluginData

    bare = PluginData(root, "edit-demo").create_study("demo", "Bare", plugin_name="Edit demo", plugin_version="1.0.0", schema_version=1)
    assert link_methods.geometry_edit_target("p1", "edit-demo", bare["id"])["geometry"] is None
    assert link_methods.geometry_source_path("p1", "edit-demo", bare["id"])["code"] == "not_allowed"
    # No face table yet (the preview is built when the geometry is shown): not_ready, never an empty table.
    (gdir / "cad_preview.json").rename(gdir / "held.json")
    nf = link_methods.geometry_faces_table("p1", "edit-demo", sid)
    assert (nf["code"], nf["retryAfter"]) == ("not_ready", ga.RETRY_AFTER_S)
    assert nf["error"] == "Magnusim has not read the faces of box yet. Show box in the viewport, then try again."
    (gdir / "held.json").rename(gdir / "cad_preview.json")
    # A STEP that is gone (a sidecar left): no_source, not a wait.
    (gdir / "source.step").rename(gdir / "held.step")
    (gdir / "source.bbrep").write_bytes(b"x" * 64)
    nr = link_methods.geometry_source_path("p1", "edit-demo", sid)
    assert (nr["code"], nr["error"], "retryAfter" in nr) == ("no_source", "The source file of box is missing.", False)
    (gdir / "held.step").rename(gdir / "source.step")
    # Another study took it over: "already edited in".
    ident = json.loads((gdir / "id.json").read_text(encoding="utf-8"))
    (gdir / "id.json").write_text(
        json.dumps({**ident, "source": {"type": "plugin_study", "plugin": "edit-demo", "study_id": bare["id"], "workspace": "demo"}}), encoding="utf-8"
    )
    (gdir / "link").mkdir(exist_ok=True)
    (gdir / "link" / "state.json").write_text(json.dumps({"rev": 1, "name": "box"}), encoding="utf-8")
    taken = link_methods.geometry_source_path("p1", "edit-demo", sid)
    assert (taken["code"], taken["error"]) == ("adopted", "box is already edited in Bare.")
    (gdir / "link" / "state.json").unlink()
    (gdir / "id.json").write_text(json.dumps(ident), encoding="utf-8")
    (gdir / "id.json").unlink()
    assert link_methods.geometry_source_path("p1", "edit-demo", sid)["code"] == "gone"
