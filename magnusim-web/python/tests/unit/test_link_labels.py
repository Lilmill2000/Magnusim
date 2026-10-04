"""Linked geometries (host API 1.5), L2 step 2 "labels": the face numbering contract, the
face-name sidecar in magnusim_sdk.link, names and labels in the preview, and the record
rewrite of an update (geometry.plan / geometry.apply), with lost faces, their return,
claimed twice, the stamp check of saves and Forget.

- gate:l2-names: write_face_names is canonical; the checks from a shell; names, labels
  and body_info in cad_preview.json.
- gate:l2-contract: the host's own parts (tests/fixtures/link-contract,
  tools/gen_link_contract_fixtures.py): per index the face table, the mesher's face
  records and the viewport's faceId scalars agree with the expected face, body included;
  a shared face has one index per body; an internal face one; the CLI check passes the
  pairs and refuses broken ones; magnusim_sdk.link.face_visits is the function core uses.
- gate:l2-rewrite: every record kind and every copy (folder record, aggregate rows and
  slots, both meshes' refinements, a draft run's views and result controls); a started
  run untouched; non-label keys kept; idempotent; a study renamed and a mesh deleted
  between plan and apply; a folder moved while the apply holds (MAGNUSIM_TEST_APPLY_PAUSE);
  a legacy row adopted meanwhile; stale-stamped records; names versus faces; 4 studies x 60
  records under 5 s.
- gate:l2-lost: returns by name, held elsewhere, BCs that shared a face, different losses,
  the material's body lost and back; Forget with its stamp; the tree's counts.
- gate:l2-stale (Python side): set_* refuses an old stamp and stamps the checked rev;
  persist_child_item keeps lost_faces and the stamp from disk.

The face map itself is scripts/geometry-face-match.js linkFaceMap (one implementation);
these tests run it with node on the previews of the link-demo exports.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import pathname2url

import pytest

from cfddesk.project import link
from tests.conftest import FIXTURES

pytestmark = pytest.mark.occt

PY = Path(__file__).resolve().parents[2]
WEB = PY.parent
SDK = PY / "sdk"
EXPORTS = FIXTURES / "link-plugins" / "link-demo" / "workspace" / "exports"
CONTRACT = FIXTURES / "link-contract"
NODE = shutil.which("node")

# v1 (tools/gen_link_demo_fixtures.py): Body 1's +x side is faces 6 and 14 (one name),
# its +y side face 12, -x face 1 and 4 (halves), the boss end face 15; Body 2 is 16..21.
# v2: +x is face 10, +y faces 4 and 8, -x face 1, no boss.


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


# ---- magnusim_sdk.link ------------------------------------------------------------------


def test_the_sdk_is_1_3_0_and_its_link_module_imports_without_ocp():
    script = (
        "import sys; sys.path.insert(0, SDK_ROOT); import magnusim_sdk, magnusim_sdk.link as l; "
        "print(magnusim_sdk.SDK_VERSION); print(sorted(m for m in sys.modules if m.split('.')[0] in {'OCP', 'cfddesk', 'numpy'}))"
    ).replace("SDK_ROOT", repr(str(SDK)))
    out = subprocess.run([sys.executable, "-I", "-S", "-c", script], capture_output=True, text=True, check=True, cwd=str(WEB.parent))
    assert out.stdout.split() == ["1.3.0", "[]"], out.stdout


def test_core_numbers_faces_with_the_sdk_walker():
    import magnusim_sdk.link as sdk

    from cfddesk.cad import link_input, preview, step

    assert preview.face_visits is sdk.face_visits
    assert link_input.check_link_shape is sdk.check_shape
    assert link_input.read_link_shape is sdk.read_shape
    assert "face_visits" in step._face_records.__code__.co_names
    assert "face_visits" in step.enumerate_volumes.__code__.co_names


def test_write_face_names_is_canonical(tmp_path: Path):
    from magnusim_sdk.link import write_face_names

    bodies = [{"index": 2, "name": "B", "id": None}, {"name": "A", "index": 1, "label": "Fluid"}]
    faces = [{"index": 2, "body": 1, "name": "F:b"}, {"label": "End", "index": 1, "body": 1, "name": "F:a"}]
    a = write_face_names(tmp_path / "a.json", bodies, faces, "A" * 64)
    b = write_face_names(tmp_path / "b.json", list(reversed(bodies)), list(reversed(faces)), "a" * 64)
    assert a == b == _sha(tmp_path / "a.json")
    assert (tmp_path / "a.json").read_bytes() == (tmp_path / "b.json").read_bytes()
    doc = json.loads((tmp_path / "a.json").read_text(encoding="utf-8"))
    assert [f["index"] for f in doc["faces"]] == [1, 2]
    assert doc["bodies"][1] == {"index": 2, "name": "B"}  # a None value is left out
    assert doc["shape_sha256"] == "a" * 64 and doc["length_unit"] == "mm"
    assert not (tmp_path / "a.json").read_bytes().endswith(b" \n")
    # Compact JSON with sorted keys and one closing newline: what canonical_names_sha256 hashes.
    raw = (tmp_path / "a.json").read_bytes()
    assert raw == (json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def _check_cli(shape: Path, names: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "magnusim_sdk.link", "check", str(shape), str(names)], capture_output=True, text=True, timeout=120
    )


@pytest.mark.parametrize("part", ["a-shared", "b-internal", "c-apart"])
def test_the_cli_check_accepts_each_contract_pair(tmp_path: Path, part: str):
    folder = CONTRACT / part
    proc = _check_cli(folder / "shape.bbrep", folder / "face_names.json")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.strip() == "ok"
    # The text twin, with a sidecar naming its own hash.
    doc = json.loads((folder / "face_names.json").read_text(encoding="utf-8"))
    doc["shape_sha256"] = _sha(folder / "shape.brep")
    names = tmp_path / "text.json"
    names.write_text(json.dumps(doc), encoding="utf-8")
    assert _check_cli(folder / "shape.brep", names).returncode == 0


@pytest.mark.parametrize(
    "broken, message",
    [
        ("swap", "face 7 is in body 2, not 1"),
        ("body", "face 1 is in body 1, not 2"),
        ("count", "11 faces listed, the shape has 12 face visits"),
        ("stale", "shape_sha256 is not the hash of the shape sent with it"),
    ],
)
def test_the_cli_check_refuses_a_broken_pair_with_the_jobs_message(tmp_path: Path, broken: str, message: str):
    folder = CONTRACT / "a-shared"
    doc = json.loads((folder / "face_names.json").read_text(encoding="utf-8"))
    faces = doc["faces"]
    if broken == "swap":
        # Indices 1 (body 1) and 7 (body 2) swapped: each row now names a face of the other body.
        faces[0]["index"], faces[6]["index"] = faces[6]["index"], faces[0]["index"]
    elif broken == "body":
        faces[0]["body"] = 2
    elif broken == "count":
        faces.pop()
    else:
        doc["shape_sha256"] = "0" * 64
    names = tmp_path / "broken.json"
    names.write_text(json.dumps(doc), encoding="utf-8")
    proc = _check_cli(folder / "shape.bbrep", names)
    assert proc.returncode == 1
    assert proc.stdout.startswith("bad_face_names: "), proc.stdout
    assert message in proc.stdout


def test_check_names_the_other_refusals(tmp_path: Path):
    from magnusim_sdk.link import check

    folder = CONTRACT / "c-apart"
    assert check(folder / "shape.bbrep", None, fmt="step")[0].startswith("unsupported_format: ")
    bad = tmp_path / "bad.brep"
    bad.write_bytes(b"not a shape")
    assert check(bad)[0].startswith("bad_brep: ")


# ---- the contract: one face numbering everywhere -----------------------------------------------


def _read(path: Path):
    from magnusim_sdk.link import read_shape

    return read_shape(path).shape


def _expected(part: str) -> dict:
    return json.loads((CONTRACT / part / "expected.json").read_text(encoding="utf-8"))


def _near(a, b, tol=1e-6) -> bool:
    return all(abs(float(x) - float(y)) <= tol for x, y in zip(a, b, strict=True))


@pytest.mark.parametrize("part", ["a-shared", "b-internal", "c-apart"])
@pytest.mark.parametrize("encoding", ["shape.bbrep", "shape.brep"])
def test_the_face_table_the_mesher_and_the_viewport_agree_with_the_defined_faces(part: str, encoding: str):
    from cfddesk.cad.preview import extract_display_faces, face_properties
    from cfddesk.cad.step import _face_records, enumerate_volumes

    shape = _read(CONTRACT / part / encoding)
    exp = _expected(part)
    table = {f["id"]: f for f in face_properties(shape)}
    assert sorted(table) == [f["index"] for f in exp["faces"]]
    records = {r.face_id: r for r in _face_records(shape)}
    for f in exp["faces"]:
        got = table[f["index"]]
        assert got["body"] == f["body"], (part, f)
        assert _near(got["centroid"], f["centroid"]) and abs(got["area"] - f["area"]) <= 1e-6 * max(1.0, f["area"]), (part, f, got)
        rec = records[f["index"] - 1]
        assert _near(rec.centroid, f["centroid"]), (part, f)
    assert extract_display_faces  # the viewport's ids: the next test
    # Each body's own visits in the mesher's body map.
    vols = enumerate_volumes(shape, list(records.values()))
    for v, body in zip(vols, range(1, exp["n_solids"] + 1), strict=True):
        assert sorted(i + 1 for i in v.face_ids) == [f["index"] for f in exp["faces"] if f["body"] == body]


@pytest.mark.parametrize("part", ["a-shared", "b-internal", "c-apart"])
def test_the_viewports_face_ids_and_bodies_follow_the_rule(part: str):
    from cfddesk.cad.preview import extract_display_faces, mesh_for_display, shape_bounds

    shape = _read(CONTRACT / part / "shape.bbrep")
    exp = {f["index"]: f["body"] for f in _expected(part)["faces"]}
    _bounds, box = shape_bounds(shape)
    mesh_for_display(shape, box)
    # (points, normals, triangles, solid ids, face ids): the faceId and solidId scalars of
    # cad_faces.vtp. Every face has triangles, and each triangle's solid is its face's body.
    _pts, _nrm, _tris, solid_ids, face_ids = extract_display_faces(shape)
    assert set(face_ids) == set(exp)
    for fid, sid in zip(face_ids, solid_ids, strict=True):
        assert sid == exp[fid], (part, fid, sid)


def test_a_shared_face_has_one_index_per_body_and_an_internal_face_one():
    shared = _expected("a-shared")
    hits = [f for f in shared["faces"] if _near(f["centroid"], shared["shared_centroid"])]
    assert sorted(f["body"] for f in hits) == [1, 2]
    internal = _expected("b-internal")
    assert [f["index"] for f in internal["faces"] if f["side"] == "internal"] == [7]


# ---- names and labels in the preview ------------------------------------------------------------


@pytest.fixture(scope="module")
def previews(tmp_path_factory) -> dict[str, Path]:
    """link_preview of v1 to v4 (the host's own process, as the job runs it)."""
    root = tmp_path_factory.mktemp("previews")
    out = {}
    for v in ("v1", "v2", "v3", "v4"):
        shape = EXPORTS / f"{v}.bbrep"
        dest = root / v
        report = root / f"{v}.json"
        proc = subprocess.run(
            [sys.executable, "-m", "cfddesk.cad.link_preview", "--shape", str(shape), "--names", str(EXPORTS / f"{v}.face_names.json"),
             "--shape-sha256", _sha(shape), "--out", str(dest), "--report", str(report)],
            cwd=PY, capture_output=True, text=True, timeout=300,
        )
        assert proc.returncode == 0, proc.stderr
        doc = json.loads(report.read_text(encoding="utf-8"))
        assert doc["ok"], doc
        (dest / "preview.json").write_text(json.dumps(doc), encoding="utf-8")
        out[v] = dest
    return out


def test_the_preview_puts_names_labels_and_body_info(previews):
    meta = json.loads((previews["v2"] / "cad_preview.json").read_text(encoding="utf-8"))
    assert meta["bodies"] == ["Body1", "Body2"]  # what today's readers expect
    assert meta["body_info"] == [{"ref": "Body1", "id": "b1", "name": "Fluid"}, {"ref": "Body2", "id": "b2", "name": "Body 2"}]
    plus_x = next(f for f in meta["faces"] if f["id"] == 10)
    assert (plus_x["name"], plus_x["label"], plus_x["body"]) == ("F:box:+x", "Box +x", 1)
    report = json.loads((previews["v2"] / "preview.json").read_text(encoding="utf-8"))
    assert report["bodies"][0] == {"index": 1, "ref": "Body1", "id": "b1", "name": "Fluid"}


# ---- the rewrite ------------------------------------------------------------------------------


def node_map(old_meta: Path, new_meta: Path) -> dict:
    """scripts/geometry-face-match.js linkFaceMap on two cad_preview.json files."""
    if not NODE:
        pytest.fail("node is needed: the face map is scripts/geometry-face-match.js linkFaceMap")
    mod = "file:" + pathname2url(str(WEB / "scripts" / "geometry-face-match.js"))
    script = (
        "import { readFileSync } from 'node:fs';"
        f"import {{ linkFaceMap }} from {json.dumps(mod)};"
        "const [a, b] = JSON.parse(readFileSync(0, 'utf8'));"
        "process.stdout.write(JSON.stringify(linkFaceMap(a, b)));"
    )
    payload = json.dumps([json.loads(old_meta.read_text(encoding="utf-8")), json.loads(new_meta.read_text(encoding="utf-8"))])
    proc = subprocess.run([NODE, "--input-type=module", "-e", script], input=payload, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _write(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")


def _jr(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class Proj:
    """A web project with a geometry linked at v1 (rev 1) and studies with every record kind."""

    def __init__(self, tmp: Path, previews: dict[str, Path], gid: str = "geom-1"):
        self.root = tmp / "projects" / "p1"
        self.root.mkdir(parents=True)
        _write(self.root / "project.json", {"id": "p1", "title": "p1", "geometries": [{"id": gid, "name": "Demo 1"}]})
        self.gid = gid
        self.gdir = self.root / "geometries" / "Geometry_Demo_1"
        (self.gdir / "simulations").mkdir(parents=True)
        for name in ("cad_preview.json", "source.bbrep", "face_names.json"):
            shutil.copyfile(previews["v1"] / name, self.gdir / name)
        _write(self.gdir / "id.json", {"id": gid, "name": "Demo 1", "kind": "geometry",
                                       "source": {"type": "plugin_study", "plugin": "link-demo", "study_id": "st-1", "workspace": "demo", "linked_at": "2026-10-01T00:00:00Z"}})
        report = _jr(previews["v1"] / "preview.json")
        _write(self.gdir / "link" / "state.json", {"rev": 1, "version": 1, "source_version": 1, "name": "Demo 1", "shape_sha256": "a" * 64,
                                                   "n_solids": 2, "n_faces": 21, "bodies": report["bodies"]})
        self.previews = previews

    def study(self, sid: str = "sim-1", name: str = "Study 1") -> Path:
        sdir = self.gdir / "simulations" / name.replace(" ", "_")
        _write(sdir / "id.json", {"id": sid, "name": name, "geometry_id": self.gid, "kind": "simulation"})
        return sdir

    def stage(self, version: str, job: str = "gl-test01-abcdef", same_shape: bool = False) -> str:
        stage = self.root / ".magnusim-staging" / f"link-{job}"
        if stage.exists():
            shutil.rmtree(stage)
        (stage / "new").mkdir(parents=True)
        shutil.copyfile(self.previews[version] / "cad_preview.json", stage / "new" / "cad_preview.json")
        shutil.copyfile(self.previews[version] / "preview.json", stage / "preview.json")
        _write(stage / "job.json", {"job": job, "source_version": 2, "name": "Demo 1", "shape_sha256": "b" * 64})
        if same_shape:
            _write(stage / "map.json", {"identity": True, "body_map": {"Body1": "Body1", "Body2": "Body2"}})
        else:
            _write(stage / "map.json", node_map(self.gdir / "cad_preview.json", stage / "new" / "cad_preview.json"))
        return f".magnusim-staging/link-{job}"

    def commit(self, version: str, from_rev: int, schema_fields=None, same_shape: bool = False) -> dict:
        rel = self.stage(version, same_shape=same_shape)
        planned = link.plan(self.root, self.gid, rel, from_rev, same_shape, schema_fields=schema_fields or {})
        link.apply(self.root, self.gid, rel)
        # The swap's part: the new face table is live now.
        shutil.copyfile(self.root / rel / "new" / "cad_preview.json", self.gdir / "cad_preview.json")
        return planned


BC = "boundary_conditions"


def _full_study(p: Proj) -> Path:
    s = p.study()
    bcs = [
        {"id": "bc-in", "name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 6@Body1"], "face": "face 6@Body1", "value": 5, "unit": "m/s"},
        {"id": "bc-out", "name": "Outlet", "bc_type": "Pressure", "faces": ["face 14@Body1"], "face": "face 14@Body1", "value": 0},
        {"id": "bc-top", "name": "Top", "bc_type": "Wall", "faces": ["face 15@Body1"], "face": "face 15@Body1", "wall_type": "Slip"},
        {"id": "bc-side", "name": "Side", "bc_type": "Wall", "faces": ["face 12@Body1", "face 1@Body1"], "face": "face 12@Body1"},
        {"id": "bc-por", "name": "Porous", "registry_key": "demo_porous", "faces": [], "settings": {"extra_faces": ["face 12@Body1"], "k": 3}},
    ]
    for b in bcs:
        _write(s / BC / f"BC_{b['name']}" / "bc.json", {**b, "simulation_id": "sim-1"})
    # The aggregate holds a copy of each, and a legacy row with no folder (and no id).
    _write(s / f"{BC}.json", {"simulation_id": "sim-1", BC: [*bcs, {"name": "Legacy", "bc_type": "Wall", "faces": ["face 12@Body1"]}], "defaults": {"wall_type": "No-slip"}})
    mat = {"id": "mat-1", "name": "Air", "assigned_volumes": ["Body1", "Body2"], "assigned_volume": "Body1", "body_ids": ["Body1"], "volume_ids": ["Body2"], "density": 1.2}
    _write(s / "materials" / "Material_Air" / "material.json", mat)
    _write(s / "materials.json", {"materials": [mat], "air": mat})
    rc = {"id": "rc-1", "name": "Area average 1", "kind": "area_average", "faces": ["face 6@Body1", "face 12@Body1"], "face_inlet": "face 6@Body1"}
    _write(s / "result_controls" / "RC_AA" / "result_control.json", rc)
    _write(s / "result_controls.json", {"result_controls": [rc], "area_average_1": rc, "surface_data": [rc]})
    for mid, name in (("mesh-1", "Mesh_1"), ("mesh-2", "Mesh_2")):
        mdir = s / "meshes" / name
        _write(mdir / "id.json", {"id": mid, "name": name, "simulation_id": "sim-1", "kind": "mesh"})
        _write(mdir / "mesh.json", {"id": mid, "name": name, "generated": True, "settings": {"mesher": "standard", "fineness": 4}})
        ref = {"id": f"ref-{mid}", "name": "Ref", "mesh_id": mid, "type": "Surface custom sizing", "faces": ["face 12@Body1"],
               "face": "face 12@Body1", "volume_ids": ["Body2"], "face_ids": [11], "start_face_ids": [5]}
        _write(mdir / "refinements" / "Ref_1" / "refinement.json", ref)
        _write(mdir / "refinements.json", {"refinements": [ref]})
    _write(s / "mesh_refinements.json", {"refinements": [{"id": "ref-mesh-1", "mesh_id": "mesh-1", "faces": ["face 12@Body1"]}]})
    for rid, status in (("run-draft", "draft"), ("run-done", "done")):
        rdir = s / "simulation_runs" / rid
        _write(rdir / "id.json", {"id": rid, "name": rid, "simulation_id": "sim-1", "kind": "run"})
        _write(rdir / "run.json", {"id": rid, "run_id": rid, "status": status, "endTime": 100,
                                   "views": [{"name": "Seeds", "pt": {"faces": ["face 6@Body1"], "region": {"face": "face 12@Body1"}}}],
                                   "current_view": {"pt": {"faces": ["face 15@Body1"]}},
                                   "result_controls": [{"id": "rrc-1", "name": "Flow", "faces": ["face 14@Body1"]}]})
        _write(rdir / "result_controls" / "RC_F" / "result_control.json", {"id": "rrc-2", "name": "Force", "faces": ["face 6@Body1"]})
    return s


SCHEMA = {"bc": {"demo_porous": [("extra_faces", "faces")]}}


def _label_free(doc: dict, keys=("faces", "face", "assigned_faces", "lost_faces", "geometry_rev", "assigned_volumes", "assigned_volume",
                                 "body_ids", "volume_ids", "face_ids", "start_face_ids", "views", "current_view", "settings", "result_controls")) -> dict:
    return {k: v for k, v in doc.items() if k not in keys}


def test_every_record_kind_and_copy_is_rewritten_once(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = _full_study(p)
    before = {q: q.read_bytes() for q in s.rglob("*.json")}
    planned = p.commit("v2", 1, SCHEMA)
    assert (planned["change"], planned["rev"]) == ("shape", 2)
    bc = {n: _jr(s / BC / f"BC_{n}" / "bc.json") for n in ("Inlet", "Outlet", "Top", "Side", "Porous")}
    # Merged: the two +x halves were on two BCs: neither keeps the face.
    assert bc["Inlet"]["faces"] == [] and bc["Inlet"]["face"] is None
    assert bc["Inlet"]["lost_faces"][0]["reason"] == "claimed_twice" and bc["Inlet"]["lost_faces"][0]["targets"] == ["face 10@Body1"]
    assert bc["Top"]["faces"] == [] and bc["Top"]["lost_faces"][0]["name"] == "F:boss:end"
    assert bc["Top"]["lost_faces"][0]["fingerprint"]["area"] == pytest.approx(16.0)
    assert sorted(bc["Side"]["faces"]) == ["face 1@Body1", "face 4@Body1", "face 8@Body1"]  # +y split, -x kept
    assert sorted(bc["Porous"]["settings"]["extra_faces"]) == ["face 4@Body1", "face 8@Body1"]  # a schema field
    assert bc["Porous"]["settings"]["k"] == 3
    for rec in bc.values():
        assert rec["geometry_rev"] == 2
    # Every copy: the aggregate rows match their folder records, and the legacy row is patched there.
    agg = _jr(s / f"{BC}.json")
    rows = {r.get("name"): r for r in agg[BC]}
    assert rows["Side"]["faces"] == bc["Side"]["faces"] and rows["Side"]["geometry_rev"] == 2
    # It shared the +y face with Side and Porous: the three keep both halves together.
    assert sorted(rows["Legacy"]["faces"]) == ["face 4@Body1", "face 8@Body1"] and rows["Legacy"]["geometry_rev"] == 2
    assert agg["defaults"] == {"wall_type": "No-slip"}
    # Materials: all four aliases, folder and aggregate and the air slot.
    mat = _jr(s / "materials" / "Material_Air" / "material.json")
    assert (mat["assigned_volumes"], mat["assigned_volume"], mat["body_ids"], mat["volume_ids"]) == (["Body1", "Body2"], "Body1", ["Body1"], ["Body2"])
    assert _jr(s / "materials.json")["air"]["geometry_rev"] == 2
    # Result controls: record, rows and both slots; face_inlet is left as it was.
    rc = _jr(s / "result_controls" / "RC_AA" / "result_control.json")
    assert sorted(rc["faces"]) == ["face 10@Body1", "face 4@Body1", "face 8@Body1"] and rc["face_inlet"] == "face 6@Body1"
    rcs = _jr(s / "result_controls.json")
    assert rcs["area_average_1"]["faces"] == rc["faces"] and rcs["surface_data"][0]["faces"] == rc["faces"]
    # Refinements of both meshes, their integer ids recomputed, the study's leftover rows too.
    for name in ("Mesh_1", "Mesh_2"):
        ref = _jr(s / "meshes" / name / "refinements" / "Ref_1" / "refinement.json")
        assert sorted(ref["faces"]) == ["face 4@Body1", "face 8@Body1"] and ref["face"] == ref["faces"][0]
        assert sorted(ref["face_ids"]) == [3, 7] and ref["volume_ids"] == ["Body2"]
        assert ref["start_face_ids"] == [9]  # 0-based 5 is v1's face 6 (a +x half): face 10 now
        assert _jr(s / "meshes" / name / "refinements.json")["refinements"][0]["faces"] == ref["faces"]
    assert sorted(_jr(s / "mesh_refinements.json")["refinements"][0]["faces"]) == ["face 4@Body1", "face 8@Body1"]
    # The draft run's views and result controls; the started run is history, untouched.
    draft = _jr(s / "simulation_runs" / "run-draft" / "run.json")
    assert draft["views"][0]["pt"]["faces"] == ["face 10@Body1"]
    # A single field on a split face: the nearest half; both are as near here, so the lower index.
    assert draft["views"][0]["pt"]["region"]["face"] == "face 4@Body1"
    assert {"studyId": "sim-1", "studyTitle": "Study 1", "item": "run-draft", "field": "views.0.pt.region.face"} in planned["report"]["split"]
    assert draft["current_view"]["pt"]["faces"] == [] and draft["lost_faces"][0]["field"] == "current_view.pt.faces"
    assert draft["result_controls"][0]["faces"] == ["face 10@Body1"] and draft["geometry_rev"] == 2
    assert _jr(s / "simulation_runs" / "run-draft" / "result_controls" / "RC_F" / "result_control.json")["faces"] == ["face 10@Body1"]
    done = s / "simulation_runs" / "run-done"
    for q in done.rglob("*.json"):
        assert q.read_bytes() == before[q], q
    # Non-label keys are what they were.
    old_side = json.loads(before[s / BC / "BC_Side" / "bc.json"])
    assert _label_free(bc["Side"]) == _label_free(old_side)
    # The report and last-update.json.
    rep = planned["report"]
    assert {(c["target"], tuple(c["items"])) for c in rep["claimed_twice"]} == {("face 10@Body1", ("Inlet", "Outlet"))}
    assert any(lf["item"] == "Top" and lf["label"] == "Boss end" for lf in rep["lost"])
    assert [m["meshName"] for m in rep["out_of_date"]["meshes"]] == ["Mesh_1", "Mesh_2"] and rep["out_of_date"]["runs"] == 1
    last = _jr(p.gdir / "link" / "last-update.json")
    assert (last["rev"], last["from_rev"]) == (2, 1)
    assert last["map"]["12"] == ["face 4@Body1", "face 8@Body1"] and "15" not in last["map"]


def test_a_second_apply_writes_the_same_files(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = _full_study(p)
    rel = p.stage("v2")
    link.plan(p.root, p.gid, rel, 1, False, schema_fields=SCHEMA)
    link.apply(p.root, p.gid, rel)
    first = {q: _jr(q) for q in s.rglob("*.json")}
    # A replay (the recovery after a crash anywhere in the apply) gives the same records.
    link.apply(p.root, p.gid, rel)
    assert {q: _jr(q) for q in s.rglob("*.json")} == first


def test_a_study_renamed_and_a_mesh_deleted_between_plan_and_apply(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = _full_study(p)
    rel = p.stage("v2")
    link.plan(p.root, p.gid, rel, 1, False, schema_fields=SCHEMA)
    moved = s.parent / "Renamed"
    s.rename(moved)
    shutil.rmtree(moved / "meshes" / "Mesh_2")
    out = link.apply(p.root, p.gid, rel)
    assert out["skipped"] >= 2
    assert sorted(_jr(moved / BC / "BC_Side" / "bc.json")["faces"]) == ["face 1@Body1", "face 4@Body1", "face 8@Body1"]
    assert not (moved / "meshes" / "Mesh_2").exists() and not s.exists()


def test_a_legacy_row_adopted_between_plan_and_apply_gets_the_same_set_in_its_folder(tmp_path: Path, previews):
    from cfddesk.project.paths import adopt_legacy_bcs

    p = Proj(tmp_path, previews)
    s = _full_study(p)
    rel = p.stage("v2")
    link.plan(p.root, p.gid, rel, 1, False, schema_fields=SCHEMA)
    # A BC delete adopts the leftover rows into folders (adopt_legacy_bcs) while fenced.
    assert adopt_legacy_bcs(p.root, "sim-1") == 1
    link.apply(p.root, p.gid, rel)
    adopted = next(_jr(q) for q in (s / BC).glob("*/bc.json") if _jr(q).get("name") == "Legacy")
    assert sorted(adopted["faces"]) == ["face 4@Body1", "face 8@Body1"] and adopted["geometry_rev"] == 2


def test_a_folder_moved_while_the_apply_holds_is_found_again(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = _full_study(p)
    rel = p.stage("v2")
    link.plan(p.root, p.gid, rel, 1, False, schema_fields=SCHEMA)
    hold = tmp_path / "hold"
    hold.write_text("x", encoding="utf-8")
    code = (
        "import sys; from pathlib import Path; from cfddesk.project import link;"
        f"print(link.apply(Path({str(p.root)!r}), {p.gid!r}, {rel!r}))"
    )
    env = {**os.environ, "MAGNUSIM_TEST_APPLY_PAUSE": str(hold)}
    proc = subprocess.Popen([sys.executable, "-c", code], cwd=PY, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(2.0)  # it resolved its first patch and waits
    moved = s.parent / "Moved"
    s.rename(moved)
    hold.unlink()
    out, err = proc.communicate(timeout=120)
    assert proc.returncode == 0, err
    assert sorted(_jr(moved / BC / "BC_Side" / "bc.json")["faces"]) == ["face 1@Body1", "face 4@Body1", "face 8@Body1"]
    assert not s.exists(), "a patch never brings a moved folder back"


def test_patch_write_never_creates_a_folder_or_a_file(tmp_path: Path):
    from cfddesk.project.link_rewrite import apply_sets, patch_write

    gone = tmp_path / "gone" / "bc.json"
    with pytest.raises(FileNotFoundError):
        patch_write(gone, lambda d: apply_sets(d, {"faces": []}))
    assert not gone.parent.exists()


def test_a_record_stamped_below_from_rev_is_not_mapped(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = p.study()
    _write(s / BC / "BC_Old" / "bc.json", {"id": "bc-old", "name": "Old", "faces": ["face 12@Body1"], "geometry_rev": 0})
    planned = p.commit("v2", 1)
    rec = _jr(s / BC / "BC_Old" / "bc.json")
    assert rec["faces"] == [] and rec["geometry_rev"] == 2
    assert rec["lost_faces"] == [{"field": "faces", "old": "face 12@Body1", "reason": "stale", "lost_at_rev": 2, "name": None}]
    assert planned["report"]["stale"][0]["item"] == "Old"


def test_names_only_keeps_the_rev_and_a_return_makes_it_faces(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = p.study()
    _write(s / BC / "BC_A" / "bc.json", {"id": "a", "name": "A", "faces": ["face 6@Body1"], "geometry_rev": 1})
    planned = p.commit("v1", 1, same_shape=True)
    assert (planned["change"], planned["rev"], planned["patches"]) == ("names", 1, 0)
    assert _jr(s / BC / "BC_A" / "bc.json") == {"id": "a", "name": "A", "faces": ["face 6@Body1"], "geometry_rev": 1}
    # A lost entry whose name is on the shape again comes back: faces, rev + 1.
    _write(s / BC / "BC_B" / "bc.json", {"id": "b", "name": "B", "faces": [], "geometry_rev": 1,
                                          "lost_faces": [{"field": "faces", "old": "face 99@Body1", "name": "F:boss:end", "body": "Body 1", "body_id": "b1", "lost_at_rev": 1, "reason": "gone"}]})
    planned = p.commit("v1", 1, same_shape=True)
    assert (planned["change"], planned["rev"]) == ("faces", 2)
    back = _jr(s / BC / "BC_B" / "bc.json")
    assert back["faces"] == ["face 15@Body1"] and back["lost_faces"] == [] and back["geometry_rev"] == 2
    assert _jr(s / BC / "BC_A" / "bc.json")["geometry_rev"] == 2


def test_returns_follow_the_bc_rule(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = p.study()
    p.commit("v2", 1)  # the boss is gone at rev 2
    lost = {"field": "faces", "old": "face 15@Body1", "name": "F:boss:end", "label": "Boss end", "body": "Body 1", "body_id": "b1", "lost_at_rev": 2, "reason": "gone"}
    other = {**lost, "old": "face 3@Body1", "lost_at_rev": 1}
    # A and B shared the face when it was lost: both get it back. C lost it in another update: claimed twice.
    _write(s / BC / "BC_A" / "bc.json", {"id": "a", "name": "A", "faces": [], "geometry_rev": 2, "lost_faces": [lost]})
    _write(s / BC / "BC_B" / "bc.json", {"id": "b", "name": "B", "faces": [], "geometry_rev": 2, "lost_faces": [lost]})
    planned = p.commit("v3", 2)
    a, b = _jr(s / BC / "BC_A" / "bc.json"), _jr(s / BC / "BC_B" / "bc.json")
    assert a["faces"] == b["faces"] == ["face 3@Body1"] and a["lost_faces"] == b["lost_faces"] == []
    assert len(planned["report"]["returned"]) == 2
    # Two different losses finding one face: neither takes it.
    p2 = Proj(tmp_path / "two", previews)
    s2 = p2.study()
    p2.commit("v2", 1)
    _write(s2 / BC / "BC_A" / "bc.json", {"id": "a", "name": "A", "faces": [], "geometry_rev": 2, "lost_faces": [lost]})
    _write(s2 / BC / "BC_C" / "bc.json", {"id": "c", "name": "C", "faces": [], "geometry_rev": 2, "lost_faces": [other]})
    p2.commit("v3", 2)
    for n in ("A", "C"):
        rec = _jr(s2 / BC / f"BC_{n}" / "bc.json")
        assert rec["faces"] == [] and rec["lost_faces"][0]["reason"] == "claimed_twice" and rec["lost_faces"][0]["targets"] == ["face 3@Body1"]



def test_two_bcs_that_shared_a_face_keep_sharing_it_and_two_that_merge_are_claimed_twice(tmp_path: Path, previews):
    # v1's +y face (12) splits into 4 and 8 in v2; its +x halves (6 and 14) merge into 10.
    p = Proj(tmp_path, previews)
    s = p.study()
    _write(s / BC / "BC_A" / "bc.json", {"id": "a", "name": "A", "faces": ["face 12@Body1"], "geometry_rev": 1})
    _write(s / BC / "BC_B" / "bc.json", {"id": "b", "name": "B", "faces": ["face 12@Body1"], "geometry_rev": 1})
    _write(s / BC / "BC_In" / "bc.json", {"id": "in", "name": "In", "faces": ["face 6@Body1"], "geometry_rev": 1})
    _write(s / BC / "BC_Out" / "bc.json", {"id": "out", "name": "Out", "faces": ["face 14@Body1"], "geometry_rev": 1})
    planned = p.commit("v2", 1)
    for n in ("A", "B"):
        rec = _jr(s / BC / f"BC_{n}" / "bc.json")
        assert sorted(rec["faces"]) == ["face 4@Body1", "face 8@Body1"] and not rec.get("lost_faces"), rec
    for n in ("In", "Out"):
        rec = _jr(s / BC / f"BC_{n}" / "bc.json")
        assert rec["faces"] == [] and rec["lost_faces"][0]["reason"] == "claimed_twice", rec
    claims = planned["report"]["claimed_twice"]
    assert [c["items"] for c in claims] == [["In", "Out"]] and claims[0]["target"] == "face 10@Body1"


def test_a_return_another_bc_holds_stays_listed_as_held_elsewhere(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = p.study()
    # At rev 1 the boss end (face 15) is on H. A lost it in an earlier update and finds it
    # again by name now (a names-only commit that brings a face back): H keeps it, A's
    # entry stays, held elsewhere. A refinement with the same entry takes it back anyway.
    lost = {"field": "faces", "old": "face 9@Body1", "name": "F:boss:end", "label": "Boss end", "body": "Body 1", "body_id": "b1", "lost_at_rev": 1, "reason": "gone"}
    _write(s / BC / "BC_H" / "bc.json", {"id": "h", "name": "H", "faces": ["face 15@Body1"], "geometry_rev": 1})
    _write(s / BC / "BC_A" / "bc.json", {"id": "a", "name": "A", "faces": [], "geometry_rev": 1, "lost_faces": [lost]})
    _write(s / "meshes" / "M" / "id.json", {"id": "m1", "name": "M", "simulation_id": "sim-1", "kind": "mesh"})
    _write(s / "meshes" / "M" / "mesh.json", {"id": "m1", "name": "M"})
    _write(s / "meshes" / "M" / "refinements" / "R" / "refinement.json", {"id": "r", "name": "R", "mesh_id": "m1", "faces": [], "geometry_rev": 1, "lost_faces": [lost]})
    planned = p.commit("v1", 1, same_shape=True)
    assert planned["change"] == "faces"
    a = _jr(s / BC / "BC_A" / "bc.json")
    assert a["faces"] == [] and a["lost_faces"][0]["reason"] == "held_elsewhere"
    assert _jr(s / BC / "BC_H" / "bc.json")["faces"] == ["face 15@Body1"]
    assert _jr(s / "meshes" / "M" / "refinements" / "R" / "refinement.json")["faces"] == ["face 15@Body1"]


def test_an_ambiguous_name_group_maps_only_for_the_record_that_held_all_of_it(tmp_path: Path, previews):
    # v1's top is two faces with one name (3 and 7) and so is v2's, at other places: the map
    # cannot pair them, so only a record that held both (and nobody else holding either) keeps them.
    p = Proj(tmp_path, previews)
    s = p.study()
    _write(s / BC / "BC_Roof" / "bc.json", {"id": "roof", "name": "Roof", "faces": ["face 3@Body1", "face 7@Body1"], "geometry_rev": 1})
    p.commit("v2", 1)
    assert sorted(_jr(s / BC / "BC_Roof" / "bc.json")["faces"]) == ["face 3@Body1", "face 7@Body1"]
    q = Proj(tmp_path / "split", previews)
    t = q.study()
    _write(t / BC / "BC_A" / "bc.json", {"id": "a", "name": "A", "faces": ["face 3@Body1"], "geometry_rev": 1})
    _write(t / BC / "BC_B" / "bc.json", {"id": "b", "name": "B", "faces": ["face 7@Body1"], "geometry_rev": 1})
    q.commit("v2", 1)
    for n in ("A", "B"):
        rec = _jr(t / BC / f"BC_{n}" / "bc.json")
        assert rec["faces"] == [] and rec["lost_faces"][0]["reason"] == "gone", rec


def test_a_material_body_lost_and_back(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = p.study()
    p.commit("v2", 1)
    # Body 2 gone in an update (the map has no pair for it): its entry, then its return.
    _write(s / "materials" / "Material_Air" / "material.json",
           {"id": "m", "name": "Air", "assigned_volumes": [], "geometry_rev": 2,
            "lost_faces": [{"field": "assigned_volumes", "old": "Body2", "name": "Body 2", "body": "Body 2", "body_id": "b2", "lost_at_rev": 2, "reason": "gone"}]})
    planned = p.commit("v3", 2)
    m = _jr(s / "materials" / "Material_Air" / "material.json")
    assert m["assigned_volumes"] == ["Body2"] and m["lost_faces"] == []
    assert planned["report"]["returned"][0]["kind"] == "material"


def test_4_studies_with_60_records_plan_and_apply_in_under_5_s(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    for k in range(4):
        s = p.study(f"sim-{k}", f"Study {k}")
        for i in range(60):
            _write(s / BC / f"BC_{i}" / "bc.json", {"id": f"bc-{i}", "name": f"B{i}", "faces": ["face 12@Body1", "face 1@Body1"], "geometry_rev": 1})
        _write(s / f"{BC}.json", {BC: [_jr(q) for q in sorted((s / BC).glob("*/bc.json"))]})
    rel = p.stage("v2")
    t0 = time.perf_counter()
    link.plan(p.root, p.gid, rel, 1, False)
    link.apply(p.root, p.gid, rel)
    took = time.perf_counter() - t0
    assert took < 5.0, f"{took:.2f} s"


# ---- saves: the stamp, and what writers keep ---------------------------------------------------


def test_persist_child_item_keeps_lost_faces_and_the_stamp_from_disk(tmp_path: Path, monkeypatch):
    from cfddesk.project import paths, web_writes

    parent = tmp_path / "bcs"
    paths.persist_child_item(parent, "bc", {"id": "b", "name": "B", "faces": [], "lost_faces": ["sent"], "geometry_rev": 9})
    first = _jr(next(parent.glob("*/bc.json")))
    assert "lost_faces" not in first and "geometry_rev" not in first  # a new record keeps neither
    path = next(parent.glob("*/bc.json"))
    _write(path, {**first, "lost_faces": [{"old": "face 1"}], "geometry_rev": 3})
    paths.persist_child_item(parent, "bc", {"id": "b", "name": "B", "faces": ["face 2"], "lost_faces": [], "geometry_rev": 1})
    kept = _jr(path)
    assert kept["lost_faces"] == [{"old": "face 1"}] and kept["geometry_rev"] == 3 and kept["faces"] == ["face 2"]
    paths.persist_child_item(parent, "bc", {"id": "b", "name": "B", "faces": []}, geometry_rev=4)
    assert _jr(path)["geometry_rev"] == 4
    # Atomic: written through atomic_write (a temp file, then a replace).
    seen = []
    real = web_writes.atomic_write
    monkeypatch.setattr(web_writes, "atomic_write", lambda p_, d: (seen.append(p_.name), real(p_, d)))
    paths.persist_child_item(parent, "bc", {"id": "b", "name": "B", "faces": []})
    assert seen == ["id.json", "bc.json"]
    # A legacy row given its folder keeps the row's own.
    paths.persist_child_item(parent, "bc", {"id": "row", "name": "Row", "lost_faces": [{"old": "x"}], "geometry_rev": 2}, keep_row=True)
    row = next(_jr(q) for q in parent.glob("*/bc.json") if _jr(q)["id"] == "row")
    assert row["lost_faces"] == [{"old": "x"}] and row["geometry_rev"] == 2


def test_set_bcs_refuses_an_old_stamp_and_stamps_the_checked_rev(tmp_path: Path, previews):
    from cfddesk.project.web_writes import set_bcs

    p = Proj(tmp_path, previews)
    p.study()
    p.commit("v2", 1)  # rev 2
    body = {"boundary_conditions": [{"id": "bc-1", "name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 10@Body1"], "geometry_rev": 1}], "simulation_id": "sim-1"}
    with pytest.raises(link.LinkError) as err:
        set_bcs(p.root, body, sim_id="sim-1")
    assert err.value.code == "geometry_changed" and err.value.message == "Demo 1 was updated. This change was not saved."
    assert not (p.gdir / "simulations" / "Study_1" / BC).exists(), "nothing was written"
    body["boundary_conditions"][0]["geometry_rev"] = 2
    set_bcs(p.root, body, sim_id="sim-1")
    assert _jr(next((p.gdir / "simulations" / "Study_1" / BC).glob("*/bc.json")))["geometry_rev"] == 2
    # The app server passes the rev it checked; the record's own stamp is ignored then.
    with pytest.raises(link.LinkError):
        set_bcs(p.root, body, sim_id="sim-1", geometry_rev=1)
    body["boundary_conditions"][0]["geometry_rev"] = 7
    set_bcs(p.root, body, sim_id="sim-1", geometry_rev=2)
    assert _jr(next((p.gdir / "simulations" / "Study_1" / BC).glob("*/bc.json")))["geometry_rev"] == 2
    # Fenced: updating.
    (p.gdir / "link" / "commit.json").write_text("{}", encoding="utf-8")
    with pytest.raises(link.LinkError) as err:
        set_bcs(p.root, body, sim_id="sim-1", geometry_rev=2)
    assert err.value.code == "geometry_updating" and err.value.message == "Updating Demo 1. Try again in a moment."


def test_a_study_on_a_geometry_no_link_made_needs_no_stamp(tmp_path: Path):
    from cfddesk.project.web_writes import set_bcs

    root = tmp_path / "projects" / "p1"
    _write(root / "project.json", {"id": "p1", "geometries": [{"id": "g"}]})
    _write(root / "geometries" / "G" / "id.json", {"id": "g", "name": "Plate"})
    _write(root / "geometries" / "G" / "simulations" / "S" / "id.json", {"id": "sim-1", "name": "S", "geometry_id": "g"})
    set_bcs(root, {"boundary_conditions": [{"id": "b", "name": "B", "faces": ["face 1@Body1"]}], "simulation_id": "sim-1"}, sim_id="sim-1")
    assert "geometry_rev" not in _jr(next((root / "geometries" / "G" / "simulations" / "S" / BC).glob("*/bc.json")))


def test_forget_needs_the_shown_rev_and_removes_every_copy(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = _full_study(p)
    p.commit("v2", 1, SCHEMA)
    assert _jr(s / BC / "BC_Top" / "bc.json")["lost_faces"]
    with pytest.raises(link.LinkError) as err:
        link.forget_lost(p.root, p.gid, 1, "sim-1", "bc", "bc-top")
    assert err.value.code == "geometry_changed"
    entry = _jr(s / BC / "BC_Top" / "bc.json")["lost_faces"][0]
    out = link.forget_lost(p.root, p.gid, 2, "sim-1", "bc", "bc-top", entry={"field": entry["field"], "old": entry["old"]})
    assert out["removed"] == 1
    assert _jr(s / BC / "BC_Top" / "bc.json")["lost_faces"] == []
    assert next(r for r in _jr(s / f"{BC}.json")[BC] if r.get("id") == "bc-top")["lost_faces"] == []
    # Forget all (the geometry panel): every record of the geometry.
    assert link.forget_lost(p.root, p.gid, 2)["removed"] >= 2
    assert link.lost_counts(p.root, p.gid) == {}
    (p.gdir / "link" / "commit.json").write_text("{}", encoding="utf-8")
    with pytest.raises(link.LinkError) as err:
        link.forget_lost(p.root, p.gid, 2)
    assert err.value.code == "geometry_updating"


def test_the_tree_and_the_panel_count_lost_faces(tmp_path: Path, previews):
    from cfddesk.project.scope import build_project_tree

    p = Proj(tmp_path, previews)
    _full_study(p)
    p.commit("v2", 1, SCHEMA)
    tree = build_project_tree(p.root, "p1")
    node = tree["geometries"][0]
    assert node["rev"] == 2
    assert node["lost_faces"] == sum(link.lost_counts(p.root, p.gid).values()) >= 3
    assert node["body_labels"][0] == {"ref": "Body1", "name": "Fluid", "label": None}  # renamed in v2, same id
    study = node["studies"][0]
    bcs = {b["name"]: b for b in study["bcs"]}
    assert bcs["Top"]["lost"] == 1 and "lost" not in bcs["Side"]
    panel = link.lost_list(p.root, p.gid)
    assert panel["linked"] and panel["last_update"]["rev"] == 2
    assert any(e["item"] == "Top" and e["label"] == "Boss end" for e in panel["entries"])


def test_the_tree_lists_a_linked_geometrys_bodies(tmp_path: Path, previews):
    # Its part row carries one body ref per solid, as an import's does: the tree's body rows.
    from cfddesk.project.scope import build_project_tree

    p = Proj(tmp_path, previews)
    p.commit("v2", 1)
    link.upsert_geometry(p.root, {"id": p.gid, "name": "Demo 1", "n_solids": 2})
    node = build_project_tree(p.root, "p1")["geometries"][0]
    assert node["bodies"] == ["Body1", "Body2"]


# ---- claimed twice across two updates, runs that can still start, monitors on runs ----------


def _node_refusal(root: Path, tmp: Path) -> dict | None:
    """scripts/link-build.js linkStartRefusal for study sim-1 of project p1 (what Generate and Start meet)."""
    if not NODE:
        pytest.fail("node is needed: the refusal is scripts/link-build.js linkStartRefusal")
    mod = "file:" + pathname2url(str(WEB / "scripts" / "link-build.js"))
    script = f"import {{ linkStartRefusal }} from {json.dumps(mod)}; process.stdout.write(JSON.stringify(linkStartRefusal('p1', 'sim-1')));"
    env = {**os.environ, "MAGNUSIM_PROJECTS_ROOT": str(root.parent), "MAGNUSIM_LOCAL_JSON": str(tmp / "none.json")}
    proc = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=120, cwd=str(WEB), env=env)
    assert proc.returncode == 0, proc.stderr[-2000:]
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _claimed_text(face: str) -> str:
    return f"Face '{face}' was in Inlet and Outlet after Demo 1 changed. Pick which one keeps it."


def _x_halves(p: Proj) -> Path:
    # v1's two +x halves (6 and 14) on two BCs: v2 merges them into face 10, v3 has it as face 12.
    s = p.study()
    for name, face in (("Inlet", "face 6@Body1"), ("Outlet", "face 14@Body1")):
        _write(
            s / BC / f"BC_{name}" / "bc.json",
            {"id": f"bc-{name}", "name": name, "bc_type": "Wall", "faces": [face], "face": face, "simulation_id": "sim-1", "geometry_rev": 1},
        )
    return s


def _take(s: Path, name: str, face: str) -> None:
    bc = _jr(s / BC / f"BC_{name}" / "bc.json")
    bc["faces"], bc["face"] = [face], face
    _write(s / BC / f"BC_{name}" / "bc.json", bc)


def test_a_face_claimed_twice_names_the_merged_face_after_the_next_update_too(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = _x_halves(p)
    p.commit("v2", 1)
    assert _node_refusal(p.root, tmp_path)["bodyExtra"]["error"] == _claimed_text("Box +x")
    p.commit("v3", 2)
    for name in ("Inlet", "Outlet"):
        entries = _jr(s / BC / f"BC_{name}" / "bc.json")["lost_faces"]
        assert [(e["reason"], e["targets"]) for e in entries] == [("claimed_twice", ["face 12@Body1"])], name
    # v3's face 10 is Box -x: the refusal must still name Box +x (face 12).
    assert _node_refusal(p.root, tmp_path)["bodyExtra"]["error"] == _claimed_text("Box +x")
    _take(s, "Inlet", "face 12@Body1")
    assert _node_refusal(p.root, tmp_path) is None, "resolved the way the message asked"


def test_a_claim_resolved_after_one_update_stays_resolved_after_the_next(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = _x_halves(p)
    p.commit("v2", 1)
    _take(s, "Inlet", "face 10@Body1")  # the user gives v2's merged +x face to Inlet
    assert _node_refusal(p.root, tmp_path) is None
    p.commit("v3", 2)
    assert _jr(s / BC / "BC_Inlet" / "bc.json")["faces"] == ["face 12@Body1"]
    for name in ("Inlet", "Outlet"):
        for e in _jr(s / BC / f"BC_{name}" / "bc.json")["lost_faces"]:
            assert e.get("targets") in (None, ["face 12@Body1"]), (name, e)
    assert _node_refusal(p.root, tmp_path) is None


def _rename_entries(s: Path, **fields) -> None:
    for name in ("Inlet", "Outlet"):
        bc = _jr(s / BC / f"BC_{name}" / "bc.json")
        for e in bc["lost_faces"]:
            e.pop("fingerprint", None)
            e.update(fields)
        _write(s / BC / f"BC_{name}" / "bc.json", bc)


def test_a_claimed_twice_entry_holds_labels_of_the_current_rev_only(tmp_path: Path, previews):
    # Found again by nothing (no name, no fingerprint): its target follows the map, 10 -> 12.
    p = Proj(tmp_path, previews)
    s = _x_halves(p)
    p.commit("v2", 1)
    _rename_entries(s, name="F:nowhere", label=None)
    p.commit("v3", 2)
    for name in ("Inlet", "Outlet"):
        assert [e["targets"] for e in _jr(s / BC / f"BC_{name}" / "bc.json")["lost_faces"]] == [["face 12@Body1"]], name
    assert _node_refusal(p.root, tmp_path)["bodyExtra"]["error"] == _claimed_text("Box +x")
    # Found again elsewhere by both (here the boss end, v3's face 3): only that face, not the old target too.
    q = Proj(tmp_path / "found", previews)
    t = _x_halves(q)
    q.commit("v2", 1)
    _rename_entries(t, name="F:boss:end", label="Boss end")
    q.commit("v3", 2)
    for name in ("Inlet", "Outlet"):
        assert [e["targets"] for e in _jr(t / BC / f"BC_{name}" / "bc.json")["lost_faces"]] == [["face 3@Body1"]], name


@pytest.mark.parametrize("status", ["draft", "stopped", "failed", "running"])
def test_a_run_that_can_still_start_is_rewritten_like_a_draft(tmp_path: Path, previews, status: str):
    from magnusim_sdk.study import run_custom_monitors

    from cfddesk.project.paths import find_run

    p = Proj(tmp_path, previews)
    s = p.study()
    rdir = s / "simulation_runs" / "run-1"
    _write(rdir / "id.json", {"id": "run-1", "name": "Run 1", "simulation_id": "sim-1", "kind": "run"})
    _write(
        rdir / "run.json",
        {
            "id": "run-1",
            "run_id": "run-1",
            "status": status,
            "built_from": {"geometry_rev": 1},
            "views": [{"name": "Seeds", "pt": {"faces": ["face 6@Body1"]}}],
            "result_controls": [{"id": "rc-1", "name": "Area average 1", "kind": "Area average", "faces": ["face 6@Body1"]}],
        },
    )
    p.commit("v2", 1)
    doc = _jr(rdir / "run.json")
    # v1's face 6 (a +x half) is v2's face 10; v2's face 6 is Box -y.
    assert doc["result_controls"][0]["faces"] == ["face 10@Body1"]
    assert doc["views"][0]["pt"]["faces"] == ["face 10@Body1"]
    assert doc["geometry_rev"] == 2 and doc["status"] == status
    run = find_run(p.root, "run-1", "sim-1")
    assert run is not None
    monitors = run_custom_monitors(run["result_controls"])
    assert monitors == [{"id": "rc-1", "name": "Area average 1", "faces": ["face 10@Body1"]}], "what its next Start writes"


def test_a_monitor_of_a_plugin_that_is_off_on_a_run_refuses_the_update(tmp_path: Path, previews):
    p = Proj(tmp_path, previews)
    s = p.study()
    rdir = s / "simulation_runs" / "run-1"
    _write(rdir / "id.json", {"id": "run-1", "name": "Run 1", "simulation_id": "sim-1", "kind": "run"})
    rc = {"id": "rc-p", "name": "Probe 1", "kind": "demo_probe", "faces": ["face 6@Body1"], "settings": {"probe_faces": ["face 6@Body1"]}}
    _write(rdir / "run.json", {"id": "run-1", "run_id": "run-1", "status": "draft", "result_controls": [rc]})
    before = (rdir / "run.json").read_bytes()
    known = {"bc": set(), "monitor": {"area_average", "flow_rate"}, "mesher": {"standard"}}
    found = link.check_kinds(p.root, p.gid, known, [], WEB)
    assert [(e["kind"], e["key"], [r["name"] for r in e["records"]]) for e in found] == [("run_result_control", "demo_probe", ["Probe 1"])]
    rel = p.stage("v2")
    with pytest.raises(link.LinkError) as err:
        link.plan(p.root, p.gid, rel, 1, False, known=known, web_root=WEB, schema_fields={})
    assert err.value.code == "plugin_needed"
    assert (rdir / "run.json").read_bytes() == before
    use = link.usage(p.root, p.gid, known, [], WEB)
    assert use["studies"] == [], "a draft run alone is no saved setup: no question, the call refuses"


def test_a_core_monitor_saved_under_its_label_is_its_registry_key(tmp_path: Path, previews):
    # The app saves an area average as kind 'Area average' (its label), on the study and on runs.
    p = Proj(tmp_path, previews)
    s = p.study()
    rc = {"id": "rc-1", "name": "Area average 1", "kind": "Area average", "faces": ["face 6@Body1"]}
    _write(s / "result_controls" / "RC_AA" / "result_control.json", rc)
    rdir = s / "simulation_runs" / "run-1"
    _write(rdir / "id.json", {"id": "run-1", "name": "Run 1", "simulation_id": "sim-1", "kind": "run"})
    _write(rdir / "run.json", {"id": "run-1", "run_id": "run-1", "status": "draft", "result_controls": [{**rc, "id": "rc-2"}]})
    known = {"bc": set(), "monitor": {"area_average", "flow_rate"}, "mesher": {"standard"}}
    assert link.check_kinds(p.root, p.gid, known, [], WEB) == []
    # Its plugin off: the key and its owner are known from the generated registry.
    off = link.check_kinds(p.root, p.gid, {**known, "monitor": set()}, [], WEB)
    assert sorted((e["kind"], e["key"], e["owner"]) for e in off) == [
        ("result_control", "area_average", "incompressible_flow"),
        ("run_result_control", "area_average", "incompressible_flow"),
    ]
    rel = p.stage("v2")
    planned = link.plan(p.root, p.gid, rel, 1, False, known=known, web_root=WEB, schema_fields={})
    assert planned["change"] == "shape"


def test_a_family_record_whose_plugin_is_off_is_its_own_kind_with_its_owner(tmp_path: Path, previews):
    # What the BC panel saves for a family: bc_type, the family's fields, no registry_key.
    p = Proj(tmp_path, previews)
    s = p.study()
    _write(
        s / BC / "BC_P" / "bc.json",
        {"id": "bc-p", "name": "Porous", "bc_type": "Demo porous", "faces": [], "extra_faces": ["face 12@Body1"], "simulation_id": "sim-1"},
    )
    _write(s / BC / "BC_Old" / "bc.json", {"id": "bc-o", "name": "Old", "faces": ["face 1@Body1"], "simulation_id": "sim-1"})
    web = tmp_path / "web"
    _write(
        web / "scripts" / "generated" / "registry.json",
        {
            "bc": [{"key": "demo_porous", "plugin": "porous-pack"}],
            "bc_family": [{"key": "porous", "record_type": "Demo porous", "aliases": [], "plugin": "porous-pack"}],
            "monitor": [],
            "mesher": [],
            "plugins": [{"key": "porous-pack", "name": "Porous pack"}],
        },
    )
    catalog = [{"key": "porous-pack", "name": "Porous pack", "source": "bundled", "status": "disabled"}]
    found = link.check_kinds(p.root, p.gid, {"bc": {"wall_noslip"}, "monitor": set(), "mesher": set()}, catalog, web)
    # Never read as a no-slip wall; a record with no bc_type at all still is one.
    got = [(e["key"], e["owner"], e["bundled_off"], [r["name"] for r in e["records"]]) for e in found]
    assert got == [("Demo porous", "porous-pack", True, ["Porous"])]


def _stage_with_centroids(p: Proj, version: str, centroids: dict[int, list[float]]) -> str:
    """A staged update whose new face table puts some faces' centroids elsewhere (the map is built from it)."""
    rel = p.stage(version)
    staged = p.root / rel / "new" / "cad_preview.json"
    meta = _jr(staged)
    for f in meta["faces"]:
        if int(f["id"]) in centroids:
            f["centroid"] = centroids[int(f["id"])]
    _write(staged, meta)
    _write(p.root / rel / "map.json", node_map(p.gdir / "cad_preview.json", staged))
    return rel


def test_a_single_face_field_takes_the_nearest_half_of_a_split_face_and_the_report_lists_it(tmp_path: Path, previews):
    # v1's +y face (12, centroid x=5) splits into v2's faces 4 and 8; here 8 is the nearer
    # half (x=5.5) and 4 the farther (x=1), so the nearest is not the lowest index.
    p = Proj(tmp_path, previews)
    s = p.study()
    rdir = s / "simulation_runs" / "run-1"
    _write(rdir / "id.json", {"id": "run-1", "name": "Run 1", "simulation_id": "sim-1", "kind": "run"})
    _write(
        rdir / "run.json",
        {"id": "run-1", "run_id": "run-1", "name": "Run 1", "status": "draft", "views": [{"name": "Seeds", "pt": {"faces": [], "region": {"face": "face 12@Body1"}}}]},
    )
    rel = _stage_with_centroids(p, "v2", {4: [1.0, 20.0, 15.0], 8: [5.5, 20.0, 15.0]})
    planned = link.plan(p.root, p.gid, rel, 1, False, schema_fields={})
    link.apply(p.root, p.gid, rel)
    assert _jr(rdir / "run.json")["views"][0]["pt"]["region"]["face"] == "face 8@Body1"
    assert {"studyId": "sim-1", "studyTitle": "Study 1", "item": "Run 1", "field": "views.0.pt.region.face"} in planned["report"]["split"]


def test_the_setup_report_names_only_faces_a_record_refers_to(tmp_path: Path, previews):
    """The host's report (5.14) lists faces records hold, by record: never a face no record holds.

    v1 to v4 (10 mm taller): six faces kept by name moved far (the boss and Body 2's top), the
    bottoms did not move. v1 to v2: Body 1's +y face split, its two +x halves merged.
    """
    p = Proj(tmp_path, previews)
    s = p.study()
    _write(s / BC / "BC_Floor" / "bc.json", {"id": "floor", "name": "Floor", "faces": ["face 20@Body2"], "face": "face 20@Body2", "geometry_rev": 1})
    rep = p.commit("v4", 1)["report"]
    # The part's own statistics still count every face (LinkResult.match, the plugin's).
    assert rep["match"]["movedFar"] == 6 and len(rep["moved_far"]) == 6
    assert rep["setup"] == {"moved_far": [], "split": [], "merged": []}
    q = Proj(tmp_path / "boss", previews)
    t = q.study()
    _write(t / BC / "BC_Top" / "bc.json", {"id": "top", "name": "Top", "faces": ["face 15@Body1"], "face": "face 15@Body1", "geometry_rev": 1})
    _write(t / BC / "BC_Floor" / "bc.json", {"id": "floor", "name": "Floor", "faces": ["face 20@Body2"], "geometry_rev": 1})
    rep = q.commit("v4", 1)["report"]
    assert rep["setup"]["moved_far"] == [
        {"studyId": "sim-1", "studyTitle": "Study 1", "kind": "bc", "item": "Top", "field": "faces", "old": "face 15@Body1", "name": "F:boss:end", "label": "Boss end"}
    ]
    assert rep["setup"]["split"] == [] and rep["setup"]["merged"] == []
    # v1 to v2: a record on the split +y face, one holding both +x halves, one on Body 2's -x (unchanged).
    r = Proj(tmp_path / "v2", previews)
    u = r.study()
    _write(u / BC / "BC_Side" / "bc.json", {"id": "side", "name": "Side", "faces": ["face 12@Body1"], "geometry_rev": 1})
    _write(u / BC / "BC_Front" / "bc.json", {"id": "front", "name": "Front", "faces": ["face 6@Body1", "face 14@Body1"], "geometry_rev": 1})
    _write(u / BC / "BC_Far" / "bc.json", {"id": "far", "name": "Far", "faces": ["face 16@Body2"], "geometry_rev": 1})
    rep = r.commit("v2", 1)["report"]
    assert rep["match"]["split"] == 3 and rep["match"]["merged"] == 2
    assert [(f["item"], f["label"], f["faces"]) for f in rep["setup"]["split"]] == [("Side", "Box +y", 2)]
    assert [(f["item"], f["target"], f["faces"]) for f in rep["setup"]["merged"]] == [("Front", "face 10@Body1", 2)]
    assert rep["setup"]["moved_far"] == []
