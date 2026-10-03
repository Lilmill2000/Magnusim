"""Linked geometries (host API 1.5), L2 step 4: the host's question and "Save as new".

LINK proposal revision 7, section 5.0. The main-lane parts:

- ``geometry.usage``: which simulation studies on a geometry have saved setup (a BC, a
  material, a result control, a refinement in any mesh, a generated mesh, a run that is
  not a draft), so a shape change asks; a study left with its defaults does not count;
- ``next_version``: "<base> v<k>" from the folders a study's link made, past a name taken;
- ``link_commit``: the new geometry's commit point (``link/pending.json`` goes), then the
  old geometry's ``link/unlinked.json``, then ``project.json``; the repair keeps the newest;
- the copy (gate:l2-copy): ``geometry.plan`` with ``studies``, ``rev`` and ``map_from`` and
  ``geometry.apply`` with ``plan-copy.json`` rewrite a copied study's records onto the new
  geometry through the link's own map (a two-solid part, by name and body id), and never
  touch the source study or either geometry's link state.
"""

from __future__ import annotations

import importlib
import json
import shutil
from pathlib import Path

import pytest

from cfddesk.project import link
from tests.unit import test_link_labels as _labels
from tests.unit.test_link_labels import BC, SCHEMA, Proj, _full_study, _jr, _write, node_map

# The v1, v2 and v3 previews (the link job's own process), shared with test_link_labels.
previews = _labels.previews

pytestmark = pytest.mark.occt

KNOWN = {"bc": {"velocity_inlet_fixed", "wall_noslip", "pressure_fixed", "demo_porous"}, "monitor": {"area_average"}, "mesher": {"standard"}}


def _geometry(root: Path, gid: str, *, plugin="link-demo", sid="st-1", version=1, name="Demo 1", linked_at="2026-10-01T00:00:00Z", rev=1, unlinked=False, pending=None) -> Path:
    gdir = root / "geometries" / f"Geometry_{gid}"
    (gdir / "link").mkdir(parents=True)
    (gdir / "simulations").mkdir()
    _write(gdir / "id.json", {"id": gid, "name": name, "kind": "geometry",
                              "source": {"type": "plugin_study", "plugin": plugin, "study_id": sid, "workspace": "demo", "linked_at": linked_at}})
    (gdir / "source.bbrep").write_bytes(b"x")
    _write(gdir / "link" / "state.json", {"rev": rev, "version": version, "source_version": 1, "name": name, "shape_sha256": "a" * 64, "job_id": f"gl-{gid}"})
    if unlinked:
        _write(gdir / "link" / "unlinked.json", {"moved_to": "x"})
    if pending:
        _write(gdir / "link" / "pending.json", {"job_id": pending})
    return gdir


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "projects" / "p1"
    root.mkdir(parents=True)
    _write(root / "project.json", {"id": "p1", "title": "p1", "geometries": []})
    return root


def _study(gdir: Path, sid="sim-1", name="Study 1") -> Path:
    sdir = gdir / "simulations" / name.replace(" ", "_")
    _write(sdir / "id.json", {"id": sid, "name": name, "geometry_id": json.loads((gdir / "id.json").read_text())["id"], "kind": "simulation"})
    # What a new study is seeded with (seedStudyDefaults): empty lists.
    _write(sdir / "materials.json", {"simulation_id": sid, "materials": [], "air": None})
    _write(sdir / "boundary_conditions.json", {"simulation_id": sid, "boundary_conditions": [], "defaults_by_simulation": {sid: {"wall_type": "No-slip"}}})
    _write(sdir / "result_controls.json", {"simulation_id": sid, "result_controls": [], "area_average_1": None})
    _write(sdir / "simulation_control.json", {"simulation_id": sid})
    return sdir


