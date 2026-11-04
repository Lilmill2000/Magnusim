"""Plans: the geometry, its faces as the app numbers them, the selectors, and the requests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from magnusim_validation import cases
from magnusim_validation.faces import resolve
from magnusim_validation.geometry import FIXED_STAMP, fix_header_stamp
from magnusim_validation.plan import make_plan

pytestmark = pytest.mark.occt


def _rows():
    def row(i, c, n, st, area=1.0):
        return {"id": i, "body": 1, "area_mm2": area, "centroid_mm": c, "normal": n, "surface_type": st}

    return [
        row(1, [150.0, 0.0, 0.0], [0.0, 0.0, -1.0], "Cylinder", 18849.6),
        row(2, [300.0, 0.0, 0.0], [1.0, 0.0, 0.0], "Plane", 314.2),
        row(3, [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], "Plane", 314.2),
    ]


def test_selectors_pick_faces_by_what_they_are():
    labels = resolve(_rows(), cases.get("c1").FACE_SELECTORS)
    assert labels == {"inlet": ["face 3@Body1"], "outlet": ["face 2@Body1"], "wall": ["face 1@Body1"]}
    assert resolve(_rows(), {"wall": {"surface_type": "Cylinder"}}) == {"wall": ["face 1@Body1"]}


def test_a_selector_that_finds_another_count_fails_loudly():
    with pytest.raises(ValueError, match="found 0 faces"):
        resolve(_rows(), {"x": {"plane": {"axis": "x", "at_mm": 10.0, "sign": 1}}})
    with pytest.raises(ValueError, match="found 2 faces"):
        resolve(_rows(), {"x": {"rest": True, "count": 1}, "y": {"surface_type": "Cylinder"}})
    with pytest.raises(ValueError, match="another selector"):
        resolve(_rows(), {"a": {"surface_type": "Cylinder"}, "b": {"surface_type": "Cylinder"}})
    with pytest.raises(ValueError, match="unknown"):
        resolve(_rows(), {"a": {"sphere": True}})


def test_the_step_header_time_stamp_is_fixed():
    text = "FILE_NAME('Open CASCADE Shape Model','2026-11-04T13:50:14',('Author'),(\n"
    assert fix_header_stamp(text) == f"FILE_NAME('Open CASCADE Shape Model','{FIXED_STAMP}',('Author'),(\n"
    # The writer numbers its products per process: the number goes too.
    product = "#7 = PRODUCT('Open CASCADE STEP translator 7.9 6',\n  'Open CASCADE STEP translator 7.9 6','',(#8));"
    want = "#7 = PRODUCT('Open CASCADE STEP translator 7.9',\n  'Open CASCADE STEP translator 7.9','',(#8));"
    assert fix_header_stamp(product) == want


@pytest.mark.parametrize("variant", ["hexdominant", "standard"])
def test_case_1_plans_the_same_every_time(tmp_path: Path, variant: str):
    c1 = cases.get("c1")
    a = make_plan(c1, variant, tmp_path / "a", cores=4)
    b = make_plan(c1, variant, tmp_path / "b", cores=4)
    assert a == b
    assert (tmp_path / "a" / "geometry.step").read_bytes() == (tmp_path / "b" / "geometry.step").read_bytes()
    assert json.loads((tmp_path / "a" / "plan.json").read_text(encoding="utf-8")) == a
    # The app's own face table of the pipe: the wall, the outlet, the inlet.
    faces = {f["id"]: f for f in a["geometry"]["faces"]}
    assert faces[1]["surface_type"] == "Cylinder"
    assert faces[2]["centroid_mm"][0] == pytest.approx(300.0) and faces[2]["normal"] == [1.0, 0.0, 0.0]
    assert faces[3]["centroid_mm"][0] == pytest.approx(0.0) and faces[3]["normal"] == [-1.0, 0.0, 0.0]
    assert faces[3]["area_mm2"] == pytest.approx(100 * 3.141592653589793)
    # Every BC's faces are the selectors' labels; the wall is always sent no-slip.
    bcs = {b["name"]: b for b in a["bcs"]}
    assert bcs["Inlet"]["faces"] == ["face 3@Body1"] and bcs["Inlet"]["value"] == 1.0
    assert bcs["Outlet"]["faces"] == ["face 2@Body1"]
    assert bcs["Pipe wall"]["faces"] == ["face 1@Body1"] and bcs["Pipe wall"]["wall_type"] == "No-slip"
    assert a["material"]["kinematic_viscosity"] == pytest.approx(2e-4)
    assert a["run"]["cores"] == 4 and a["run"]["endTime"] == 3000
    assert a["mesh"]["settings"]["fineness"] == 6
    engine = a["mesh"]["settings"]["advanced"]["mesh_engine"]
    if variant == "hexdominant":
        assert engine == "snappy_hexdominant"
        assert a["mesh"]["settings"]["automatic_boundary_layers"] is False
        assert a["mesh"]["refinements"][0]["faces"] == ["face 1@Body1"]
        assert a["study"]["settings"]["n_non_orthogonal"] == 1
    else:
        assert engine == "standard"
        assert a["mesh"]["settings"]["automatic_boundary_layers"] is True
        assert a["mesh"]["refinements"] == []
        assert a["study"]["settings"]["n_non_orthogonal"] == 2
    assert a["mesh"]["expect"]["layers"] is True


def test_a_coarse_plan_is_coarser(tmp_path: Path):
    c1 = cases.get("c1")
    p = make_plan(c1, "hexdominant", tmp_path, coarse=True, cores=2)
    assert p["coarse"] is True
    assert p["mesh"]["settings"]["fineness"] == 4
    assert p["run"]["endTime"] == 750 and p["run"]["cores"] == 2
    with pytest.raises(ValueError):
        make_plan(c1, "polyhedral", tmp_path / "x")
