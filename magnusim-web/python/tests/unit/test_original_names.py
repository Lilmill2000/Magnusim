"""The adoption's original names (host API 1.7): ``geometry.adopt_names``.

The page sends a face-name file of the ORIGINAL geometry (``originalNames``); the host
checks it against the geometry's face table and writes ``<staging>/old_named.json``, the
table with each face's name and label and the bodies' ids, which the face map starts from.
A file that does not describe the geometry is refused ``bad_face_names`` with the rule it
breaks; with no file the table is written without names (faces follow by shape).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from cfddesk.project import geometry_actions as ga
from cfddesk.project import link
from tests.conftest import FIXTURES

FX = FIXTURES / "edit-plugins" / "edit-demo" / "workspace" / "fixtures"


def _setup(tmp_path: Path, names: dict | None) -> tuple[Path, str]:
    root = tmp_path / "p1"
    gdir = root / "geometries" / "Geometry_box"
    gdir.mkdir(parents=True)
    (root / "project.json").write_text(json.dumps({"id": "p1", "geometries": [{"id": "geom-box", "name": "box", "source_kind": "step"}]}), encoding="utf-8")
    (gdir / "id.json").write_text(json.dumps({"id": "geom-box", "name": "box", "original_filename": "box.step"}), encoding="utf-8")
    shutil.copyfile(FX / "box.step", gdir / "source.step")
    # The host's face table of box.step (its fingerprints are the fixture's, read from the STEP).
    good = _good()["faces"]
    rows = [{"id": f["index"], "body": 1, "area": f["area"], "centroid": f["centroid"], "normal": f["normal"], "surface_type": "Plane"} for f in good]
    bounds = {"xmin": 0, "xmax": 20, "ymin": 0, "ymax": 20, "zmin": 0, "zmax": 20}
    (gdir / "cad_preview.json").write_text(json.dumps({"n_solids": 1, "faces": rows, "bounds": bounds}), encoding="utf-8")
    stage = root / ".magnusim-staging" / "link-gl-1"
    (stage / "in").mkdir(parents=True)
    if names is not None:
        (stage / "in" / "original_names").write_text(json.dumps(names), encoding="utf-8")
    return root, ".magnusim-staging/link-gl-1"


def _good(name: str = "box.original_names.json") -> dict:
    return json.loads((FX / name).read_text(encoding="utf-8"))


def test_a_good_file_names_the_original_faces(tmp_path: Path):
    root, rel = _setup(tmp_path, _good())
    got = ga.adopt_names(root, "geom-box", rel)
    assert (got["ok"], got["named"], got["unverified"], got["faces"], got["bodies"]) == (True, 6, 0, 6, 1)
    named = json.loads((root / rel / "old_named.json").read_text(encoding="utf-8"))
    assert [f["name"] for f in named["faces"]][:2] == ["F:box:-x", "F:box:+x"]
    assert named["faces"][5]["label"] == "Box +z" and named["faces"][5]["area"] == 400.0
    assert named["body_info"] == [{"ref": "Body1", "id": "b1", "name": "Box", "label": None}]
    # The face map reads it as the old table.
    from cfddesk.project.link_rewrite import FaceMap

    fmap = FaceMap.load(root / rel, root / "geometries" / "Geometry_box", {})
    assert fmap.old.faces[6]["name"] == "F:box:+z" and fmap.old.bodies["Body1"]["id"] == "b1"


def test_no_file_writes_the_table_without_names(tmp_path: Path):
    root, rel = _setup(tmp_path, None)
    assert ga.adopt_names(root, "geom-box", rel)["named"] == 0
    named = json.loads((root / rel / "old_named.json").read_text(encoding="utf-8"))
    assert all("name" not in f for f in named["faces"]) and named["body_info"][0]["ref"] == "Body1"


@pytest.mark.parametrize(
    "breaks, rule",
    [
        (lambda d: d.update(shape_sha256="0" * 64), "shape_sha256"),
        (lambda d: d.pop("shape_sha256"), "shape_sha256"),
        (lambda d: d.update(format="other"), "format"),
        (lambda d: d["faces"].pop(), "5 faces listed, the geometry has 6"),
        (lambda d: d["bodies"].append({"index": 2}), "2 bodies listed, the geometry has 1"),
        (lambda d: d["faces"][0].update(body=2), "face 1 is in body 1"),
        (lambda d: d["faces"][1].update(index=1), "listed twice"),
        (lambda d: d["faces"][0].update(name=""), "faces[0].name"),
        (lambda d: d.update(length_unit="in"), "length_unit"),
        (lambda d: d["faces"][0].update(centroid=[1, 2]), "faces[0]: centroid must be 3 numbers"),
        (lambda d: d["faces"][0].update(area="big"), "faces[0]: centroid must be 3 numbers"),
        (lambda d: d["faces"][0].update(normal=[0, 1]), "faces[0]: centroid must be 3 numbers"),
    ],
)
def test_each_rule_is_bad_face_names(tmp_path: Path, breaks, rule):
    doc = _good()
    breaks(doc)
    root, rel = _setup(tmp_path, doc)
    with pytest.raises(link.LinkError) as err:
        ga.adopt_names(root, "geom-box", rel)
    assert err.value.code == "bad_face_names"
    assert err.value.message.startswith("originalNames does not describe box: ")
    assert rule in err.value.message, err.value.message
    assert not (root / rel / "old_named.json").exists()


def test_names_that_point_at_other_faces_are_refused_beyond_a_fifth(tmp_path: Path):
    """Every row names the next face (with that face's fingerprint): none matches its face."""
    root, rel = _setup(tmp_path, _good("box.rotated_names.json"))
    with pytest.raises(link.LinkError) as err:
        ga.adopt_names(root, "geom-box", rel)
    assert (err.value.code, err.value.message) == ("bad_face_names", "originalNames: 6 of 6 faces don't match box")
    assert not (root / rel / "old_named.json").exists()


def test_one_row_that_points_at_another_face_loses_its_name(tmp_path: Path):
    """The top's row names the -x face: that name is dropped (the top follows by shape), never put on the top."""
    root, rel = _setup(tmp_path, _good("box.one_wrong_names.json"))
    got = ga.adopt_names(root, "geom-box", rel)
    assert (got["named"], got["unverified"]) == (5, 1)
    named = json.loads((root / rel / "old_named.json").read_text(encoding="utf-8"))
    by_name = {f.get("name"): f for f in named["faces"]}
    top = next(f for f in named["faces"] if f["normal"][2] > 0.5)
    assert "name" not in top and "label" not in top
    assert by_name["F:box:-x"]["normal"][0] < -0.5  # the -x face keeps its own name, once
    assert [f.get("name") for f in named["faces"]].count("F:box:-x") == 1


def test_a_named_row_with_no_fingerprint_is_unverified(tmp_path: Path):
    doc = _good()
    for k in ("centroid", "area", "normal"):
        doc["faces"][0].pop(k)
    root, rel = _setup(tmp_path, doc)
    assert ga.adopt_names(root, "geom-box", rel)["unverified"] == 1
    for f in doc["faces"][1:3]:
        for k in ("centroid", "area", "normal"):
            f.pop(k)
    root2, rel2 = _setup(tmp_path / "b", doc)
    with pytest.raises(link.LinkError) as err:
        ga.adopt_names(root2, "geom-box", rel2)
    assert err.value.message == "originalNames: 3 of 6 faces don't match box"


def test_no_face_table_is_not_ready_never_an_empty_map(tmp_path: Path):
    for names in (_good(), None):
        root, rel = _setup(tmp_path / ("a" if names else "b"), names)
        (root / "geometries" / "Geometry_box" / "cad_preview.json").unlink()
        with pytest.raises(link.LinkError) as err:
            ga.adopt_names(root, "geom-box", rel)
        assert err.value.code == "not_ready"
        assert not (root / rel / "old_named.json").exists()


def test_the_worker_answers_a_refusal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.worker import link_methods

    doc = _good()
    doc["shape_sha256"] = "1" * 64
    root, rel = _setup(tmp_path, doc)
    got = link_methods.geometry_adopt_names(project_dir=str(root), geometry_id="geom-box", staging_rel=rel)
    assert (got["ok"], got["code"]) == (False, "bad_face_names")
    assert link_methods.geometry_adopt_names(project_dir=str(root), geometry_id="geom-nope", staging_rel=rel)["code"] == "gone"