# ---- geometry.usage -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "kind",
    ["bc", "material", "result_control", "refinement", "mesh", "run"],
)
def test_usage_counts_each_kind_of_saved_setup_alone(tmp_path: Path, kind: str):
    root = _project(tmp_path)
    g = _geometry(root, "geom-1")
    s = _study(g)
    assert link.usage(root, "geom-1", KNOWN)["studies"] == [], "defaults only: not in use"
    if kind == "bc":
        _write(s / BC / "BC_Wall" / "bc.json", {"id": "bc-1", "name": "Wall", "bc_type": "Wall", "faces": []})
    elif kind == "material":
        _write(s / "materials" / "Material_Air" / "material.json", {"id": "m-1", "name": "Air"})
    elif kind == "result_control":
        _write(s / "result_controls" / "RC_1" / "result_control.json", {"id": "rc-1", "name": "Avg", "kind": "area_average", "faces": []})
    elif kind == "refinement":
        _write(s / "meshes" / "Mesh_1" / "id.json", {"id": "mesh-1", "name": "Mesh 1", "kind": "mesh"})
        _write(s / "meshes" / "Mesh_1" / "mesh.json", {"id": "mesh-1", "generated": False})
        _write(s / "meshes" / "Mesh_1" / "refinements" / "Ref_1" / "refinement.json", {"id": "ref-1", "faces": []})
    elif kind == "mesh":
        _write(s / "meshes" / "Mesh_1" / "id.json", {"id": "mesh-1", "name": "Mesh 1", "kind": "mesh"})
        _write(s / "meshes" / "Mesh_1" / "mesh.json", {"id": "mesh-1", "generated": True})
    else:
        _write(s / "simulation_runs" / "Run_1" / "id.json", {"id": "run-1", "name": "Run 1", "kind": "run"})
        _write(s / "simulation_runs" / "Run_1" / "run.json", {"id": "run-1", "status": "finished"})
    use = link.usage(root, "geom-1", KNOWN)
    assert [(st["id"], st["setup"], st["unknown"]) for st in use["studies"]] == [("sim-1", [kind], [])]
    assert use["last"] == "sim-1"


def test_usage_ignores_draft_meshes_and_runs_and_names_the_study_shown_last(tmp_path: Path):
    root = _project(tmp_path)
    g = _geometry(root, "geom-1")
    s1 = _study(g, "sim-1", "Study 1")
    s2 = _study(g, "sim-2", "Study 2")
    _write(s1 / "meshes" / "Mesh_1" / "id.json", {"id": "mesh-1", "name": "Mesh 1", "kind": "mesh"})
    _write(s1 / "meshes" / "Mesh_1" / "mesh.json", {"id": "mesh-1", "generated": False})
    _write(s1 / "simulation_runs" / "Run_1" / "id.json", {"id": "run-1", "name": "Run 1", "kind": "run"})
    _write(s1 / "simulation_runs" / "Run_1" / "run.json", {"id": "run-1", "status": "draft"})
    assert link.usage(root, "geom-1", KNOWN)["studies"] == []
    for s, n in ((s1, "Inlet"), (s2, "Outlet")):
        _write(s / BC / f"BC_{n}" / "bc.json", {"id": f"bc-{n}", "name": n, "bc_type": "Wall", "faces": []})
    use = link.usage(root, "geom-1", KNOWN)
    assert [st["id"] for st in use["studies"]] == ["sim-1", "sim-2"]
    assert use["last"] == "sim-1"
    _write(root / "simulations.json", {"active_id": "sim-2", "simulations": []})
    assert link.usage(root, "geom-1", KNOWN)["last"] == "sim-2", "the project's active study when it is one of them"


def test_usage_lists_what_blocks_an_overwrite_and_each_copy(tmp_path: Path):
    root = _project(tmp_path)
    g = _geometry(root, "geom-1")
    s1 = _study(g, "sim-1", "Study 1")
    s2 = _study(g, "sim-2", "Study 2")
    _write(s1 / BC / "BC_Porous" / "bc.json", {"id": "bc-p", "name": "Porous", "registry_key": "demo_porous", "faces": []})
    _write(s2 / BC / "BC_Wall" / "bc.json", {"id": "bc-w", "name": "Wall", "bc_type": "Wall", "faces": []})
    known = {**KNOWN, "bc": KNOWN["bc"] - {"demo_porous"}}
    use = link.usage(root, "geom-1", known)
    assert [u["key"] for u in use["unknown"]] == ["demo_porous"]
    by = {st["id"]: st for st in use["studies"]}
    assert [u["key"] for u in by["sim-1"]["unknown"]] == ["demo_porous"]
    assert by["sim-2"]["unknown"] == []


