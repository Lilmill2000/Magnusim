"""Linked geometries (host API 1.5), L2 step 1: the job's input, preview and main-lane calls.

- The link input: a binary or a text BREP, told apart by its header; any other format
  is ``unsupported_format``; an unreadable file, a version this OCCT does not read and a
  face outside every solid are ``bad_brep``; no solid is ``empty`` (proposal 5.3).
- The face-name sidecar's rules (5.11) and its canonical hash.
- The preview in its own process: the geometry files, no centre of mass (a follow-up),
  the same face table from a text BREP as from its binary twin.
- ``geometry.record_source`` (a link that changed nothing; refused while fenced),
  ``geometry.check_kinds`` (record kinds no loaded plugin provides, with the owner),
  ``geometry.plan`` / ``geometry.apply`` (the commit point, idempotent),
  ``project.upsert_geometry`` (never the active geometry, never a removed folder),
  ``geometry.link_check`` (one read at the call), and the tree's link fields.
- The test switches are inert unless set.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.cad import link_input
from cfddesk.project import link
from tests.conftest import FIXTURES

pytestmark = pytest.mark.occt

PY = Path(__file__).resolve().parents[2]
LINK_DEMO = FIXTURES / "link-plugins" / "link-demo"
SHARED = FIXTURES / "geometry" / "two-boxes-shared-face.brep"


def _box(dx=10.0, dy=20.0, dz=30.0):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

    return BRepPrimAPI_MakeBox(dx, dy, dz).Shape()


def _write_bin(shape, path: Path) -> Path:
    from OCP.BinTools import BinTools

    assert BinTools.Write_s(shape, str(path))
    return path


def _write_text(shape, path: Path) -> Path:
    from OCP.BRepTools import BRepTools

    assert BRepTools.Write_s(shape, str(path))
    return path


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _names_doc(n_faces: int, n_bodies: int = 1, body_of=None, shape_sha256: str | None = None) -> dict:
    body_of = body_of or (lambda i: 1)
    doc = {
        "format": "magnusim.face-names",
        "version": 1,
        "length_unit": "mm",
        "bodies": [{"index": b, "id": f"b{b}", "name": f"Body {b}", "label": "Fluid" if b == 1 else f"Solid {b}"} for b in range(1, n_bodies + 1)],
        "faces": [{"index": i, "body": body_of(i), "name": f"F:{i}", "label": f"Face {i}"} for i in range(1, n_faces + 1)],
    }
    if shape_sha256:
        doc["shape_sha256"] = shape_sha256
    return doc


# ---- the input ----------------------------------------------------------------------


def test_binary_and_text_breps_are_told_apart_by_their_header(tmp_path: Path):
    b = _write_bin(_box(), tmp_path / "a.bbrep")
    t = _write_text(_box(), tmp_path / "a.brep")
    assert link_input.brep_encoding(b) == "binary"
    assert link_input.brep_encoding(t) == "text"
    assert link_input.read_link_shape(b, "brep").encoding == "binary"
    assert link_input.read_link_shape(t, "brep").encoding == "text"
    # A text BREP another program wrote (gmsh writes this header too).
    assert link_input.brep_encoding(SHARED) == "text"


def test_only_brep_is_read(tmp_path: Path):
    b = _write_bin(_box(), tmp_path / "a.bbrep")
    with pytest.raises(link_input.LinkInputError) as err:
        link_input.read_link_shape(b, "step")
    assert err.value.code == "unsupported_format"
    assert "'brep'" in err.value.message


@pytest.mark.parametrize(
    "content",
    [
        b"ISO-10303-21;\nHEADER;\n",  # a STEP file
        b"\nOpen CASCADE Topology V9, (c) Open Cascade\nLocations 0\n",  # a version this OCCT does not read
        b"DBRep_DrawableShape\n\nCASCADE Topology V3\ngarbage",  # a broken text BREP
        b"",
    ],
)
def test_an_unreadable_shape_is_bad_brep(tmp_path: Path, content: bytes):
    p = tmp_path / "x.brep"
    p.write_bytes(content)
    with pytest.raises(link_input.LinkInputError) as err:
        link_input.read_link_shape(p, "brep")
    assert err.value.code == "bad_brep"


def test_a_shape_with_no_solid_is_empty_and_a_free_face_is_bad_brep():
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Pln
    from OCP.TopoDS import TopoDS_Compound

    face = BRepBuilderAPI_MakeFace(gp_Pln(), 0.0, 1.0, 0.0, 1.0).Face()
    only_face = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(only_face)
    builder.Add(only_face, face)
    with pytest.raises(link_input.LinkInputError) as err:
        link_input.check_link_shape(only_face)
    assert err.value.code == "empty"
    mixed = TopoDS_Compound()
    builder.MakeCompound(mixed)
    builder.Add(mixed, _box())
    builder.Add(mixed, BRepBuilderAPI_MakeFace(gp_Pln(), 50.0, 51.0, 0.0, 1.0).Face())
    with pytest.raises(link_input.LinkInputError) as err:
        link_input.check_link_shape(mixed)
    assert err.value.code == "bad_brep"
    assert "outside every solid" in err.value.message
    assert len(link_input.check_link_shape(_box())) == 6


# ---- the sidecar --------------------------------------------------------------------


def _shared_visits():
    read = link_input.read_link_shape(SHARED, "brep")
    return link_input.check_link_shape(read.shape)


def test_a_good_sidecar_passes_and_counts_named_faces():
    visits = _shared_visits()
    assert len(visits) == 12  # the shared face is visited once per box
    body_of = {i: b for i, b, _f in visits}
    doc = _names_doc(12, 2, body_of.get, _sha(SHARED))
    assert link_input.check_face_names(doc, visits, 2, _sha(SHARED)) == {"bodies": 2, "faces": 12, "named": 12}


@pytest.mark.parametrize(
    "breaks, rule",
    [
        (lambda d: d.update(length_unit="m"), "length_unit"),
        (lambda d: d.update(shape_sha256="0" * 64), "shape_sha256"),
        (lambda d: d["faces"].pop(), "face visits"),
        (lambda d: d["bodies"].pop(), "solids"),
        (lambda d: d["faces"][1].update(index=1), "listed twice"),
        (lambda d: d["faces"][0].update(index=99), "out of range"),
        (lambda d: d["faces"][0].update(body=2), "is in body 1"),
        (lambda d: d["bodies"][1].update(name="Body 1"), "two bodies are named"),
        (lambda d: d["bodies"][1].update(id="b1"), "two bodies have the id"),
        (lambda d: d["faces"][0].update(name="x" * 201), "longer than 200"),
        (lambda d: d["faces"][0].update(label="y" * 121), "longer than 120"),
        (lambda d: d["faces"][0].update(name="\u202e\u0007"), "is empty"),
        (lambda d: d.update(format="other"), "format must be"),
    ],
)
def test_each_sidecar_rule_is_bad_face_names(breaks, rule):
    visits = _shared_visits()
    body_of = {i: b for i, b, _f in visits}
    doc = _names_doc(12, 2, body_of.get, _sha(SHARED))
    breaks(doc)
    with pytest.raises(link_input.LinkInputError) as err:
        link_input.check_face_names(doc, visits, 2, _sha(SHARED))
    assert err.value.code == "bad_face_names"
    assert rule in err.value.message


def test_the_names_hash_ignores_key_order_and_whitespace():
    a = {"format": "magnusim.face-names", "faces": [{"index": 1, "name": "F"}], "version": 1}
    b = json.loads('{ "version": 1,\n "faces": [ { "name": "F", "index": 1 } ], "format": "magnusim.face-names" }')
    assert link_input.canonical_names_sha256(a) == link_input.canonical_names_sha256(b)
    assert link_input.canonical_names_sha256(a) != link_input.canonical_names_sha256({**a, "version": 2})


def test_names_are_cleaned_of_control_and_bidi_characters():
    assert link_input.clean_text("\u202eEvil\u2066 face\u0007") == "Evil face"


# ---- the preview, in its own process --------------------------------------------------


def _run_preview(tmp_path: Path, shape: Path, names: Path | None = None, sha: str | None = None, out_name="new"):
    out = tmp_path / out_name
    report = tmp_path / f"{out_name}.json"
    args = [sys.executable, "-m", "cfddesk.cad.link_preview", "--shape", str(shape), "--format", "brep", "--out", str(out), "--report", str(report)]
    if names is not None:
        args += ["--names", str(names)]
    if sha:
        args += ["--shape-sha256", sha]
    proc = subprocess.run(args, cwd=PY, capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stderr
    return out, json.loads(report.read_text(encoding="utf-8"))


def test_the_preview_writes_the_geometry_files_from_a_binary_brep(tmp_path: Path):
    shape = tmp_path / "in.bbrep"
    shutil.copyfile(SHARED, tmp_path / "shared.brep")
    from OCP.BRep import BRep_Builder
    from OCP.BRepTools import BRepTools
    from OCP.TopoDS import TopoDS_Shape

    s = TopoDS_Shape()
    assert BRepTools.Read_s(s, str(SHARED), BRep_Builder())
    _write_bin(s, shape)
    visits = link_input.check_link_shape(s)
    names = tmp_path / "names.json"
    body_of = {i: b for i, b, _f in visits}
    names.write_text(json.dumps(_names_doc(12, 2, body_of.get, _sha(shape))), encoding="utf-8")
    out, report = _run_preview(tmp_path, shape, names, _sha(shape))
    assert report["ok"] is True
    assert report["encoding"] == "binary"
    assert (report["n_solids"], report["n_faces"], report["named"]) == (2, 12, 12)
    assert report["bodies"] == [
        {"index": 1, "ref": "Body1", "id": "b1", "name": "Body 1", "label": "Fluid"},
        {"index": 2, "ref": "Body2", "id": "b2", "name": "Body 2", "label": "Solid 2"},
    ]
    assert report["names_sha256"] == link_input.canonical_names_sha256(json.loads(names.read_text(encoding="utf-8")))
    for name in ("source.bbrep", "cad_faces.vtp", "cad_edges.vtp", "cad_preview.json", "face_names.json"):
        assert (out / name).is_file(), name
    # A binary BREP is stored as sent; the sidecar too.
    assert (out / "source.bbrep").read_bytes() == shape.read_bytes()
    assert (out / "face_names.json").read_bytes() == names.read_bytes()
    meta = json.loads((out / "cad_preview.json").read_text(encoding="utf-8"))
    assert meta["preview_version"] == 8
    assert "center_of_mass" not in meta  # a follow-up writes it
    assert meta["step_path"] == "source.step" and meta["faces_vtp"] == "cad_faces.vtp"
    assert [f["body"] for f in meta["faces"]] == [body_of[i] for i in range(1, 13)]


def test_a_text_brep_gives_the_same_face_table_as_its_binary_twin(tmp_path: Path):
    from OCP.BRep import BRep_Builder
    from OCP.BRepTools import BRepTools
    from OCP.TopoDS import TopoDS_Shape

    s = TopoDS_Shape()
    assert BRepTools.Read_s(s, str(SHARED), BRep_Builder())
    binary = _write_bin(s, tmp_path / "twin.bbrep")
    out_t, rep_t = _run_preview(tmp_path, SHARED, out_name="text")
    out_b, rep_b = _run_preview(tmp_path, binary, out_name="bin")
    assert rep_t["encoding"] == "text" and rep_b["encoding"] == "binary"
    face_t = json.loads((out_t / "cad_preview.json").read_text(encoding="utf-8"))["faces"]
    face_b = json.loads((out_b / "cad_preview.json").read_text(encoding="utf-8"))["faces"]
    assert [(f["id"], f["body"], round(f["area"], 6), [round(c, 6) for c in f["centroid"]]) for f in face_t] == [
        (f["id"], f["body"], round(f["area"], 6), [round(c, 6) for c in f["centroid"]]) for f in face_b
    ]
    # The text input is stored as a binary BREP the host reads.
    assert link_input.brep_encoding(out_t / "source.bbrep") == "binary"


def test_the_preview_reports_a_refusal_with_its_code(tmp_path: Path):
    bad = tmp_path / "bad.brep"
    bad.write_bytes(b"not a brep")
    _out, report = _run_preview(tmp_path, bad)
    assert report == {"ok": False, "code": "bad_brep", "error": "The shape is not an OCCT BREP file (binary or text)."}
    shape = _write_bin(_box(), tmp_path / "box.bbrep")
    names = tmp_path / "names.json"
    names.write_text(json.dumps(_names_doc(5)), encoding="utf-8")
    _out, report = _run_preview(tmp_path, shape, names, out_name="short")
    assert report["ok"] is False and report["code"] == "bad_face_names"


def test_the_centre_of_mass_follow_up(tmp_path: Path):
    shape = _write_bin(_box(10, 20, 30), tmp_path / "box.bbrep")
    proc = subprocess.run(
        [sys.executable, "-m", "cfddesk.cad.link_preview", "--com", str(shape)], cwd=PY, capture_output=True, text=True, timeout=120
    )
    assert proc.returncode == 0, proc.stderr
    line = next(ln for ln in proc.stdout.splitlines() if ln.startswith("LINK_COM "))
    doc = json.loads(line[len("LINK_COM ") :])
    assert [round(c, 6) for c in doc["center_of_mass"]] == [5.0, 10.0, 15.0]


# ---- the main-lane calls --------------------------------------------------------------


def _project(tmp_path: Path, pid="p1", doc=None) -> Path:
    root = tmp_path / "projects" / pid
    root.mkdir(parents=True)
    (root / "project.json").write_text(json.dumps(doc or {"id": pid, "title": pid, "geometries": []}), encoding="utf-8")
    return root


def _linked_geometry(root: Path, gid="geom-1", plugin="link-demo", sid="st-1", rev=1, linked_at="2026-10-01T00:00:00Z", folder=None, **state) -> Path:
    gdir = root / "geometries" / (folder or f"Geometry_{gid}")
    (gdir / "link").mkdir(parents=True)
    (gdir / "simulations").mkdir()
    (gdir / "id.json").write_text(
        json.dumps(
            {
                "id": gid,
                "name": "Demo 1",
                "kind": "geometry",
                "source": {"type": "plugin_study", "plugin": plugin, "study_id": sid, "workspace": "demo", "linked_at": linked_at},
            }
        ),
        encoding="utf-8",
    )
    (gdir / "source.bbrep").write_bytes(b"x")
    (gdir / "link" / "state.json").write_text(
        json.dumps({"rev": rev, "version": 1, "source_version": 3, "name": "Demo 1", "shape_sha256": "a" * 64, **state}), encoding="utf-8"
    )
    return gdir


def test_record_source_keeps_the_larger_version_and_refuses_while_fenced(tmp_path: Path):
    root = _project(tmp_path)
    gdir = _linked_geometry(root)
    assert link.record_source(root, "geom-1", 5)["source_version"] == 5
    assert link.record_source(root, "geom-1", 4)["source_version"] == 5
    state = link.read_state(gdir)
    assert state["rev"] == 1 and state["synced_at"]
    (gdir / "link" / "commit.json").write_text("{}", encoding="utf-8")
    with pytest.raises(link.LinkError) as err:
        link.record_source(root, "geom-1", 9)
    assert err.value.code == "geometry_updating"
    assert link.read_state(gdir)["source_version"] == 5
    with pytest.raises(link.LinkError) as err:
        link.record_source(root, "geom-gone", 9)
    assert err.value.code == "gone"


def test_the_link_is_found_by_plugin_and_study_together(tmp_path: Path):
    root = _project(tmp_path)
    _linked_geometry(root, "geom-a", plugin="link-demo", sid="st-1")
    _linked_geometry(root, "geom-b", plugin="link-demo-2", sid="st-1")
    assert link.find_linked(root, "link-demo", "st-1")["id"] == "geom-a"
    assert link.find_linked(root, "link-demo-2", "st-1")["id"] == "geom-b"
    assert link.find_linked(root, "link-demo", "st-2") is None
    # The newest linked_at wins; removed, pending and unlinked folders and rev 0 are no link.
    _linked_geometry(root, "geom-c", sid="st-1", linked_at="2026-10-02T00:00:00Z")
    assert link.find_linked(root, "link-demo", "st-1")["id"] == "geom-c"
    for marker in ("removed.json", "pending.json", "unlinked.json"):
        (root / "geometries" / "Geometry_geom-c" / "link" / marker).write_text("{}", encoding="utf-8")
        assert link.find_linked(root, "link-demo", "st-1")["id"] == "geom-a", marker
        (root / "geometries" / "Geometry_geom-c" / "link" / marker).unlink()
    _linked_geometry(root, "geom-d", sid="st-9", rev=0)
    assert link.find_linked(root, "link-demo", "st-9") is None


def _study(root: Path, gid: str, sid="sim-1", name="Study 1") -> Path:
    gdir = next(p for p in (root / "geometries").iterdir() if json.loads((p / "id.json").read_text())["id"] == gid)
    sdir = gdir / "simulations" / name.replace(" ", "_")
    sdir.mkdir(parents=True)
    (sdir / "id.json").write_text(json.dumps({"id": sid, "name": name, "geometry_id": gid, "kind": "simulation"}), encoding="utf-8")
    return sdir


def _record(parent: Path, folder: str, json_name: str, rec: dict) -> None:
    (parent / folder).mkdir(parents=True)
    (parent / folder / json_name).write_text(json.dumps(rec), encoding="utf-8")


def test_check_kinds_lists_records_no_loaded_plugin_provides_with_the_owner(tmp_path: Path):
    root = _project(tmp_path)
    _linked_geometry(root)
    sdir = _study(root, "geom-1")
    _record(sdir / "boundary_conditions", "BC_Inlet", "bc.json", {"id": "bc-1", "name": "Inlet", "bc_type": "Velocity inlet", "faces": []})
    _record(sdir / "boundary_conditions", "BC_Porous", "bc.json", {"id": "bc-2", "name": "Porous", "registry_key": "demo_porous", "faces": []})
    _record(sdir / "result_controls", "RC_Flow", "result_control.json", {"id": "rc-1", "name": "Flow", "kind": "demo_flow", "faces": []})
    _record(sdir / "result_controls", "RC_Avg", "result_control.json", {"id": "rc-2", "name": "Average", "faces": []})
    known = {"bc": {"velocity_inlet_fixed", "wall_noslip"}, "monitor": {"area_average"}, "mesher": {"standard"}}
    web = tmp_path / "web"
    (web / "scripts" / "generated").mkdir(parents=True)
    (web / "scripts" / "generated" / "registry.json").write_text(
        json.dumps({"bc": [{"key": "demo_porous", "plugin": "porous-pack"}], "monitor": [], "mesher": [], "plugins": [{"key": "porous-pack", "name": "Porous pack"}]}),
        encoding="utf-8",
    )
    catalog = [{"key": "porous-pack", "name": "Porous pack", "source": "bundled", "status": "disabled"}]
    found = {e["key"]: e for e in link.check_kinds(root, "geom-1", known, catalog, web)}
    assert set(found) == {"demo_porous", "demo_flow"}
    assert found["demo_porous"]["owner"] == "porous-pack" and found["demo_porous"]["bundled_off"] is True
    assert found["demo_porous"]["records"] == [{"study_id": "sim-1", "study": "Study 1", "id": "bc-2", "name": "Porous"}]
    assert found["demo_flow"]["owner"] is None and found["demo_flow"]["bundled_off"] is False
    assert found["demo_flow"]["kind"] == "result_control"
    # Not installed: the same refusal, with no owner known.
    assert link.check_kinds(root, "geom-1", {**known, "bc": known["bc"] | {"demo_porous"}, "monitor": {"area_average", "demo_flow"}}, catalog, web) == []


def _staging(root: Path, job="gl-1", source_version=7, preview=None, **job_fields) -> str:
    stage = root / ".magnusim-staging" / f"link-{job}"
    stage.mkdir(parents=True)
    (stage / "job.json").write_text(
        json.dumps({"job": job, "source_version": source_version, "name": "Demo 1", "shape_sha256": "b" * 64, "names_file_sha256": None, **job_fields}),
        encoding="utf-8",
    )
    (stage / "preview.json").write_text(
        json.dumps(preview or {"ok": True, "n_solids": 1, "n_faces": 6, "bounds": {"xmin": 0}, "bodies": [{"index": 1, "ref": "Body1"}], "names_sha256": None}),
        encoding="utf-8",
    )
    return f".magnusim-staging/link-{job}"


def test_plan_then_apply_commits_a_shape_change_and_a_second_apply_changes_nothing(tmp_path: Path):
    root = _project(tmp_path)
    gdir = _linked_geometry(root, rev=3)
    rel = _staging(root)
    planned = link.plan(root, "geom-1", rel, 3, False)
    assert (planned["change"], planned["rev"]) == ("shape", 4)
    # The plan writes only plan.json.
    assert link.read_state(gdir)["rev"] == 3
    assert not (gdir / "link" / "last-update.json").exists()
    assert link.apply(root, "geom-1", rel)["rev"] == 4
    state = link.read_state(gdir)
    assert (state["rev"], state["source_version"], state["job_id"], state["shape_sha256"]) == (4, 7, "gl-1", "b" * 64)
    assert state["version"] == 1  # kept
    last = json.loads((gdir / "link" / "last-update.json").read_text(encoding="utf-8"))
    assert (last["rev"], last["from_rev"]) == (4, 3)
    before = {p.name: p.read_bytes() for p in (gdir / "link").iterdir()}
    link.apply(root, "geom-1", rel)
    after = {p.name: p.read_bytes() for p in (gdir / "link").iterdir()}
    assert {k: json.loads(v) | {"synced_at": None} for k, v in before.items()} == {
        k: json.loads(v) | {"synced_at": None} for k, v in after.items()
    }


def test_a_names_change_keeps_the_rev_and_the_last_update(tmp_path: Path):
    root = _project(tmp_path)
    gdir = _linked_geometry(root, rev=2)
    rel = _staging(root, preview={"ok": True, "n_solids": 1, "n_faces": 6, "bodies": [], "names_sha256": "c" * 64})
    assert link.plan(root, "geom-1", rel, 2, True)["change"] == "names"
    link.apply(root, "geom-1", rel)
    assert link.read_state(gdir)["rev"] == 2
    assert link.read_state(gdir)["names_sha256"] == "c" * 64
    assert not (gdir / "link" / "last-update.json").exists()


def test_plan_refuses_a_stale_rev_a_removed_geometry_and_unknown_kinds(tmp_path: Path):
    root = _project(tmp_path)
    gdir = _linked_geometry(root, rev=2)
    rel = _staging(root)
    with pytest.raises(link.LinkError) as err:
        link.plan(root, "geom-1", rel, 1, False)
    assert err.value.code == "stale"
    sdir = _study(root, "geom-1")
    _record(sdir / "boundary_conditions", "BC_P", "bc.json", {"id": "bc-9", "name": "Porous", "registry_key": "demo_porous"})
    with pytest.raises(link.LinkError) as err:
        link.plan(root, "geom-1", rel, 2, False, known={"bc": set(), "monitor": set(), "mesher": set()})
    assert err.value.code == "plugin_needed"
    assert err.value.data[0]["records"][0]["name"] == "Porous"
    assert not (root / rel / "plan.json").exists()
    (gdir / "link" / "removed.json").write_text("{}", encoding="utf-8")
    with pytest.raises(link.LinkError) as err:
        link.plan(root, "geom-1", rel, 2, False)
    assert err.value.code == "gone"
    with pytest.raises(link.LinkError) as err:
        link.plan(root, "geom-1", "../elsewhere", 2, False)
    assert err.value.code in ("bad_request", "gone")


def test_upsert_geometry_adds_and_refreshes_one_record_and_never_the_active_geometry(tmp_path: Path):
    root = _project(tmp_path, doc={"id": "p1", "title": "p1", "active_geometry_id": "geom-0", "geometries": [{"id": "geom-0", "name": "Plate"}]})
    _linked_geometry(root, "geom-1")
    assert link.upsert_geometry(root, {"id": "geom-1", "name": "Demo 1", "n_faces": 6})["added"] is True
    assert link.upsert_geometry(root, {"id": "geom-1", "name": "Demo 1", "n_faces": 7})["added"] is False
    proj = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert proj["active_geometry_id"] == "geom-0"
    assert [g["id"] for g in proj["geometries"]] == ["geom-0", "geom-1"]
    assert proj["geometries"][1]["n_faces"] == 7
    # A folder that is gone, removed or pending is never added back.
    gdir = _linked_geometry(root, "geom-2")
    (gdir / "link" / "removed.json").write_text("{}", encoding="utf-8")
    assert link.upsert_geometry(root, {"id": "geom-2"}) == {"ok": True, "skipped": "gone"}
    assert link.upsert_geometry(root, {"id": "geom-3"}) == {"ok": True, "skipped": "gone"}
    proj = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert [g["id"] for g in proj["geometries"]] == ["geom-0", "geom-1"]


def test_an_empty_project_shows_its_first_linked_geometry_and_a_lost_record_comes_back(tmp_path: Path):
    root = _project(tmp_path)
    _linked_geometry(root, "geom-1", bodies=[{"index": 1, "ref": "Body1"}], n_solids=1, n_faces=6)
    rec = link.geometry_record("p1", link.find_linked(root, "link-demo", "st-1"), link.read_state(root / "geometries" / "Geometry_geom-1"))
    link.upsert_geometry(root, rec)
    proj = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert proj["active_geometry_id"] == "geom-1"
    assert proj["geometry"]["faces_url"] == "/api/geometry/cad?project_id=p1&geometry_id=geom-1&part=faces"
    assert proj["geometry"]["bodies"] == ["Body1"]
    # The record lost (an async writer's old snapshot): the hydrate's repair adds it back.
    (root / "project.json").write_text(json.dumps({**proj, "geometries": []}), encoding="utf-8")
    assert link.repair_project(root) == ["geom-1"]
    assert link.repair_project(root) == []
    proj = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert [g["id"] for g in proj["geometries"]] == ["geom-1"]
    assert proj["geometries"][0]["source"]["study_id"] == "st-1"
    # A removed folder is not repaired back.
    (root / "geometries" / "Geometry_geom-1" / "link" / "removed.json").write_text("{}", encoding="utf-8")
    (root / "project.json").write_text(json.dumps({**proj, "geometries": []}), encoding="utf-8")
    assert link.repair_project(root) == []


def test_the_desktop_format_is_told_apart(tmp_path: Path):
    web = _project(tmp_path, "web")
    desk = _project(tmp_path, "desk", doc={"version": 3, "units": {"length": "m"}, "simulations": []})
    assert link.is_desktop_format(web) is False
    assert link.is_desktop_format(desk) is True


def test_the_tree_carries_the_link_fields(tmp_path: Path):
    from cfddesk.project.scope import build_project_tree

    root = _project(tmp_path)
    gdir = _linked_geometry(root, rev=3, names_sha256="1234abcd" + "0" * 56, name="Demo 1")
    node = build_project_tree(root, "p1")["geometries"][0]
    assert node["source"] == {"plugin": "link-demo", "study_id": "st-1", "workspace": "demo"}
    assert (node["rev"], node["names8"], node["updating"], node["name"]) == (3, "1234abcd", False, "Demo 1")
    (gdir / "link" / "commit.json").write_text("{}", encoding="utf-8")
    assert build_project_tree(root, "p1")["geometries"][0]["updating"] is True


def test_the_test_switches_are_inert_unless_set(tmp_path: Path):
    assert link.test_hooks_active() == {"fail_apply": False, "apply_pause": False, "link_hooks": False}
    root = _project(tmp_path)
    _linked_geometry(root, rev=1)
    rel = _staging(root)
    link.plan(root, "geom-1", rel, 1, False)
    code = (
        "import sys; from pathlib import Path; from cfddesk.project import link\n"
        "try:\n    link.apply(Path(sys.argv[1]), 'geom-1', sys.argv[2])\n"
        "except link.LinkError as e:\n    print('REFUSED', e.code); sys.exit(0)\n"
        "print('APPLIED')\n"
    )
    env = {**os.environ, "MAGNUSIM_TEST_LINK_FAIL_APPLY": "1"}
    proc = subprocess.run([sys.executable, "-c", code, str(root), rel], cwd=PY, capture_output=True, text=True, env=env, timeout=120)
    assert "REFUSED failed" in proc.stdout, proc.stderr
    assert link.read_state(root / "geometries" / "Geometry_geom-1")["rev"] == 1


# ---- geometry.link_check, through the worker method --------------------------------------


@pytest.fixture
def plugin_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.registry import load_all, reset_for_tests

    plugins = tmp_path / "plugins"
    shutil.copytree(LINK_DEMO, plugins / "link-demo")
    projects = tmp_path / "projects"
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(projects))
    reset_for_tests()
    load_all(force=True)
    yield projects
    reset_for_tests()


def test_link_check_answers_the_study_its_kind_and_the_linked_geometry(tmp_path: Path, plugin_env: Path):
    from cfddesk.registry.plugin_data import PluginData
    from cfddesk.worker import link_methods

    root = _project(tmp_path)
    data = PluginData(root, "link-demo")
    demo = data.create_study("demo", "Demo 1", plugin_name="Link demo", plugin_version="1.0.0", schema_version=1)
    sketch = data.create_study("sketch", "Sketch 1", plugin_name="Link demo", plugin_version="1.0.0", schema_version=1)
    got = link_methods.geometry_link_check("p1", "link-demo", demo["id"])
    assert got["ok"] is True and got["links_geometry"] is True and got["geometry"] is None
    assert got["study"]["title"] == "Demo 1" and got["study"]["workspace"] == "demo"
    assert link_methods.geometry_link_check("p1", "link-demo", sketch["id"])["links_geometry"] is False
    assert link_methods.geometry_link_check("p1", "link-demo", "st-nothere")["code"] == "study_not_found"
    assert link_methods.geometry_link_check("nope", "link-demo", demo["id"])["code"] == "project_not_found"
    _linked_geometry(root, "geom-1", sid=demo["id"])
    (root / "geometries" / "Geometry_geom-1" / "link" / "commit.json").write_text(json.dumps({"job": "gl-x", "phase": "apply"}), encoding="utf-8")
    geom = link_methods.geometry_link_check("p1", "link-demo", demo["id"])["geometry"]
    assert (geom["id"], geom["state"]["rev"], geom["journal"]["phase"]) == ("geom-1", 1, "apply")
    (root / "project.json").write_text(json.dumps({"version": 3, "units": {}, "simulations": []}), encoding="utf-8")
    assert link_methods.geometry_link_check("p1", "link-demo", demo["id"])["code"] == "not_allowed"


def test_the_tree_shows_a_geometry_whose_study_was_deleted_as_a_plain_one(tmp_path: Path, plugin_env: Path):
    """5.18, 5.19: deleting the linking plugin study (its plugin on) leaves a plain geometry."""
    from cfddesk.registry.plugin_data import PluginData
    from cfddesk.worker import methods

    root = _project(tmp_path)
    data = PluginData(root, "link-demo")
    demo = data.create_study("demo", "Demo 1", plugin_name="Link demo", plugin_version="1.0.0", schema_version=1)
    data.create_study("demo", "Demo 2", plugin_name="Link demo", plugin_version="1.0.0", schema_version=1)
    _linked_geometry(root, "geom-1", sid=demo["id"])

    def node() -> dict:
        return next(g for g in methods.project_tree(project_id="p1")["geometries"] if g["id"] == "geom-1")

    first = node()
    assert (first.get("source_state"), first["source"]["study_title"], bool(first.get("unlinked"))) == ("ok", "Demo 1", False)
    shutil.rmtree(root / "plugins" / "link-demo" / "studies" / demo["id"])
    after = node()
    assert (after.get("source_state"), bool(after.get("unlinked")), after.get("behind")) == ("study_deleted", True, False)
    # The geometry panel's read agrees: no "from <study>".
    assert link.lost_list(root, "geom-1")["unlinked"] is True