# ---- versions and names -------------------------------------------------------------------


def test_next_version_counts_the_studys_folders_and_skips_a_name_taken(tmp_path: Path):
    root = _project(tmp_path)
    assert link.next_version(root, "link-demo", "st-1", "Demo 1") == {"version": 1, "name": "Demo 1"}
    _geometry(root, "geom-1", unlinked=True)
    assert link.next_version(root, "link-demo", "st-1", "Demo 1") == {"version": 2, "name": "Demo 1 v2"}
    _geometry(root, "geom-2", version=2, name="Demo 1 v2", linked_at="2026-10-02T00:00:00Z")
    # Another plugin's study with the same id, and a plain import named "Demo 1 v3".
    _geometry(root, "geom-x", plugin="link-demo-2", version=7)
    plain = root / "geometries" / "Geometry_Imported"
    plain.mkdir(parents=True)
    _write(plain / "id.json", {"id": "geom-imp", "name": "demo 1 V3", "kind": "geometry"})
    assert link.next_version(root, "link-demo", "st-1", "Demo 1") == {"version": 4, "name": "Demo 1 v4"}
    # A removed or a pending folder does not count.
    _geometry(root, "geom-9", version=9, pending="gl-x")
    removed = _geometry(root, "geom-8", version=8)
    _write(removed / "link" / "removed.json", {})
    assert link.next_version(root, "link-demo", "st-1", "Wing") == {"version": 3, "name": "Wing v3"}
    assert link.versioned_name("Wing", 1) == "Wing" and link.versioned_name("Wing", 3) == "Wing v3"


def test_an_update_names_the_linked_geometry_after_the_study_with_its_version(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    p.study()
    state = _jr(p.gdir / "link" / "state.json")
    _write(p.gdir / "link" / "state.json", {**state, "version": 3, "name": "Demo 1 v3"})
    rel = p.stage("v2")
    _write(p.root / rel / "job.json", {**_jr(p.root / rel / "job.json"), "name": "Wing"})
    link.plan(p.root, p.gid, rel, 1, False)
    link.apply(p.root, p.gid, rel)
    assert _jr(p.gdir / "link" / "state.json")["name"] == "Wing v3"


# ---- the commit and the repair ------------------------------------------------------------


def test_link_commit_removes_pending_then_marks_the_old_one_unlinked_then_lists_the_new_one(tmp_path: Path):
    root = _project(tmp_path)
    old = _geometry(root, "geom-1")
    new = _geometry(root, "geom-2", version=2, name="Demo 1 v2", linked_at="2026-10-02T00:00:00Z", pending="gl-new")
    assert link.find_linked(root, "link-demo", "st-1")["id"] == "geom-1", "hidden until its commit"
    with pytest.raises(link.LinkError):
        link.link_commit(root, "geom-2", "geom-1", "gl-other")
    assert (new / "link" / "pending.json").is_file()
    out = link.link_commit(root, "geom-2", "geom-1", "gl-new")
    assert out == {"ok": True, "geometry_id": "geom-2", "name": "Demo 1 v2"}
    assert not (new / "link" / "pending.json").exists()
    assert _jr(old / "link" / "unlinked.json")["moved_to"] == "geom-2"
    assert link.find_linked(root, "link-demo", "st-1")["id"] == "geom-2"
    proj = _jr(root / "project.json")
    assert [g["id"] for g in proj["geometries"]] == ["geom-2"]
    # Again: the same files.
    before = (old / "link" / "unlinked.json").read_bytes()
    link.link_commit(root, "geom-2", "geom-1", "gl-new")
    assert (old / "link" / "unlinked.json").read_bytes() == before
    # A first link has no old geometry.
    first = _geometry(root, "geom-3", sid="st-3", pending="gl-3")
    link.link_commit(root, "geom-3", None, "gl-3")
    assert not (first / "link" / "pending.json").exists()


def test_link_commit_stops_after_its_commit_point_only_with_the_test_switch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = _project(tmp_path)
    old = _geometry(root, "geom-1")
    _geometry(root, "geom-2", linked_at="2026-10-02T00:00:00Z", pending="gl-new")
    link.link_commit(root, "geom-2", "geom-1", "gl-new", stop_after_commit_point=True)
    assert (old / "link" / "unlinked.json").is_file(), "inert without the switch"
    monkeypatch.setenv("MAGNUSIM_TEST_LINK_HOOKS", "1")
    hooked = importlib.reload(link)
    try:
        old2 = _geometry(root, "geom-4", sid="st-4")
        new2 = _geometry(root, "geom-5", sid="st-4", linked_at="2026-10-02T00:00:00Z", pending="gl-5")
        with pytest.raises(hooked.LinkError):
            hooked.link_commit(root, "geom-5", "geom-4", "gl-5", stop_after_commit_point=True)
        assert not (new2 / "link" / "pending.json").exists() and not (old2 / "link" / "unlinked.json").exists()
        # Two folders link the study now: the newest wins, and the repair marks the other.
        assert hooked.find_linked(root, "link-demo", "st-4")["id"] == "geom-5"
        assert hooked.mark_older_unlinked(root) == ["geom-4"]
        assert _jr(old2 / "link" / "unlinked.json")["moved_to"] == "geom-5"
        assert hooked.mark_older_unlinked(root) == []
    finally:
        monkeypatch.delenv("MAGNUSIM_TEST_LINK_HOOKS")
        importlib.reload(link)


def test_the_tree_hides_a_pending_geometry_and_marks_an_unlinked_one(tmp_path: Path):
    from cfddesk.project.scope import build_project_tree

    root = _project(tmp_path)
    _geometry(root, "geom-1", unlinked=True)
    _geometry(root, "geom-2", linked_at="2026-10-02T00:00:00Z", pending="gl-2")
    tree = build_project_tree(root, "p1")
    assert [(g["id"], g["unlinked"]) for g in tree["geometries"]] == [("geom-1", True)]


# ---- the copy (gate:l2-copy) --------------------------------------------------------------


def _save_as_new(p: Proj) -> tuple[Path, Path]:
    """The new geometry folder (v2's files, rev 1, version 2, pending) and a copy of Study 1 on it, as the
    study copy with keep_labels leaves it: the source's records, labels and stamps unchanged."""
    gdir = p.root / "geometries" / "Geometry_Demo_1_v2"
    (gdir / "simulations").mkdir(parents=True)
    for name in ("cad_preview.json", "source.bbrep", "face_names.json"):
        shutil.copyfile(p.previews["v2"] / name, gdir / name)
    _write(gdir / "id.json", {"id": "geom-2", "name": "Demo 1 v2", "kind": "geometry",
                              "source": {"type": "plugin_study", "plugin": "link-demo", "study_id": "st-1", "workspace": "demo", "linked_at": "2026-10-02T00:00:00Z"}})
    report = _jr(p.previews["v2"] / "preview.json")
    _write(gdir / "link" / "state.json", {"rev": 1, "version": 2, "source_version": 2, "name": "Demo 1 v2", "shape_sha256": "b" * 64,
                                          "n_solids": 2, "n_faces": 17, "bodies": report["bodies"]})
    _write(gdir / "link" / "pending.json", {"job_id": "gl-test01-abcdef"})
    copy = gdir / "simulations" / "Study_1_copy"
    shutil.copytree(p.gdir / "simulations" / "Study_1", copy)
    _write(copy / "id.json", {"id": "sim-copy", "name": "Study 1 copy", "geometry_id": "geom-2", "kind": "simulation"})
    return gdir, copy


def test_the_copy_maps_a_two_solid_part_through_the_links_own_map(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = _full_study(p)
    # Body 2's +x side (v1 face 17) is v2's face 12: the same name in the paired body.
    _write(s / BC / "BC_Side2" / "bc.json", {"id": "bc-side2", "name": "Side2", "bc_type": "Wall", "faces": ["face 17@Body2"], "simulation_id": "sim-1"})
    # The old geometry is at rev 2 by now; the new one starts at rev 1 (the copy maps from rev 2).
    _write(p.gdir / "link" / "state.json", {**_jr(p.gdir / "link" / "state.json"), "rev": 2})
    src_before = {q: q.read_bytes() for q in s.rglob("*") if q.is_file()}
    old_state = (p.gdir / "link" / "state.json").read_bytes()
    gdir, copy = _save_as_new(p)
    new_state = (gdir / "link" / "state.json").read_bytes()
    rel = p.stage("v2")
    planned = link.plan(p.root, "geom-2", rel, 2, False, studies=["sim-copy"], rev=1, schema_fields=SCHEMA, map_from=p.gid)
    assert (planned["change"], planned["rev"]) == ("shape", 1)
    assert (p.root / rel / "plan-copy.json").is_file() and not (p.root / rel / "plan.json").exists()
    link.apply(p.root, "geom-2", rel, "plan-copy.json")
    bc = {n: _jr(copy / BC / f"BC_{n}" / "bc.json") for n in ("Inlet", "Outlet", "Top", "Side", "Porous", "Side2")}
    assert bc["Side2"]["faces"] == ["face 12@Body2"]
    assert sorted(bc["Side"]["faces"]) == ["face 1@Body1", "face 4@Body1", "face 8@Body1"], "a split keeps both halves"
    assert bc["Top"]["faces"] == [] and bc["Top"]["lost_faces"][0]["name"] == "F:boss:end"
    assert bc["Inlet"]["lost_faces"][0]["reason"] == "claimed_twice", "two BCs whose faces merge"
    for rec in bc.values():
        assert rec["geometry_rev"] == 1
    mat = _jr(copy / "materials" / "Material_Air" / "material.json")
    assert mat["volume_ids"] == ["Body2"] and mat["geometry_rev"] == 1, "a body pairs by id"
    ref = _jr(copy / "meshes" / "Mesh_1" / "refinements" / "Ref_1" / "refinement.json")
    assert sorted(ref["faces"]) == ["face 4@Body1", "face 8@Body1"] and sorted(ref["face_ids"]) == [3, 7] and ref["volume_ids"] == ["Body2"]
    rc = _jr(copy / "result_controls" / "RC_AA" / "result_control.json")
    assert sorted(rc["faces"]) == ["face 10@Body1", "face 4@Body1", "face 8@Body1"]
    draft = _jr(copy / "simulation_runs" / "run-draft" / "run.json")
    assert draft["views"][0]["pt"]["faces"] == ["face 10@Body1"] and draft["geometry_rev"] == 1
    # Nothing of the source or of either geometry's link state.
    assert {q: q.read_bytes() for q in s.rglob("*") if q.is_file()} == src_before
    assert (p.gdir / "link" / "state.json").read_bytes() == old_state
    assert (gdir / "link" / "state.json").read_bytes() == new_state
    assert not (p.gdir / "link" / "last-update.json").exists() and not (gdir / "link" / "last-update.json").exists()

    # The face v2 removed comes back on the copy when an overwrite of "Demo 1 v2" brings v3.
    stage = p.root / ".magnusim-staging" / "link-gl-test02-abcdef"
    (stage / "new").mkdir(parents=True)
    shutil.copyfile(previews["v3"] / "cad_preview.json", stage / "new" / "cad_preview.json")
    shutil.copyfile(previews["v3"] / "preview.json", stage / "preview.json")
    _write(stage / "job.json", {"job": "gl-test02-abcdef", "source_version": 3, "name": "Demo 1", "shape_sha256": "c" * 64})
    _write(stage / "map.json", node_map(gdir / "cad_preview.json", stage / "new" / "cad_preview.json"))
    (gdir / "link" / "pending.json").unlink()
    link.plan(p.root, "geom-2", ".magnusim-staging/link-gl-test02-abcdef", 1, False, schema_fields=SCHEMA)
    link.apply(p.root, "geom-2", ".magnusim-staging/link-gl-test02-abcdef")
    top = _jr(copy / BC / "BC_Top" / "bc.json")
    assert len(top["faces"]) == 1 and top["lost_faces"] == [] and top["geometry_rev"] == 2
    assert _jr(gdir / "link" / "state.json")["name"] == "Demo 1 v2", "the version suffix stays"

